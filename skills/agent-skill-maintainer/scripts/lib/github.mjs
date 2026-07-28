/**
 * State-bound GitHub mutation previews.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalDriftError,
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  redactText,
  validateDocument,
} from "./core.mjs";
import {
  createIsolatedGitTransport,
  isCommitAncestor,
  pushGithubBranch,
  readGithubRemoteBranch,
  validateBranchPushCandidate,
  verifyReleaseNoteCoverageProof,
} from "./git.mjs";

const ACTIONS = new Set([
  "fork_create",
  "branch_push",
  "publish_pr",
  "pr_create",
  "pr_update",
  "merge",
  "release",
]);
const STATE_FIELDS = Object.freeze([
  "run_id",
  "binding_id",
  "account",
  "repository",
  "relationship",
  "base_branch",
  "base_commit",
  "head_branch",
  "head_commit",
  "diff_hash",
  "action_target",
  "capability_proof",
  "provider_contract_hash",
]);
const ACCOUNT_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const MANAGED_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const FORK_PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/** Carries the deterministic reconcile status for a Fork observation failure. */
class ForkObservationError extends ApprovalDriftError {
  constructor(message, reconciliationStatus) {
    super(message);
    this.name = "ForkObservationError";
    this.reconciliationStatus = reconciliationStatus;
  }
}

/** Runs GitHub CLI without shell expansion or an interactive prompt. */
function defaultRunner(arguments_, { environment = {} } = {}) {
  return spawnSync("gh", arguments_, {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...environment,
    },
    shell: false,
    windowsHide: true,
  });
}

/** Returns trimmed stdout or raises a bounded GitHub CLI error. */
function runGithub(runner, arguments_, options = {}) {
  const result = runner(arguments_, options);
  if (
    !isObject(result) ||
    !Number.isInteger(result.status) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error("GitHub runner 回傳格式不合法");
  }
  if (result.status !== 0) {
    const summary = redactText(
      result.stderr.trim().split(/\r?\n/u)[0] || "unknown error",
    );
    throw new Error(`GitHub CLI 執行失敗：${summary}`);
  }
  return result.stdout.trim();
}

/** Builds a fingerprinted capability proof from read-only GitHub evidence. */
export function buildGithubCapabilityProof({
  account,
  repository,
  permission,
  defaultBranch,
  immutableReleases,
  inspectedAt,
}) {
  if (
    typeof account !== "string" ||
    !ACCOUNT_PATTERN.test(account) ||
    typeof repository !== "string" ||
    !REPOSITORY_PATTERN.test(repository) ||
    !["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission) ||
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0 ||
    typeof immutableReleases !== "boolean" ||
    !Number.isFinite(Date.parse(inspectedAt))
  ) {
    throw new Error("GitHub capability evidence 格式不合法");
  }
  const relationship = MANAGED_PERMISSIONS.has(permission)
    ? "managed"
    : "contribute";
  const proof = {
    schema_version: 1,
    account,
    repository,
    permission,
    default_branch: defaultBranch,
    relationship,
    immutable_releases: immutableReleases,
    release_enabled:
      relationship === "managed" && immutableReleases === true,
    inspected_at: new Date(Date.parse(inspectedAt)).toISOString(),
  };
  proof.fingerprint = fingerprint(proof);
  validateDocument("github-capability-proof", proof);
  return proof;
}

/** Inspects repository relationship and Release capability without writes. */
export function inspectGithubRepositoryCapabilities(
  repository,
  {
    runner = defaultRunner,
    now = new Date(),
  } = {},
) {
  if (
    typeof repository !== "string" ||
    !REPOSITORY_PATTERN.test(repository)
  ) {
    throw new Error("GitHub repository 格式不合法");
  }
  const account = runGithub(runner, ["api", "user", "--jq", ".login"]);
  const observed = parseGithubJson(
    runGithub(runner, [
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,viewerPermission,defaultBranchRef",
    ]),
    "GitHub repository capability",
  );
  if (
    observed.nameWithOwner?.toLowerCase() !== repository.toLowerCase() ||
    typeof observed.defaultBranchRef?.name !== "string"
  ) {
    throw new ApprovalDriftError(
      "GitHub repository capability identity 不一致",
    );
  }
  const immutability = parseGithubJson(
    runGithub(runner, [
      "api",
      `repos/${repository}/immutable-releases`,
    ]),
    "GitHub Release immutability",
  );
  const inspectedAt = now instanceof Date
    ? now.toISOString()
    : new Date(now).toISOString();
  return buildGithubCapabilityProof({
    account,
    repository: observed.nameWithOwner,
    permission: observed.viewerPermission,
    defaultBranch: observed.defaultBranchRef.name,
    immutableReleases: immutability.enabled === true,
    inspectedAt,
  });
}

/** Verifies proof integrity without trusting caller-derived booleans. */
function validateCapabilityProof(proof) {
  validateDocument("github-capability-proof", proof);
  const current = buildGithubCapabilityProof({
    account: proof.account,
    repository: proof.repository,
    permission: proof.permission,
    defaultBranch: proof.default_branch,
    immutableReleases: proof.immutable_releases,
    inspectedAt: proof.inspected_at,
  });
  if (canonicalJson(current) !== canonicalJson(proof)) {
    throw new ApprovalDriftError(
      "GitHub capability proof fingerprint 不一致",
    );
  }
  return proof;
}

/** Classifies one attempted Fork POST without exposing an unredacted error. */
function runForkCreateRequest(runner, arguments_) {
  const result = runner(arguments_);
  if (
    !isObject(result) ||
    !Number.isInteger(result.status) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    return {
      status: "pending",
      reason: "GitHub Fork 建立回應不完整",
    };
  }
  if (result.status === 0) {
    return { status: "accepted", reason: null };
  }
  const summary = redactText(
    result.stderr.trim().split(/\r?\n/u)[0] || "unknown error",
  );
  if (/\b4[0-9]{2}\b/u.test(summary)) {
    return {
      status: "blocked",
      reason: `GitHub 明確拒絕 Fork 建立：${summary}`,
    };
  }
  return {
    status: "pending",
    reason: `GitHub Fork 建立結果不確定：${summary}`,
  };
}

/** Returns the validated branch-push target from one preview. */
function branchPushTarget(preview) {
  const target = preview.state.action_target;
  const headRepository = headRepositoryForPreview(preview);
  if (preview.state.head_branch === preview.state.base_branch) {
    throw new Error("branch push head branch 不得等於 base branch");
  }
  if (
    typeof target.candidate_path_fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(target.candidate_path_fingerprint)
  ) {
    throw new Error("branch push candidate path fingerprint 不合法");
  }
  if (
    target.expected_remote_commit !== null &&
    (typeof target.expected_remote_commit !== "string" ||
      !COMMIT_PATTERN.test(target.expected_remote_commit))
  ) {
    throw new Error("branch push expected remote commit 不合法");
  }
  const expectedOperation =
    target.expected_remote_commit === null
      ? "create"
      : target.expected_remote_commit === preview.state.head_commit
        ? "verify-existing"
        : "fast-forward";
  if (target.operation !== expectedOperation) {
    throw new Error("branch push operation 與遠端前態不一致");
  }
  const expectedFields = [
    "candidate_path_fingerprint",
    "expected_remote_commit",
    "head_repository",
    "operation",
    ...(preview.action === "publish_pr"
      ? ["title", "body", "draft"]
      : []),
  ];
  const unknown = Object.keys(target)
    .filter((name) => !expectedFields.includes(name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`branch push target 含未知欄位：${unknown.join(", ")}`);
  }
  if (preview.action === "publish_pr") {
    textField(target, "title");
    textField(target, "body", { allowEmpty: true });
    if (typeof target.draft !== "boolean") {
      throw new Error("action_target.draft 必須是 boolean");
    }
  }
  return {
    candidatePathFingerprint: target.candidate_path_fingerprint,
    expectedRemoteCommit: target.expected_remote_commit,
    headRepository,
    operation: target.operation,
  };
}

/** Returns the immutable personal Fork target from one preview. */
function forkTarget(preview) {
  const target = preview.state.action_target;
  if (preview.state.relationship !== "contribute") {
    throw new Error("fork_create 只適用於 contribute 關係");
  }
  const repositoryName = preview.state.repository.split("/")[1];
  const expectedRepository = `${preview.state.account}/${repositoryName}`;
  if (
    typeof target.fork_repository !== "string" ||
    !REPOSITORY_PATTERN.test(target.fork_repository) ||
    target.fork_repository.toLowerCase() !==
      expectedRepository.toLowerCase()
  ) {
    throw new Error(
      "Fork destination 必須是 active account 的同名個人倉庫",
    );
  }
  if (target.default_branch_only !== true) {
    throw new Error("Fork 第一版必須使用 default_branch_only=true");
  }
  if (!["create", "reuse"].includes(target.operation)) {
    throw new Error("Fork operation 必須是 create 或 reuse");
  }
  const expectedFields = [
    "fork_repository",
    "default_branch_only",
    "operation",
  ];
  const unknown = Object.keys(target)
    .filter((name) => !expectedFields.includes(name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`Fork target 含未知欄位：${unknown.join(", ")}`);
  }
  return {
    forkRepository: target.fork_repository,
    defaultBranchOnly: true,
    operation: target.operation,
  };
}

/** Returns the immutable GitHub HTTPS URL for one verified repository. */
function githubRemoteUrl(repository) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("GitHub repository 格式不合法");
  }
  return `https://github.com/${repository}.git`;
}

