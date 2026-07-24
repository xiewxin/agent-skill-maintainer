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
  "branch_push",
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
  "base_commit",
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
const MANAGED_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;

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
  ];
  const unknown = Object.keys(target)
    .filter((name) => !expectedFields.includes(name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`branch push target 含未知欄位：${unknown.join(", ")}`);
  }
  return {
    candidatePathFingerprint: target.candidate_path_fingerprint,
    expectedRemoteCommit: target.expected_remote_commit,
    headRepository,
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
  if (preview.action !== "branch_push") {
    throw new Error("只有 branch_push 需要 candidate preflight");
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
  if (action === "pr_create") {
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

/** Builds a redacted absence proof for one previously attempted action. */
function buildNotAppliedResult(
  preview,
  approvalFingerprint,
  remoteState,
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
  const absenceProof = {
    schema_version: 1,
    action: preview.action,
    repository: preview.state.repository,
    approval_fingerprint: approvalFingerprint,
    preview_fingerprint: preview.fingerprint,
    observed_at: observedAt,
    status: "not_applied",
    remote_state_hash: fingerprint(remoteState),
  };
  validateDocument("github-action-reconciliation", absenceProof);
  return {
    action: preview.action,
    repository: preview.state.repository,
    status: "not_applied",
    absence_proof: absenceProof,
  };
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
  if (preview.action === "pr_create") {
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
      preview.action === "pr_create" &&
      pullRequest.isDraft !== preview.state.action_target.draft
    ) ||
    (
      preview.action === "pr_create" &&
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
  const number = preview.action === "pr_create"
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
  } = {},
) {
  const current = buildGithubActionPreview(preview.action, preview.state);
  if (canonicalJson(current) !== canonicalJson(preview)) {
    throw new ApprovalDriftError("GitHub 動作預覽 fingerprint 已漂移");
  }
  const account = runGithub(runner, ["api", "user", "--jq", ".login"]);
  if (account !== preview.state.account) {
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
    repository.defaultBranchRef?.name !== preview.state.base_branch
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
    preview.action === "branch_push" &&
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
        "contribute Fork 不存在或無法驗證；目前不支援自動建立 Fork",
        { cause: error },
      );
    }
    if (
      fork.nameWithOwner?.toLowerCase() !==
        headRepository.toLowerCase() ||
      !MANAGED_PERMISSIONS.has(fork.viewerPermission) ||
      fork.parent?.nameWithOwner?.toLowerCase() !==
        preview.state.repository.toLowerCase()
    ) {
      throw new ApprovalDriftError(
        "contribute Fork owner、parent 或寫入權限已漂移",
      );
    }
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
  if (typeof state.release_enabled !== "boolean") {
    throw new Error("release_enabled 必須是 boolean");
  }
  if (state.relationship === "analyze-only") {
    throw new Error("analyze-only 不可建立 GitHub 寫入預覽");
  }
  if (["pr_create", "pr_update"].includes(action)) {
    headRepositoryForPreview({ state });
  }
  if (action === "branch_push") {
    branchPushTarget({ action, state });
  }
  if (["merge", "release"].includes(action) && state.relationship !== "managed") {
    throw new Error("只有 managed 倉庫可合併或發布");
  }
  if (action === "release" && state.release_enabled !== true) {
    throw new Error("release_enabled=false，不可建立發布預覽");
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
  if (preview.action === "branch_push") {
    return applyBranchPush(preview, {
      runner,
      gitRunner,
      candidatePath,
      candidateSnapshot,
      temporaryRoot,
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
  } = {},
) {
  let reconciliation;
  if (preview.action === "branch_push") {
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
