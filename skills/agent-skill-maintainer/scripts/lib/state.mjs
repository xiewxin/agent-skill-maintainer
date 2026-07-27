/**
 * Versioned local run state, atomic writes, and per-binding locks.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  validateBranchPushProofContract,
  validateCandidateSnapshotContract,
  validateDocument,
  validateForkProofContract,
  validatePrProofContract,
  validatePrReadyValidation,
} from "./core.mjs";
import { verifyReleaseNoteCoverageProof } from "./git.mjs";
import { verifyGithubActionApproval } from "./github.mjs";
import { verifyLocalUpdateApproval } from "./update.mjs";

export class InvalidStateTransition extends Error {
  /** Indicates an illegal lifecycle transition. */
  constructor(message) {
    super(message);
    this.name = "InvalidStateTransition";
  }
}

export class LockUnavailableError extends Error {
  /** Indicates an active or unverifiable binding lock. */
  constructor(message) {
    super(message);
    this.name = "LockUnavailableError";
  }
}

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL_PHASES = new Set(["aborted", "blocked", "completed"]);
const INTERRUPTION_PHASES = new Set(["aborted", "blocked"]);
const CONSUMED_ACTION_PHASES = new Set([
  "isolation",
  "fork_creation",
  "branch_push",
  "pr_creation",
  "pr_update",
  "merge",
  "release",
  "local_update",
]);
const GITHUB_ACTION_PHASES = Object.freeze({
  fork_create: "fork_creation",
  branch_push: "branch_push",
  pr_create: "pr_creation",
  pr_update: "pr_update",
  merge: "merge",
  release: "release",
});
const PHASE_GITHUB_ACTIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(GITHUB_ACTION_PHASES).map(
      ([action, phase]) => [phase, action],
    ),
  ),
);
const NEXT_PHASES = Object.freeze({
  target_selection: new Set(["evidence_collection"]),
  evidence_collection: new Set(["feedback_validation"]),
  feedback_validation: new Set(["optimization_design"]),
  optimization_design: new Set(["optimization_approval", "completed"]),
  optimization_approval: new Set(["isolation"]),
  isolation: new Set(["implementation"]),
  implementation: new Set(["validation", "optimization_approval"]),
  validation: new Set([
    "fork_creation",
    "branch_push",
    "optimization_approval",
  ]),
  fork_creation: new Set([
    "fork_creation",
    "branch_push",
    "optimization_approval",
  ]),
  branch_push: new Set([
    "branch_push",
    "pr_creation",
    "pr_update",
    "optimization_approval",
  ]),
  pr_creation: new Set([
    "pr_creation",
    "pr_update",
    "merge",
    "optimization_approval",
    "completed",
  ]),
  pr_update: new Set([
    "pr_update",
    "merge",
    "optimization_approval",
    "completed",
  ]),
  merge: new Set(["merge", "release", "completed"]),
  release: new Set(["release", "local_update", "completed"]),
  local_update: new Set(["local_update", "completed"]),
});
const LEGACY_PHASES = Object.freeze({
  targeting: "target_selection",
  evidence: "evidence_collection",
  feedback: "feedback_validation",
  optimization: "optimization_design",
  approved: "optimization_approval",
  isolated: "isolation",
  implementation: "implementation",
  validation: "validation",
  pr_preview: "pr_creation",
  waiting_ci: "pr_creation",
  merged: "merge",
  released: "release",
  completed: "completed",
  aborted: "aborted",
  blocked: "blocked",
});
const TARGET_FIELDS = new Set([
  "skill",
  "repository",
  "version",
  "source_commit",
  "source_fingerprint",
]);
const PHASE_UPDATE_FIELDS = Object.freeze({
  evidence_collection: new Set(["evidence_ids"]),
  feedback_validation: new Set(["feedback_ids"]),
  optimization_design: new Set(["optimization_ids"]),
  optimization_approval: new Set(["optimization_ids"]),
  isolation: new Set(["approvals", "repository_snapshot"]),
  implementation: new Set(),
  validation: new Set(["candidate_snapshot"]),
  fork_creation: new Set([
    "action_preview",
    "approvals",
    "validation_summary",
  ]),
  branch_push: new Set([
    "action_preview",
    "approvals",
    "fork_proof",
    "validation_summary",
  ]),
  pr_creation: new Set([
    "action_preview",
    "approvals",
    "branch_push_proof",
    "validation_summary",
  ]),
  pr_update: new Set([
    "action_preview",
    "approvals",
    "branch_push_proof",
    "candidate_snapshot",
    "pr_proof",
    "validation_summary",
  ]),
  merge: new Set(["action_preview", "approvals", "pr_proof"]),
  release: new Set([
    "action_preview",
    "approvals",
    "merge_proof",
    "release_coverage",
  ]),
  local_update: new Set([
    "action_preview",
    "approvals",
    "publication_proof",
    "update_proof",
  ]),
  completed: new Set(),
  aborted: new Set(),
  blocked: new Set(),
});

/** Validates path components used by local state. */
function safeComponent(value, label) {
  if (typeof value !== "string" || !COMPONENT_PATTERN.test(value)) {
    throw new Error(`${label} 格式不合法`);
  }
  return value;
}

/** Returns a run state's fixed local path. */
function runPath(stateRoot, runId) {
  return resolve(stateRoot, "runs", safeComponent(runId, "run_id"), "state.json");
}

/** Returns a hashed binding path that does not reveal the binding name. */
function bindingPath(stateRoot, bindingId, directory, suffix) {
  const safeBindingId = safeComponent(bindingId, "binding_id");
  const name = createHash("sha256").update(safeBindingId, "utf8").digest("hex");
  return resolve(stateRoot, directory, `${name}.${suffix}`);
}