/** Runs one operation with a temporary Git config owned by GitHub CLI. */
function withTemporaryGithubGitConfig(
  runner,
  operation,
  {
    temporaryRoot = tmpdir(),
    sourceRepository = null,
  } = {},
) {
  const root = mkdtempSync(
    join(temporaryRoot, "agent-skill-maintainer-git-"),
  );
  const gitConfigGlobal = join(root, "gitconfig");
  try {
    runGithub(
      runner,
      ["auth", "setup-git", "--hostname", "github.com"],
      {
        environment: {
          GIT_CONFIG_GLOBAL: gitConfigGlobal,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    const temporaryRepository = createIsolatedGitTransport(root, {
      sourceRepository,
      gitConfigGlobal,
    });
    return operation({ gitConfigGlobal, temporaryRepository });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Builds a schema-valid proof after an exact remote ref observation. */
function buildBranchPushProof(preview) {
  const target = branchPushTarget(preview);
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    head_repository: target.headRepository,
    relationship: preview.state.relationship,
    base_branch: preview.state.base_branch,
    base_commit: preview.state.base_commit,
    branch: preview.state.head_branch,
    commit: preview.state.head_commit,
    candidate_diff_hash: preview.state.diff_hash,
    previous_remote_commit: target.expectedRemoteCommit,
    operation: target.operation,
    forced: false,
    verified: true,
  };
  validateDocument("branch-push-proof", proof);
  return proof;
}

/** Revalidates one candidate without performing remote access. */
export function validateBranchPushLocalState(
  preview,
  candidatePath,
  candidateSnapshot,
) {
  if (!["branch_push", "publish_pr"].includes(preview.action)) {
    throw new Error("只有 branch_push 或 publish_pr 需要 candidate preflight");
  }
  const target = branchPushTarget(preview);
  if (
    preview.state.base_branch !==
      candidateSnapshot?.repository_snapshot?.base_ref ||
    preview.state.base_commit !==
      candidateSnapshot?.repository_snapshot?.merge_base ||
    preview.state.head_commit !==
      candidateSnapshot?.repository_snapshot?.head_commit ||
    preview.state.diff_hash !== candidateSnapshot?.candidate_diff_hash
  ) {
    throw new ApprovalDriftError(
      "branch push preview 與 candidate snapshot 不一致",
    );
  }
  return validateBranchPushCandidate(
    candidatePath,
    candidateSnapshot,
    {
      candidatePathFingerprint: target.candidatePathFingerprint,
      branch: preview.state.head_branch,
    },
  );
}

/** Parses one JSON object emitted by GitHub CLI. */
function parseGithubJson(value, label) {
  let document;
  try {
    document = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 回傳無效 JSON`, { cause: error });
  }
  if (!isObject(document)) {
    throw new Error(`${label} 必須回傳 JSON object`);
  }
  return document;
}

/** Parses one JSON array emitted by GitHub CLI. */
function parseGithubArray(value, label) {
  let document;
  try {
    document = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} 回傳無效 JSON`, { cause: error });
  }
  if (!Array.isArray(document)) {
    throw new Error(`${label} 必須回傳 JSON array`);
  }
  return document;
}

/** Reads an optional GitHub JSON object and treats only a real 404 as absent. */
function readOptionalGithubJson(runner, arguments_, label) {
  const result = runner(arguments_);
  if (
    !isObject(result) ||
    !Number.isInteger(result.status) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error("GitHub runner 回傳格式不合法");
  }
  if (result.status === 0) {
    return parseGithubJson(result.stdout.trim(), label);
  }
  const summary = redactText(
    result.stderr.trim().split(/\r?\n/u)[0] || "unknown error",
  );
  if (
    /(?:\b404\b|^not found(?:\b|:)|could not resolve to a repository)/iu.test(
      summary,
    )
  ) {
    return null;
  }
  throw new Error(`GitHub CLI 執行失敗：${summary}`);
}

/** Verifies one personal Fork repository against the approved destination. */
function validatePersonalForkRepository(
  repository,
  { forkRepository, upstreamRepository },
) {
  if (
    repository.nameWithOwner?.toLowerCase() !==
      forkRepository.toLowerCase()
  ) {
    throw new ForkObservationError(
      "Fork repository identity 已漂移",
      "drifted",
    );
  }
  if (
    repository.parent?.nameWithOwner?.toLowerCase() !==
      upstreamRepository.toLowerCase()
  ) {
    throw new ForkObservationError(
      "Fork parent 與核准上游不一致",
      "drifted",
    );
  }
  if (!MANAGED_PERMISSIONS.has(repository.viewerPermission)) {
    throw new ForkObservationError(
      "Fork permission 不足以推送分支",
      "blocked",
    );
  }
  return repository;
}

/** Reads and validates the expected personal Fork and base commit. */
function readForkObservation(preview, runner) {
  const target = forkTarget(preview);
  const repository = readOptionalGithubJson(
    runner,
    [
      "repo",
      "view",
      target.forkRepository,
      "--json",
      "nameWithOwner,viewerPermission,parent",
    ],
    "GitHub Fork repository",
  );
  if (repository === null) {
    return {
      exists: false,
      base_commit_available: false,
    };
  }
  validatePersonalForkRepository(repository, {
    forkRepository: target.forkRepository,
    upstreamRepository: preview.state.repository,
  });
  const commit = readOptionalGithubJson(
    runner,
    [
      "api",
      `repos/${target.forkRepository}/commits/${preview.state.base_commit}`,
      "--jq",
      "{sha: .sha}",
    ],
    "GitHub Fork base commit",
  );
  return {
    exists: true,
    base_commit_available:
      commit?.sha === preview.state.base_commit,
  };
}

/** Builds one verified Fork proof after the destination is observable. */
function buildForkProof(preview, observation) {
  if (
    observation?.exists !== true ||
    observation.base_commit_available !== true
  ) {
    throw new Error("Fork 尚未具備可驗證的基準提交");
  }
  const target = forkTarget(preview);
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    fork_repository: target.forkRepository,
    account: preview.state.account,
    relationship: "contribute",
    base_branch: preview.state.base_branch,
    base_commit: preview.state.base_commit,
    default_branch_only: true,
    operation: target.operation,
    parent_repository: preview.state.repository,
    base_commit_available: true,
    verified: true,
  };
  validateDocument("fork-proof", proof);
  return proof;
}

/** Requires a non-empty bounded text field. */
function textField(target, name, { allowEmpty = false } = {}) {
  const value = target[name];
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > 65536
  ) {
    throw new Error(`action_target.${name} 格式不合法`);
  }
  return value;
}

/** Requires a positive Pull Request number. */
function pullRequestNumber(target) {
  if (!Number.isInteger(target.pr_number) || target.pr_number <= 0) {
    throw new Error("action_target.pr_number 格式不合法");
  }
  return target.pr_number;
}

/** Validates one exact mutation target and returns its gh argument list. */
function buildMutationArguments(preview) {
  const { action, state } = preview;
  const target = state.action_target;
  if (["pr_create", "publish_pr"].includes(action)) {
    const headRepository = headRepositoryForPreview(preview);
    if (typeof target.draft !== "boolean") {
      throw new Error("action_target.draft 必須是 boolean");
    }
    const head = headRepository.toLowerCase() === state.repository.toLowerCase()
      ? state.head_branch
      : `${headRepository.split("/")[0]}:${state.head_branch}`;
    const arguments_ = [
      "pr",
      "create",
      "--repo",
      state.repository,
      "--base",
      state.base_branch,
      "--head",
      head,
      "--title",
      textField(target, "title"),
      "--body",
      textField(target, "body", { allowEmpty: true }),
    ];
    if (target.draft) {
      arguments_.push("--draft");
    }
    return arguments_;
  }
  if (action === "pr_update") {
    return [
      "pr",
      "edit",
      String(pullRequestNumber(target)),
      "--repo",
      state.repository,
      "--title",
      textField(target, "title"),
      "--body",
      textField(target, "body", { allowEmpty: true }),
    ];
  }
  if (action === "merge") {
    const method = target.method;
    if (!["squash", "merge", "rebase"].includes(method)) {
      throw new Error("action_target.method 格式不合法");
    }
    return [
      "pr",
      "merge",
      String(pullRequestNumber(target)),
      "--repo",
      state.repository,
      `--${method}`,
      "--match-head-commit",
      state.head_commit,
    ];
  }
  if (action === "release") {
    if (
      typeof target.draft !== "boolean" ||
      typeof target.prerelease !== "boolean"
    ) {
      throw new Error("Release draft／prerelease 必須是 boolean");
    }
    const arguments_ = [
      "release",
      "create",
      target.version,
      "--repo",
      state.repository,
      "--target",
      state.head_commit,
      "--title",
      textField(target, "title"),
      "--notes",
      textField(target, "notes", { allowEmpty: true }),
    ];
    if (target.draft) {
      arguments_.push("--draft");
    }
    if (target.prerelease) {
      arguments_.push("--prerelease");
    }
    return arguments_;
  }
  throw new Error(`${action} 尚未提供確定性 apply`);
}

/** Returns the head repository whose branch must match the approved commit. */
function headRepositoryForPreview(preview) {
  const candidate = preview.state.action_target.head_repository;
  if (candidate === undefined) {
    if (preview.state.relationship === "contribute") {
      throw new Error(
        "contribute PR 必須提供 action_target.head_repository",
      );
    }
    return preview.state.repository;
  }
  if (typeof candidate !== "string" || !REPOSITORY_PATTERN.test(candidate)) {
    throw new Error("action_target.head_repository 格式不合法");
  }
  if (
    preview.state.relationship === "contribute" &&
    candidate.split("/")[0].toLowerCase() !==
      preview.state.account.toLowerCase()
  ) {
    throw new ApprovalDriftError(
      "contribute PR 的 head repository 必須由 active account 擁有",
    );
  }
  if (
    preview.state.relationship === "managed" &&
    candidate.toLowerCase() !== preview.state.repository.toLowerCase()
  ) {
    throw new ApprovalDriftError(
      "managed Pull Request 必須使用同一 repository 的 head branch",
    );
  }
  return candidate;
}

/** Builds one redacted reconciliation record for a prior remote attempt. */
function buildActionReconciliationResult(
  preview,
  approvalFingerprint,
  remoteState,
  status,
  now,
) {
  if (
    typeof approvalFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(approvalFingerprint)
  ) {
    throw new Error("GitHub reconcile 缺少 approval fingerprint");
  }
  const observedAt = now instanceof Date
    ? now.toISOString()
    : new Date(now).toISOString();
  if (
    !["not_applied", "partial", "pending", "blocked", "drifted"].includes(status)
  ) {
    throw new Error("GitHub reconcile status 不合法");
  }
  const reconciliation = {
    schema_version: 1,
    action: preview.action,
    repository: preview.state.repository,
    approval_fingerprint: approvalFingerprint,
    preview_fingerprint: preview.fingerprint,
    observed_at: observedAt,
    status,
    remote_state_hash: fingerprint(remoteState),
  };
  validateDocument("github-action-reconciliation", reconciliation);
  const result = {
    action: preview.action,
    repository: preview.state.repository,
    status,
    reconciliation,
  };
  if (status === "pending") {
    result.guidance =
      preview.action === "publish_pr"
        ? "分支已驗證推送，但 PR 尚不可觀察；稍後唯讀 reconcile，不得重放複合動作或建立新 PR"
        : "稍後執行唯讀 github-reconcile；不得重送 Fork 建立 POST";
  } else if (status === "blocked") {
    result.guidance =
      "需要人工調查阻擋原因；不得重送 Fork 建立 POST";
  } else if (status === "drifted") {
    result.guidance =
      "重新確認帳號、上游與目的地關係；不得沿用目前預覽";
  } else if (status === "partial") {
    result.guidance =
      "分支已驗證推送且唯讀核對已證明 PR 不存在；可另行確認 pr_create 補完，不得重放複合動作";
  }
  if (status === "not_applied") {
    result.absence_proof = reconciliation;
  }
  return result;
}

/** Builds a redacted absence proof for one previously attempted action. */
function buildNotAppliedResult(
  preview,
  approvalFingerprint,
  remoteState,
  now,
) {
  return buildActionReconciliationResult(
    preview,
    approvalFingerprint,
    remoteState,
    "not_applied",
    now,
  );
}

/** Reads the exact release and tag state for one version. */
function readReleaseAvailability(preview, runner) {
  const [owner, name] = preview.state.repository.split("/");
  const version = preview.state.action_target.version;
  return parseGithubJson(
    runGithub(runner, [
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!,$name:String!,$tag:String!,$ref:String!){repository(owner:$owner,name:$name){release(tagName:$tag){tagName} ref(qualifiedName:$ref){name}}}",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-f",
      `tag=${version}`,
      "-f",
      `ref=refs/tags/${version}`,
      "--jq",
      ".data.repository",
    ]),
    "GitHub Release availability",
  );
}

