#!/usr/bin/env node
/**
 * Local deterministic Agent Skill Maintainer CLI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fingerprint,
  loadProviderProfiles,
  SCHEMA_NAMES,
  selectTargets,
  validateDocument,
} from "./lib/core.mjs";
import {
  buildForwardEvaluationBinding,
  validatePrReadyValidation,
} from "./lib/evaluation.mjs";
import {
  applyGithubAction,
  buildGithubActionApproval,
  buildGithubActionPreview,
  inspectGithubRepositoryCapabilities,
  inspectGithubActionState,
  reconcileGithubAction,
  verifyExistingFork,
  validateBranchPushLocalState,
} from "./lib/github.mjs";
import {
  fingerprintCandidatePath,
  fingerprintTree,
} from "./lib/git.mjs";
import {
  applyLocalUpdate,
  buildLocalUpdateApproval,
  buildLocalUpdatePreview,
  reconcileLocalUpdate,
  validateLocalUpdatePreflight,
} from "./lib/update.mjs";
import {
  authorizeLocalUpdateApply,
  authorizeLocalUpdateReconcile,
  authorizeGithubActionReconcile,
  createPublicationContinuation,
  createRun,
  readRun,
  recordLocalUpdateOutcome,
  recordGithubActionReconciliation,
  reserveLocalUpdateApply,
  reserveGithubActionApply,
  transitionRun,
} from "./lib/state.mjs";
import {
  applyCleanup,
  approveCleanup,
  previewCleanup,
  reconcileCleanup,
} from "./lib/cleanup.mjs";
import {
  buildBlindedAdjudication,
  buildBlindedMeasurement,
  deriveBlindedForwardAggregate,
} from "./lib/evaluation.mjs";

const DEFAULT_STATE_ROOT = resolve(homedir(), ".agent-skill-maintainer");

/** Creates one immutable command contract for parsing and discovery. */
function commandSpec({
  category,
  summary,
  arguments: argumentNames = [],
  required: requiredNames = [],
  repeatable = [],
  sideEffect = "none",
  naturalLanguagePolicy = "direct-read-only",
}) {
  return Object.freeze({
    category,
    summary,
    arguments: Object.freeze(argumentNames),
    required: Object.freeze(requiredNames),
    repeatable: Object.freeze(repeatable),
    side_effect: sideEffect,
    natural_language_policy: naturalLanguagePolicy,
  });
}

