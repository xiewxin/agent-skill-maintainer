import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ApprovalDriftError,
  buildApproval,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  buildCandidateSnapshot,
  buildReleaseChangeInventory,
  buildRepositorySnapshot,
  createIsolatedCandidate,
  evaluateReleaseNoteCoverage,
  fingerprintTree,
  validateCandidateProcessArtifacts,
  validateIsolatedPaths,
  verifyReleaseNoteCoverageProof,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  applyGithubAction,
  buildGithubActionApproval,
  buildGithubActionPreview,
  reconcileGithubAction,
  verifyGithubActionApproval,
  verifyGithubActionPreview,
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";
import {
  initializeRepository,
  optimizationFixture,
  runGit,
} from "./fixtures.mjs";

const DOCUMENTATION_IMPACT = {
  schema_version: 1,
  status: "updated",
  changed_guides: ["README.md"],
  root_index_action: "verified-current",
  contract_preserved: true,
  reason: "README reflects the approved candidate behavior.",
};

/** Creates installed, source, and candidate roots for one isolated test. */
function createIsolationFixture() {
  const root = mkdtempSync(join(tmpdir(), "maintainer-git-"));
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

/** Builds a verified binding and approval for the current source head. */
function sourceApproval(source, installedFingerprint, relationship = "managed") {
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
    repository: "example/skill",
    headCommit: snapshot.head_commit,
    diffHash: snapshot.diff_hash,
    processArtifactPrefixes: snapshot.process_artifact_prefixes,
  });
  return { snapshot, optimization, binding, relationship, approval };
}

