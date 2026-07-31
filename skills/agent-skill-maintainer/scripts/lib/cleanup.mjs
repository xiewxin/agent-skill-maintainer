/**
 * State-bound candidate cleanup with quarantine and read-only recovery.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  canonicalJson,
  clone,
  compareUtf8,
  fingerprint,
  validateCandidateSnapshotContract,
  validateDocument,
} from "./core.mjs";
import {
  fingerprintCandidatePath,
  validateCandidateCheckoutForCleanup,
} from "./git.mjs";
import {
  readRun,
  withBindingLock,
} from "./state.mjs";

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ELIGIBLE_COMPLETIONS = new Set([
  "stop_after_merge",
  "stop_after_release",
  "local_update_verified",
]);
const ACTIVE_CLEANUP_STATUSES = new Set([
  "previewed",
  "approved",
  "attempted",
  "quarantined",
  "pending",
  "blocked",
]);
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1000;

function safeComponent(value, label) {
  if (typeof value !== "string" || !COMPONENT_PATTERN.test(value)) {
    throw new Error(`${label} 格式不合法`);
  }
  return value;
}

function cleanupStatePath(stateRoot, transactionId) {
  return resolve(
    stateRoot,
    "cleanup",
    safeComponent(transactionId, "transaction_id"),
    "state.json",
  );
}

function rawSha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function atomicWriteJson(path, document) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(
    directory,
    `.state-${process.pid}-${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, `${JSON.stringify(document)}\n`, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readCleanupState(stateRoot, transactionId) {
  const path = cleanupStatePath(resolve(stateRoot), transactionId);
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("cleanup transaction 無法讀取", { cause: error });
  }
  validateDocument("cleanup-transaction", document);
  validateDocument("cleanup-preview", document.preview);
  if (document.approval !== undefined) {
    validateDocument("cleanup-approval", document.approval);
  }
  return document;
}

function exactChild(root, name) {
  const safeName = safeComponent(name, "candidate");
  if (safeName === ".quarantine") {
    throw new Error("candidate 不可指向 quarantine");
  }
  const target = resolve(root, safeName);
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot !== safeName ||
    isAbsolute(pathFromRoot) ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("candidate 必須是固定 candidates root 的直接子目錄");
  }
  return target;
}

function assertSafeDirectory(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} 必須是非 symlink 目錄`);
  }
}

function scanTree(root, { allowMissingEntries = false } = {}) {
  assertSafeDirectory(root, "cleanup resource");
  const entries = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory) => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((first, second) => compareUtf8(first.name, second.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`cleanup resource 含 symbolic link：${relativePath}`);
      }
      if (metadata.isDirectory()) {
        entries.push({
          path: relativePath,
          kind: "directory",
          mode: metadata.mode & 0o777,
        });
        visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`cleanup resource 含特殊檔案：${relativePath}`);
      }
      const payload = readFileSync(absolute);
      entries.push({
        path: relativePath,
        kind: "file",
        mode: metadata.mode & 0o777,
        bytes: payload.length,
        sha256: rawSha256(payload),
      });
      fileCount += 1;
      totalBytes += payload.length;
    }
  };
  visit(root);
  entries.sort((first, second) => compareUtf8(first.path, second.path));
  return {
    entries,
    file_count: fileCount,
    total_bytes: totalBytes,
    tree_fingerprint: fingerprint(entries),
    allow_missing_entries: allowMissingEntries,
  };
}

function sourceStateBytes(stateRoot, sourceRunId) {
  return readFileSync(
    resolve(
      stateRoot,
      "runs",
      safeComponent(sourceRunId, "source_run_id"),
      "state.json",
    ),
  );
}

function candidateIdentity(candidateSnapshot) {
  return fingerprint({
    repository_snapshot: candidateSnapshot.repository_snapshot,
    candidate_diff_hash: candidateSnapshot.candidate_diff_hash,
  });
}

function listStateDocuments(stateRoot) {
  const runsRoot = resolve(stateRoot, "runs");
  if (!existsSync(runsRoot)) {
    return [];
  }
  const documents = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !COMPONENT_PATTERN.test(entry.name)) {
      continue;
    }
    try {
      documents.push(
        readRun(stateRoot, entry.name, { persistMigration: false }),
      );
    } catch {
      documents.push({
        run_id: entry.name,
        status: "unknown",
        unreadable: true,
      });
    }
  }
  return documents;
}

function listCleanupDocuments(stateRoot) {
  const cleanupRoot = resolve(stateRoot, "cleanup");
  if (!existsSync(cleanupRoot)) {
    return [];
  }
  const documents = [];
  for (const entry of readdirSync(cleanupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !COMPONENT_PATTERN.test(entry.name)) {
      continue;
    }
    try {
      documents.push(readCleanupState(stateRoot, entry.name));
    } catch {
      documents.push({
        transaction_id: entry.name,
        status: "unknown",
      });
    }
  }
  return documents;
}

function findReferences(
  stateRoot,
  sourceRun,
  candidateSnapshot,
  { transactionId = null } = {},
) {
  const identity = candidateIdentity(candidateSnapshot);
  const blockers = [];
  for (const run of listStateDocuments(stateRoot)) {
    if (run.run_id === sourceRun.run_id) {
      continue;
    }
    let sameCandidate = false;
    if (run.candidate_snapshot !== undefined) {
      try {
        sameCandidate =
          candidateIdentity(
            validateCandidateSnapshotContract(run.candidate_snapshot),
          ) === identity;
      } catch {
        if (run.status === "active") {
          blockers.push({
            kind: "ambiguous_active_candidate_snapshot",
            reference_fingerprint: fingerprint(run.run_id),
          });
        }
      }
    }
    const sourceContinuation =
      run.continuation?.source_run_id === sourceRun.run_id;
    if (
      (sameCandidate || sourceContinuation) &&
      run.status === "active"
    ) {
      blockers.push({
        kind: "active_run",
        reference_fingerprint: fingerprint(run.run_id),
      });
    }
    if (run.status === "unknown" && run.unreadable === true) {
      blockers.push({
        kind: "unreadable_run_state",
        reference_fingerprint: fingerprint(run.run_id),
      });
    }
  }
  for (const transaction of listCleanupDocuments(stateRoot)) {
    if (transaction.transaction_id === transactionId) {
      continue;
    }
    if (
      transaction.preview?.candidate_identity === identity &&
      ACTIVE_CLEANUP_STATUSES.has(transaction.status)
    ) {
      blockers.push({
        kind: "active_cleanup",
        reference_fingerprint: fingerprint(transaction.transaction_id),
      });
    }
    if (transaction.status === "unknown") {
      blockers.push({
        kind: "unreadable_cleanup_state",
        reference_fingerprint: fingerprint(transaction.transaction_id),
      });
    }
  }
  return blockers;
}

function inspectCleanupTarget({
  stateRoot,
  sourceRunId,
  candidateName,
  candidatesRoot,
  transactionId = null,
}) {
  const root = resolve(candidatesRoot ?? resolve(stateRoot, "candidates"));
  assertSafeDirectory(root, "candidates root");
  const sourceBytes = sourceStateBytes(stateRoot, sourceRunId);
  const sourceRun = readRun(stateRoot, sourceRunId, {
    persistMigration: false,
  });
  if (
    sourceRun.status !== "completed" ||
    sourceRun.phase !== "completed" ||
    !ELIGIBLE_COMPLETIONS.has(sourceRun.completion_disposition?.kind)
  ) {
    throw new Error("source run 尚未完成可清理的整合或發布終態");
  }
  const candidateSnapshot = validateCandidateSnapshotContract(
    sourceRun.candidate_snapshot,
  );
  const candidate = exactChild(root, candidateName);
  if (!existsSync(candidate)) {
    throw new Error("cleanup candidate 不存在");
  }
  const checkout = validateCandidateCheckoutForCleanup(
    candidate,
    candidateSnapshot,
  );
  const manifest = scanTree(candidate);
  const references = findReferences(
    stateRoot,
    sourceRun,
    candidateSnapshot,
    { transactionId },
  );
  if (references.length > 0) {
    throw new Error(
      `cleanup candidate 仍有 ${references.length} 筆不可忽略引用`,
    );
  }
  return {
    root,
    candidate,
    sourceBytes,
    sourceRun,
    candidateSnapshot,
    checkout,
    manifest,
  };
}

/** Creates and persists an exact cleanup preview without changing the source run. */
export function previewCleanup({
  stateRoot,
  sourceRunId,
  candidateName,
  candidatesRoot,
  previewedAt = new Date().toISOString(),
}) {
  if (!Number.isFinite(Date.parse(previewedAt))) {
    throw new Error("cleanup preview 時間不合法");
  }
  const root = resolve(stateRoot);
  const inspected = inspectCleanupTarget({
    stateRoot: root,
    sourceRunId,
    candidateName,
    candidatesRoot,
  });
  const previewBase = {
    schema_version: 1,
    action: "candidate_cleanup",
    source_run_id: sourceRunId,
    source_state_sha256: rawSha256(inspected.sourceBytes),
    binding_id: inspected.sourceRun.binding_id,
    candidate: {
      kind: "candidate_checkout",
      relative_path: candidateName,
      canonical_path_fingerprint:
        fingerprintCandidatePath(inspected.candidate),
      tree_fingerprint: inspected.manifest.tree_fingerprint,
      file_count: inspected.manifest.file_count,
      total_bytes: inspected.manifest.total_bytes,
    },
    candidate_identity: candidateIdentity(inspected.candidateSnapshot),
    completion_kind: inspected.sourceRun.completion_disposition.kind,
    previewed_at: previewedAt,
  };
  const transactionId = fingerprint(previewBase).slice(0, 32);
  const preview = {
    ...previewBase,
    transaction_id: transactionId,
  };
  preview.fingerprint = fingerprint(preview);
  validateDocument("cleanup-preview", preview);
  const state = {
    schema_version: 1,
    transaction_id: transactionId,
    source_run_id: sourceRunId,
    binding_id: inspected.sourceRun.binding_id,
    status: "previewed",
    preview,
    manifest: inspected.manifest.entries,
    reconciliations: [],
  };
  validateDocument("cleanup-transaction", state);
  return withBindingLock(root, inspected.sourceRun.binding_id, () => {
    const path = cleanupStatePath(root, transactionId);
    if (existsSync(path)) {
      const existing = readCleanupState(root, transactionId);
      if (
        existing.status === "previewed" &&
        canonicalJson(existing.preview) === canonicalJson(preview)
      ) {
        return clone(preview);
      }
      throw new Error("相同 cleanup transaction 已存在且不可覆寫");
    }
    atomicWriteJson(path, state);
    return clone(preview);
  });
}

