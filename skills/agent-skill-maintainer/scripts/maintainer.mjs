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
  applyGithubAction,
  buildGithubActionApproval,
  buildGithubActionPreview,
  reconcileGithubAction,
  validateBranchPushLocalState,
} from "./lib/github.mjs";
import { fingerprintCandidatePath } from "./lib/git.mjs";
import {
  authorizeGithubActionReconcile,
  createRun,
  readRun,
  recordGithubActionReconciliation,
  reserveGithubActionApply,
  transitionRun,
} from "./lib/state.mjs";

const DEFAULT_STATE_ROOT = resolve(homedir(), ".agent-skill-maintainer");

/** Parses one command and rejects unknown or ambiguous arguments. */
function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (
    ![
      "target",
      "start",
      "status",
      "transition",
      "validate",
      "github-preview",
      "github-approve",
      "github-apply",
      "github-reconcile",
    ].includes(command)
  ) {
    throw new Error("未知或缺少命令");
  }
  const values = {};
  const repeated = { explicit: [], candidate: [] };
  const repeatable =
    command === "target"
      ? new Set(["explicit", "candidate"])
      : new Set();
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
  const allowed = {
    target: new Set(["explicit", "candidate"]),
    start: new Set([
      "state-root",
      "run-id",
      "binding-id",
      "skill",
      "repository",
    ]),
    status: new Set(["state-root", "run-id"]),
    transition: new Set([
      "state-root",
      "run-id",
      "phase",
      "updates",
    ]),
    validate: new Set(["schema", "input"]),
    "github-preview": new Set(["action", "state", "candidate"]),
    "github-approve": new Set([
      "preview",
      "confirmed-at",
      "expires-at",
    ]),
    "github-apply": new Set([
      "state-root",
      "run-id",
      "preview",
      "approval",
      "candidate",
    ]),
    "github-reconcile": new Set([
      "state-root",
      "run-id",
      "preview",
      "approval",
    ]),
  }[command];
  const supplied = [
    ...Object.keys(values),
    ...Object.keys(repeated).filter((name) => repeated[name].length > 0),
  ];
  const unknown = supplied.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`未知參數：${unknown.map((name) => `--${name}`).join(", ")}`);
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
  } = {},
) {
  if (command === "target") {
    return selectTargets({
      explicitTargets: repeated.explicit,
      evidenceCandidates: repeated.candidate,
      installedSkills: [],
    });
  }
  if (command === "start") {
    const target = { skill: required(values, "skill") };
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
    );
  }
  if (command === "transition") {
    const updates = values.updates === undefined
      ? {}
      : readJsonFile(values.updates, "lifecycle updates");
    return transitionRun(
      values["state-root"] ?? DEFAULT_STATE_ROOT,
      required(values, "run-id"),
      required(values, "phase"),
      { updates },
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
  if (command === "github-preview") {
    const action = required(values, "action");
    const state = readJsonFile(
      required(values, "state"),
      "GitHub action state",
    );
    if (action === "branch_push") {
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
      throw new Error("--candidate 只適用於 branch_push");
    }
    return buildGithubActionPreview(
      action,
      state,
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
    if (preview.action === "branch_push") {
      candidatePath = required(values, "candidate");
      const active = readRun(stateRoot, runId);
      validateBranchPushLocalState(
        preview,
        candidatePath,
        active.candidate_snapshot,
      );
    } else if (values.candidate !== undefined) {
      throw new Error("--candidate 只適用於 branch_push");
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
    return applyGithubAction(preview, approval, {
      candidatePath,
      candidateSnapshot: reserved.candidate_snapshot,
      documentationImpact,
      runner: githubRunner,
      gitRunner,
      temporaryRoot,
    });
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
    const result = reconcileGithubAction(preview, {
      documentationImpact,
      approvalFingerprint: approval.fingerprint,
      runner: githubRunner,
      gitRunner,
      temporaryRoot,
    });
    if (result.status === "not_applied") {
      recordGithubActionReconciliation(
        values["state-root"] ?? DEFAULT_STATE_ROOT,
        required(values, "run-id"),
        preview,
        approval,
        result.absence_proof,
        {
          providerContractHash: fingerprint(loadProviderProfiles()),
        },
      );
    }
    return result;
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