/** Writes JSON through a same-directory temporary file and atomic rename. */
function atomicWriteJson(path, document) {
  const parent = resolve(path, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(
    parent,
    `.state-${process.pid}-${randomBytes(8).toString("hex")}.json`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeSync(
      descriptor,
      `${JSON.stringify(document, null, 2)}\n`,
      null,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}

/** Keeps only target fields needed to resume a run. */
function minimalTarget(target) {
  if (!isObject(target)) {
    throw new Error("target 必須是 object");
  }
  const unknown = Object.keys(target)
    .filter((name) => !TARGET_FIELDS.has(name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`target 含不允許保存的欄位：${unknown.join(", ")}`);
  }
  const minimal = clone(target);
  if (typeof minimal.skill !== "string" || minimal.skill.trim().length === 0) {
    throw new Error("target.skill 為必填");
  }
  return minimal;
}

/** Migrates a legacy Preview run to the current schema. */
function migrateRunDocument(document) {
  if (!isObject(document)) {
    throw new Error("run state 必須是 object");
  }
  if (!Number.isInteger(document.schema_version)) {
    throw new Error("run state schema_version 不合法");
  }
  if (document.schema_version === 7) {
    return {
      document: clone(document),
      migrated: false,
    };
  }
  let current;
  let migrated = true;
  if (document.schema_version === 6) {
    current = clone(document);
  } else if (document.schema_version === 5) {
    current = clone(document);
  } else if (document.schema_version === 4) {
    current = clone(document);
  } else if (document.schema_version === 3) {
    current = clone(document);
    if (!Array.isArray(current.consumed_approval_fingerprints)) {
      current.consumed_approval_fingerprints = [];
    }
    if (!Array.isArray(current.attempted_github_action_fingerprints)) {
      current.attempted_github_action_fingerprints = [];
    }
    const inferredAction = PHASE_GITHUB_ACTIONS[current.phase];
    current.github_action_attempts =
      current.attempted_github_action_fingerprints.map(
        (approvalFingerprint, index, attempts) => ({
          action:
            inferredAction !== undefined && index === attempts.length - 1
              ? inferredAction
              : "unknown",
          approval_fingerprint: approvalFingerprint,
        }),
      );
    current.github_action_reconciliations = [];
  } else if (document.schema_version === 2) {
    current = {
      ...clone(document),
      consumed_approval_fingerprints:
        document.consumed_approval_fingerprints ?? [],
      attempted_github_action_fingerprints: [],
      github_action_attempts: [],
      github_action_reconciliations: [],
    };
  } else {
    if (document.schema_version !== 1) {
      throw new Error(
        `不支援的 run state schema_version：${document.schema_version}`,
      );
    }
    const phase = LEGACY_PHASES[document.phase];
    if (phase === undefined) {
      throw new Error(`無法遷移舊版 run phase：${document.phase}`);
    }
    current = {
      ...clone(document),
      phase,
      consumed_approval_fingerprints:
        document.consumed_approval_fingerprints ?? [],
      attempted_github_action_fingerprints: [],
      github_action_attempts: [],
      github_action_reconciliations: [],
    };
  }
  if (document.schema_version === 3) {
    migrated = true;
  }
  if (
    document.schema_version <= 4 &&
    current.status === "active" &&
    ["pr_creation", "pr_update", "merge", "release", "local_update"].includes(
      current.phase,
    )
  ) {
    throw new Error(
      "舊版 active run 已進入遠端副作用階段但缺少 branch push proof；" +
      "請使用原版本完成 reconcile，或建立新 run",
    );
  }
  if (
    current.status === "active" &&
    current.phase === "local_update"
  ) {
    throw new Error(
      "舊版 active run 的 local_update 缺少新版獨立審批與嘗試證據；" +
        "請使用原版本完成，或建立新 run",
    );
  }
  current.attempted_local_update_fingerprints ??= [];
  current.local_update_attempts ??= [];
  current.local_update_reconciliations ??= [];
  current.schema_version = 7;
  return {
    document: current,
    migrated,
  };
}

/** Creates a minimal recoverable run state. */
export function createRun(
  stateRoot,
  { runId, bindingId, target },
) {
  const safeBindingId = safeComponent(bindingId, "binding_id");
  const path = runPath(resolve(stateRoot), runId);
  if (existsSync(path)) {
    throw new Error(`run 已存在：${runId}`);
  }
  const document = {
    schema_version: 7,
    run_id: runId,
    binding_id: safeBindingId,
    phase: "target_selection",
    status: "active",
    target: minimalTarget(target),
    approvals: [],
    consumed_approval_fingerprints: [],
    attempted_github_action_fingerprints: [],
    github_action_attempts: [],
    github_action_reconciliations: [],
    attempted_local_update_fingerprints: [],
    local_update_attempts: [],
    local_update_reconciliations: [],
  };
  validateDocument("run-state", document);
  atomicWriteJson(path, document);
  return clone(document);
}

/** Reads, migrates, and validates an existing run state. */
export function readRun(stateRoot, runId) {
  const path = runPath(resolve(stateRoot), runId);
  let loaded;
  try {
    loaded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`無法讀取 run state：${runId}`, { cause: error });
  }
  if (!isObject(loaded)) {
    throw new Error("run state 必須是 object");
  }
  if (loaded.run_id !== runId) {
    throw new Error("run state 身份與路徑不一致");
  }
  safeComponent(loaded.binding_id, "binding_id");
  const { document, migrated } = migrateRunDocument(loaded);
  validateDocument("run-state", document);
  for (const reconciliation of document.github_action_reconciliations) {
    validateDocument("github-action-reconciliation", reconciliation);
  }
  for (const attempt of document.github_action_attempts) {
    if (
      attempt.action === "fork_create" &&
      (
        !Number.isFinite(Date.parse(attempt.attempted_at)) ||
        attempt.preview_fingerprint === undefined ||
        attempt.repository !== document.target?.repository ||
        attempt.fork_repository === undefined
      )
    ) {
      throw new Error("fork_create attempt 缺少綁定的執行資訊");
    }
  }
  for (const reconciliation of document.local_update_reconciliations) {
    validateDocument("local-update-reconciliation", reconciliation);
  }
  if (migrated) {
    atomicWriteJson(path, document);
  }
  return document;
}

/** Validates one GitHub action against its active run and candidate. */
function validateGithubActionRunBinding(
  document,
  preview,
  approval,
  {
    providerContractHash,
    now = new Date(),
    attempted,
  },
) {
  if (document.status !== "active") {
    throw new InvalidStateTransition("terminal run 不可執行 GitHub action");
  }
  verifyGithubActionApproval(approval, preview, {
    now,
    requireFresh: attempted !== true,
  });
  const expectedPhase = GITHUB_ACTION_PHASES[preview.action];
  if (expectedPhase === undefined || document.phase !== expectedPhase) {
    throw new InvalidStateTransition(
      `${preview.action} 與目前 run phase 不一致`,
    );
  }
  if (
    preview.state.run_id !== document.run_id ||
    preview.state.binding_id !== document.binding_id ||
    preview.state.repository !== document.target?.repository
  ) {
    throw new InvalidStateTransition(
      "GitHub action 與目前 run identity 不一致",
    );
  }
  if (
    typeof providerContractHash !== "string" ||
    preview.state.provider_contract_hash !== providerContractHash
  ) {
    throw new InvalidStateTransition("Provider contract 已漂移");
  }
  if (
    !document.consumed_approval_fingerprints.includes(
      approval.fingerprint,
    )
  ) {
    throw new InvalidStateTransition(
      "GitHub action approval 尚未由 lifecycle 預先消費",
    );
  }
  const wasAttempted =
    document.attempted_github_action_fingerprints.includes(
      approval.fingerprint,
    );
  if (attempted !== wasAttempted) {
    if (attempted) {
      throw new InvalidStateTransition(
        "GitHub action 尚未記錄遠端嘗試，不可 reconcile",
      );
    }
    throw new InvalidStateTransition(
      "GitHub action approval 已嘗試執行，不可重放",
    );
  }

  const candidate = validateRunCandidate(document);
  let expectedBaseBranch = candidate.repository_snapshot.base_ref;
  let expectedBaseCommit = candidate.repository_snapshot.merge_base;
  let expectedHeadCommit = candidate.repository_snapshot.head_commit;
  if (preview.action === "release") {
    validateDocument("merge-proof", document.merge_proof);
    expectedBaseBranch = document.merge_proof.default_branch;
    expectedBaseCommit = document.merge_proof.merge_commit;
    expectedHeadCommit = document.merge_proof.merge_commit;
    if (
      document.release_version !==
        preview.state.action_target.version
    ) {
      throw new InvalidStateTransition(
        "Release version 與目前 run 不一致",
      );
    }
  }
  if (
    preview.state.base_branch !== expectedBaseBranch ||
    preview.state.base_commit !== expectedBaseCommit ||
    preview.state.head_commit !== expectedHeadCommit ||
    preview.state.diff_hash !== candidate.candidate_diff_hash
  ) {
    throw new InvalidStateTransition(
      "GitHub action 與目前 candidate snapshot 不一致",
    );
  }
  if (
    ["pr_update", "merge"].includes(preview.action) &&
    preview.state.action_target.pr_number !== document.pr_proof?.number
  ) {
    throw new InvalidStateTransition(
      "GitHub action 與目前 Pull Request proof 不一致",
    );
  }
  return candidate;
}

/** Reserves one already-authorized GitHub action before any remote mutation. */
export function reserveGithubActionApply(
  stateRoot,
  runId,
  preview,
  approval,
  { providerContractHash, now = new Date() } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateGithubActionRunBinding(document, preview, approval, {
      providerContractHash,
      now,
      attempted: false,
    });
    document.attempted_github_action_fingerprints.push(
      approval.fingerprint,
    );
    const attempt = {
      action: preview.action,
      approval_fingerprint: approval.fingerprint,
    };
    if (preview.action === "fork_create") {
      const attemptedAt = now instanceof Date
        ? now.toISOString()
        : new Date(now).toISOString();
      if (!Number.isFinite(Date.parse(attemptedAt))) {
        throw new InvalidStateTransition(
          "fork_create attempt 時間不合法",
        );
      }
      attempt.attempted_at = attemptedAt;
      attempt.preview_fingerprint = preview.fingerprint;
      attempt.repository = preview.state.repository;
      attempt.fork_repository =
        preview.state.action_target.fork_repository;
    }
    document.github_action_attempts.push(attempt);
    validateDocument("run-state", document);
    atomicWriteJson(runPath(root, runId), document);
    return clone(document);
  });
}