/** Records a short-lived one-time approval for an exact cleanup preview. */
export function approveCleanup(
  stateRoot,
  preview,
  {
    confirmedAt,
    expiresAt,
  },
) {
  validateDocument("cleanup-preview", preview);
  const confirmed = Date.parse(confirmedAt);
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(confirmed) ||
    !Number.isFinite(expires) ||
    confirmed < Date.parse(preview.previewed_at) ||
    expires <= confirmed ||
    expires - confirmed > MAX_APPROVAL_TTL_MS
  ) {
    throw new Error("cleanup approval 時間範圍不合法");
  }
  const approval = {
    schema_version: 1,
    action: "candidate_cleanup",
    transaction_id: preview.transaction_id,
    source_run_id: preview.source_run_id,
    preview_fingerprint: preview.fingerprint,
    confirmed_at: confirmedAt,
    expires_at: expiresAt,
  };
  approval.fingerprint = fingerprint(approval);
  validateDocument("cleanup-approval", approval);
  const root = resolve(stateRoot);
  return withBindingLock(root, preview.binding_id, () => {
    const state = readCleanupState(root, preview.transaction_id);
    if (
      state.status !== "previewed" ||
      canonicalJson(state.preview) !== canonicalJson(preview)
    ) {
      throw new Error("cleanup preview 已漂移或不再可批准");
    }
    state.status = "approved";
    state.approval = approval;
    atomicWriteJson(
      cleanupStatePath(root, preview.transaction_id),
      state,
    );
    return clone(approval);
  });
}

