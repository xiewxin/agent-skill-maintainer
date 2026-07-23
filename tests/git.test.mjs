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
  verifyGithubActionApproval,
  verifyGithubActionPreview,
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";
import {
  initializeRepository,
  optimizationFixture,
  runGit,
} from "./fixtures.mjs";

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

test("GitHub previews are stable, drift-bound, and do not apply", () => {
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    head_branch: "feature",
    head_commit: "abc123",
    diff_hash: "diff123",
    action_target: { title: "Improve workflow" },
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
  assert.throws(() => applyGithubAction(preview), /dry-run/u);
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
    head_branch: "feature",
    head_commit: "abc123",
    diff_hash: "diff123",
    action_target: {
      version: "v1.0.0",
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
        head_commit: "changed",
      }),
    /漂移/u,
  );
});