/** Authorizes a read-only recovery for one previously attempted action. */
export function authorizeGithubActionReconcile(
  stateRoot,
  runId,
  preview,
  approval,
  { providerContractHash } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateGithubActionRunBinding(document, preview, approval, {
      providerContractHash,
      now: approval.confirmed_at,
      attempted: true,
    });
    return clone(document);
  });
}

/** Records one verified read-only reconciliation for a prior attempt. */
export function recordGithubActionReconciliation(
  stateRoot,
  runId,
  preview,
  approval,
  reconciliation,
  { providerContractHash } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateGithubActionRunBinding(document, preview, approval, {
      providerContractHash,
      now: approval.confirmed_at,
      attempted: true,
    });
    validateDocument("github-action-reconciliation", reconciliation);
    if (
      reconciliation.action !== preview.action ||
      reconciliation.repository !== document.target?.repository ||
      reconciliation.approval_fingerprint !== approval.fingerprint ||
      reconciliation.preview_fingerprint !== preview.fingerprint
    ) {
      throw new InvalidStateTransition(
        "GitHub reconciliation 與目前 action 不一致",
      );
    }
    const existing = document.github_action_reconciliations.find(
      (item) =>
        item.approval_fingerprint === approval.fingerprint &&
        canonicalJson(item) === canonicalJson(reconciliation),
    );
    if (existing !== undefined) {
      return clone(document);
    }
    const latest = document.github_action_reconciliations
      .filter(
        (item) =>
          item.approval_fingerprint === approval.fingerprint,
      )
      .at(-1);
    if (
      latest !== undefined &&
      ["blocked", "drifted"].includes(latest.status)
    ) {
      throw new InvalidStateTransition(
        "GitHub reconciliation 已進入終止狀態",
      );
    }
    document.github_action_reconciliations.push(clone(reconciliation));
    validateDocument("run-state", document);
    atomicWriteJson(runPath(root, runId), document);
    return clone(document);
  });
}