test("repository snapshot uses merge base and hashes committed diff", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-snapshot-"));
  try {
    initializeRepository(root);
    runGit(root, "switch", "-c", "feature");
    writeFileSync(join(root, "SKILL.md"), "base\nfeature\n", "utf8");
    runGit(root, "add", "SKILL.md");
    runGit(root, "commit", "-m", "feature");
    const snapshot = buildRepositorySnapshot(root, { baseRef: "main" });
    assert.equal(snapshot.merge_base, runGit(root, "rev-parse", "main"));
    assert.equal(snapshot.head_commit, runGit(root, "rev-parse", "HEAD"));
    assert.deepEqual(snapshot.changed_files, ["SKILL.md"]);
    assert.equal(snapshot.diff_hash.length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository snapshot rejects a Git subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-snapshot-root-"));
  try {
    initializeRepository(root);
    const nested = join(root, "nested");
    mkdirSync(nested);
    assert.throws(
      () => buildRepositorySnapshot(nested, { baseRef: "main" }),
      /repository 必須指向 Git 根目錄/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed fingerprint is stable and detects drift", () => {
  const fixture = createIsolationFixture();
  try {
    const before = fingerprintTree(fixture.installed);
    assert.equal(before, fingerprintTree(fixture.installed));
    writeFileSync(join(fixture.installed, "SKILL.md"), "changed\n", "utf8");
    assert.notEqual(before, fingerprintTree(fixture.installed));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("canonical path overlap and aliases are rejected", (context) => {
  const fixture = createIsolationFixture();
  try {
    assert.throws(
      () =>
        validateIsolatedPaths({
          installedPath: fixture.source,
          sourcePath: fixture.source,
          candidatePath: join(fixture.candidates, "run-001"),
        }),
      /不可重疊/u,
    );
    if (process.platform === "win32") {
      context.skip("Windows symlink privileges are not guaranteed");
      return;
    }
    const alias = join(fixture.root, "installed-alias");
    symlinkSync(fixture.source, alias, "dir");
    assert.throws(
      () =>
        validateIsolatedPaths({
          installedPath: alias,
          sourcePath: fixture.source,
          candidatePath: join(fixture.candidates, "run-001"),
        }),
      /不可重疊/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("isolated candidate preserves source and starts clean", () => {
  const fixture = createIsolationFixture();
  try {
    const installedFingerprint = fingerprintTree(fixture.installed);
    const {
      snapshot,
      optimization,
      binding,
      relationship,
      approval,
    } = sourceApproval(fixture.source, installedFingerprint);
    const sourceBranch = runGit(fixture.source, "branch", "--show-current");
    assert.throws(
      () =>
        createIsolatedCandidate({
          installedPath: fixture.installed,
          expectedInstalledFingerprint: installedFingerprint,
          sourcePath: fixture.source,
          candidateRoot: fixture.candidates,
          candidateName: "cross-run",
          branchName: "maintain/cross-run",
          baseRef: "main",
          repository: "example/skill",
          runId: "run-002",
          binding,
          relationship,
          optimizations: [optimization],
          approval,
        }),
      ApprovalDriftError,
    );
    const result = createIsolatedCandidate({
      installedPath: fixture.installed,
      expectedInstalledFingerprint: installedFingerprint,
      sourcePath: fixture.source,
      candidateRoot: fixture.candidates,
      candidateName: "run-001",
      branchName: "maintain/run-001",
      baseRef: "main",
      repository: "example/skill",
      runId: "run-001",
      binding,
      relationship,
      optimizations: [optimization],
      approval,
    });
    assert.equal(
      result.candidate_path,
      realpathSync(resolve(fixture.candidates, "run-001")),
    );
    assert.equal(result.branch, "maintain/run-001");
    assert.deepEqual(result.repository_snapshot, snapshot);
    assert.equal(
      runGit(result.candidate_path, "branch", "--show-current"),
      "maintain/run-001",
    );
    assert.equal(runGit(result.candidate_path, "status", "--porcelain"), "");
    assert.equal(
      runGit(fixture.source, "branch", "--show-current"),
      sourceBranch,
    );
    assert.equal(readFileSync(join(fixture.source, "SKILL.md"), "utf8"), "source\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("analyze-only or unverified bindings cannot create candidates", () => {
  const fixture = createIsolationFixture();
  try {
    const installedFingerprint = fingerprintTree(fixture.installed);
    const analyzeOnly = sourceApproval(fixture.source, installedFingerprint);
    assert.throws(
      () =>
        createIsolatedCandidate({
          installedPath: fixture.installed,
          expectedInstalledFingerprint: installedFingerprint,
          sourcePath: fixture.source,
          candidateRoot: fixture.candidates,
          candidateName: "run-analyze-only",
          branchName: "maintain/run-analyze-only",
          baseRef: "main",
          repository: "example/skill",
          runId: "run-001",
          binding: {
            ...analyzeOnly.binding,
            relationship: "analyze-only",
          },
          relationship: "analyze-only",
          optimizations: [analyzeOnly.optimization],
          approval: analyzeOnly.approval,
        }),
      /不可建立候選/u,
    );
    const managed = sourceApproval(
      fixture.source,
      installedFingerprint,
      "managed",
    );
    assert.throws(
      () =>
        createIsolatedCandidate({
          installedPath: fixture.installed,
          expectedInstalledFingerprint: installedFingerprint,
          sourcePath: fixture.source,
          candidateRoot: fixture.candidates,
          candidateName: "run-unverified",
          branchName: "maintain/run-unverified",
          baseRef: "main",
          repository: "example/skill",
          runId: "run-001",
          binding: { ...managed.binding, remote_verified: false },
          relationship: managed.relationship,
          optimizations: [managed.optimization],
          approval: managed.approval,
        }),
      /不可建立候選/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("installed drift and tracked symlinks block candidate creation", (context) => {
  const fixture = createIsolationFixture();
  try {
    const oldFingerprint = fingerprintTree(fixture.installed);
    const first = sourceApproval(fixture.source, oldFingerprint);
    writeFileSync(join(fixture.installed, "SKILL.md"), "changed\n", "utf8");
    assert.throws(
      () =>
        createIsolatedCandidate({
          installedPath: fixture.installed,
          expectedInstalledFingerprint: oldFingerprint,
          sourcePath: fixture.source,
          candidateRoot: fixture.candidates,
          candidateName: "run-001",
          branchName: "maintain/run-001",
          baseRef: "main",
          repository: "example/skill",
          runId: "run-001",
          binding: first.binding,
          relationship: first.relationship,
          optimizations: [first.optimization],
          approval: first.approval,
        }),
      /installed Skill 已改變/u,
    );
    if (process.platform === "win32") {
      context.skip("Windows symlink privileges are not guaranteed");
      return;
    }
    writeFileSync(join(fixture.installed, "SKILL.md"), "installed\n", "utf8");
    symlinkSync(join(fixture.root, "outside"), join(fixture.source, "outside-link"));
    runGit(fixture.source, "add", "outside-link");
    runGit(fixture.source, "commit", "-m", "add unsafe link");
    const installedFingerprint = fingerprintTree(fixture.installed);
    const unsafe = sourceApproval(fixture.source, installedFingerprint);
    assert.throws(
      () =>
        createIsolatedCandidate({
          installedPath: fixture.installed,
          expectedInstalledFingerprint: installedFingerprint,
          sourcePath: fixture.source,
          candidateRoot: fixture.candidates,
          candidateName: "run-002",
          branchName: "maintain/run-002",
          baseRef: "main",
          repository: "example/skill",
          runId: "run-001",
          binding: unsafe.binding,
          relationship: unsafe.relationship,
          optimizations: [unsafe.optimization],
          approval: unsafe.approval,
        }),
      /symbolic link/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("candidate snapshot hashes tracked and untracked changes with OPT mapping", () => {
  const fixture = createIsolationFixture();
  try {
    const installedFingerprint = fingerprintTree(fixture.installed);
    const {
      optimization,
      binding,
      relationship,
      approval,
    } = sourceApproval(fixture.source, installedFingerprint);
    const result = createIsolatedCandidate({
      installedPath: fixture.installed,
      expectedInstalledFingerprint: installedFingerprint,
      sourcePath: fixture.source,
      candidateRoot: fixture.candidates,
      candidateName: "run-003",
      branchName: "maintain/run-003",
      baseRef: "main",
      repository: "example/skill",
      runId: "run-001",
      binding,
      relationship,
      optimizations: [optimization],
      approval,
    });
    writeFileSync(join(result.candidate_path, "SKILL.md"), "improved\n", "utf8");
    mkdirSync(join(result.candidate_path, "tests"));
    writeFileSync(
      join(result.candidate_path, "tests", "regression.txt"),
      "regression\n",
      "utf8",
    );
    const mapping = {
      "SKILL.md": ["OPT-001"],
      "tests/regression.txt": ["OPT-001"],
    };
    const snapshot = buildCandidateSnapshot({
      candidatePath: result.candidate_path,
      installedPath: fixture.installed,
      sourcePath: fixture.source,
      baseRef: "main",
      approvedOptIds: ["OPT-001"],
      fileOptMap: mapping,
    });
    assert.deepEqual(snapshot.changed_files, [
      "SKILL.md",
      "tests/regression.txt",
    ]);
    assert.deepEqual(snapshot.file_opt_map, mapping);
    assert.equal(snapshot.candidate_diff_hash.length, 64);
    writeFileSync(
      join(result.candidate_path, "tests", "regression.txt"),
      "changed\n",
      "utf8",
    );
    const changed = buildCandidateSnapshot({
      candidatePath: result.candidate_path,
      installedPath: fixture.installed,
      sourcePath: fixture.source,
      baseRef: "main",
      approvedOptIds: ["OPT-001"],
      fileOptMap: mapping,
    });
    assert.notEqual(snapshot.candidate_diff_hash, changed.candidate_diff_hash);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("candidate snapshot rejects missing and unknown OPT mappings", () => {
  const fixture = createIsolationFixture();
  try {
    const installedFingerprint = fingerprintTree(fixture.installed);
    const {
      optimization,
      binding,
      relationship,
      approval,
    } = sourceApproval(fixture.source, installedFingerprint);
    const result = createIsolatedCandidate({
      installedPath: fixture.installed,
      expectedInstalledFingerprint: installedFingerprint,
      sourcePath: fixture.source,
      candidateRoot: fixture.candidates,
      candidateName: "run-004",
      branchName: "maintain/run-004",
      baseRef: "main",
      repository: "example/skill",
      runId: "run-001",
      binding,
      relationship,
      optimizations: [optimization],
      approval,
    });
    writeFileSync(join(result.candidate_path, "SKILL.md"), "improved\n", "utf8");
    const common = {
      candidatePath: result.candidate_path,
      installedPath: fixture.installed,
      sourcePath: fixture.source,
      baseRef: "main",
      approvedOptIds: ["OPT-001"],
    };
    assert.throws(
      () => buildCandidateSnapshot({ ...common, fileOptMap: {} }),
      /未完整映射/u,
    );
    assert.throws(
      () =>
        buildCandidateSnapshot({
          ...common,
          fileOptMap: { "SKILL.md": ["OPT-999"] },
        }),
      /未核准 OPT/u,
    );
    assert.throws(
      () =>
        buildCandidateSnapshot({
          ...common,
          approvedOptIds: ["OPT-001", "OPT-002"],
          fileOptMap: { "SKILL.md": ["OPT-001"] },
        }),
      /未對應任何候選檔案/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("candidate process artifacts are blocked from tracked or untracked Diff", () => {
  assert.equal(
    validateCandidateProcessArtifacts(["SKILL.md"], {
      excludedPrefixes: ["docs/plans/"],
    }),
    true,
  );
  assert.throws(
    () =>
      validateCandidateProcessArtifacts(
        ["docs/plans/private-plan.md"],
        { excludedPrefixes: ["docs/plans/"] },
      ),
    /過程檔/u,
  );
  assert.throws(
    () =>
      validateCandidateProcessArtifacts([
        ".agent-skill-maintainer/runs/run-001.json",
      ]),
    /過程檔/u,
  );
});

test("release inventory covers the complete previous-tag range", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-release-"));
  try {
    initializeRepository(root);
    runGit(root, "tag", "v1.0.0");
    runGit(root, "commit", "--allow-empty", "-m", "feat: defaults (#2)");
    runGit(root, "commit", "--allow-empty", "-m", "feat: planning provider");
    const inventory = buildReleaseChangeInventory(root, {
      previousRef: "v1.0.0",
      candidateRef: "HEAD",
    });
    assert.equal(inventory.commits.length, 2);
    assert.deepEqual(inventory.pull_requests, [2]);
    assert.equal(inventory.candidate_commit, runGit(root, "rev-parse", "HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release note coverage reports omitted PR and accepted OPT", () => {
  const inventory = {
    schema_version: 1,
    previous_ref: "v1.2.0",
    previous_commit: "base123",
    candidate_ref: "HEAD",
    candidate_commit: "head123",
    commits: [
      {
        commit: "commit-pr2",
        subject: "feat: defaults (#2)",
        pull_requests: [2],
      },
      {
        commit: "commit-matt",
        subject: "feat: planning provider",
        pull_requests: [],
      },
    ],
    pull_requests: [2],
  };
  const coverage = evaluateReleaseNoteCoverage(inventory, {
    mappings: [
      {
        id: "NOTE-001",
        disposition: "included",
        source_commits: ["commit-matt"],
        source_prs: [],
        optimization_ids: ["OPT-002"],
        note: "Integrates the planning provider.",
        reason: "",
      },
    ],
    requiredOptimizationIds: new Set(["OPT-001", "OPT-002"]),
  });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing_commits, ["commit-pr2"]);
  assert.deepEqual(coverage.missing_prs, [2]);
  assert.deepEqual(coverage.missing_optimization_ids, ["OPT-001"]);
  assert.equal(coverage.proof_fingerprint.length, 64);
  assert.throws(
    () =>
      verifyReleaseNoteCoverageProof({
        ...coverage,
        complete: true,
      }),
    /修改或不完整/u,
  );
  assert.throws(
    () =>
      evaluateReleaseNoteCoverage(
        {
          ...inventory,
          commits: [inventory.commits[1]],
          pull_requests: [],
        },
        {
          mappings: [
            {
              id: "NOTE-001",
              disposition: "excluded",
              source_commits: ["commit-matt"],
              source_prs: [],
              optimization_ids: [],
              note: "",
              reason: "",
            },
          ],
          requiredOptimizationIds: new Set(),
        },
      ),
    /說明理由/u,
  );
});

test("GitHub previews are stable and drift-bound", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: "base123",
    head_branch: "feature",
    head_commit: "abc123",
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "Documents and tests the improvement.",
      draft: false,
      head_repository: "example/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  assert.equal(preview.fingerprint.length, 64);
  assert.equal(
    verifyGithubActionPreview(preview, "pr_create", state),
    true,
  );
  assert.throws(
    () =>
      verifyGithubActionPreview(preview, "pr_create", {
        ...state,
        head_commit: "changed",
      }),
    ApprovalDriftError,
  );
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T08:15:00.000Z",
  });
  assert.equal(
    verifyGithubActionApproval(approval, preview, {
      now: "2026-07-23T08:10:00.000Z",
    }),
    true,
  );
  assert.throws(
    () =>
      verifyGithubActionApproval(
        approval,
        buildGithubActionPreview("pr_update", state),
        { now: "2026-07-23T08:10:00.000Z" },
      ),
    ApprovalDriftError,
  );
  assert.throws(
    () =>
      verifyGithubActionApproval(approval, preview, {
        now: "2026-07-23T08:15:00.000Z",
      }),
    /過期/u,
  );
  assert.throws(
    () =>
      buildGithubActionApproval(preview, {
        confirmedAt: "2026-07-23T08:00:00.000Z",
        expiresAt: "2026-07-23T08:31:00.000Z",
      }),
    /時間範圍/u,
  );
  const futureApproval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T09:00:00.000Z",
    expiresAt: "2026-07-23T09:15:00.000Z",
  });
  assert.throws(
    () =>
      verifyGithubActionApproval(futureApproval, preview, {
        now: "2026-07-23T08:00:00.000Z",
      }),
    /未來/u,
  );
});

test("GitHub apply revalidates remote state and uses argument-safe gh commands", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "Body with `code`, spaces, and $literal text.",
      draft: false,
      head_repository: "example/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T08:15:00.000Z",
  });
  const calls = [];
  const runner = (arguments_) => {
    calls.push(arguments_);
    const key = arguments_.slice(0, 3).join(" ");
    if (key === "api user --jq") {
      return { status: 0, stdout: "example-user\n", stderr: "" };
    }
    if (key === "repo view example/skill") {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example/skill",
          viewerPermission: "ADMIN",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (key === "api repos/example/skill/commits/feature --jq") {
      return { status: 0, stdout: `${state.head_commit}\n`, stderr: "" };
    }
    if (key === "api repos/example/skill/branches/main --jq") {
      return { status: 0, stdout: `${state.base_commit}\n`, stderr: "" };
    }
    if (key === "pr create --repo") {
      return {
        status: 0,
        stdout: "https://github.com/example/skill/pull/7\n",
        stderr: "",
      };
    }
    if (key === "pr view 7") {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 7,
          url: "https://github.com/example/skill/pull/7",
          baseRefName: "main",
          headRefOid: state.head_commit,
          headRepository: { nameWithOwner: "example/skill" },
          state: "OPEN",
          isDraft: false,
          statusCheckRollup: [],
          title: state.action_target.title,
          body: state.action_target.body,
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };

  const result = applyGithubAction(preview, approval, {
    now: "2026-07-23T08:10:00.000Z",
    runner,
    documentationImpact: DOCUMENTATION_IMPACT,
  });

  assert.equal(result.action, "pr_create");
  assert.equal(result.repository, "example/skill");
  assert.equal(result.url, "https://github.com/example/skill/pull/7");
  assert.equal(result.proof.number, 7);
  assert.equal(result.proof.head_commit, state.head_commit);
  assert.deepEqual(
    result.proof.documentation_impact,
    DOCUMENTATION_IMPACT,
  );
  const mutation = calls.find(
    (arguments_) =>
      arguments_[0] === "pr" && arguments_[1] === "create",
  );
  assert.ok(mutation);
  assert.deepEqual(mutation.slice(0, 8), [
    "pr",
    "create",
    "--repo",
    "example/skill",
    "--base",
    "main",
    "--head",
    "feature",
  ]);
  assert.equal(mutation[mutation.indexOf("--body") + 1], state.action_target.body);
  assert.ok(!mutation.includes("--admin"));
  assert.ok(!mutation.includes("--auto"));
});

test("GitHub apply refuses account, commit, approval, and relationship drift", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "A complete body.",
      draft: true,
      head_repository: "example/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T08:15:00.000Z",
  });
  let mutationCount = 0;
  const runner = (arguments_) => {
    if (arguments_[0] === "pr" && arguments_[1] === "create") {
      mutationCount += 1;
    }
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: "different-user\n", stderr: "" };
    }
    throw new Error("mutation should not be reached");
  };
  assert.throws(
    () =>
      applyGithubAction(preview, approval, {
        now: "2026-07-23T08:10:00.000Z",
        runner,
      }),
    /active account/u,
  );
  assert.equal(mutationCount, 0);
  assert.throws(
    () =>
      applyGithubAction(preview, approval, {
        now: "2026-07-23T08:15:00.000Z",
        runner,
      }),
    /過期/u,
  );
  assert.equal(mutationCount, 0);
  assert.throws(
    () =>
      buildGithubActionPreview("merge", {
        ...state,
        relationship: "contribute",
        action_target: { pr_number: 7, method: "squash" },
      }),
    /managed/u,
  );
  assert.throws(
    () =>
      buildGithubActionPreview("pr_create", {
        ...state,
        action_target: {
          ...state.action_target,
          head_repository: "someone-else/skill",
        },
      }),
    /同一 repository/u,
  );

  const baseDriftRunner = (arguments_) => {
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: "example-user\n", stderr: "" };
    }
    if (arguments_[0] === "repo" && arguments_[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example/skill",
          viewerPermission: "ADMIN",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] === "repos/example/skill/branches/main"
    ) {
      return {
        status: 0,
        stdout: `${"c".repeat(40)}\n`,
        stderr: "",
      };
    }
    throw new Error("mutation should not be reached");
  };
  assert.throws(
    () =>
      applyGithubAction(preview, approval, {
        now: "2026-07-23T08:10:00.000Z",
        runner: baseDriftRunner,
      }),
    /base branch commit/u,
  );
});

test("managed PR update refuses a head repository from another fork", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      pr_number: 7,
      title: "Improve workflow",
      body: "Updated body.",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_update", state);
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T08:15:00.000Z",
  });
  let mutationCount = 0;
  const runner = (arguments_) => {
    if (arguments_[0] === "pr" && arguments_[1] === "edit") {
      mutationCount += 1;
    }
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: "example-user\n", stderr: "" };
    }
    if (arguments_[0] === "repo" && arguments_[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example/skill",
          viewerPermission: "ADMIN",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] === "repos/example/skill/branches/main"
    ) {
      return { status: 0, stdout: `${state.base_commit}\n`, stderr: "" };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          baseRefName: "main",
          headRefName: "feature",
          headRefOid: state.head_commit,
          headRepository: { nameWithOwner: "someone-else/skill" },
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };

  assert.throws(
    () =>
      applyGithubAction(preview, approval, {
        now: "2026-07-23T08:10:00.000Z",
        runner,
        documentationImpact: DOCUMENTATION_IMPACT,
      }),
    /head repository/u,
  );
  assert.equal(mutationCount, 0);
});

test("contribute PR apply and reconcile accept the confirmed account fork", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "contributor",
    repository: "example/skill",
    relationship: "contribute",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "Fork contribution.",
      draft: true,
      head_repository: "contributor/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T08:15:00.000Z",
  });
  const pullRequest = {
    number: 7,
    url: "https://github.com/example/skill/pull/7",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: state.head_commit,
    headRepository: { nameWithOwner: "contributor/skill" },
    state: "OPEN",
    isDraft: true,
    statusCheckRollup: [],
    title: state.action_target.title,
    body: state.action_target.body,
  };
  const calls = [];
  const runner = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: "contributor\n", stderr: "" };
    }
    if (arguments_[0] === "repo" && arguments_[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example/skill",
          viewerPermission: "READ",
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] === "repos/example/skill/branches/main"
    ) {
      return { status: 0, stdout: `${state.base_commit}\n`, stderr: "" };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] === "repos/contributor/skill/commits/feature"
    ) {
      return { status: 0, stdout: `${state.head_commit}\n`, stderr: "" };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "create") {
      return { status: 0, stdout: `${pullRequest.url}\n`, stderr: "" };
    }
    if (arguments_[0] === "pr" && arguments_[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify(pullRequest),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };
  const applied = applyGithubAction(preview, approval, {
    now: "2026-07-23T08:10:00.000Z",
    runner,
    documentationImpact: DOCUMENTATION_IMPACT,
  });
  assert.equal(applied.proof.number, 7);
  assert.ok(
    calls.some(
      (arguments_) =>
        arguments_[0] === "pr" &&
        arguments_[1] === "create" &&
        arguments_.includes("contributor:feature"),
    ),
  );

  const recovered = reconcileGithubAction(preview, {
    documentationImpact: DOCUMENTATION_IMPACT,
    runner: (arguments_) => {
      assert.deepEqual(arguments_.slice(0, 2), ["pr", "list"]);
      assert.equal(
        arguments_[arguments_.indexOf("--head") + 1],
        "feature",
      );
      return {
        status: 0,
        stdout: JSON.stringify([pullRequest]),
        stderr: "",
      };
    },
  });
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.proof.number, 7);
});

test("PR create reconcile proves absence before a fresh confirmation", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "contributor",
    repository: "example/skill",
    relationship: "contribute",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "Fork contribution.",
      draft: true,
      head_repository: "contributor/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  const calls = [];
  const result = reconcileGithubAction(preview, {
    approvalFingerprint: "d".repeat(64),
    now: "2026-07-23T08:10:00.000Z",
    documentationImpact: DOCUMENTATION_IMPACT,
    runner: (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "pr" && arguments_[1] === "list") {
        assert.equal(
          arguments_[arguments_.indexOf("--head") + 1],
          "feature",
        );
        return { status: 0, stdout: "[]\n", stderr: "" };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1] === "--method" &&
        arguments_[2] === "GET"
      ) {
        assert.ok(arguments_.includes("head=contributor:feature"));
        return { status: 0, stdout: "[]\n", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
    },
  });

  assert.equal(result.status, "not_applied");
  assert.equal(result.absence_proof.action, "pr_create");
  assert.equal(
    result.absence_proof.approval_fingerprint,
    "d".repeat(64),
  );
  assert.equal(calls.length, 2);
});

test("PR create reconcile blocks metadata drift and recovers a REST identity match", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "contributor",
    repository: "example/skill",
    relationship: "contribute",
    base_branch: "main",
    base_commit: "b".repeat(40),
    head_branch: "feature",
    head_commit: "a".repeat(40),
    diff_hash: "diff123",
    action_target: {
      title: "Improve workflow",
      body: "Fork contribution.",
      draft: true,
      head_repository: "contributor/skill",
    },
    release_enabled: false,
    provider_contract_hash: "provider123",
  };
  const preview = buildGithubActionPreview("pr_create", state);
  const identity = {
    number: 7,
    url: "https://github.com/example/skill/pull/7",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: state.head_commit,
    headRepository: { nameWithOwner: "contributor/skill" },
    state: "OPEN",
    isDraft: true,
    statusCheckRollup: [],
    title: "Edited by a bot",
    body: state.action_target.body,
  };
  assert.throws(
    () =>
      reconcileGithubAction(preview, {
        approvalFingerprint: "d".repeat(64),
        documentationImpact: DOCUMENTATION_IMPACT,
        runner: () => ({
          status: 0,
          stdout: JSON.stringify([identity]),
          stderr: "",
        }),
      }),
    /metadata/u,
  );

  let readCount = 0;
  const recovered = reconcileGithubAction(preview, {
    documentationImpact: DOCUMENTATION_IMPACT,
    runner: (arguments_) => {
      readCount += 1;
      if (arguments_[0] === "pr") {
        return { status: 0, stdout: "[]\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            html_url: "https://github.com/example/skill/pull/7",
            base: { ref: "main" },
            head: {
              ref: "feature",
              sha: state.head_commit,
              repo: { full_name: "contributor/skill" },
            },
            state: "open",
            draft: true,
            title: state.action_target.title,
            body: state.action_target.body,
          },
        ]),
        stderr: "",
      };
    },
  });
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.proof.number, 7);
  assert.equal(readCount, 2);
});