/** Returns the exact release and tag state before publication. */
function inspectReleaseAvailability(preview, runner) {
  const state = readReleaseAvailability(preview, runner);
  if (state.release !== null || state.ref !== null) {
    throw new ApprovalDriftError("Release tag 或 GitHub Release 已存在");
  }
  const immutability = parseGithubJson(
    runGithub(runner, [
      "api",
      `repos/${preview.state.repository}/immutable-releases`,
    ]),
    "GitHub Release immutability",
  );
  if (immutability.enabled !== true) {
    throw new ApprovalDriftError("GitHub Release immutability 尚未啟用");
  }
}

/** Verifies that the created Release and tag point to the approved commit. */
function verifyCreatedRelease(preview, output, runner) {
  const version = preview.state.action_target.version;
  const release = parseGithubJson(
    runGithub(runner, [
      "release",
      "view",
      version,
      "--repo",
      preview.state.repository,
      "--json",
      "tagName,targetCommitish,url,isDraft,isPrerelease",
    ]),
    "GitHub Release",
  );
  const tagCommit = runGithub(runner, [
    "api",
    `repos/${preview.state.repository}/commits/${encodeURIComponent(version)}`,
    "--jq",
    ".sha",
  ]);
  if (
    release.tagName !== version ||
    release.targetCommitish !== preview.state.head_commit ||
    release.url !== output ||
    release.isDraft !== preview.state.action_target.draft ||
    release.isPrerelease !== preview.state.action_target.prerelease ||
    tagCommit !== preview.state.head_commit
  ) {
    throw new ApprovalDriftError(
      "GitHub Release 或 tag 未指向核准的 commit",
    );
  }
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    version,
    tag: version,
    commit: tagCommit,
    release_url: release.url,
    official: true,
  };
  validateDocument("publication-proof", proof);
  return proof;
}