/** Validates one local update action against its active run. */
function validateLocalUpdateRunBinding(
  document,
  preview,
  approval,
  {
    providerContractHash,
    now = new Date(),
    attempted,
  },
) {
  if (document.status !== "active") {
    throw new InvalidStateTransition(
      "terminal run 不可執行 Local update",
    );
  }
  verifyLocalUpdateApproval(approval, preview, {
    now,
    requireFresh: attempted !== true,
  });
  if (document.phase !== "local_update") {
    throw new InvalidStateTransition(
      "Local update 與目前 run phase 不一致",
    );
  }
  if (
    preview.state.run_id !== document.run_id ||
    preview.state.binding_id !== document.binding_id ||
    preview.state.skill !== document.target?.skill ||
    preview.state.repository !== document.target?.repository
  ) {
    throw new InvalidStateTransition(
      "Local update 與目前 run identity 不一致",
    );
  }
  if (
    typeof providerContractHash !== "string" ||
    preview.state.provider_contract_hash !== providerContractHash
  ) {
    throw new InvalidStateTransition("Provider contract 已漂移");
  }
  if (
    !document.consumed_approval_fingerprints.includes(
      approval.fingerprint,
    )
  ) {
    throw new InvalidStateTransition(
      "Local update approval 尚未由 lifecycle 預先消費",
    );
  }
  const wasAttempted =
    document.attempted_local_update_fingerprints.includes(
      approval.fingerprint,
    );
  if (attempted !== wasAttempted) {
    if (attempted) {
      throw new InvalidStateTransition(
        "Local update 尚未記錄嘗試，不可 reconcile",
      );
    }
    throw new InvalidStateTransition(
      "Local update approval 已嘗試執行，不可重放",
    );
  }
  validateRunCandidate(document);
  validateDocument("publication-proof", document.publication_proof);
  if (
    preview.state.to_version !== document.publication_proof.version ||
    preview.state.release_tag !== document.publication_proof.tag ||
    preview.state.source_commit !== document.publication_proof.commit ||
    preview.state.repository !== document.publication_proof.repository
  ) {
    throw new InvalidStateTransition(
      "Local update 與官方發布證明不一致",
    );
  }
  return true;
}

/** Authorizes a local update without recording an attempt. */
export function authorizeLocalUpdateApply(
  stateRoot,
  runId,
  preview,
  approval,
  { providerContractHash, now = new Date() } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateLocalUpdateRunBinding(document, preview, approval, {
      providerContractHash,
      now,
      attempted: false,
    });
    return clone(document);
  });
}

/** Reserves one authorized local update before any installation write. */
export function reserveLocalUpdateApply(
  stateRoot,
  runId,
  preview,
  approval,
  { providerContractHash, now = new Date() } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateLocalUpdateRunBinding(document, preview, approval, {
      providerContractHash,
      now,
      attempted: false,
    });
    const attemptedAt = now instanceof Date
      ? now.toISOString()
      : new Date(now).toISOString();
    if (!Number.isFinite(Date.parse(attemptedAt))) {
      throw new InvalidStateTransition(
        "Local update attempt 時間不合法",
      );
    }
    document.attempted_local_update_fingerprints.push(
      approval.fingerprint,
    );
    document.local_update_attempts.push({
      approval_fingerprint: approval.fingerprint,
      preview_fingerprint: preview.fingerprint,
      attempted_at: attemptedAt,
      canonical_path_fingerprint:
        preview.state.canonical_path_fingerprint,
    });
    validateDocument("run-state", document);
    atomicWriteJson(runPath(root, runId), document);
    return clone(document);
  });
}

/** Authorizes a read-only local update reconciliation. */
export function authorizeLocalUpdateReconcile(
  stateRoot,
  runId,
  preview,
  approval,
  { providerContractHash } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateLocalUpdateRunBinding(document, preview, approval, {
      providerContractHash,
      now: approval.confirmed_at,
      attempted: true,
    });
    return clone(document);
  });
}