test("merge and release reconcile return bound not-applied proofs", () => {
  const headCommit = "a".repeat(40);
  const base = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: headCommit,
    head_branch: "feature",
    head_commit: headCommit,
    diff_hash: "diff123",
    release_enabled: true,
    provider_contract_hash: "provider123",
  };
  const mergePreview = buildGithubActionPreview("merge", {
    ...base,
    action_target: { pr_number: 7, method: "squash" },
  });
  const mergeResult = reconcileGithubAction(mergePreview, {
    approvalFingerprint: "e".repeat(64),
    now: "2026-07-23T08:10:00.000Z",
    runner: (arguments_) => {
      assert.deepEqual(arguments_.slice(0, 3), ["pr", "view", "7"]);
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 7,
          baseRefName: "main",
          headRefOid: headCommit,
          headRepository: { nameWithOwner: "example/skill" },
          state: "OPEN",
          mergedAt: null,
          mergeCommit: null,
        }),
        stderr: "",
      };
    },
  });
  assert.equal(mergeResult.status, "not_applied");
  assert.equal(mergeResult.absence_proof.action, "merge");

  const coverage = evaluateReleaseNoteCoverage(
    {
      schema_version: 1,
      previous_ref: "v0.0.1",
      previous_commit: "0".repeat(40),
      candidate_ref: "HEAD",
      candidate_commit: headCommit,
      commits: [
        {
          commit: headCommit,
          subject: "feat: workflow",
          pull_requests: [7],
        },
      ],
      pull_requests: [7],
    },
    {
      mappings: [
        {
          id: "NOTE-001",
          disposition: "included",
          source_commits: [headCommit],
          source_prs: [7],
          optimization_ids: ["OPT-001"],
          note: "Publishes the workflow improvement.",
          reason: "",
        },
      ],
      requiredOptimizationIds: new Set(["OPT-001"]),
    },
  );
  const releasePreview = buildGithubActionPreview("release", {
    ...base,
    action_target: {
      version: "v0.1.0",
      title: "Agent Skill Maintainer v0.1.0",
      notes: "Preview release.",
      draft: false,
      prerelease: true,
      release_note_coverage: coverage,
    },
  });
  const releaseResult = reconcileGithubAction(releasePreview, {
    approvalFingerprint: "f".repeat(64),
    now: "2026-07-23T08:10:00.000Z",
    runner: (arguments_) => {
      assert.deepEqual(arguments_.slice(0, 2), ["api", "graphql"]);
      return {
        status: 0,
        stdout: JSON.stringify({ release: null, ref: null }),
        stderr: "",
      };
    },
  });
  assert.equal(releaseResult.status, "not_applied");
  assert.equal(releaseResult.absence_proof.action, "release");
});