/** Verifies an open Pull Request after creation or metadata update. */
function buildOpenPullRequestProof(
  preview,
  output,
  documentationImpact,
  pullRequest,
) {
  if (!isObject(documentationImpact)) {
    throw new Error("Pull Request apply 缺少 documentation impact");
  }
  let number = preview.state.action_target.pr_number;
  if (["pr_create", "publish_pr"].includes(preview.action)) {
    const match = output.match(/\/pull\/(?<number>[1-9][0-9]*)$/u);
    number = Number(match?.groups?.number);
  }
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Pull Request apply 未取得有效 PR number");
  }
  const expectedHeadRepository = headRepositoryForPreview(preview);
  const checks = Array.isArray(pullRequest.statusCheckRollup)
    ? pullRequest.statusCheckRollup
    : [];
  const checksPassed =
    checks.length > 0 &&
    checks.every((check) => {
      const conclusion = check?.conclusion ?? check?.state;
      return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
    });
  if (
    pullRequest.number !== number ||
    pullRequest.baseRefName !== preview.state.base_branch ||
    pullRequest.headRefOid !== preview.state.head_commit ||
    pullRequest.state !== "OPEN" ||
    pullRequest.headRepository?.nameWithOwner?.toLowerCase() !==
      expectedHeadRepository.toLowerCase() ||
    pullRequest.title !== preview.state.action_target.title ||
    pullRequest.body !== preview.state.action_target.body ||
    (
      ["pr_create", "publish_pr"].includes(preview.action) &&
      pullRequest.isDraft !== preview.state.action_target.draft
    ) ||
    (
      ["pr_create", "publish_pr"].includes(preview.action) &&
      pullRequest.url !== output
    )
  ) {
    throw new ApprovalDriftError(
      "GitHub Pull Request postcondition 與核准目標不一致",
    );
  }
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    number,
    head_commit: pullRequest.headRefOid,
    base_branch: pullRequest.baseRefName,
    state: "open",
    checks_passed: checksPassed,
    documentation_impact: clone(documentationImpact),
  };
  validateDocument("pr-proof", proof);
  return proof;
}

/** Reads one Pull Request with the complete postcondition field set. */
function readOpenPullRequest(preview, number, runner) {
  return parseGithubJson(
    runGithub(runner, [
      "pr",
      "view",
      String(number),
      "--repo",
      preview.state.repository,
      "--json",
      "number,url,baseRefName,headRefName,headRefOid,headRepository,state,isDraft,statusCheckRollup,title,body",
    ]),
    "GitHub Pull Request postcondition",
  );
}

/** Verifies an open Pull Request after creation or metadata update. */
function verifyOpenPullRequest(
  preview,
  output,
  runner,
  documentationImpact,
) {
  const number = ["pr_create", "publish_pr"].includes(preview.action)
    ? Number(output.match(/\/pull\/(?<number>[1-9][0-9]*)$/u)?.groups?.number)
    : preview.state.action_target.pr_number;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Pull Request apply 未取得有效 PR number");
  }
  const pullRequest = readOpenPullRequest(preview, number, runner);
  return buildOpenPullRequestProof(
    preview,
    output,
    documentationImpact,
    pullRequest,
  );
}

/** Finds the exact created Pull Request when mutation output was interrupted. */
function reconcileCreatedPullRequest(
  preview,
  runner,
  documentationImpact,
) {
  const expectedHeadRepository = headRepositoryForPreview(preview);
  const pullRequests = parseGithubArray(
    runGithub(runner, [
      "pr",
      "list",
      "--repo",
      preview.state.repository,
      "--state",
      "all",
      "--base",
      preview.state.base_branch,
      "--head",
      preview.state.head_branch,
      "--limit",
      "10",
      "--json",
      "number,url,baseRefName,headRefName,headRefOid,headRepository,state,isDraft,statusCheckRollup,title,body",
    ]),
    "GitHub Pull Request reconcile",
  );
  const identityMatches = pullRequests.filter(
    (pullRequest) =>
      pullRequest.baseRefName === preview.state.base_branch &&
      pullRequest.headRefName === preview.state.head_branch &&
      pullRequest.headRefOid === preview.state.head_commit &&
      pullRequest.headRepository?.nameWithOwner?.toLowerCase() ===
        expectedHeadRepository.toLowerCase(),
  );
  if (identityMatches.length !== 1) {
    if (identityMatches.length > 1) {
      throw new ApprovalDriftError(
        "無法唯一識別已建立的 GitHub Pull Request",
      );
    }
    const owner = expectedHeadRepository.split("/")[0];
    const restPullRequests = parseGithubArray(
      runGithub(runner, [
        "api",
        "--method",
        "GET",
        `repos/${preview.state.repository}/pulls`,
        "-f",
        "state=all",
        "-f",
        `head=${owner}:${preview.state.head_branch}`,
        "-f",
        `base=${preview.state.base_branch}`,
      ]),
      "GitHub REST Pull Request reconcile",
    );
    const restIdentityMatches = restPullRequests.filter(
      (pullRequest) =>
        pullRequest.base?.ref === preview.state.base_branch &&
        pullRequest.head?.ref === preview.state.head_branch &&
        pullRequest.head?.sha === preview.state.head_commit &&
        pullRequest.head?.repo?.full_name?.toLowerCase() ===
          expectedHeadRepository.toLowerCase(),
    );
    if (restIdentityMatches.length > 1) {
      throw new ApprovalDriftError(
        "無法唯一識別 REST Pull Request reconcile 結果",
      );
    }
    if (restIdentityMatches.length === 1) {
      const pullRequest = restIdentityMatches[0];
      if (
        pullRequest.title !== preview.state.action_target.title ||
        pullRequest.body !== preview.state.action_target.body ||
        pullRequest.draft !== preview.state.action_target.draft
      ) {
        throw new ApprovalDriftError(
          "GitHub Pull Request metadata 已漂移",
        );
      }
      const normalized = {
        number: pullRequest.number,
        url: pullRequest.html_url,
        baseRefName: pullRequest.base.ref,
        headRefName: pullRequest.head.ref,
        headRefOid: pullRequest.head.sha,
        headRepository: {
          nameWithOwner: pullRequest.head.repo.full_name,
        },
        state: String(pullRequest.state).toUpperCase(),
        isDraft: pullRequest.draft,
        statusCheckRollup: [],
        title: pullRequest.title,
        body: pullRequest.body,
      };
      return {
        status: "applied",
        proof: buildOpenPullRequestProof(
          preview,
          normalized.url,
          documentationImpact,
          normalized,
        ),
      };
    }
    return {
      status: "not_applied",
      remote_state: {
        gh_cli_matches: 0,
        rest_matches: 0,
        head_repository: expectedHeadRepository,
        head_branch: preview.state.head_branch,
        head_commit: preview.state.head_commit,
      },
    };
  }
  if (
    identityMatches[0].title !== preview.state.action_target.title ||
    identityMatches[0].body !== preview.state.action_target.body ||
    identityMatches[0].isDraft !== preview.state.action_target.draft
  ) {
    throw new ApprovalDriftError(
      "GitHub Pull Request metadata 已漂移",
    );
  }
  return {
    status: "applied",
    proof: buildOpenPullRequestProof(
      preview,
      identityMatches[0].url,
      documentationImpact,
      identityMatches[0],
    ),
  };
}