/** Records one verified local update proof or reconciliation. */
export function recordLocalUpdateOutcome(
  stateRoot,
  runId,
  preview,
  approval,
  outcome,
  { providerContractHash } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    validateLocalUpdateRunBinding(document, preview, approval, {
      providerContractHash,
      now: approval.confirmed_at,
      attempted: true,
    });
    if (!isObject(outcome)) {
      throw new InvalidStateTransition(
        "Local update outcome 必須是 object",
      );
    }
    if (isObject(outcome.proof)) {
      validateDocument("update-proof", outcome.proof);
      if (
        outcome.proof.run_id !== document.run_id ||
        outcome.proof.binding_id !== document.binding_id ||
        outcome.proof.skill !== document.target?.skill ||
        outcome.proof.repository !== document.target?.repository ||
        outcome.proof.from_version !== preview.state.from_version ||
        outcome.proof.to_version !==
          document.publication_proof.version ||
        outcome.proof.release_tag !==
          document.publication_proof.tag ||
        outcome.proof.source_commit !==
          document.publication_proof.commit ||
        outcome.proof.install_method !==
          preview.state.install_method ||
        outcome.proof.scope !== preview.state.scope ||
        outcome.proof.mode !== preview.state.mode ||
        outcome.proof.canonical_path_fingerprint !==
          preview.state.canonical_path_fingerprint ||
        outcome.proof.previous_fingerprint !==
          preview.state.current_fingerprint ||
        outcome.proof.verified !== true
      ) {
        throw new InvalidStateTransition(
          "Local update proof 與目前 run 不一致",
        );
      }
      if (
        isObject(document.update_proof) &&
        canonicalJson(document.update_proof) !==
          canonicalJson(outcome.proof)
      ) {
        throw new InvalidStateTransition(
          "Local update proof 已存在且內容不同",
        );
      }
      document.update_proof = clone(outcome.proof);
    } else if (isObject(outcome.reconciliation)) {
      validateDocument(
        "local-update-reconciliation",
        outcome.reconciliation,
      );
      if (
        outcome.reconciliation.approval_fingerprint !==
          approval.fingerprint ||
        outcome.reconciliation.preview_fingerprint !==
          preview.fingerprint
      ) {
        throw new InvalidStateTransition(
          "Local update reconciliation 與目前 action 不一致",
        );
      }
      const existing = document.local_update_reconciliations.find(
        (item) =>
          item.approval_fingerprint === approval.fingerprint &&
          canonicalJson(item) ===
            canonicalJson(outcome.reconciliation),
      );
      if (existing !== undefined) {
        return clone(document);
      }
      const latest = document.local_update_reconciliations
        .filter(
          (item) =>
            item.approval_fingerprint === approval.fingerprint,
        )
        .at(-1);
      if (
        latest !== undefined &&
        ["blocked", "drifted"].includes(latest.status)
      ) {
        throw new InvalidStateTransition(
          "Local update reconciliation 已進入終止狀態",
        );
      }
      document.local_update_reconciliations.push(
        clone(outcome.reconciliation),
      );
    } else {
      throw new InvalidStateTransition(
        "Local update outcome 缺少 proof 或 reconciliation",
      );
    }
    validateDocument("run-state", document);
    atomicWriteJson(runPath(root, runId), document);
    return clone(document);
  });
}

/** Creates the persistent implementation lease for a binding. */
function claimImplementationLease(stateRoot, bindingId, runId) {
  const path = bindingPath(stateRoot, bindingId, "leases", "json");
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const lease = {
    schema_version: 1,
    binding_id: bindingId,
    run_id: runId,
  };
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    let existing;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch (readError) {
      throw new LockUnavailableError(
        "binding lease 已存在且無法驗證",
        { cause: readError },
      );
    }
    if (existing.run_id === runId) {
      return false;
    }
    throw new LockUnavailableError(
      `binding 已由 run ${existing.run_id ?? "<unknown>"} 使用`,
    );
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(lease)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

/** Releases only a lease owned by the selected run. */
function releaseImplementationLease(stateRoot, bindingId, runId) {
  const path = bindingPath(stateRoot, bindingId, "leases", "json");
  if (!existsSync(path)) {
    return;
  }
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LockUnavailableError("binding lease 無法驗證，拒絕刪除", {
      cause: error,
    });
  }
  if (existing.run_id !== runId) {
    throw new LockUnavailableError("拒絕釋放其他 run 的 binding lease");
  }
  unlinkSync(path);
}

/** Returns whether a local process identifier is still active. */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  return true;
}