test("GitHub update, merge, and release apply only their approved action", () => {
  const headCommit = "a".repeat(40);
  const base = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: headCommit,
    head_branch: "feature",
    head_commit: headCommit,
    diff_hash: "diff123",
    release_enabled: true,
    provider_contract_hash: "provider123",
  };
  const inventory = {
    schema_version: 1,
    previous_ref: "v0.0.1",
    previous_commit: "0".repeat(40),
    candidate_ref: "HEAD",
    candidate_commit: headCommit,
    commits: [
      {
        commit: headCommit,
        subject: "feat: workflow",
        pull_requests: [7],
      },
    ],
    pull_requests: [7],
  };
  const releaseCoverage = evaluateReleaseNoteCoverage(inventory, {
    mappings: [
      {
        id: "NOTE-001",
        disposition: "included",
        source_commits: [headCommit],
        source_prs: [7],
        optimization_ids: ["OPT-001"],
        note: "Publishes the workflow improvement.",
        reason: "",
      },
    ],
    requiredOptimizationIds: new Set(["OPT-001"]),
  });
  const scenarios = [
    {
      action: "pr_update",
      target: {
        pr_number: 7,
        title: "Improve workflow",
        body: "Updated body.",
      },
      mutation: ["pr", "edit", "7"],
      output: "",
    },
    {
      action: "merge",
      target: { pr_number: 7, method: "squash" },
      mutation: ["pr", "merge", "7"],
      output: "",
    },
    {
      action: "release",
      target: {
        version: "v0.1.0",
        title: "Agent Skill Maintainer v0.1.0",
        notes: "Preview release.",
        draft: false,
        prerelease: true,
        release_note_coverage: releaseCoverage,
      },
      mutation: ["release", "create", "v0.1.0"],
      output: "https://github.com/example/skill/releases/tag/v0.1.0\n",
    },
  ];

  for (const scenario of scenarios) {
    const preview = buildGithubActionPreview(scenario.action, {
      ...base,
      action_target: scenario.target,
    });
    const approval = buildGithubActionApproval(preview, {
      confirmedAt: "2026-07-23T08:00:00.000Z",
      expiresAt: "2026-07-23T08:15:00.000Z",
    });
    const calls = [];
    const runner = (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "api" && arguments_[1] === "user") {
        return { status: 0, stdout: "example-user\n", stderr: "" };
      }
      if (arguments_[0] === "repo" && arguments_[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            nameWithOwner: "example/skill",
            viewerPermission: "ADMIN",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "view") {
        const jsonFields = arguments_[arguments_.indexOf("--json") + 1];
        if (
          jsonFields ===
          "number,url,baseRefName,headRefName,headRefOid,headRepository,state,isDraft,statusCheckRollup,title,body"
        ) {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: 7,
              url: "https://github.com/example/skill/pull/7",
              baseRefName: "main",
              headRefOid: headCommit,
              headRepository: { nameWithOwner: "example/skill" },
              state: "OPEN",
              isDraft: false,
              statusCheckRollup: [
                { name: "validation", conclusion: "SUCCESS" },
              ],
              title: scenario.target.title,
              body: scenario.target.body,
            }),
            stderr: "",
          };
        }
        if (
          jsonFields ===
          "number,baseRefName,state,mergedAt,mergeCommit"
        ) {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: 7,
              baseRefName: "main",
              state: "MERGED",
              mergedAt: "2026-07-23T08:10:01.000Z",
              mergeCommit: { oid: "m".repeat(40) },
            }),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            baseRefName: "main",
            headRefName: "feature",
            headRefOid: headCommit,
            headRepository: { nameWithOwner: "example/skill" },
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            statusCheckRollup: [
              { name: "validation", conclusion: "SUCCESS" },
            ],
          }),
          stderr: "",
        };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1] === `repos/example/skill/commits/${headCommit}`
      ) {
        return { status: 0, stdout: `${headCommit}\n`, stderr: "" };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1] === "repos/example/skill/branches/main"
      ) {
        return { status: 0, stdout: `${headCommit}\n`, stderr: "" };
      }
      if (
        scenario.action === "release" &&
        arguments_[0] === "api" &&
        arguments_[1] === "graphql"
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({ release: null, ref: null }),
          stderr: "",
        };
      }
      if (
        scenario.action === "release" &&
        arguments_[0] === "api" &&
        arguments_[1] ===
          "repos/example/skill/immutable-releases"
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({ enabled: true }),
          stderr: "",
        };
      }
      if (
        scenario.action === "release" &&
        arguments_[0] === "release" &&
        arguments_[1] === "view"
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({
            tagName: "v0.1.0",
            targetCommitish: headCommit,
            url: scenario.output.trim(),
            isDraft: false,
            isPrerelease: true,
          }),
          stderr: "",
        };
      }
      if (
        scenario.action === "release" &&
        arguments_[0] === "api" &&
        arguments_[1] ===
          "repos/example/skill/commits/v0.1.0"
      ) {
        return { status: 0, stdout: `${headCommit}\n`, stderr: "" };
      }
      if (
        scenario.mutation.every(
          (part, index) => arguments_[index] === part,
        )
      ) {
        return { status: 0, stdout: scenario.output, stderr: "" };
      }
      throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
    };

    const result = applyGithubAction(preview, approval, {
      now: "2026-07-23T08:10:00.000Z",
      runner,
      documentationImpact:
        scenario.action === "pr_update"
          ? DOCUMENTATION_IMPACT
          : null,
    });
    assert.equal(result.action, scenario.action);
    if (scenario.action === "pr_update") {
      assert.equal(result.proof.number, 7);
      assert.equal(result.proof.state, "open");
    } else if (scenario.action === "merge") {
      assert.equal(result.proof.pr_number, 7);
      assert.equal(result.proof.merge_commit, "m".repeat(40));
    } else {
      assert.equal(result.proof.version, "v0.1.0");
      assert.equal(result.proof.commit, headCommit);
    }
    const mutation = calls.find((arguments_) =>
      scenario.mutation.every(
        (part, index) => arguments_[index] === part,
      ),
    );
    assert.ok(mutation);
    assert.ok(!mutation.includes("--admin"));
    assert.ok(!mutation.includes("--auto"));
  }
});

