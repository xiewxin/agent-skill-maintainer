/**
 * State-bound GitHub mutation previews.
 */

import {
  ApprovalDriftError,
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  validateDocument,
} from "./core.mjs";
import { verifyReleaseNoteCoverageProof } from "./git.mjs";

const ACTIONS = new Set([
  "pr_create",
  "pr_update",
  "merge",
  "release",
  "local_update",
]);
const STATE_FIELDS = Object.freeze([
  "run_id",
  "binding_id",
  "account",
  "repository",
  "relationship",
  "base_branch",
  "head_branch",
  "head_commit",
  "diff_hash",
  "action_target",
  "release_enabled",
  "provider_contract_hash",
]);
const ACCOUNT_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/** Validates and normalizes a complete GitHub action state. */
function normalizePreview(action, state) {
  if (!ACTIONS.has(action)) {
    throw new Error("GitHub action 不合法");
  }
  const missing = STATE_FIELDS.filter((name) => !Object.hasOwn(state, name));
  const unknown = Object.keys(state)
    .filter((name) => !STATE_FIELDS.includes(name))
    .sort();
  if (missing.length > 0) {
    throw new Error(`GitHub preview 缺少欄位：${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`GitHub preview 含未知欄位：${unknown.join(", ")}`);
  }
  if (
    typeof state.run_id !== "string" ||
    state.run_id.length === 0 ||
    /\s/u.test(state.run_id)
  ) {
    throw new Error("run_id 格式不合法");
  }
  if (typeof state.account !== "string" || !ACCOUNT_PATTERN.test(state.account)) {
    throw new Error("GitHub account 格式不合法");
  }
  if (
    typeof state.binding_id !== "string" ||
    state.binding_id.length === 0 ||
    /\s/u.test(state.binding_id)
  ) {
    throw new Error("binding_id 格式不合法");
  }
  if (
    typeof state.repository !== "string" ||
    !REPOSITORY_PATTERN.test(state.repository)
  ) {
    throw new Error("GitHub repository 格式不合法");
  }
  if (!["managed", "contribute", "analyze-only"].includes(state.relationship)) {
    throw new Error("relationship 不合法");
  }
  for (const name of [
    "base_branch",
    "head_branch",
    "head_commit",
    "diff_hash",
    "provider_contract_hash",
  ]) {
    const value = state[name];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("-") ||
      /\s/u.test(value)
    ) {
      throw new Error(`${name} 格式不合法`);
    }
  }
  if (!isObject(state.action_target) || Object.keys(state.action_target).length === 0) {
    throw new Error("action_target 必須是非空 object");
  }
  if (typeof state.release_enabled !== "boolean") {
    throw new Error("release_enabled 必須是 boolean");
  }
  if (state.relationship === "analyze-only") {
    throw new Error("analyze-only 不可建立 GitHub 寫入預覽");
  }
  if (["merge", "release"].includes(action) && state.relationship !== "managed") {
    throw new Error("只有 managed 倉庫可合併或發布");
  }
  if (action === "release" && state.release_enabled !== true) {
    throw new Error("release_enabled=false，不可建立發布預覽");
  }
  if (action === "release") {
    if (
      typeof state.action_target.version !== "string" ||
      !/^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
        state.action_target.version,
      )
    ) {
      throw new Error("Release version 必須是 SemVer");
    }
    const coverage = verifyReleaseNoteCoverageProof(
      state.action_target.release_note_coverage,
    );
    if (coverage.candidate_commit !== state.head_commit) {
      throw new Error("Release 說明對帳的候選提交已漂移");
    }
  }
  return {
    schema_version: 1,
    action,
    state: Object.fromEntries(
      STATE_FIELDS.map((name) => [name, clone(state[name])]),
    ),
  };
}

/** Builds a stable preview without performing a remote write. */
export function buildGithubActionPreview(action, state) {
  const preview = normalizePreview(action, state);
  preview.fingerprint = fingerprint(preview);
  return preview;
}

/** Verifies that a preview still matches the current action state. */
export function verifyGithubActionPreview(preview, action, state) {
  const current = buildGithubActionPreview(action, state);
  if (canonicalJson(preview) !== canonicalJson(current)) {
    throw new ApprovalDriftError(
      "GitHub 動作狀態已改變，必須重新預覽與確認",
    );
  }
  return true;
}

/** Builds one expiring confirmation bound to an exact GitHub action preview. */
export function buildGithubActionApproval(
  preview,
  { confirmedAt, expiresAt },
) {
  if (!isObject(preview) || !isObject(preview.state)) {
    throw new Error("GitHub action preview 不合法");
  }
  const unsignedPreview = clone(preview);
  delete unsignedPreview.fingerprint;
  if (fingerprint(unsignedPreview) !== preview.fingerprint) {
    throw new Error("GitHub action preview fingerprint 不一致");
  }
  const confirmed = Date.parse(confirmedAt);
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(confirmed) ||
    !Number.isFinite(expires) ||
    expires <= confirmed
  ) {
    throw new Error("GitHub action approval 時間範圍不合法");
  }
  const state = preview.state;
  const approval = {
    schema_version: 1,
    action: preview.action,
    preview_fingerprint: preview.fingerprint,
    run_id: state.run_id,
    binding_id: state.binding_id,
    account: state.account,
    repository: state.repository,
    relationship: state.relationship,
    base_branch: state.base_branch,
    head_branch: state.head_branch,
    head_commit: state.head_commit,
    diff_hash: state.diff_hash,
    action_target_hash: fingerprint(state.action_target),
    release_enabled: state.release_enabled,
    provider_contract_hash: state.provider_contract_hash,
    confirmed_at: new Date(confirmed).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
  approval.fingerprint = fingerprint(approval);
  validateDocument("github-action-approval", approval);
  return approval;
}

/** Verifies action identity, current preview state, and confirmation expiry. */
export function verifyGithubActionApproval(
  approval,
  preview,
  { now = new Date() } = {},
) {
  validateDocument("github-action-approval", approval);
  const current = buildGithubActionApproval(preview, {
    confirmedAt: approval.confirmed_at,
    expiresAt: approval.expires_at,
  });
  if (canonicalJson(current) !== canonicalJson(approval)) {
    throw new ApprovalDriftError(
      "GitHub 動作確認與目前預覽不一致，必須重新確認",
    );
  }
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(currentTime)) {
    throw new Error("approval 驗證時間不合法");
  }
  if (currentTime >= Date.parse(approval.expires_at)) {
    throw new ApprovalDriftError("GitHub 動作確認已過期");
  }
  return true;
}

/** Refuses remote writes until the deterministic apply milestone is complete. */
export function applyGithubAction(_preview) {
  throw new Error("目前里程碑只支援 GitHub dry-run 預覽");
}
