import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApproval,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  buildCandidateSnapshot,
  buildRepositorySnapshot,
  createIsolatedCandidate,
  fingerprintTree,
  runGit as runSafeGit,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";

/** Runs Git in a test repository and returns trimmed stdout. */
export function runGit(repository, ...arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

/** Initializes a deterministic local Git repository. */
export function initializeRepository(repository) {
  mkdirSync(repository, { recursive: true });
  runGit(repository, "init", "-b", "main");
  runGit(repository, "config", "user.name", "Test User");
  runGit(repository, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repository, "SKILL.md"), "base\n", "utf8");
  runGit(repository, "add", "SKILL.md");
  runGit(repository, "commit", "-m", "base");
}

/** Creates installed, source, and candidate roots for one isolated test. */
export function createIsolationFixture({
  prefix = "maintainer-git-",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const installed = join(root, "installed", "example-skill");
  const source = join(root, "source");
  const candidates = join(root, "candidates");
  mkdirSync(installed, { recursive: true });
  mkdirSync(candidates);
  writeFileSync(join(installed, "SKILL.md"), "installed\n", "utf8");
  initializeRepository(source);
  writeFileSync(join(source, "SKILL.md"), "source\n", "utf8");
  runGit(source, "add", "SKILL.md");
  runGit(source, "commit", "-m", "source");
  return { root, installed, source, candidates };
}

/** Returns one complete accepted optimization fixture. */
export function optimizationFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "OPT-001",
    feedback_ids: ["FB-001"],
    intent_evidence: "既有能力合同。",
    problem_evidence: "固定輸入可重現。",
    owner: "example-skill",
    scope: "既有能力範圍。",
    closure: "補上缺失閉環。",
    minimum_change: "只修改必要規則。",
    regression_case: "固定輸入不得再次失敗。",
    generalized_value: "避免同類錯誤。",
    confidence: "high",
    decision_status: "accepted",
    decision_reason: "問題可重現且符合能力初衷。",
    ...overrides,
  };
}

/** Returns one complete redacted evidence fixture. */
export function evidenceFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "EV-001",
    source_type: "current-run",
    source_ref: "sha256:example-evidence",
    skill_version: "0.1.0",
    redacted_summary: "使用者修正了錯誤的步驟選擇。",
    confidence: "high",
    ...overrides,
  };
}

/** Returns one complete feedback fixture. */
export function feedbackFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "FB-001",
    target_skill: "example-skill",
    phenomenon: "代理選擇了不符合既有意圖的步驟。",
    expected_behavior: "應依目標 Skill 的既有邊界選擇步驟。",
    source_ids: ["EV-001"],
    skill_version: "0.1.0",
    reproduction: "已由固定輸入重現。",
    missing_evidence: [],
    classification: "skill-defect",
    confidence: "high",
    provisional_owner: "example-skill",
    ...overrides,
  };
}

/** Returns one isolated candidate snapshot fixture. */
export function candidateFixture(overrides = {}) {
  return {
    schema_version: 1,
    repository_snapshot: {
      schema_version: 1,
      base_ref: "main",
      merge_base: "abc123",
      head_commit: "abc123",
      diff_hash: "a".repeat(64),
      changed_files: [],
      process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
    },
    candidate_diff_hash: "b".repeat(64),
    changed_files: ["SKILL.md", "tests/regression.txt"],
    approved_opt_ids: ["OPT-001"],
    process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
    file_opt_map: {
      "SKILL.md": ["OPT-001"],
      "tests/regression.txt": ["OPT-001"],
    },
    diff_mapping_complete: true,
    isolated: true,
    ...overrides,
  };
}