/** Runs one synchronous operation while holding the binding lock. */
export function withBindingLock(stateRoot, bindingId, operation) {
  const safeBindingId = safeComponent(bindingId, "binding_id");
  const path = bindingPath(resolve(stateRoot), safeBindingId, "locks", "lock");
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let existing;
      try {
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch (readError) {
        throw new LockUnavailableError(
          "binding 操作鎖已存在且無法驗證",
          { cause: readError },
        );
      }
      if (processIsAlive(existing.pid)) {
        throw new LockUnavailableError(
          `binding 已由其他 run 鎖定：${safeBindingId}`,
        );
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }
  if (descriptor === undefined) {
    throw new LockUnavailableError(
      `無法取得 binding 操作鎖：${safeBindingId}`,
    );
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schema_version: 1,
        binding_id: safeBindingId,
        pid: process.pid,
      })}\n`,
      "utf8",
    );
    closeSync(descriptor);
    descriptor = undefined;
    return operation(path);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

/** Requires one schema-valid confirmation for the selected lifecycle action. */
function requireActionApproval(
  document,
  action,
  {
    expectedBaseBranch = null,
    expectedHeadCommit = null,
    expectedDiffHash = null,
  } = {},
) {
  const approval = document.approvals.find(
    (item) => isObject(item) && item.action === action,
  );
  if (approval === undefined) {
    throw new InvalidStateTransition(`缺少 ${action} 獨立確認`);
  }
  if (document.consumed_approval_fingerprints.includes(approval.fingerprint)) {
    throw new InvalidStateTransition(`${action} 確認已使用，不可重放`);
  }
  if (action === "implementation") {
    validateDocument("approval", approval);
    const unsigned = clone(approval);
    delete unsigned.fingerprint;
    if (fingerprint(unsigned) !== approval.fingerprint) {
      throw new InvalidStateTransition("implementation 確認 fingerprint 不一致");
    }
    if (
      approval.binding_id !== document.binding_id ||
      approval.run_id !== document.run_id ||
      approval.repository !== document.target?.repository ||
      approval.head_commit !== expectedHeadCommit ||
      approval.diff_hash !== expectedDiffHash ||
      canonicalJson(approval.process_artifact_prefixes) !==
        canonicalJson(document.repository_snapshot.process_artifact_prefixes)
    ) {
      throw new InvalidStateTransition("implementation 確認與目前倉庫狀態不一致");
    }
    return approval;
  }
  if (action === "local_update") {
    if (!isObject(document.action_preview)) {
      throw new InvalidStateTransition("缺少 local_update 動作預覽");
    }
    verifyLocalUpdateApproval(
      approval,
      document.action_preview,
      { now: new Date() },
    );
    if (
      approval.run_id !== document.run_id ||
      approval.binding_id !== document.binding_id ||
      approval.skill !== document.target?.skill ||
      approval.repository !== document.target?.repository ||
      (
        expectedHeadCommit !== null &&
        approval.source_commit !== expectedHeadCommit
      )
    ) {
      throw new InvalidStateTransition(
        "local_update 確認與目前發布狀態不一致",
      );
    }
    return approval;
  }
  if (!isObject(document.action_preview)) {
    throw new InvalidStateTransition(`缺少 ${action} 動作預覽`);
  }
  verifyGithubActionApproval(
    approval,
    document.action_preview,
    { now: new Date() },
  );
  if (
    approval.action !== action ||
    approval.run_id !== document.run_id ||
    approval.binding_id !== document.binding_id ||
    approval.repository !== document.target?.repository ||
    (expectedBaseBranch !== null &&
      approval.base_branch !== expectedBaseBranch) ||
    (expectedHeadCommit !== null &&
      approval.head_commit !== expectedHeadCommit) ||
    (expectedDiffHash !== null && approval.diff_hash !== expectedDiffHash)
  ) {
    throw new InvalidStateTransition(`${action} 確認與目前候選狀態不一致`);
  }
  return approval;
}

/** Returns the exact mutation target carried by the current action preview. */
function currentActionTarget(document, action) {
  const target = document.action_preview?.state?.action_target;
  if (
    document.action_preview?.action !== action ||
    !isObject(target)
  ) {
    throw new InvalidStateTransition(`${action} 動作目標不合法`);
  }
  return target;
}

/** Revalidates a candidate against the process contract approved at isolation. */
function validateRunCandidate(document) {
  const candidate = validateCandidateSnapshotContract(
    document.candidate_snapshot,
  );
  if (
    canonicalJson(candidate.process_artifact_prefixes) !==
    canonicalJson(document.repository_snapshot.process_artifact_prefixes)
  ) {
    throw new InvalidStateTransition(
      "candidate 過程檔合同與核准的 repository snapshot 不一致",
    );
  }
  return candidate;
}

/** Enforces proof-forward contracts before entering side-effect stages. */
function requirePhaseEvidence(document, nextPhase) {
  if (nextPhase === "isolation") {
    validateDocument("repository-snapshot", document.repository_snapshot);
    requireActionApproval(document, "implementation", {
      expectedHeadCommit: document.repository_snapshot.head_commit,
      expectedDiffHash: document.repository_snapshot.diff_hash,
    });
  }
  if (nextPhase === "validation") {
    validateRunCandidate(document);
  }
  if (nextPhase === "fork_creation") {
    const candidate = validateRunCandidate(document);
    validatePrReadyValidation(document.validation_summary, candidate);
    requireActionApproval(
      document,
      "fork_create",
      {
        expectedHeadCommit:
          candidate.repository_snapshot.head_commit,
        expectedDiffHash: candidate.candidate_diff_hash,
        expectedBaseBranch:
          candidate.repository_snapshot.base_ref,
      },
    );
    if (
      document.action_preview.state.relationship !== "contribute"
    ) {
      throw new InvalidStateTransition(
        "fork_creation 只適用於 contribute 關係",
      );
    }
  }
  if (nextPhase === "branch_push") {
    const candidate = validateRunCandidate(document);
    validatePrReadyValidation(document.validation_summary, candidate);
    requireActionApproval(
      document,
      "branch_push",
      {
        expectedHeadCommit:
          candidate.repository_snapshot.head_commit,
        expectedDiffHash: candidate.candidate_diff_hash,
        expectedBaseBranch: candidate.repository_snapshot.base_ref,
      },
    );
    if (
      document.action_preview.state.relationship === "contribute"
    ) {
      const target =
        document.action_preview.state.action_target;
      validateForkProofContract(document.fork_proof, {
        repository: document.target.repository,
        forkRepository: target.head_repository,
        account: document.action_preview.state.account,
        baseBranch: candidate.repository_snapshot.base_ref,
        baseCommit: candidate.repository_snapshot.merge_base,
      });
    }
  }
  if (["pr_creation", "pr_update"].includes(nextPhase)) {
    const candidate = validateRunCandidate(document);
    const validation = validatePrReadyValidation(
      document.validation_summary,
      candidate,
    );
    const documentationImpact = validation.checks.find(
      (check) => check.category === "documentation",
    ).details;
    if (nextPhase === "pr_update") {
      validatePrProofContract(document.pr_proof, documentationImpact, {
        repository: document.target.repository,
        baseBranch:
          document.candidate_snapshot.repository_snapshot.base_ref,
        headCommit:
          document.candidate_snapshot.repository_snapshot.head_commit,
      });
    }
    const action =
      nextPhase === "pr_creation" ? "pr_create" : "pr_update";
    requireActionApproval(
      document,
      action,
      {
        expectedHeadCommit:
          document.candidate_snapshot.repository_snapshot.head_commit,
        expectedDiffHash: document.candidate_snapshot.candidate_diff_hash,
        expectedBaseBranch:
          document.candidate_snapshot.repository_snapshot.base_ref,
      },
    );
    const actionTarget = currentActionTarget(document, action);
    const headRepository =
      actionTarget.head_repository ?? document.target.repository;
    validateBranchPushProofContract(
      document.branch_push_proof,
      candidate,
      {
        repository: document.target.repository,
        relationship: document.action_preview.state.relationship,
        baseBranch: candidate.repository_snapshot.base_ref,
        baseCommit: candidate.repository_snapshot.merge_base,
        headBranch: document.action_preview.state.head_branch,
        headRepository,
      },
    );
    if (
      nextPhase === "pr_update" &&
      currentActionTarget(document, action).pr_number !==
        document.pr_proof.number
    ) {
      throw new InvalidStateTransition("PR update 目標與 PR proof 不一致");
    }
  }
  if (nextPhase === "merge") {
    const candidate = validateRunCandidate(document);
    const validation = validatePrReadyValidation(
      document.validation_summary,
      candidate,
    );
    const documentationImpact = validation.checks.find(
      (check) => check.category === "documentation",
    ).details;
    validatePrProofContract(document.pr_proof, documentationImpact, {
      repository: document.target.repository,
      baseBranch:
        document.candidate_snapshot.repository_snapshot.base_ref,
      headCommit:
        document.candidate_snapshot.repository_snapshot.head_commit,
    });
    if (
      document.pr_proof.state !== "open" ||
      document.pr_proof.checks_passed !== true
    ) {
      throw new InvalidStateTransition("Pull Request 尚未符合合併條件");
    }
    requireActionApproval(document, "merge", {
      expectedBaseBranch:
        document.candidate_snapshot.repository_snapshot.base_ref,
      expectedHeadCommit: document.pr_proof.head_commit,
      expectedDiffHash: document.candidate_snapshot.candidate_diff_hash,
    });
    if (
      currentActionTarget(document, "merge").pr_number !==
      document.pr_proof.number
    ) {
      throw new InvalidStateTransition("Merge 目標與 PR proof 不一致");
    }
  }
  if (nextPhase === "release") {
    validateRunCandidate(document);
    validateDocument("merge-proof", document.merge_proof);
    if (
      document.merge_proof.repository !== document.target?.repository ||
      document.merge_proof.pr_number !== document.pr_proof?.number ||
      document.merge_proof.default_branch !== document.pr_proof?.base_branch
    ) {
      throw new InvalidStateTransition(
        "Merge proof 與目前倉庫、PR 或預設分支不一致",
      );
    }
    const coverage = verifyReleaseNoteCoverageProof(
      document.release_coverage,
    );
    if (coverage.candidate_commit !== document.merge_proof.merge_commit) {
      throw new InvalidStateTransition(
        "Release coverage 與合併提交不一致",
      );
    }
    requireActionApproval(document, "release", {
      expectedBaseBranch: document.merge_proof.default_branch,
      expectedHeadCommit: coverage.candidate_commit,
      expectedDiffHash: document.candidate_snapshot.candidate_diff_hash,
    });
    const releaseTarget = currentActionTarget(document, "release");
    if (
      typeof releaseTarget.version !== "string" ||
      releaseTarget.version.length === 0 ||
      canonicalJson(releaseTarget.release_note_coverage) !==
        canonicalJson(coverage)
    ) {
      throw new InvalidStateTransition(
        "Release 目標與完整 coverage proof 不一致",
      );
    }
  }
  if (nextPhase === "local_update") {
    validateRunCandidate(document);
    validateDocument("publication-proof", document.publication_proof);
    const expectedReleaseUrl =
      `https://github.com/${document.target?.repository}/releases/tag/` +
      document.publication_proof.tag;
    if (
      document.publication_proof.official !== true ||
      document.publication_proof.repository !==
        document.target?.repository ||
      document.publication_proof.commit !==
        document.merge_proof?.merge_commit ||
      document.publication_proof.version !== document.release_version ||
      document.publication_proof.tag !== document.release_version ||
      document.publication_proof.release_url !== expectedReleaseUrl
    ) {
      throw new InvalidStateTransition("尚未驗證官方發布");
    }
    requireActionApproval(document, "local_update", {
      expectedHeadCommit: document.publication_proof.commit,
    });
    if (
      document.action_preview.state.skill !== document.target?.skill ||
      document.action_preview.state.repository !==
        document.target?.repository ||
      document.action_preview.state.to_version !==
        document.publication_proof.version ||
      document.action_preview.state.release_tag !==
        document.publication_proof.tag ||
      document.action_preview.state.source_commit !==
        document.publication_proof.commit
    ) {
      throw new InvalidStateTransition(
        "Local update 目標與官方發布證明不一致",
      );
    }
  }
  if (nextPhase === "completed" && document.phase === "local_update") {
    if (!isObject(document.update_proof)) {
      throw new InvalidStateTransition(
        "Local update 尚未產生 update-proof",
      );
    }
    validateDocument("update-proof", document.update_proof);
    if (
      document.update_proof.verified !== true ||
      document.update_proof.run_id !== document.run_id ||
      document.update_proof.binding_id !== document.binding_id ||
      document.update_proof.skill !== document.target?.skill ||
      document.update_proof.repository !==
        document.target?.repository ||
      document.update_proof.to_version !==
        document.publication_proof?.version ||
      document.update_proof.release_tag !==
        document.publication_proof?.tag ||
      document.update_proof.source_commit !==
        document.publication_proof?.commit
    ) {
      throw new InvalidStateTransition(
        "Local update proof 與目前發布狀態不一致",
      );
    }
  }
}