function verifyApproval(preview, approval, now) {
  validateDocument("cleanup-preview", preview);
  validateDocument("cleanup-approval", approval);
  const unsigned = clone(approval);
  delete unsigned.fingerprint;
  if (
    approval.fingerprint !== fingerprint(unsigned) ||
    approval.preview_fingerprint !== preview.fingerprint ||
    approval.transaction_id !== preview.transaction_id ||
    approval.source_run_id !== preview.source_run_id ||
    Date.parse(approval.confirmed_at) > now.getTime() ||
    Date.parse(approval.expires_at) <= now.getTime()
  ) {
    throw new Error("cleanup approval 無效、漂移或已過期");
  }
}

function assertManifestExact(path, expectedEntries) {
  const current = scanTree(path);
  if (canonicalJson(current.entries) !== canonicalJson(expectedEntries)) {
    throw new Error("cleanup resource content 已漂移");
  }
  return current;
}

function assertManifestSubset(path, expectedEntries) {
  const current = scanTree(path, { allowMissingEntries: true });
  const expected = new Map(
    expectedEntries.map((entry) => [entry.path, entry]),
  );
  for (const entry of current.entries) {
    if (canonicalJson(expected.get(entry.path)) !== canonicalJson(entry)) {
      throw new Error("quarantine 含未知或漂移內容");
    }
  }
  return current;
}