/** Builds a verified binding and approval for the current source head. */
export function sourceApproval(
  source,
  installedFingerprint,
  relationship = "managed",
) {
  const snapshot = buildRepositorySnapshot(source, { baseRef: "main" });
  const optimization = optimizationFixture();
  const binding = {
    schema_version: 1,
    binding_id: "binding-001",
    skill: "example-skill",
    source_repository: "example/skill",
    installed_fingerprint: installedFingerprint,
    install_method: "manual",
    remote_verified: true,
    relationship,
    release_enabled: false,
  };
  const approval = buildApproval([optimization], {
    runId: "run-001",
    bindingId: binding.binding_id,
    relationship,
    repository: binding.source_repository,
    headCommit: snapshot.head_commit,
    diffHash: snapshot.diff_hash,
    processArtifactPrefixes: snapshot.process_artifact_prefixes,
  });
  return { snapshot, optimization, binding, relationship, approval };
}

/** Creates one clean committed candidate suitable for branch-push tests. */
export function createBranchPushFixture({
  prefix = "maintainer-push-",
  candidateName = "push-run",
  branchName = "maintain/push-run",
  relationship = "managed",
} = {}) {
  const fixture = createIsolationFixture({ prefix });
  const installedFingerprint = fingerprintTree(fixture.installed);
  const {
    snapshot: repositorySnapshot,
    optimization,
    binding,
    approval: implementationApproval,
  } = sourceApproval(
    fixture.source,
    installedFingerprint,
    relationship,
  );
  const isolated = createIsolatedCandidate({
    installedPath: fixture.installed,
    expectedInstalledFingerprint: installedFingerprint,
    sourcePath: fixture.source,
    candidateRoot: fixture.candidates,
    candidateName,
    branchName,
    baseRef: "main",
    repository: binding.source_repository,
    runId: "run-001",
    binding,
    relationship,
    optimizations: [optimization],
    approval: implementationApproval,
  });
  runGit(isolated.candidate_path, "config", "user.name", "Test User");
  runGit(
    isolated.candidate_path,
    "config",
    "user.email",
    "test@example.invalid",
  );
  writeFileSync(
    join(isolated.candidate_path, "SKILL.md"),
    "source\nbranch push\n",
    "utf8",
  );
  runGit(isolated.candidate_path, "add", "SKILL.md");
  runGit(isolated.candidate_path, "commit", "-m", "branch push");
  const candidateSnapshot = buildCandidateSnapshot({
    candidatePath: isolated.candidate_path,
    installedPath: fixture.installed,
    sourcePath: fixture.source,
    baseRef: "main",
    approvedOptIds: ["OPT-001"],
    fileOptMap: { "SKILL.md": ["OPT-001"] },
  });
  return {
    ...fixture,
    candidate: isolated.candidate_path,
    branch: isolated.branch,
    binding,
    implementationApproval,
    repositorySnapshot,
    candidateSnapshot,
  };
}

/** Returns a deterministic GitHub CLI runner for branch-push tests. */
export function branchPushGithubRunner(
  state,
  {
    forkAvailable = true,
    forkParent = state.repository,
    forkPermission = "WRITE",
    onSetupGit = () => {},
  } = {},
) {
  return (arguments_, options = {}) => {
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: `${state.account}\n`, stderr: "" };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === state.repository
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: state.repository,
          viewerPermission:
            state.relationship === "managed" ? "ADMIN" : "READ",
          defaultBranchRef: { name: state.base_branch },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === state.action_target.head_repository
    ) {
      if (!forkAvailable) {
        return {
          status: 1,
          stdout: "",
          stderr: "repository not found",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: state.action_target.head_repository,
          viewerPermission: forkPermission,
          parent: { nameWithOwner: forkParent },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] ===
        `repos/${state.repository}/branches/${state.base_branch}`
    ) {
      return {
        status: 0,
        stdout: `${state.base_commit}\n`,
        stderr: "",
      };
    }
    if (arguments_[0] === "auth" && arguments_[1] === "setup-git") {
      onSetupGit(options.environment);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };
}

/** Rewrites verified HTTPS remotes to local bare remotes for integration tests. */
export function localRemoteGitRunner(
  remoteMap,
  { beforePush = () => {} } = {},
) {
  return (repository, arguments_, options) => {
    if (arguments_[0] === "push") {
      beforePush();
    }
    return runSafeGit(
      repository,
      arguments_.map((value) => remoteMap.get(value) ?? value),
      options,
    );
  };
}