/** Builds a merge proof from one freshly read Pull Request. */
function buildMergeProof(preview, pullRequest) {
  const number = pullRequestNumber(preview.state.action_target);
  const mergeCommit = pullRequest.mergeCommit?.oid;
  if (
    pullRequest.number !== number ||
    pullRequest.baseRefName !== preview.state.base_branch ||
    pullRequest.state !== "MERGED" ||
    typeof pullRequest.mergedAt !== "string" ||
    typeof mergeCommit !== "string" ||
    mergeCommit.length === 0
  ) {
    throw new ApprovalDriftError(
      "GitHub merge postcondition 與核准目標不一致",
    );
  }
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    pr_number: number,
    merge_commit: mergeCommit,
    default_branch: pullRequest.baseRefName,
  };
  validateDocument("merge-proof", proof);
  return proof;
}

/** Verifies the merged Pull Request and returns its merge proof. */
function verifyMergedPullRequest(preview, runner) {
  const number = pullRequestNumber(preview.state.action_target);
  const pullRequest = parseGithubJson(
    runGithub(runner, [
      "pr",
      "view",
      String(number),
      "--repo",
      preview.state.repository,
      "--json",
      "number,baseRefName,state,mergedAt,mergeCommit",
    ]),
    "GitHub merged Pull Request",
  );
  return buildMergeProof(preview, pullRequest);
}

/** Re-reads the active account, repository permission, and mutation target. */
export function inspectGithubActionState(
  preview,
  {
    runner = defaultRunner,
    allowBaseCommitDrift = false,
    allowForkDestination = false,
  } = {},
) {
  const current = buildGithubActionPreview(preview.action, preview.state);
  if (canonicalJson(current) !== canonicalJson(preview)) {
    throw new ApprovalDriftError("GitHub 動作預覽 fingerprint 已漂移");
  }
  const capability = validateCapabilityProof(
    preview.state.capability_proof,
  );
  const account = runGithub(runner, ["api", "user", "--jq", ".login"]);
  if (
    account !== preview.state.account ||
    account !== capability.account
  ) {
    throw new ApprovalDriftError(
      `GitHub active account 已改變：預期 ${preview.state.account}`,
    );
  }
  const repository = parseGithubJson(
    runGithub(runner, [
      "repo",
      "view",
      preview.state.repository,
      "--json",
      "nameWithOwner,viewerPermission,defaultBranchRef",
    ]),
    "GitHub repository",
  );
  if (
    repository.nameWithOwner?.toLowerCase() !==
      preview.state.repository.toLowerCase() ||
    repository.defaultBranchRef?.name !== preview.state.base_branch ||
    repository.nameWithOwner?.toLowerCase() !==
      capability.repository.toLowerCase() ||
    repository.defaultBranchRef?.name !== capability.default_branch
  ) {
    throw new ApprovalDriftError("GitHub repository 或 base branch 已漂移");
  }
  if (
    preview.state.relationship === "managed" &&
    !MANAGED_PERMISSIONS.has(repository.viewerPermission)
  ) {
    throw new ApprovalDriftError("GitHub repository 寫入權限已漂移");
  }
  if (
    preview.state.relationship === "contribute" &&
    MANAGED_PERMISSIONS.has(repository.viewerPermission)
  ) {
    throw new ApprovalDriftError(
      "GitHub repository 關係已由 contribute 漂移為 managed",
    );
  }
  if (repository.viewerPermission !== capability.permission) {
    throw new ApprovalDriftError(
      "GitHub repository permission 與 capability proof 不一致",
    );
  }
  if (preview.action === "fork_create") {
    const target = forkTarget(preview);
    const observation = readForkObservation(preview, runner);
    if (
      target.operation === "create" &&
      allowForkDestination !== true &&
      observation.exists
    ) {
      throw new ApprovalDriftError(
        "個人 Fork 已存在，必須重新預覽為 reuse",
      );
    }
    if (
      target.operation === "reuse" &&
      (
        observation.exists !== true ||
        observation.base_commit_available !== true
      )
    ) {
      throw new ApprovalDriftError(
        "reuse Fork 尚未具備核准的基準提交",
      );
    }
  }
  if (
    ["branch_push", "publish_pr"].includes(preview.action) &&
    preview.state.relationship === "contribute"
  ) {
    const headRepository = headRepositoryForPreview(preview);
    let fork;
    try {
      fork = parseGithubJson(
        runGithub(runner, [
          "repo",
          "view",
          headRepository,
          "--json",
          "nameWithOwner,viewerPermission,parent",
        ]),
        "GitHub fork repository",
      );
    } catch (error) {
      throw new ApprovalDriftError(
        "contribute Fork 不存在或無法驗證；請先完成 fork_create 或既有 Fork 驗證",
        { cause: error },
      );
    }
    validatePersonalForkRepository(fork, {
      forkRepository: headRepository,
      upstreamRepository: preview.state.repository,
    });
  }
  let baseCommit;
  if (allowBaseCommitDrift !== true) {
    baseCommit = runGithub(runner, [
      "api",
      `repos/${preview.state.repository}/branches/${encodeURIComponent(
        preview.state.base_branch,
      )}`,
      "--jq",
      ".commit.sha",
    ]);
    if (baseCommit !== preview.state.base_commit) {
      throw new ApprovalDriftError("GitHub base branch commit 已漂移");
    }
  }

  if (preview.action === "pr_create") {
    const repositoryName = headRepositoryForPreview(preview);
    const commit = runGithub(runner, [
      "api",
      `repos/${repositoryName}/commits/${encodeURIComponent(
        preview.state.head_branch,
      )}`,
      "--jq",
      ".sha",
    ]);
    if (commit !== preview.state.head_commit) {
      throw new ApprovalDriftError("GitHub head branch commit 已漂移");
    }
  }

  if (["pr_update", "merge"].includes(preview.action)) {
    const number = pullRequestNumber(preview.state.action_target);
    const pullRequest = parseGithubJson(
      runGithub(runner, [
        "pr",
        "view",
        String(number),
        "--repo",
        preview.state.repository,
        "--json",
        "baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,state,isDraft,mergeable,statusCheckRollup",
      ]),
      "GitHub Pull Request",
    );
    const expectedHeadRepository = headRepositoryForPreview(preview);
    if (
      pullRequest.baseRefName !== preview.state.base_branch ||
      pullRequest.headRefName !== preview.state.head_branch ||
      pullRequest.headRefOid !== preview.state.head_commit ||
      pullRequest.state !== "OPEN"
    ) {
      throw new ApprovalDriftError("GitHub Pull Request 狀態已漂移");
    }
    if (
      pullRequest.headRepository?.nameWithOwner?.toLowerCase() !==
        expectedHeadRepository.toLowerCase()
    ) {
      throw new ApprovalDriftError(
        "Pull Request head repository 已漂移",
      );
    }
    if (
      preview.state.relationship === "contribute" &&
      pullRequest.headRepositoryOwner?.login?.toLowerCase() !==
        preview.state.account.toLowerCase()
    ) {
      throw new ApprovalDriftError("contribute Pull Request owner 已漂移");
    }
    if (preview.action === "merge") {
      const checks = Array.isArray(pullRequest.statusCheckRollup)
        ? pullRequest.statusCheckRollup
        : [];
      const failed = checks.some((check) => {
        const conclusion = check?.conclusion ?? check?.state;
        return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
      });
      if (
        pullRequest.isDraft === true ||
        pullRequest.mergeable !== "MERGEABLE" ||
        failed
      ) {
        throw new ApprovalDriftError("GitHub Pull Request 尚未符合合併條件");
      }
    }
  }

  if (preview.action === "release") {
    const commit = runGithub(runner, [
      "api",
      `repos/${preview.state.repository}/commits/${preview.state.head_commit}`,
      "--jq",
      ".sha",
    ]);
    if (commit !== preview.state.head_commit) {
      throw new ApprovalDriftError("Release target commit 已漂移");
    }
    if (baseCommit !== preview.state.head_commit) {
      throw new ApprovalDriftError("Release target 不是目前 default branch commit");
    }
    inspectReleaseAvailability(preview, runner);
  }
  return clone(preview.state);
}