/** Single owner for accepted commands, arguments, help, and intent safety. */
export const COMMAND_REGISTRY = Object.freeze({
  help: commandSpec({
    category: "discovery",
    summary: "List every deterministic command or inspect one command.",
    arguments: ["command"],
  }),
  target: commandSpec({
    category: "analysis",
    summary: "Select an explicit target or list evidence-backed candidates.",
    arguments: ["explicit", "candidate"],
    repeatable: ["explicit", "candidate"],
  }),
  start: commandSpec({
    category: "run",
    summary: "Create one bound local maintenance run.",
    arguments: [
      "state-root",
      "run-id",
      "binding-id",
      "skill",
      "skill-path",
      "repository",
    ],
    required: ["run-id", "binding-id", "skill", "skill-path"],
    sideEffect: "local-state",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  status: commandSpec({
    category: "run",
    summary: "Read one run without persisting compatibility migration.",
    arguments: ["state-root", "run-id"],
    required: ["run-id"],
  }),
  transition: commandSpec({
    category: "run",
    summary: "Advance one run through a legal lifecycle transition.",
    arguments: [
      "state-root",
      "run-id",
      "phase",
      "updates",
      "candidate",
    ],
    required: ["run-id", "phase"],
    sideEffect: "local-state",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "publication-continue": commandSpec({
    category: "run",
    summary: "Create a bounded post-merge publication continuation.",
    arguments: [
      "state-root",
      "source-run-id",
      "run-id",
      "binding-id",
      "merge-proof",
    ],
    required: [
      "source-run-id",
      "run-id",
      "binding-id",
      "merge-proof",
    ],
    sideEffect: "local-state",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  validate: commandSpec({
    category: "analysis",
    summary: "Validate one JSON document against a public schema.",
    arguments: ["schema", "input"],
    required: ["schema", "input"],
  }),
  "github-inspect": commandSpec({
    category: "github",
    summary: "Inspect repository capabilities without a remote write.",
    arguments: ["repository", "inspected-at"],
    required: ["repository"],
  }),
  "github-preview": commandSpec({
    category: "github",
    summary: "Build a state-bound preview for one GitHub action.",
    arguments: ["action", "state", "candidate"],
    required: ["action", "state"],
    naturalLanguagePolicy: "direct-preview",
  }),
  "github-fork-verify": commandSpec({
    category: "github",
    summary: "Verify an existing personal Fork without creating one.",
    arguments: ["state"],
    required: ["state"],
  }),
  "github-approve": commandSpec({
    category: "github",
    summary: "Create an expiring approval after exact user confirmation.",
    arguments: ["preview", "confirmed-at", "expires-at"],
    required: ["preview", "confirmed-at", "expires-at"],
    sideEffect: "local-approval",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "github-apply": commandSpec({
    category: "github",
    summary: "Apply one approved GitHub action from its active run.",
    arguments: [
      "state-root",
      "run-id",
      "preview",
      "approval",
      "candidate",
    ],
    required: ["run-id", "preview", "approval"],
    sideEffect: "remote-write",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "github-reconcile": commandSpec({
    category: "github",
    summary: "Reconcile one previously attempted GitHub action.",
    arguments: [
      "state-root",
      "run-id",
      "preview",
      "approval",
    ],
    required: ["run-id", "preview", "approval"],
    sideEffect: "local-state",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "update-preview": commandSpec({
    category: "update",
    summary: "Preview an exact post-release local Skill update.",
    arguments: ["state", "binding", "installed"],
    required: ["state", "binding", "installed"],
    naturalLanguagePolicy: "direct-preview",
  }),
  "update-approve": commandSpec({
    category: "update",
    summary: "Create an expiring local-update approval.",
    arguments: ["preview", "confirmed-at", "expires-at"],
    required: ["preview", "confirmed-at", "expires-at"],
    sideEffect: "local-approval",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "update-apply": commandSpec({
    category: "update",
    summary: "Atomically apply one approved exact Release update.",
    arguments: [
      "state-root",
      "run-id",
      "preview",
      "approval",
      "binding",
      "installed",
    ],
    required: [
      "run-id",
      "preview",
      "approval",
      "binding",
      "installed",
    ],
    sideEffect: "local-installation",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "update-reconcile": commandSpec({
    category: "update",
    summary: "Reconcile one previously attempted local update.",
    arguments: [
      "state-root",
      "run-id",
      "preview",
      "approval",
      "binding",
      "installed",
    ],
    required: [
      "run-id",
      "preview",
      "approval",
      "binding",
      "installed",
    ],
    sideEffect: "local-state",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "cleanup-preview": commandSpec({
    category: "cleanup",
    summary: "Preview cleanup for one exact eligible candidate.",
    arguments: [
      "state-root",
      "source-run-id",
      "candidate",
      "candidates-root",
      "previewed-at",
    ],
    required: ["source-run-id", "candidate"],
    sideEffect: "local-state",
    naturalLanguagePolicy: "direct-preview",
  }),
  "cleanup-approve": commandSpec({
    category: "cleanup",
    summary: "Create an expiring candidate-cleanup approval.",
    arguments: [
      "state-root",
      "preview",
      "confirmed-at",
      "expires-at",
    ],
    required: ["preview", "confirmed-at", "expires-at"],
    sideEffect: "local-approval",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "cleanup-apply": commandSpec({
    category: "cleanup",
    summary: "Quarantine and remove one approved exact candidate.",
    arguments: [
      "state-root",
      "preview",
      "approval",
      "candidates-root",
    ],
    required: ["preview", "approval"],
    sideEffect: "candidate-deletion",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "cleanup-reconcile": commandSpec({
    category: "cleanup",
    summary: "Reconcile one existing candidate-cleanup transaction.",
    arguments: [
      "state-root",
      "transaction-id",
      "candidates-root",
      "finish",
    ],
    required: ["transaction-id"],
    sideEffect: "candidate-deletion",
    naturalLanguagePolicy: "explicit-confirmation-only",
  }),
  "eval-measure": commandSpec({
    category: "evaluation",
    summary: "Build objective blinded A/B measurements.",
    arguments: [
      "fixture",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
      "measured-at",
    ],
    required: [
      "fixture",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
    ],
  }),
  "eval-adjudicate": commandSpec({
    category: "evaluation",
    summary: "Build blinded adjudication from private bound sources.",
    arguments: [
      "fixture",
      "assignment",
      "sessions",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
      "judge-output",
      "measurement",
      "unblinded-at",
    ],
    required: [
      "fixture",
      "assignment",
      "sessions",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
      "judge-output",
      "measurement",
      "unblinded-at",
    ],
  }),
  "eval-derive": commandSpec({
    category: "evaluation",
    summary: "Derive a forward aggregate from validated private sources.",
    arguments: [
      "fixture",
      "adjudication",
      "measurement",
      "candidate-skill",
      "platform-validation",
      "private-source-manifest-sha256",
    ],
    required: [
      "fixture",
      "adjudication",
      "measurement",
      "candidate-skill",
      "platform-validation",
      "private-source-manifest-sha256",
    ],
  }),
  "eval-bind": commandSpec({
    category: "evaluation",
    summary: "Build the complete self-contained forward binding.",
    arguments: [
      "candidate-snapshot",
      "candidate",
      "fixture",
      "assignment",
      "sessions",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
      "judge-output",
      "measured-at",
      "unblinded-at",
      "platform-validation",
      "evaluator-attestation",
    ],
    required: [
      "candidate-snapshot",
      "candidate",
      "fixture",
      "assignment",
      "sessions",
      "label-a-output",
      "label-a-events",
      "label-b-output",
      "label-b-events",
      "judge-output",
      "measured-at",
      "unblinded-at",
      "platform-validation",
      "evaluator-attestation",
    ],
  }),
});

/** Returns stable machine-readable help without internal Set objects. */
function commandHelp(command = null) {
  const selected = command === null
    ? Object.entries(COMMAND_REGISTRY)
    : [[command, COMMAND_REGISTRY[command]]];
  if (selected[0][1] === undefined) {
    throw new Error(`未知命令：${command}`);
  }
  const commands = selected.map(([name, spec]) => ({
    name,
    category: spec.category,
    summary: spec.summary,
    arguments: spec.arguments.map((argument) => ({
      name: argument,
      required: spec.required.includes(argument),
      repeatable: spec.repeatable.includes(argument),
    })),
    side_effect: spec.side_effect,
    natural_language_policy: spec.natural_language_policy,
  }));
  return {
    schema_version: 1,
    capability_scope: "selected-agent-skill-maintenance-only",
    non_goals: [
      "general-codebase-maintenance",
      "general-repository-publication",
      "arbitrary-workflow-orchestration",
    ],
    command_count: commands.length,
    commands,
  };
}

/** Parses one command and rejects unknown or ambiguous arguments. */
function parseArguments(argv) {
  const [rawCommand, ...tokens] = argv;
  const command = rawCommand === "--help" ? "help" : rawCommand;
  const spec = COMMAND_REGISTRY[command];
  if (spec === undefined) {
    throw new Error("未知或缺少命令");
  }
  const values = {};
  const repeated = Object.fromEntries(
    spec.repeatable.map((name) => [name, []]),
  );
  const repeatable = new Set(spec.repeatable);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw new Error(`不合法參數：${token}`);
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`參數缺少值：--${name}`);
    }
    index += 1;
    if (repeatable.has(name)) {
      repeated[name].push(value);
    } else {
      if (Object.hasOwn(values, name)) {
        throw new Error(`參數不可重複：--${name}`);
      }
      values[name] = value;
    }
  }
  const allowed = new Set(spec.arguments);
  const supplied = [
    ...Object.keys(values),
    ...Object.keys(repeated).filter((name) => repeated[name].length > 0),
  ];
  const unknown = supplied.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`未知參數：${unknown.map((name) => `--${name}`).join(", ")}`);
  }
  const missing = spec.required.filter(
    (name) =>
      (values[name] ?? repeated[name]?.[0] ?? "").length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `缺少必要參數：${missing.map((name) => `--${name}`).join(", ")}`,
    );
  }
  return { command, values, repeated };
}

/** Requires one non-empty option value. */
function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少必要參數：--${name}`);
  }
  return value;
}

/** Reads one JSON object from an explicit local file. */
function readJsonFile(path, label) {
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`無法讀取 ${label}`, { cause: error });
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} 必須是 JSON object`);
  }
  return document;
}

/** Executes one parsed deterministic command with optional test runners. */
function execute(
  { command, values, repeated },
  {
    githubRunner,
    gitRunner,
    temporaryRoot,
    homeDirectory,
    stateDirectory,
    claudeConfigDirectory,
  } = {},
) {
  if (command === "help") {
    return commandHelp(values.command ?? null);
  }
  if (command === "target") {
    return selectTargets({
      explicitTargets: repeated.explicit,
      evidenceCandidates: repeated.candidate,
      installedSkills: [],
    });
  }
  if (command === "start") {
    const target = {
      skill: required(values, "skill"),
      skill_path: required(values, "skill-path"),
    };
    if (values.repository !== undefined) {
      target.repository = values.repository;
    }
    return createRun(values["state-root"] ?? DEFAULT_STATE_ROOT, {
      runId: required(values, "run-id"),
      bindingId: required(values, "binding-id"),
      target,
    });
  }
  if (command === "status") {
    return readRun(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      required(values, "run-id"),
      { persistMigration: false },
    );
  }
  if (command === "transition") {
    const phase = required(values, "phase");
    if (
      !["branch_push", "publish_pr"].includes(phase) &&
      values.candidate !== undefined
    ) {
      throw new Error(
        "--candidate 只適用於 branch_push 或 publish_pr transition",
      );
    }
    const updates = values.updates === undefined
      ? {}
      : readJsonFile(values.updates, "lifecycle updates");
    return transitionRun(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      required(values, "run-id"),
      phase,
      {
        updates,
        candidatePath: ["branch_push", "publish_pr"].includes(phase)
          ? required(values, "candidate")
          : undefined,
      },
    );
  }
  if (command === "publication-continue") {
    return createPublicationContinuation(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      {
        sourceRunId: required(values, "source-run-id"),
        runId: required(values, "run-id"),
        bindingId: required(values, "binding-id"),
        mergeProof: readJsonFile(
          required(values, "merge-proof"),
          "Merge proof",
        ),
      },
      { githubRunner },
    );
  }
  if (command === "validate") {
    const schema = required(values, "schema");
    if (!SCHEMA_NAMES.includes(schema)) {
      throw new Error(`未知 schema：${schema}`);
    }
    const document = JSON.parse(readFileSync(required(values, "input"), "utf8"));
    validateDocument(schema, document);
    return { schema, valid: true };
  }
  if (command === "github-inspect") {
    return inspectGithubRepositoryCapabilities(
      required(values, "repository"),
      {
        runner: githubRunner,
        now:
          values["inspected-at"] === undefined
            ? new Date()
            : new Date(values["inspected-at"]),
      },
    );
  }
  if (command === "github-preview") {
    const action = required(values, "action");
    const state = readJsonFile(
      required(values, "state"),
      "GitHub action state",
    );
    if (["branch_push", "publish_pr"].includes(action)) {
      const candidate = required(values, "candidate");
      const pathFingerprint = fingerprintCandidatePath(candidate);
      const supplied =
        state.action_target?.candidate_path_fingerprint;
      if (supplied !== undefined && supplied !== pathFingerprint) {
        throw new Error(
          "GitHub action state 的 candidate path fingerprint 已漂移",
        );
      }
      if (
        state.action_target === null ||
        typeof state.action_target !== "object" ||
        Array.isArray(state.action_target)
      ) {
        throw new Error("branch push action_target 必須是 object");
      }
      state.action_target.candidate_path_fingerprint =
        pathFingerprint;
    } else if (values.candidate !== undefined) {
      throw new Error("--candidate 只適用於 branch_push 或 publish_pr");
    }
    return buildGithubActionPreview(
      action,
      state,
    );
  }
  if (command === "github-fork-verify") {
    return verifyExistingFork(
      readJsonFile(
        required(values, "state"),
        "GitHub Fork verification state",
      ),
      { runner: githubRunner },
    );
  }
  if (command === "github-approve") {
    return buildGithubActionApproval(
      readJsonFile(required(values, "preview"), "GitHub action preview"),
      {
        confirmedAt: required(values, "confirmed-at"),
        expiresAt: required(values, "expires-at"),
      },
    );
  }
  if (command === "github-apply") {
    const preview = readJsonFile(
      required(values, "preview"),
      "GitHub action preview",
    );
    const approval = readJsonFile(
      required(values, "approval"),
      "GitHub action approval",
    );
    const stateRoot = values["state-root"] ?? DEFAULT_STATE_ROOT;
    const runId = required(values, "run-id");
    let candidatePath;
    if (["branch_push", "publish_pr"].includes(preview.action)) {
      candidatePath = required(values, "candidate");
      const active = readRun(stateRoot, runId);
      validateBranchPushLocalState(
        preview,
        candidatePath,
        active.candidate_snapshot,
      );
      validatePrReadyValidation(
        active.validation_summary,
        active.candidate_snapshot,
        candidatePath,
      );
    } else if (values.candidate !== undefined) {
      throw new Error("--candidate 只適用於 branch_push 或 publish_pr");
    }
    if (preview.action === "fork_create") {
      inspectGithubActionState(preview, {
        runner: githubRunner,
      });
    }
    const reserved = reserveGithubActionApply(
      stateRoot,
      runId,
      preview,
      approval,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    const documentationImpact = reserved.validation_summary?.checks?.find(
      (check) => check?.category === "documentation",
    )?.details ?? null;
    if (["branch_push", "publish_pr"].includes(preview.action)) {
      validatePrReadyValidation(
        reserved.validation_summary,
        reserved.candidate_snapshot,
        candidatePath,
      );
    }
    const result = applyGithubAction(preview, approval, {
      candidatePath,
      candidateSnapshot: reserved.candidate_snapshot,
      documentationImpact,
      runner: githubRunner,
      gitRunner,
      temporaryRoot,
    });
    const reconciliation =
      result.reconciliation ??
      {
        schema_version: 1,
        action: preview.action,
        repository: preview.state.repository,
        approval_fingerprint: approval.fingerprint,
        preview_fingerprint: preview.fingerprint,
        observed_at: new Date().toISOString(),
        status: "applied",
        remote_state_hash: fingerprint(result.proof ?? result),
      };
    recordGithubActionReconciliation(
      stateRoot,
      runId,
      preview,
      approval,
      reconciliation,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    return result;
  }
  if (command === "github-reconcile") {
    const preview = readJsonFile(
      required(values, "preview"),
      "GitHub action preview",
    );
    const approval = readJsonFile(
      required(values, "approval"),
      "GitHub action approval",
    );
    const active = authorizeGithubActionReconcile(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      required(values, "run-id"),
      preview,
      approval,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    const documentationImpact = active.validation_summary?.checks?.find(
      (check) => check?.category === "documentation",
    )?.details ?? null;
    const attempt = active.github_action_attempts
      .filter(
        (item) =>
          item.action === preview.action &&
          item.approval_fingerprint === approval.fingerprint,
      )
      .at(-1);
    const result = reconcileGithubAction(preview, {
      documentationImpact,
      approvalFingerprint: approval.fingerprint,
      attemptedAt: attempt?.attempted_at,
      runner: githubRunner,
      gitRunner,
      temporaryRoot,
    });
    if (result.reconciliation !== undefined) {
      recordGithubActionReconciliation(
        values["state-root"] ?? DEFAULT_STATE_ROOT,
        required(values, "run-id"),
        preview,
        approval,
        result.reconciliation,
        {
          providerContractHash: fingerprint(loadProviderProfiles()),
        },
      );
    }
    return result;
  }
  if (command === "update-preview") {
    return buildLocalUpdatePreview(
      readJsonFile(
        required(values, "state"),
        "Local update state",
      ),
      readJsonFile(
        required(values, "binding"),
        "Local update binding",
      ),
      required(values, "installed"),
      {
        homeDirectory,
        runner: githubRunner,
        stateDirectory,
        claudeConfigDirectory,
      },
    );
  }
  if (command === "update-approve") {
    return buildLocalUpdateApproval(
      readJsonFile(
        required(values, "preview"),
        "Local update preview",
      ),
      {
        confirmedAt: required(values, "confirmed-at"),
        expiresAt: required(values, "expires-at"),
      },
    );
  }
  if (command === "update-apply") {
    const preview = readJsonFile(
      required(values, "preview"),
      "Local update preview",
    );
    const approval = readJsonFile(
      required(values, "approval"),
      "Local update approval",
    );
    const binding = readJsonFile(
      required(values, "binding"),
      "Local update binding",
    );
    const stateRoot = values["state-root"] ?? DEFAULT_STATE_ROOT;
    const runId = required(values, "run-id");
    const installedPath = required(values, "installed");
    authorizeLocalUpdateApply(
      stateRoot,
      runId,
      preview,
      approval,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    validateLocalUpdatePreflight(preview, approval, {
      binding,
      installedPath,
      homeDirectory,
      runner: githubRunner,
      stateDirectory,
      claudeConfigDirectory,
    });
    reserveLocalUpdateApply(
      stateRoot,
      runId,
      preview,
      approval,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    const result = applyLocalUpdate(preview, approval, {
      binding,
      installedPath,
      homeDirectory,
      runner: githubRunner,
      stateDirectory,
      claudeConfigDirectory,
    });
    recordLocalUpdateOutcome(
      stateRoot,
      runId,
      preview,
      approval,
      result,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    return result;
  }
  if (command === "update-reconcile") {
    const preview = readJsonFile(
      required(values, "preview"),
      "Local update preview",
    );
    const approval = readJsonFile(
      required(values, "approval"),
      "Local update approval",
    );
    const binding = readJsonFile(
      required(values, "binding"),
      "Local update binding",
    );
    const stateRoot = values["state-root"] ?? DEFAULT_STATE_ROOT;
    const runId = required(values, "run-id");
    authorizeLocalUpdateReconcile(
      stateRoot,
      runId,
      preview,
      approval,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    const result = reconcileLocalUpdate(preview, approval, {
      binding,
      installedPath: required(values, "installed"),
      homeDirectory,
      runner: githubRunner,
      stateDirectory,
      claudeConfigDirectory,
    });
    recordLocalUpdateOutcome(
      stateRoot,
      runId,
      preview,
      approval,
      result,
      {
        providerContractHash: fingerprint(loadProviderProfiles()),
      },
    );
    return result;
  }
  if (command === "cleanup-preview") {
    return previewCleanup({
      stateRoot: values["state-root"] ?? DEFAULT_STATE_ROOT,
      sourceRunId: required(values, "source-run-id"),
      candidateName: required(values, "candidate"),
      candidatesRoot: values["candidates-root"],
      previewedAt:
        values["previewed-at"] ?? new Date().toISOString(),
    });
  }
  if (command === "cleanup-approve") {
    return approveCleanup(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      readJsonFile(
        required(values, "preview"),
        "Candidate cleanup preview",
      ),
      {
        confirmedAt: required(values, "confirmed-at"),
        expiresAt: required(values, "expires-at"),
      },
    );
  }
  if (command === "cleanup-apply") {
    return applyCleanup({
      stateRoot: values["state-root"] ?? DEFAULT_STATE_ROOT,
      preview: readJsonFile(
        required(values, "preview"),
        "Candidate cleanup preview",
      ),
      approval: readJsonFile(
        required(values, "approval"),
        "Candidate cleanup approval",
      ),
      candidatesRoot: values["candidates-root"],
    });
  }
  if (command === "cleanup-reconcile") {
    const finish = values.finish ?? "false";
    if (!["true", "false"].includes(finish)) {
      throw new Error("--finish 只接受 true 或 false");
    }
    return reconcileCleanup({
      stateRoot: values["state-root"] ?? DEFAULT_STATE_ROOT,
      transactionId: required(values, "transaction-id"),
      candidatesRoot: values["candidates-root"],
      finish: finish === "true",
    });
  }
  if (command === "eval-measure") {
    return buildBlindedMeasurement({
      fixture: readJsonFile(
        required(values, "fixture"),
        "Held-out fixture",
      ),
      labelA: {
        output: readFileSync(
          required(values, "label-a-output"),
          "utf8",
        ),
        events: readFileSync(
          required(values, "label-a-events"),
          "utf8",
        ),
      },
      labelB: {
        output: readFileSync(
          required(values, "label-b-output"),
          "utf8",
        ),
        events: readFileSync(
          required(values, "label-b-events"),
          "utf8",
        ),
      },
      measuredAt: values["measured-at"] ?? new Date().toISOString(),
    });
  }
  if (command === "eval-adjudicate") {
    return buildBlindedAdjudication({
      fixture: readJsonFile(
        required(values, "fixture"),
        "Held-out fixture",
      ),
      assignment: readJsonFile(
        required(values, "assignment"),
        "Private A/B assignment",
      ),
      sessions: readJsonFile(
        required(values, "sessions"),
        "Private session metadata",
      ),
      labelOutputs: {
        a: readFileSync(
          required(values, "label-a-output"),
          "utf8",
        ),
        b: readFileSync(
          required(values, "label-b-output"),
          "utf8",
        ),
      },
      labelTranscripts: {
        a: readFileSync(
          required(values, "label-a-events"),
          "utf8",
        ),
        b: readFileSync(
          required(values, "label-b-events"),
          "utf8",
        ),
      },
      judgeOutput: readJsonFile(
        required(values, "judge-output"),
        "Private Judge output",
      ),
      measurement: readJsonFile(
        required(values, "measurement"),
        "Blinded measurement",
      ),
      unblindedAt: required(values, "unblinded-at"),
    });
  }
  if (command === "eval-derive") {
    const fixture = readJsonFile(
      required(values, "fixture"),
      "Held-out fixture",
    );
    return deriveBlindedForwardAggregate({
      adjudication: readJsonFile(
        required(values, "adjudication"),
        "Blinded adjudication",
      ),
      measurement: readJsonFile(
        required(values, "measurement"),
        "Blinded measurement",
      ),
      fixture,
      currentSkillFingerprint: fingerprintTree(
        required(values, "candidate-skill"),
      ),
      platformValidationSource: readJsonFile(
        required(values, "platform-validation"),
        "Private platform validation",
      ),
      privateSourceManifestSha256: required(
        values,
        "private-source-manifest-sha256",
      ),
    });
  }
  if (command === "eval-bind") {
    return buildForwardEvaluationBinding(
      readJsonFile(
        required(values, "candidate-snapshot"),
        "Candidate snapshot",
      ),
      {
        fixture: readJsonFile(
          required(values, "fixture"),
          "Locked evaluation fixture",
        ),
        assignment: readJsonFile(
          required(values, "assignment"),
          "Private A/B assignment",
        ),
        sessions: readJsonFile(
          required(values, "sessions"),
          "Private session metadata",
        ),
        labelA: {
          output: readFileSync(
            required(values, "label-a-output"),
            "utf8",
          ),
          events: readFileSync(
            required(values, "label-a-events"),
            "utf8",
          ),
        },
        labelB: {
          output: readFileSync(
            required(values, "label-b-output"),
            "utf8",
          ),
          events: readFileSync(
            required(values, "label-b-events"),
            "utf8",
          ),
        },
        judgeOutput: readJsonFile(
          required(values, "judge-output"),
          "Private Judge output",
        ),
        measuredAt: required(values, "measured-at"),
        unblindedAt: required(values, "unblinded-at"),
        platformValidationSource: readJsonFile(
          required(values, "platform-validation"),
          "Private platform validation",
        ),
        candidatePath: required(values, "candidate"),
        evaluatorAttestation: readJsonFile(
          required(values, "evaluator-attestation"),
          "Neutral evaluator attestation",
        ),
      },
    );
  }
  throw new Error(`未知命令：${command}`);
}

/** Parses and executes one command for CLI and contract-test parity. */
export function runMaintainerCommand(argv, dependencies = {}) {
  return execute(parseArguments(argv), dependencies);
}

/** Runs the CLI with machine-readable stdout and stderr. */
export function main(argv = process.argv.slice(2)) {
  let command = argv[0] ?? null;
  try {
    const result = runMaintainerCommand(argv);
    command = argv[0] ?? null;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        command,
        error: error.message,
        valid: false,
      })}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