/** Advances one run through a legal lifecycle transition. */
export function transitionRun(
  stateRoot,
  runId,
  nextPhase,
  { updates = {} } = {},
) {
  const root = resolve(stateRoot);
  const initial = readRun(root, runId);
  return withBindingLock(root, initial.binding_id, () => {
    const document = readRun(root, runId);
    if (document.status !== "active") {
      throw new InvalidStateTransition("terminal run 不可再次轉換");
    }
    if (
      !INTERRUPTION_PHASES.has(nextPhase) &&
      !NEXT_PHASES[document.phase]?.has(nextPhase)
    ) {
      throw new InvalidStateTransition(
        `不可由 ${document.phase} 進入 ${nextPhase}`,
      );
    }
    if (!isObject(updates)) {
      throw new Error("state updates 必須是 object");
    }
    const allowedUpdates = PHASE_UPDATE_FIELDS[nextPhase];
    if (allowedUpdates === undefined) {
      throw new Error(`未知 lifecycle phase：${nextPhase}`);
    }
    const unknown = Object.keys(updates)
      .filter((name) => !allowedUpdates.has(name))
      .sort();
    if (unknown.length > 0) {
      throw new Error(
        `${nextPhase} 不允許更新欄位：${unknown.join(", ")}`,
      );
    }

    let leaseCreated = false;
    if (nextPhase === "isolation") {
      leaseCreated = claimImplementationLease(
        root,
        document.binding_id,
        runId,
      );
    }
    try {
      const retryAction = PHASE_GITHUB_ACTIONS[nextPhase];
      if (nextPhase === document.phase && retryAction !== undefined) {
        if (
          document.github_action_attempts.some(
            (attempt) => attempt.action === "unknown",
          )
        ) {
          throw new InvalidStateTransition(
            "舊版 GitHub action attempt 無法安全推斷，不可自動重試",
          );
        }
        const priorAttempts = document.github_action_attempts.filter(
          (attempt) => attempt.action === retryAction,
        );
        const latestAttempt = priorAttempts.at(-1);
        if (
          latestAttempt !== undefined &&
          !document.github_action_reconciliations.some(
            (item) =>
              item.action === retryAction &&
              item.approval_fingerprint ===
                latestAttempt.approval_fingerprint &&
              item.status === "not_applied",
          )
        ) {
          throw new InvalidStateTransition(
            `${retryAction} 上次嘗試尚未證明未寫入，不可重試`,
          );
        }
      }
      if (
        nextPhase === "local_update" &&
        document.phase === "local_update"
      ) {
        const latestAttempt = document.local_update_attempts.at(-1);
        if (
          latestAttempt !== undefined &&
          !document.local_update_reconciliations.some(
            (item) =>
              item.approval_fingerprint ===
                latestAttempt.approval_fingerprint &&
              ["not_applied", "rolled_back"].includes(item.status),
          )
        ) {
          throw new InvalidStateTransition(
            "local_update 上次嘗試尚未證明未套用或已回滾，不可重試",
          );
        }
      }
      Object.assign(document, clone(updates));
      requirePhaseEvidence(document, nextPhase);
      if (nextPhase === "release") {
        document.release_version = currentActionTarget(
          document,
          "release",
        ).version;
      }
      if (CONSUMED_ACTION_PHASES.has(nextPhase)) {
        const action = nextPhase === "isolation"
          ? "implementation"
          : nextPhase === "local_update"
            ? "local_update"
            : PHASE_GITHUB_ACTIONS[nextPhase];
        const consumed = document.approvals.find(
          (item) => isObject(item) && item.action === action,
        );
        if (typeof consumed?.fingerprint !== "string") {
          throw new InvalidStateTransition(
            `${action} 確認無法記錄消費狀態`,
          );
        }
        document.consumed_approval_fingerprints.push(consumed.fingerprint);
        document.approvals = [];
        delete document.action_preview;
      }
      document.phase = nextPhase;
      if (TERMINAL_PHASES.has(nextPhase)) {
        document.status = nextPhase;
        document.approvals = [];
      }
      validateDocument("run-state", document);
      atomicWriteJson(runPath(root, runId), document);
    } catch (error) {
      if (leaseCreated) {
        releaseImplementationLease(root, document.binding_id, runId);
      }
      throw error;
    }
    if (TERMINAL_PHASES.has(nextPhase)) {
      releaseImplementationLease(root, document.binding_id, runId);
    }
    return clone(document);
  });
}