test("release preview requires complete coverage bound to head commit", () => {
  const inventory = {
    schema_version: 1,
    previous_ref: "v0.9.0",
    previous_commit: "base123",
    candidate_ref: "HEAD",
    candidate_commit: "abc123",
    commits: [
      {
        commit: "commit-one",
        subject: "feat: release candidate",
        pull_requests: [1],
      },
    ],
    pull_requests: [1],
  };
  const incompleteCoverage = evaluateReleaseNoteCoverage(inventory, {
    mappings: [],
    requiredOptimizationIds: new Set(["OPT-001"]),
  });
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: "base123",
    head_branch: "feature",
    head_commit: "abc123",
    diff_hash: "diff123",
    action_target: {
      version: "v1.0.0",
      title: "Agent Skill Maintainer v1.0.0",
      notes: "Release notes.",
      draft: false,
      prerelease: false,
      release_note_coverage: incompleteCoverage,
    },
    release_enabled: true,
    provider_contract_hash: "provider123",
  };
  assert.throws(
    () => buildGithubActionPreview("release", state),
    /尚未完成/u,
  );
  assert.throws(
    () =>
      buildGithubActionPreview("release", {
        ...state,
        action_target: {
          ...state.action_target,
          release_note_coverage: {
            complete: true,
            candidate_commit: "abc123",
          },
        },
      }),
    /覆蓋證明缺少/u,
  );
  state.action_target.release_note_coverage = evaluateReleaseNoteCoverage(
    inventory,
    {
      mappings: [
        {
          id: "NOTE-001",
          disposition: "included",
          source_commits: ["commit-one"],
          source_prs: [1],
          optimization_ids: ["OPT-001"],
          note: "Publishes the accepted workflow improvement.",
          reason: "",
        },
      ],
      requiredOptimizationIds: new Set(["OPT-001"]),
    },
  );
  assert.equal(
    buildGithubActionPreview("release", state).action,
    "release",
  );
  assert.throws(
    () =>
      buildGithubActionPreview("release", {
        ...state,
        action_target: {
          ...state.action_target,
          draft: true,
        },
      }),
    /非 draft/u,
  );
  assert.throws(
    () =>
      buildGithubActionPreview("release", {
        ...state,
        head_commit: "changed",
      }),
    /漂移/u,
  );
});