/** Verifies an existing personal Fork without creating a remote mutation. */
export function verifyExistingFork(
  state,
  { runner = defaultRunner } = {},
) {
  const preview = buildGithubActionPreview("fork_create", state);
  if (forkTarget(preview).operation !== "reuse") {
    throw new Error("既有 Fork 驗證必須使用 operation=reuse");
  }
  inspectGithubActionState(preview, { runner });
  return buildForkProof(
    preview,
    readForkObservation(preview, runner),
  );
}

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
    "base_commit",
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
  const capability = validateCapabilityProof(state.capability_proof);
  if (
    capability.account !== state.account ||
    capability.repository.toLowerCase() !== state.repository.toLowerCase() ||
    capability.default_branch !== state.base_branch ||
    capability.relationship !== state.relationship
  ) {
    throw new Error("GitHub capability proof 與 action state 不一致");
  }
  if (state.relationship === "analyze-only") {
    throw new Error("analyze-only 不可建立 GitHub 寫入預覽");
  }
  if (["pr_create", "publish_pr", "pr_update"].includes(action)) {
    headRepositoryForPreview({ state });
  }
  if (action === "fork_create") {
    forkTarget({ action, state });
  }
  if (["branch_push", "publish_pr"].includes(action)) {
    branchPushTarget({ action, state });
  }
  if (["merge", "release"].includes(action) && state.relationship !== "managed") {
    throw new Error("只有 managed 倉庫可合併或發布");
  }
  if (action === "release" && capability.release_enabled !== true) {
    throw new Error("GitHub capability proof 不允許建立發布預覽");
  }
  if (action === "release") {
    if (
      state.action_target.draft !== false ||
      typeof state.action_target.prerelease !== "boolean" ||
      typeof state.action_target.version !== "string" ||
      !/^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(
        state.action_target.version,
      )
    ) {
      throw new Error(
        "Release 必須是非 draft，且 version 必須符合 SemVer",
      );
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
    expires <= confirmed ||
    expires - confirmed > MAX_APPROVAL_TTL_MS
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
    base_commit: state.base_commit,
    head_branch: state.head_branch,
    head_commit: state.head_commit,
    diff_hash: state.diff_hash,
    action_target_hash: fingerprint(state.action_target),
    capability_fingerprint: state.capability_proof.fingerprint,
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
  { now = new Date(), requireFresh = true } = {},
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
  if (requireFresh !== true) {
    return true;
  }
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(currentTime)) {
    throw new Error("approval 驗證時間不合法");
  }
  if (
    Date.parse(approval.confirmed_at) >
    currentTime + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    throw new ApprovalDriftError("GitHub 動作確認時間位於未來");
  }
  if (currentTime >= Date.parse(approval.expires_at)) {
    throw new ApprovalDriftError("GitHub 動作確認已過期");
  }
  return true;
}

/** Applies one exact branch push through an isolated Git transport. */
function applyBranchPush(
  preview,
  {
    runner,
    gitRunner,
    candidatePath,
    candidateSnapshot,
    temporaryRoot,
  },
) {
  const local = validateBranchPushLocalState(
    preview,
    candidatePath,
    candidateSnapshot,
  );
  inspectGithubActionState(preview, { runner });
  const target = branchPushTarget(preview);
  const remoteUrl = githubRemoteUrl(target.headRepository);
  const proof = withTemporaryGithubGitConfig(
    runner,
    ({ gitConfigGlobal, temporaryRepository }) => {
      const before = readGithubRemoteBranch(
        temporaryRepository,
        {
          remoteUrl,
          branch: preview.state.head_branch,
          gitConfigGlobal,
          runner: gitRunner,
        },
      );
      if (before !== target.expectedRemoteCommit) {
        throw new ApprovalDriftError(
          "GitHub branch push 遠端前態已漂移",
        );
      }
      if (
        target.operation === "fast-forward" &&
        !isCommitAncestor(
          local.candidate_path,
          target.expectedRemoteCommit,
          preview.state.head_commit,
          { runner: gitRunner },
        )
      ) {
        throw new ApprovalDriftError(
          "GitHub branch push 不是 fast-forward",
        );
      }
      if (target.operation !== "verify-existing") {
        pushGithubBranch(
          temporaryRepository,
          {
            remoteUrl,
            branch: preview.state.head_branch,
            headCommit: preview.state.head_commit,
            expectedRemoteCommit: target.expectedRemoteCommit,
            gitConfigGlobal,
            runner: gitRunner,
          },
        );
      }
      const after = readGithubRemoteBranch(
        temporaryRepository,
        {
          remoteUrl,
          branch: preview.state.head_branch,
          gitConfigGlobal,
          runner: gitRunner,
        },
      );
      if (after !== preview.state.head_commit) {
        throw new Error(
          "GitHub branch push postcondition 未指向核准提交",
        );
      }
      return buildBranchPushProof(preview);
    },
    {
      temporaryRoot,
      sourceRepository: local.candidate_path,
    },
  );
  return {
    action: "branch_push",
    repository: preview.state.repository,
    proof,
  };
}

/** Projects the Pull Request half of one compound publish preview. */
function publishPrPullRequestPreview(preview) {
  if (preview.action !== "publish_pr") {
    throw new Error("只有 publish_pr 可建立 PR 子預覽");
  }
  const target = preview.state.action_target;
  return buildGithubActionPreview("pr_create", {
    ...clone(preview.state),
    action_target: {
      head_repository: target.head_repository,
      title: target.title,
      body: target.body,
      draft: target.draft,
    },
  });
}

/** Builds the proof for a fully applied or push-only compound action. */
function buildPublishPrProof(
  preview,
  branchPushProof,
  prProof = null,
) {
  validateDocument("branch-push-proof", branchPushProof);
  if (prProof !== null) {
    validateDocument("pr-proof", prProof);
  }
  const proof = {
    schema_version: 1,
    repository: preview.state.repository,
    status: prProof === null ? "partial" : "applied",
    branch_push_proof: clone(branchPushProof),
    pr_proof: prProof === null ? null : clone(prProof),
    verified: true,
  };
  validateDocument("publish-pr-proof", proof);
  return proof;
}

/** Returns a non-replayable partial result after the branch is verified. */
function buildPublishPrPartialResult(
  preview,
  approval,
  branchPushProof,
  remoteState,
  status,
  now,
) {
  const result = buildActionReconciliationResult(
    preview,
    approval.fingerprint,
    remoteState,
    status,
    now,
  );
  result.proof = buildPublishPrProof(
    preview,
    branchPushProof,
    null,
  );
  return result;
}