function buildCleanupProof(state, appliedAt) {
  const proof = {
    schema_version: 1,
    action: "candidate_cleanup",
    transaction_id: state.transaction_id,
    source_run_id: state.source_run_id,
    source_state_sha256: state.preview.source_state_sha256,
    preview_fingerprint: state.preview.fingerprint,
    approval_fingerprint: state.approval.fingerprint,
    candidate_identity: state.preview.candidate_identity,
    tree_fingerprint: state.preview.candidate.tree_fingerprint,
    applied_at: appliedAt,
    quarantined_before_delete: true,
    source_run_unchanged: true,
    applied: true,
  };
  validateDocument("cleanup-proof", proof);
  return proof;
}

function verifySourceUnchanged(stateRoot, state) {
  if (
    rawSha256(sourceStateBytes(stateRoot, state.source_run_id)) !==
      state.preview.source_state_sha256
  ) {
    throw new Error("terminal source run 已漂移");
  }
}

/** Applies one approved cleanup after reserving the attempt. */
export function applyCleanup({
  stateRoot,
  preview,
  approval,
  candidatesRoot,
  now = new Date(),
  fault = null,
}) {
  const root = resolve(stateRoot);
  verifyApproval(preview, approval, now);
  return withBindingLock(root, preview.binding_id, () => {
    const state = readCleanupState(root, preview.transaction_id);
    if (
      state.status !== "approved" ||
      canonicalJson(state.preview) !== canonicalJson(preview) ||
      canonicalJson(state.approval) !== canonicalJson(approval)
    ) {
      throw new Error("cleanup approval 已使用或 transaction 已漂移");
    }
    const inspected = inspectCleanupTarget({
      stateRoot: root,
      sourceRunId: preview.source_run_id,
      candidateName: preview.candidate.relative_path,
      candidatesRoot,
      transactionId: preview.transaction_id,
    });
    if (
      rawSha256(inspected.sourceBytes) !== preview.source_state_sha256 ||
      fingerprintCandidatePath(inspected.candidate) !==
        preview.candidate.canonical_path_fingerprint ||
      inspected.manifest.tree_fingerprint !==
        preview.candidate.tree_fingerprint ||
      canonicalJson(inspected.manifest.entries) !==
        canonicalJson(state.manifest)
    ) {
      throw new Error("cleanup apply preflight 已漂移");
    }
    const attempt = {
      attempted_at: now.toISOString(),
      approval_fingerprint: approval.fingerprint,
      preview_fingerprint: preview.fingerprint,
    };
    state.status = "attempted";
    state.attempt = attempt;
    atomicWriteJson(cleanupStatePath(root, state.transaction_id), state);
    if (fault === "after-reserve") {
      throw new Error("injected cleanup fault after reserve");
    }
    const quarantineRoot = resolve(inspected.root, ".quarantine");
    if (existsSync(quarantineRoot)) {
      assertSafeDirectory(quarantineRoot, "cleanup quarantine root");
    } else {
      mkdirSync(quarantineRoot, { mode: 0o700 });
    }
    const quarantine = exactChild(
      quarantineRoot,
      state.transaction_id,
    );
    if (existsSync(quarantine)) {
      throw new Error("cleanup quarantine target 已存在");
    }
    renameSync(inspected.candidate, quarantine);
    state.status = "quarantined";
    state.quarantine = {
      relative_path: `.quarantine/${state.transaction_id}`,
    };
    atomicWriteJson(cleanupStatePath(root, state.transaction_id), state);
    if (fault === "after-rename") {
      throw new Error("injected cleanup fault after rename");
    }
    assertManifestExact(quarantine, state.manifest);
    try {
      rmSync(quarantine, { recursive: true, force: false });
    } catch (error) {
      state.status = "pending";
      atomicWriteJson(cleanupStatePath(root, state.transaction_id), state);
      throw error;
    }
    verifySourceUnchanged(root, state);
    state.status = "applied";
    state.proof = buildCleanupProof(state, new Date().toISOString());
    atomicWriteJson(cleanupStatePath(root, state.transaction_id), state);
    return clone(state.proof);
  });
}