/** Pushes the exact branch, then creates the exact Pull Request once. */
function applyPublishPr(
  preview,
  approval,
  {
    runner,
    gitRunner,
    candidatePath,
    candidateSnapshot,
    temporaryRoot,
    documentationImpact,
    now,
  },
) {
  const pushed = applyBranchPush(preview, {
    runner,
    gitRunner,
    candidatePath,
    candidateSnapshot,
    temporaryRoot,
  });
  const prPreview = publishPrPullRequestPreview(preview);
  try {
    inspectGithubActionState(prPreview, { runner });
    const output = runGithub(
      runner,
      buildMutationArguments(prPreview),
    );
    if (!/^https:\/\/github\.com\/[^\s]+$/u.test(output)) {
      throw new Error(
        "publish_pr 的 pr_create 未回傳可驗證 GitHub URL",
      );
    }
    const prProof = verifyOpenPullRequest(
      prPreview,
      output,
      runner,
      documentationImpact,
    );
    return {
      action: "publish_pr",
      repository: preview.state.repository,
      status: "applied",
      url: output,
      proof: buildPublishPrProof(
        preview,
        pushed.proof,
        prProof,
      ),
    };
  } catch (error) {
    let reconciled;
    try {
      reconciled = reconcileCreatedPullRequest(
        prPreview,
        runner,
        documentationImpact,
      );
    } catch (reconcileError) {
      const pending = buildPublishPrPartialResult(
        preview,
        approval,
        pushed.proof,
        {
          head_repository: pushed.proof.head_repository,
          branch: pushed.proof.branch,
          commit: pushed.proof.commit,
          pr_condition: "unobservable",
        },
        "pending",
        now,
      );
      pending.reason = redactText(
        reconcileError instanceof Error
          ? reconcileError.message
          : "Pull Request 核對結果不確定",
      );
      return pending;
    }
    if (reconciled.status === "applied") {
      return {
        action: "publish_pr",
        repository: preview.state.repository,
        status: "applied",
        proof: buildPublishPrProof(
          preview,
          pushed.proof,
          reconciled.proof,
        ),
      };
    }
    const partial = buildPublishPrPartialResult(
      preview,
      approval,
      pushed.proof,
      {
        head_repository: pushed.proof.head_repository,
        branch: pushed.proof.branch,
        commit: pushed.proof.commit,
        pr_condition: "absent",
      },
      "partial",
      now,
    );
    partial.reason = redactText(
      error instanceof Error
        ? error.message
        : "Pull Request 建立結果不確定",
    );
    return partial;
  }
}

/** Applies or reuses one exact personal Fork without cloning it locally. */
function applyForkCreate(
  preview,
  approval,
  {
    runner,
    now,
  },
) {
  const target = forkTarget(preview);
  try {
    inspectGithubActionState(preview, { runner });
  } catch (error) {
    if (target.operation !== "create") {
      throw error;
    }
    const result = buildActionReconciliationResult(
      preview,
      approval.fingerprint,
      {
        fork_repository: target.forkRepository,
        condition: "preflight_failed_before_post",
      },
      "not_applied",
      now,
    );
    result.reason = redactText(
      error instanceof Error
        ? error.message
        : "Fork 建立前核對失敗",
    );
    result.guidance =
      "遠端寫入未執行；修正核對問題後重新預覽並取得新的確認";
    return result;
  }
  let requestAccepted = false;
  if (target.operation === "create") {
    const request = runForkCreateRequest(runner, [
      "api",
      "--method",
      "POST",
      `repos/${preview.state.repository}/forks`,
      "-F",
      "default_branch_only=true",
    ]);
    if (request.status !== "accepted") {
      const result = buildActionReconciliationResult(
        preview,
        approval.fingerprint,
        {
          fork_repository: target.forkRepository,
          condition:
            request.status === "blocked"
              ? "request_rejected"
              : "request_outcome_unknown",
        },
        request.status,
        now,
      );
      result.reason = request.reason;
      return result;
    }
    requestAccepted = true;
  }
  let observation;
  try {
    observation = readForkObservation(preview, runner);
  } catch (error) {
    if (!requestAccepted) {
      throw error;
    }
    const status =
      error instanceof ForkObservationError
        ? error.reconciliationStatus
        : "pending";
    const result = buildActionReconciliationResult(
      preview,
      approval.fingerprint,
      {
        fork_repository: target.forkRepository,
        condition:
          error instanceof ForkObservationError
            ? "identity_or_permission_drift"
            : "post_accepted_observation_failed",
      },
      status,
      now,
    );
    result.reason =
      error instanceof ForkObservationError
        ? redactText(error.message)
        : "Fork 建立已受理，但後續核對暫時失敗";
    return result;
  }
  if (
    observation.exists === true &&
    observation.base_commit_available === true
  ) {
    return {
      action: "fork_create",
      repository: preview.state.repository,
      status: "applied",
      proof: buildForkProof(preview, observation),
    };
  }
  return buildActionReconciliationResult(
    preview,
    approval.fingerprint,
    {
      fork_repository: target.forkRepository,
      exists: observation.exists,
      base_commit_available: observation.base_commit_available,
    },
    "pending",
    now,
  );
}

/** Applies one confirmed action after re-reading its remote GitHub state. */
export function applyGithubAction(
  preview,
  approval,
  {
    now = new Date(),
    runner = defaultRunner,
    gitRunner,
    candidatePath,
    candidateSnapshot,
    temporaryRoot,
    documentationImpact = null,
  } = {},
) {
  verifyGithubActionApproval(approval, preview, { now });
  if (preview.action === "fork_create") {
    return applyForkCreate(preview, approval, {
      runner,
      now,
    });
  }
  if (preview.action === "branch_push") {
    return applyBranchPush(preview, {
      runner,
      gitRunner,
      candidatePath,
      candidateSnapshot,
      temporaryRoot,
    });
  }
  if (preview.action === "publish_pr") {
    return applyPublishPr(preview, approval, {
      runner,
      gitRunner,
      candidatePath,
      candidateSnapshot,
      temporaryRoot,
      documentationImpact,
      now,
    });
  }
  const arguments_ = buildMutationArguments(preview);
  inspectGithubActionState(preview, { runner });
  const output = runGithub(runner, arguments_);
  const result = {
    action: preview.action,
    repository: preview.state.repository,
  };
  if (["pr_create", "release"].includes(preview.action)) {
    if (!/^https:\/\/github\.com\/[^\s]+$/u.test(output)) {
      throw new Error(`${preview.action} 未回傳可驗證的 GitHub URL`);
    }
    result.url = output;
  }
  if (["pr_create", "pr_update"].includes(preview.action)) {
    result.proof = verifyOpenPullRequest(
      preview,
      output,
      runner,
      documentationImpact,
    );
  } else if (preview.action === "merge") {
    result.proof = verifyMergedPullRequest(preview, runner);
  } else if (preview.action === "release") {
    result.proof = verifyCreatedRelease(preview, output, runner);
  }
  return result;
}

/** Re-reads a previously attempted action without issuing another mutation. */
export function reconcileGithubAction(
  preview,
  {
    runner = defaultRunner,
    documentationImpact = null,
    approvalFingerprint,
    now = new Date(),
    gitRunner,
    temporaryRoot,
    attemptedAt,
  } = {},
) {
  let reconciliation;
  if (preview.action === "fork_create") {
    const target = forkTarget(preview);
    let observation;
    try {
      inspectGithubActionState(preview, {
        runner,
        allowForkDestination: true,
      });
      observation = readForkObservation(preview, runner);
    } catch (error) {
      if (!(error instanceof ApprovalDriftError)) {
        throw error;
      }
      const status =
        error instanceof ForkObservationError
          ? error.reconciliationStatus
          : "drifted";
      return buildActionReconciliationResult(
        preview,
        approvalFingerprint,
        {
          fork_repository: target.forkRepository,
          condition: "identity_or_permission_drift",
        },
        status,
        now,
      );
    }
    if (
      observation.exists === true &&
      observation.base_commit_available === true
    ) {
      reconciliation = {
        status: "applied",
        proof: buildForkProof(preview, observation),
      };
    } else {
      const attempted = Date.parse(attemptedAt);
      const observed = now instanceof Date
        ? now.getTime()
        : Date.parse(now);
      if (!Number.isFinite(attempted) || !Number.isFinite(observed)) {
        throw new Error("Fork reconcile 缺少合法 attempted_at");
      }
      const status =
        observed - attempted >= FORK_PENDING_TIMEOUT_MS
          ? "blocked"
          : "pending";
      return buildActionReconciliationResult(
        preview,
        approvalFingerprint,
        {
          fork_repository: target.forkRepository,
          exists: observation.exists,
          base_commit_available: observation.base_commit_available,
        },
        status,
        now,
      );
    }
  } else if (preview.action === "publish_pr") {
    inspectGithubActionState(preview, {
      runner,
      allowBaseCommitDrift: true,
    });
    const target = branchPushTarget(preview);
    const remoteUrl = githubRemoteUrl(target.headRepository);
    const remoteCommit = withTemporaryGithubGitConfig(
      runner,
      ({ gitConfigGlobal, temporaryRepository }) =>
        readGithubRemoteBranch(
          temporaryRepository,
          {
            remoteUrl,
            branch: preview.state.head_branch,
            gitConfigGlobal,
            runner: gitRunner,
          },
        ),
      { temporaryRoot },
    );
    if (remoteCommit === target.expectedRemoteCommit) {
      reconciliation = {
        status: "not_applied",
        remote_state: {
          head_repository: target.headRepository,
          branch: preview.state.head_branch,
          commit: remoteCommit,
        },
      };
    } else if (remoteCommit === preview.state.head_commit) {
      const branchProof = buildBranchPushProof(preview);
      const prReconciliation = reconcileCreatedPullRequest(
        publishPrPullRequestPreview(preview),
        runner,
        documentationImpact,
      );
      if (prReconciliation.status === "applied") {
        reconciliation = {
          status: "applied",
          proof: buildPublishPrProof(
            preview,
            branchProof,
            prReconciliation.proof,
          ),
        };
      } else {
        return {
          ...buildActionReconciliationResult(
            preview,
            approvalFingerprint,
            {
              head_repository: target.headRepository,
              branch: preview.state.head_branch,
              commit: remoteCommit,
              pr_condition: "absent",
            },
            "partial",
            now,
          ),
          proof: buildPublishPrProof(
            preview,
            branchProof,
            null,
          ),
        };
      }
    } else {
      throw new ApprovalDriftError(
        "publish_pr reconcile 的遠端分支已漂移",
      );
    }
  } else if (preview.action === "branch_push") {
    inspectGithubActionState(preview, {
      runner,
      allowBaseCommitDrift: true,
    });
    const target = branchPushTarget(preview);
    const remoteUrl = githubRemoteUrl(target.headRepository);
    const remoteCommit = withTemporaryGithubGitConfig(
      runner,
      ({ gitConfigGlobal, temporaryRepository }) =>
        readGithubRemoteBranch(
          temporaryRepository,
          {
            remoteUrl,
            branch: preview.state.head_branch,
            gitConfigGlobal,
            runner: gitRunner,
          },
        ),
      { temporaryRoot },
    );
    if (remoteCommit === preview.state.head_commit) {
      reconciliation = {
        status: "applied",
        proof: buildBranchPushProof(preview),
      };
    } else if (remoteCommit === target.expectedRemoteCommit) {
      reconciliation = {
        status: "not_applied",
        remote_state: {
          head_repository: target.headRepository,
          branch: preview.state.head_branch,
          commit: remoteCommit,
        },
      };
    } else {
      throw new ApprovalDriftError(
        "GitHub branch push reconcile 遠端狀態已漂移",
      );
    }
  } else if (preview.action === "pr_create") {
    reconciliation = reconcileCreatedPullRequest(
      preview,
      runner,
      documentationImpact,
    );
  } else if (preview.action === "pr_update") {
    const number = pullRequestNumber(preview.state.action_target);
    const pullRequest = readOpenPullRequest(preview, number, runner);
    const expectedHeadRepository = headRepositoryForPreview(preview);
    const identityMatches =
      pullRequest.number === number &&
      pullRequest.baseRefName === preview.state.base_branch &&
      pullRequest.headRefOid === preview.state.head_commit &&
      pullRequest.headRepository?.nameWithOwner?.toLowerCase() ===
        expectedHeadRepository.toLowerCase() &&
      pullRequest.state === "OPEN";
    if (!identityMatches) {
      throw new ApprovalDriftError(
        "GitHub Pull Request reconcile identity 已漂移",
      );
    }
    if (
      pullRequest.title === preview.state.action_target.title &&
      pullRequest.body === preview.state.action_target.body
    ) {
      reconciliation = {
        status: "applied",
        proof: buildOpenPullRequestProof(
          preview,
          "",
          documentationImpact,
          pullRequest,
        ),
      };
    } else {
      reconciliation = {
        status: "not_applied",
        remote_state: {
          number,
          head_commit: pullRequest.headRefOid,
          title_hash: fingerprint(pullRequest.title),
          body_hash: fingerprint(pullRequest.body),
        },
      };
    }
  } else if (preview.action === "merge") {
    const number = pullRequestNumber(preview.state.action_target);
    const pullRequest = parseGithubJson(
      runGithub(runner, [
        "pr",
        "view",
        String(number),
        "--repo",
        preview.state.repository,
        "--json",
        "number,baseRefName,headRefOid,headRepository,state,mergedAt,mergeCommit",
      ]),
      "GitHub merge reconcile",
    );
    if (pullRequest.state === "MERGED") {
      reconciliation = {
        status: "applied",
        proof: buildMergeProof(preview, pullRequest),
      };
    } else {
      const expectedHeadRepository = headRepositoryForPreview(preview);
      if (
        pullRequest.number !== number ||
        pullRequest.baseRefName !== preview.state.base_branch ||
        pullRequest.headRefOid !== preview.state.head_commit ||
        pullRequest.headRepository?.nameWithOwner?.toLowerCase() !==
          expectedHeadRepository.toLowerCase() ||
        pullRequest.state !== "OPEN"
      ) {
        throw new ApprovalDriftError(
          "GitHub merge reconcile identity 已漂移",
        );
      }
      reconciliation = {
        status: "not_applied",
        remote_state: {
          number,
          state: pullRequest.state,
          head_commit: pullRequest.headRefOid,
        },
      };
    }
  } else if (preview.action === "release") {
    const version = preview.state.action_target.version;
    const availability = readReleaseAvailability(preview, runner);
    if (availability.release === null && availability.ref === null) {
      reconciliation = {
        status: "not_applied",
        remote_state: {
          version,
          release_exists: false,
          tag_exists: false,
        },
      };
    } else if (
      availability.release !== null &&
      availability.ref !== null
    ) {
      const output =
        `https://github.com/${preview.state.repository}/releases/tag/${version}`;
      reconciliation = {
        status: "applied",
        proof: verifyCreatedRelease(preview, output, runner),
      };
    } else {
      throw new ApprovalDriftError(
        "GitHub Release 與 tag reconcile 結果不一致",
      );
    }
  } else {
    throw new Error(`${preview.action} 不支援 GitHub reconcile`);
  }
  if (reconciliation.status === "not_applied") {
    return buildNotAppliedResult(
      preview,
      approvalFingerprint,
      reconciliation.remote_state,
      now,
    );
  }
  return {
    action: preview.action,
    repository: preview.state.repository,
    status: "applied",
    proof: reconciliation.proof,
  };
}