function reconciliationDocument(state, status, observedAt, details) {
  const reconciliation = {
    schema_version: 1,
    action: "candidate_cleanup",
    transaction_id: state.transaction_id,
    source_run_id: state.source_run_id,
    approval_fingerprint: state.approval?.fingerprint ?? null,
    observed_at: observedAt,
    status,
    details,
  };
  validateDocument("cleanup-reconciliation", reconciliation);
  return reconciliation;
}

/** Reconciles an interrupted cleanup without repeating the approved apply. */
export function reconcileCleanup({
  stateRoot,
  transactionId,
  candidatesRoot,
  finish = false,
  now = new Date(),
}) {
  const root = resolve(stateRoot);
  const initial = readCleanupState(root, transactionId);
  return withBindingLock(root, initial.binding_id, () => {
    const state = readCleanupState(root, transactionId);
    if (state.status === "applied") {
      return clone(state.proof);
    }
    if (!["attempted", "quarantined", "pending"].includes(state.status)) {
      throw new Error("cleanup transaction 尚未嘗試或已進入終止狀態");
    }
    verifySourceUnchanged(root, state);
    const candidates = resolve(candidatesRoot ?? resolve(root, "candidates"));
    assertSafeDirectory(candidates, "candidates root");
    const original = exactChild(
      candidates,
      state.preview.candidate.relative_path,
    );
    const quarantineRoot = resolve(candidates, ".quarantine");
    if (existsSync(quarantineRoot)) {
      assertSafeDirectory(quarantineRoot, "cleanup quarantine root");
    }
    const quarantine = exactChild(quarantineRoot, state.transaction_id);
    const originalExists = existsSync(original);
    const quarantineExists = existsSync(quarantine);
    let reconciliation;
    if (
      originalExists &&
      !quarantineExists &&
      state.status === "attempted"
    ) {
      assertManifestExact(original, state.manifest);
      reconciliation = reconciliationDocument(
        state,
        "not_applied",
        now.toISOString(),
        "The reserved attempt did not move the exact candidate.",
      );
      state.status = "not_applied";
    } else if (!originalExists && quarantineExists) {
      assertManifestSubset(quarantine, state.manifest);
      if (!finish) {
        reconciliation = reconciliationDocument(
          state,
          "pending",
          now.toISOString(),
          "The exact candidate is quarantined; explicit finish is required.",
        );
        state.status = "pending";
      } else {
        rmSync(quarantine, { recursive: true, force: false });
        state.status = "applied";
        state.proof = buildCleanupProof(state, now.toISOString());
        reconciliation = reconciliationDocument(
          state,
          "applied",
          now.toISOString(),
          "The same transaction finished deletion from quarantine.",
        );
      }
    } else if (
      !originalExists &&
      !quarantineExists &&
      ["quarantined", "pending"].includes(state.status)
    ) {
      state.status = "applied";
      state.proof = buildCleanupProof(state, now.toISOString());
      reconciliation = reconciliationDocument(
        state,
        "applied",
        now.toISOString(),
        "The attempted transaction already removed the quarantined candidate.",
      );
    } else {
      reconciliation = reconciliationDocument(
        state,
        "blocked",
        now.toISOString(),
        "Observed cleanup paths do not prove a legal state transition.",
      );
      state.status = "blocked";
    }
    state.reconciliations.push(reconciliation);
    atomicWriteJson(cleanupStatePath(root, state.transaction_id), state);
    return state.proof === undefined
      ? clone(reconciliation)
      : clone(state.proof);
  });
}

export { readCleanupState };
