import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildValidationResult,
  fingerprint,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  buildGithubActionApproval,
  buildGithubActionPreview,
  buildGithubCapabilityProof,
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";
import {
  buildLocalUpdateApproval,
} from "../skills/agent-skill-maintainer/scripts/lib/update.mjs";
import {
  evaluateReleaseNoteCoverage,
  fingerprintCandidatePath,
  fingerprintTree,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  createBranchPushFixture,
  forwardEvaluationBindingFixture,
} from "./fixtures.mjs";
import {
  authorizeGithubActionReconcile,
  createPublicationContinuation,
  InvalidStateTransition,
  LockUnavailableError,
  createRun,
  readRun,
  recordLocalUpdateOutcome,
  recordGithubActionReconciliation,
  reserveLocalUpdateApply,
  reserveGithubActionApply,
  transitionRun,
  withBindingLock,
} from "../skills/agent-skill-maintainer/scripts/lib/state.mjs";
import {
  runMaintainerCommand,
} from "../skills/agent-skill-maintainer/scripts/maintainer.mjs";

const LIVE_CANDIDATE = createBranchPushFixture({
  prefix: "maintainer-state-live-",
  branchName: "feature",
});
const REPOSITORY_SNAPSHOT = Object.freeze(
  LIVE_CANDIDATE.repositorySnapshot,
);

/** Builds an implementation confirmation bound to one run. */
function implementationApproval(runId = "run-001") {
  const approval = {
    schema_version: 1,
    action: "implementation",
    run_id: runId,
    binding_id: "binding-001",
    relationship: "managed",
    repository: "example/skill",
    head_commit: REPOSITORY_SNAPSHOT.head_commit,
    diff_hash: REPOSITORY_SNAPSHOT.diff_hash,
    process_artifact_prefixes:
      REPOSITORY_SNAPSHOT.process_artifact_prefixes,
    approved_opt_ids: ["OPT-001"],
    optimizations_hash: "b".repeat(64),
  };
  approval.fingerprint = fingerprint(approval);
  return approval;
}

const CANDIDATE_SNAPSHOT = Object.freeze(
  LIVE_CANDIDATE.candidateSnapshot,
);

const DOCUMENTATION_IMPACT = Object.freeze({
  schema_version: 1,
  status: "updated",
  changed_guides: ["README.md"],
  root_index_action: "verified-current",
  contract_preserved: true,
  reason: "使用說明已隨候選行為更新。",
});

const VALIDATION_SUMMARY = Object.freeze(
  buildValidationResult(CANDIDATE_SNAPSHOT, {
    checks: [
      {
        id: "publication",
        category: "safety",
        status: "passed",
        summary: "公開資料與安全檢查通過。",
      },
      {
        id: "regression",
        category: "regression",
        status: "passed",
        summary: "回歸案例通過。",
      },
      {
        id: "forward",
        category: "forward",
        status: "passed",
        summary: "前向合同案例通過。",
        details: forwardEvaluationBindingFixture(
          CANDIDATE_SNAPSHOT,
          LIVE_CANDIDATE.candidate,
        ),
      },
      {
        id: "quality",
        category: "quality",
        status: "passed",
        summary: "候選品質門檻通過。",
      },
      {
        id: "agent-documentation-impact",
        category: "documentation",
        status: "passed",
        summary: "Agent 指引影响已更新并验证。",
        details: DOCUMENTATION_IMPACT,
      },
    ],
    requiredCheckIds: new Set([
      "publication",
      "regression",
      "forward",
      "quality",
      "agent-documentation-impact",
    ]),
  }),
);

const PR_PROOF = Object.freeze({
  schema_version: 1,
  repository: "example/skill",
  number: 1,
  head_commit: CANDIDATE_SNAPSHOT.repository_snapshot.head_commit,
  base_branch: "main",
  state: "open",
  checks_passed: true,
  documentation_impact: DOCUMENTATION_IMPACT,
});

const BRANCH_PUSH_PROOF = Object.freeze({
  schema_version: 1,
  repository: "example/skill",
  head_repository: "example/skill",
  relationship: "managed",
  base_branch: "main",
  base_commit: CANDIDATE_SNAPSHOT.repository_snapshot.merge_base,
  branch: "feature",
  commit: CANDIDATE_SNAPSHOT.repository_snapshot.head_commit,
  candidate_diff_hash: CANDIDATE_SNAPSHOT.candidate_diff_hash,
  previous_remote_commit: null,
  operation: "create",
  forced: false,
  verified: true,
});

const FORK_PROOF = Object.freeze({
  schema_version: 1,
  repository: "example/skill",
  fork_repository: "example-user/skill",
  account: "example-user",
  relationship: "contribute",
  base_branch: "main",
  base_commit: REPOSITORY_SNAPSHOT.merge_base,
  default_branch_only: true,
  operation: "create",
  parent_repository: "example/skill",
  base_commit_available: true,
  verified: true,
});

const MERGE_COMMIT = "8".repeat(40);

const RELEASE_COVERAGE = Object.freeze(
  evaluateReleaseNoteCoverage(
    {
      schema_version: 1,
      previous_ref: "v0.9.0",
      previous_commit:
        CANDIDATE_SNAPSHOT.repository_snapshot.merge_base,
      candidate_ref: "HEAD",
      candidate_commit: MERGE_COMMIT,
      commits: [
        {
          commit: MERGE_COMMIT,
          subject: "feat: workflow improvement (#1)",
          pull_requests: [1],
        },
      ],
      pull_requests: [1],
    },
    {
      mappings: [
        {
          id: "NOTE-001",
          disposition: "included",
          source_commits: [MERGE_COMMIT],
          source_prs: [1],
          optimization_ids: ["OPT-001"],
          note: "Publishes the workflow improvement.",
          reason: "",
        },
      ],
      requiredOptimizationIds: new Set(["OPT-001"]),
    },
  ),
);
const LOCAL_PROVIDER_HASH = "9".repeat(64);

test.after(() => {
  rmSync(LIVE_CANDIDATE.root, { recursive: true, force: true });
});

/** Returns one exact Preview and expiring confirmation for a lifecycle action. */
function actionEvidence(
  action,
  {
    headCommit = CANDIDATE_SNAPSHOT.repository_snapshot.head_commit,
    baseCommit = action === "release"
      ? headCommit
      : CANDIDATE_SNAPSHOT.repository_snapshot.merge_base,
    runId = "run-001",
    relationship = action === "fork_create"
      ? "contribute"
      : "managed",
    actionTarget = action === "fork_create"
      ? {
          fork_repository: "example-user/skill",
          default_branch_only: true,
          operation: "create",
        }
      : action === "branch_push" || action === "publish_pr"
      ? {
          candidate_path_fingerprint: fingerprintCandidatePath(
            LIVE_CANDIDATE.candidate,
          ),
          expected_remote_commit: null,
          head_repository: "example/skill",
          operation: "create",
          ...(action === "publish_pr"
            ? {
                title: "Publish the verified workflow",
                body: "Includes the approved change.",
                draft: false,
              }
            : {}),
        }
      : action === "pr_update" || action === "merge"
        ? { pr_number: 1, summary: `${action} workflow improvement` }
        : { title: `${action} workflow improvement` },
  } = {},
) {
  const preview = buildGithubActionPreview(action, {
    run_id: runId,
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship,
    base_branch: "main",
    base_commit: baseCommit,
    head_branch: "feature",
    head_commit: headCommit,
    diff_hash: CANDIDATE_SNAPSHOT.candidate_diff_hash,
    action_target: actionTarget,
    capability_proof: buildGithubCapabilityProof({
      account: "example-user",
      repository: "example/skill",
      permission: relationship === "managed" ? "ADMIN" : "READ",
      defaultBranch: "main",
      immutableReleases: true,
      inspectedAt: "2026-07-28T08:00:00.000Z",
    }),
    provider_contract_hash: "provider123",
  });
  const confirmedAt = new Date(Date.now() - 60_000);
  const approval = buildGithubActionApproval(preview, {
    confirmedAt: confirmedAt.toISOString(),
    expiresAt: new Date(
      confirmedAt.getTime() + 15 * 60 * 1000,
    ).toISOString(),
  });
  return { action_preview: preview, approvals: [approval] };
}

/** Returns one exact local update Preview and expiring confirmation. */
function localUpdateEvidence() {
  const preview = {
    schema_version: 1,
    action: "local_update",
    state: {
      run_id: "run-001",
      binding_id: "binding-001",
      skill: "example-skill",
      repository: "example/skill",
      relationship: "managed",
      from_version: "v0.9.0",
      to_version: "v1.0.0",
      release_tag: "v1.0.0",
      source_commit: MERGE_COMMIT,
      install_method: "npx-skills",
      scope: "global",
      mode: "symlink",
      source_url: "https://github.com/example/skill.git",
      skill_path: "skills/example-skill/SKILL.md",
      agents: ["claude-code", "codex"],
      lock_schema_version: 3,
      canonical_path_fingerprint: "a".repeat(64),
      current_fingerprint: "b".repeat(64),
      target_tree_sha: "c".repeat(40),
      current_ref: "v0.9.0",
      target_ref: "v1.0.0",
      lock_entry_hash: "d".repeat(64),
      agent_links_hash: "e".repeat(64),
      provider_contract_hash: LOCAL_PROVIDER_HASH,
    },
  };
  preview.fingerprint = fingerprint(preview);
  const confirmedAt = new Date(Date.now() - 60_000);
  const approval = buildLocalUpdateApproval(preview, {
    confirmedAt: confirmedAt.toISOString(),
    expiresAt: new Date(
      confirmedAt.getTime() + 15 * 60 * 1000,
    ).toISOString(),
  });
  return { action_preview: preview, approvals: [approval] };
}

/** Returns a verified proof matching localUpdateEvidence. */
function localUpdateProof() {
  return {
    schema_version: 2,
    run_id: "run-001",
    binding_id: "binding-001",
    skill: "example-skill",
    repository: "example/skill",
    from_version: "v0.9.0",
    to_version: "v1.0.0",
    release_tag: "v1.0.0",
    source_commit: MERGE_COMMIT,
    install_method: "npx-skills",
    scope: "global",
    mode: "symlink",
    canonical_path_fingerprint: "a".repeat(64),
    previous_fingerprint: "b".repeat(64),
    installed_fingerprint: "f".repeat(64),
    lock_entry_hash: "1".repeat(64),
    agent_links_hash: "e".repeat(64),
    operation: "update",
    activation: "future_tasks_only",
    verified_at: new Date().toISOString(),
    verified: true,
  };
}

/** Runs one state test with an isolated root. */
function withStateRoot(operation) {
  const root = mkdtempSync(join(tmpdir(), "maintainer-state-"));
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("run state is minimal, versioned, and recoverable", () => {
  withStateRoot((root) => {
    const created = createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    assert.equal(created.schema_version, 8);
    assert.equal(created.phase, "target_selection");
    assert.deepEqual(readRun(root, "run-001"), created);
    assert.doesNotMatch(JSON.stringify(created), /raw_transcript|secret/u);
    assert.throws(() =>
      createRun(root, {
        runId: "run-002",
        bindingId: "binding-001",
        target: {
          skill: "example-skill",
          raw_transcript: "must not persist",
        },
      }),
    );
  });
});

test("invalid transitions fail and terminal phases clear approvals", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: { skill: "example-skill" },
    });
    assert.throws(
      () => transitionRun(root, "run-001", "implementation"),
      InvalidStateTransition,
    );
    transitionRun(root, "run-001", "evidence_collection");
    const aborted = transitionRun(root, "run-001", "aborted");
    assert.equal(aborted.status, "aborted");
    assert.deepEqual(aborted.approvals, []);
    assert.throws(
      () => transitionRun(root, "run-001", "completed"),
      InvalidStateTransition,
    );
  });
});

test("validation rejects a snapshot for a decoy Skill path", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
    ]) {
      transitionRun(root, "run-001", phase, { updates });
    }
    const decoy = structuredClone(CANDIDATE_SNAPSHOT);
    decoy.skill_path = ".";
    decoy.skill_name = "decoy-skill";
    decoy.candidate_skill_fingerprint = fingerprintTree(
      LIVE_CANDIDATE.candidate,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "validation", {
          updates: { candidate_snapshot: decoy },
        }),
      /已確認 target/u,
    );
  });
});

test("full managed lifecycle includes PR update and local update", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    const phases = [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "branch_push",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("branch_push"),
        },
      ],
      [
        "pr_creation",
        {
          branch_push_proof: BRANCH_PUSH_PROOF,
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("pr_create"),
        },
      ],
      [
        "pr_update",
        {
          pr_proof: PR_PROOF,
          ...actionEvidence("pr_update"),
        },
      ],
      [
        "merge",
        {
          pr_proof: PR_PROOF,
          ...actionEvidence("merge"),
        },
      ],
      [
        "release",
        {
          merge_proof: {
            schema_version: 1,
            repository: "example/skill",
            pr_number: 1,
            merge_commit: MERGE_COMMIT,
            default_branch: "main",
          },
          release_coverage: RELEASE_COVERAGE,
          ...actionEvidence("release", {
            headCommit: MERGE_COMMIT,
            actionTarget: {
              version: "v1.0.0",
              title: "Agent Skill Maintainer v1.0.0",
              notes: "Release notes.",
              draft: false,
              prerelease: false,
              release_note_coverage: RELEASE_COVERAGE,
            },
          }),
        },
      ],
    ];
    let document;
    for (const [phase, updates] of phases) {
      document = transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
      assert.equal(document.phase, phase);
    }
    const updateEvidence = localUpdateEvidence();
    document = transitionRun(root, "run-001", "local_update", {
      updates: {
        publication_proof: {
          schema_version: 1,
          repository: "example/skill",
          version: "v1.0.0",
          tag: "v1.0.0",
          commit: MERGE_COMMIT,
          release_url: "https://github.com/example/skill/releases/tag/v1.0.0",
          official: true,
        },
        ...updateEvidence,
      },
    });
    assert.equal(document.phase, "local_update");
    assert.throws(
      () => transitionRun(root, "run-001", "completed"),
      /update-proof/u,
    );
    const approval = updateEvidence.approvals[0];
    reserveLocalUpdateApply(
      root,
      "run-001",
      updateEvidence.action_preview,
      approval,
      { providerContractHash: LOCAL_PROVIDER_HASH },
    );
    assert.throws(
      () =>
        reserveLocalUpdateApply(
          root,
          "run-001",
          updateEvidence.action_preview,
          approval,
          { providerContractHash: LOCAL_PROVIDER_HASH },
        ),
      /不可重放/u,
    );
    assert.throws(
      () =>
        recordLocalUpdateOutcome(
          root,
          "run-001",
          updateEvidence.action_preview,
          approval,
          {
            proof: {
              ...localUpdateProof(),
              previous_fingerprint: "9".repeat(64),
            },
          },
          { providerContractHash: LOCAL_PROVIDER_HASH },
        ),
      /目前 run 不一致/u,
    );
    recordLocalUpdateOutcome(
      root,
      "run-001",
      updateEvidence.action_preview,
      approval,
      { proof: localUpdateProof() },
      { providerContractHash: LOCAL_PROVIDER_HASH },
    );
    document = transitionRun(root, "run-001", "completed", {
      updates: {
        completion_disposition: {
          schema_version: 1,
          kind: "local_update_verified",
          after_phase: "local_update",
          reason: "The exact published Skill update was verified.",
        },
      },
    });
    assert.equal(document.phase, "completed");
    assert.equal(document.status, "completed");
  });
});

test("merge completion is explicit and can seed one verified release continuation", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-source",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval("run-source")],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "branch_push",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("branch_push", {
            runId: "run-source",
          }),
        },
      ],
      [
        "pr_creation",
        {
          branch_push_proof: BRANCH_PUSH_PROOF,
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("pr_create", {
            runId: "run-source",
          }),
        },
      ],
      [
        "merge",
        {
          pr_proof: PR_PROOF,
          ...actionEvidence("merge", {
            runId: "run-source",
          }),
        },
      ],
    ]) {
      transitionRun(root, "run-source", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    assert.throws(
      () => transitionRun(root, "run-source", "completed"),
      /completion disposition/u,
    );
    const mergeProof = {
      schema_version: 1,
      repository: "example/skill",
      pr_number: 1,
      merge_commit: MERGE_COMMIT,
      default_branch: "main",
    };
    const completed = transitionRun(
      root,
      "run-source",
      "completed",
      {
        updates: {
          pr_proof: PR_PROOF,
          merge_proof: mergeProof,
          completion_disposition: {
            schema_version: 1,
            kind: "stop_after_merge",
            after_phase: "merge",
            reason: "The user stopped after the verified merge.",
          },
        },
      },
    );
    assert.equal(
      completed.completion_disposition.kind,
      "stop_after_merge",
    );
    const sourcePath = join(
      root,
      "runs",
      "run-source",
      "state.json",
    );
    const pendingSource = structuredClone(completed);
    pendingSource.github_action_attempts.push({
      action: "merge",
      approval_fingerprint: "f".repeat(64),
      attempted_at: "2026-07-28T08:30:00.000Z",
    });
    writeFileSync(
      sourcePath,
      `${JSON.stringify(pendingSource)}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        createPublicationContinuation(root, {
          sourceRunId: "run-source",
          runId: "run-release-pending",
          bindingId: "binding-001",
          mergeProof,
        }),
      /GitHub action.*reconcile/u,
    );
    assert.equal(
      existsSync(
        join(root, "runs", "run-release-pending", "state.json"),
      ),
      false,
    );
    writeFileSync(
      sourcePath,
      `${JSON.stringify(completed)}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        createPublicationContinuation(root, {
          sourceRunId: "run-source",
          runId: "run-release-invalid",
          bindingId: "binding-001",
          mergeProof: {
            ...mergeProof,
            merge_commit: "0".repeat(40),
          },
        }),
      /merge proof/u,
    );
    const continuation = createPublicationContinuation(root, {
      sourceRunId: "run-source",
      runId: "run-release",
      bindingId: "binding-001",
      mergeProof,
    });
    assert.equal(continuation.phase, "merge");
    assert.equal(continuation.status, "active");
    assert.equal(
      continuation.continuation.source_run_id,
      "run-source",
    );
    assert.deepEqual(continuation.merge_proof, mergeProof);
  });
});

test("legacy terminal merge recovery requires exact fresh GitHub proof", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-legacy",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval("run-legacy")],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "branch_push",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("branch_push", {
            runId: "run-legacy",
          }),
        },
      ],
      [
        "pr_creation",
        {
          branch_push_proof: BRANCH_PUSH_PROOF,
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("pr_create", {
            runId: "run-legacy",
          }),
        },
      ],
    ]) {
      transitionRun(root, "run-legacy", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    transitionRun(root, "run-legacy", "completed", {
      updates: {
        pr_proof: PR_PROOF,
        completion_disposition: {
          schema_version: 1,
          kind: "stop_after_pr",
          after_phase: "pr_creation",
          reason: "Legacy controller stopped after publication handoff.",
        },
      },
    });
    const mergeProof = {
      schema_version: 1,
      repository: "example/skill",
      pr_number: 1,
      merge_commit: MERGE_COMMIT,
      default_branch: "main",
    };
    assert.throws(
      () =>
        createPublicationContinuation(root, {
          sourceRunId: "run-legacy",
          runId: "run-v8-stop-after-pr",
          bindingId: "binding-001",
          mergeProof,
        }),
      /只有明確 stop_after_merge 或可驗證 legacy_completed/u,
    );

    const sourcePath = join(
      root,
      "runs",
      "run-legacy",
      "state.json",
    );
    const legacy = JSON.parse(readFileSync(sourcePath, "utf8"));
    legacy.schema_version = 7;
    delete legacy.completion_disposition;
    delete legacy.target.skill_path;
    for (const field of [
      "skill_path",
      "skill_name",
      "candidate_skill_fingerprint",
      "evaluation_fixture_path",
      "evaluation_fixture_sha256",
    ]) {
      delete legacy.candidate_snapshot[field];
    }
    const legacyChecks = legacy.validation_summary.checks.map(
      (check) =>
        check.category === "forward"
          ? { ...check, details: undefined }
          : check,
    );
    legacy.validation_summary = buildValidationResult(
      legacy.candidate_snapshot,
      {
        checks: legacyChecks,
        requiredCheckIds: new Set(
          legacyChecks.map((check) => check.id),
        ),
      },
    );
    writeFileSync(sourcePath, `${JSON.stringify(legacy)}\n`, "utf8");

    let observations = 0;
    let liveState = "MERGED";
    let remoteChangedFiles = [
      ...CANDIDATE_SNAPSHOT.changed_files,
    ];
    const githubRunner = (arguments_) => {
      observations += 1;
      if (
        arguments_[0] === "api" &&
        arguments_[1] === "--paginate"
      ) {
        assert.deepEqual(arguments_, [
          "api",
          "--paginate",
          "--slurp",
          "repos/example/skill/pulls/1/files?per_page=100",
        ]);
        return {
          status: 0,
          stdout: JSON.stringify([
            remoteChangedFiles.map((filename) => ({ filename })),
          ]),
          stderr: "",
        };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1].includes("/git/trees/")
      ) {
        assert.deepEqual(arguments_, [
          "api",
          `repos/example/skill/git/trees/${MERGE_COMMIT}?recursive=1`,
        ]);
        return {
          status: 0,
          stdout: JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "SKILL.md",
                mode: "100644",
                type: "blob",
                sha: "a".repeat(40),
              },
              {
                path: "skill/SKILL.md",
                mode: "100644",
                type: "blob",
                sha: "b".repeat(40),
              },
            ],
          }),
          stderr: "",
        };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1].endsWith(`/${"a".repeat(40)}`)
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(
              "---\nname: decoy-skill\n---\n",
            ).toString("base64"),
          }),
          stderr: "",
        };
      }
      if (
        arguments_[0] === "api" &&
        arguments_[1].endsWith(`/${"b".repeat(40)}`)
      ) {
        return {
          status: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(
              "---\nname: example-skill\n---\n",
            ).toString("base64"),
          }),
          stderr: "",
        };
      }
      assert.deepEqual(arguments_, [
        "pr",
        "view",
        "1",
        "--repo",
        "example/skill",
        "--json",
        "number,baseRefName,headRefOid,state,mergedAt,mergeCommit",
      ]);
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 1,
          baseRefName: "main",
          headRefOid:
            CANDIDATE_SNAPSHOT.repository_snapshot.head_commit,
          state: liveState,
          mergedAt: "2026-07-28T08:55:24.000Z",
          mergeCommit: { oid: MERGE_COMMIT },
        }),
        stderr: "",
      };
    };

    assert.throws(
      () =>
        createPublicationContinuation(
          root,
          {
            sourceRunId: "run-legacy",
            runId: "run-release-invalid",
            bindingId: "binding-001",
            mergeProof: {
              ...mergeProof,
              merge_commit: "0".repeat(40),
            },
          },
          { githubRunner },
        ),
      /merge proof.*GitHub/u,
    );
    assert.equal(
      existsSync(
        join(root, "runs", "run-release-invalid", "state.json"),
      ),
      false,
    );
    assert.equal(
      JSON.parse(readFileSync(sourcePath, "utf8")).schema_version,
      7,
    );

    liveState = "OPEN";
    assert.throws(
      () =>
        createPublicationContinuation(
          root,
          {
            sourceRunId: "run-legacy",
            runId: "run-release-open",
            bindingId: "binding-001",
            mergeProof,
          },
          { githubRunner },
        ),
      /merge proof.*GitHub/u,
    );
    assert.equal(
      existsSync(
        join(root, "runs", "run-release-open", "state.json"),
      ),
      false,
    );
    assert.equal(
      JSON.parse(readFileSync(sourcePath, "utf8")).schema_version,
      7,
    );

    liveState = "MERGED";
    remoteChangedFiles = [
      ...CANDIDATE_SNAPSHOT.changed_files,
      "other/SKILL.md",
    ];
    assert.throws(
      () =>
        createPublicationContinuation(
          root,
          {
            sourceRunId: "run-legacy",
            runId: "run-release-extra-remote-skill",
            bindingId: "binding-001",
            mergeProof,
          },
          { githubRunner },
        ),
      /changed files.*GitHub Pull Request/u,
    );
    assert.equal(
      existsSync(
        join(
          root,
          "runs",
          "run-release-extra-remote-skill",
          "state.json",
        ),
      ),
      false,
    );
    remoteChangedFiles = [...CANDIDATE_SNAPSHOT.changed_files];
    const mergeProofPath = join(root, "merge-proof.json");
    writeFileSync(
      mergeProofPath,
      `${JSON.stringify(mergeProof)}\n`,
      "utf8",
    );
    const continuation = runMaintainerCommand(
      [
        "publication-continue",
        "--state-root",
        root,
        "--source-run-id",
        "run-legacy",
        "--run-id",
        "run-release",
        "--binding-id",
        "binding-001",
        "--merge-proof",
        mergeProofPath,
      ],
      { githubRunner },
    );
    assert.equal(observations, 10);
    assert.equal(
      continuation.continuation.source_completion_kind,
      "legacy_completed",
    );
    assert.match(
      continuation.continuation
        .legacy_merge_verification_fingerprint,
      /^[a-f0-9]{64}$/u,
    );
    assert.deepEqual(continuation.merge_proof, mergeProof);
    assert.equal(continuation.target.skill_path, "skill");
    assert.equal(continuation.candidate_snapshot.skill_path, "skill");
    assert.equal(
      continuation.candidate_snapshot.skill_name,
      "example-skill",
    );
    assert.match(
      continuation.candidate_snapshot
        .candidate_skill_fingerprint,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(
      JSON.parse(readFileSync(sourcePath, "utf8")).schema_version,
      7,
    );
    const continuationBeforeMergeRetry = readRun(root, "run-release");
    assert.throws(
      () => transitionRun(root, "run-release", "merge"),
      /continuation.*不可再次進入 merge/u,
    );
    assert.deepEqual(
      readRun(root, "run-release"),
      continuationBeforeMergeRetry,
    );
    const releaseEvidence = actionEvidence("release", {
      headCommit: MERGE_COMMIT,
      runId: "run-release",
      actionTarget: {
        version: "v1.0.0",
        title: "Agent Skill Maintainer v1.0.0",
        notes: "Release notes.",
        draft: false,
        prerelease: false,
        release_note_coverage: RELEASE_COVERAGE,
      },
    });
    const release = transitionRun(root, "run-release", "release", {
      updates: {
        merge_proof: mergeProof,
        release_coverage: RELEASE_COVERAGE,
        ...releaseEvidence,
      },
    });
    assert.equal(release.phase, "release");

    const continuationPath = join(
      root,
      "runs",
      "run-release",
      "state.json",
    );
    const tampered = JSON.parse(
      readFileSync(continuationPath, "utf8"),
    );
    delete tampered.continuation
      .legacy_merge_verification_fingerprint;
    writeFileSync(
      continuationPath,
      `${JSON.stringify(tampered)}\n`,
      "utf8",
    );
    assert.throws(
      () => readRun(root, "run-release"),
      /缺少唯讀 merge 或 candidate identity verification/u,
    );
  });
});

test("publish_pr keeps granular pr_create fallback after a verified push", () => {
  withStateRoot((root) => {
    const publishEvidence = actionEvidence("publish_pr");
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "publish_pr",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...publishEvidence,
        },
      ],
    ]) {
      transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    reserveGithubActionApply(
      root,
      "run-001",
      publishEvidence.action_preview,
      publishEvidence.approvals[0],
      { providerContractHash: "provider123" },
    );
    assert.throws(
      () => transitionRun(root, "run-001", "aborted"),
      /尚未 reconciliation/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "completed", {
          updates: {
            pr_proof: PR_PROOF,
            completion_disposition: {
              schema_version: 1,
              kind: "stop_after_pr",
              after_phase: "publish_pr",
              reason: "An in-flight writer cannot be bypassed.",
            },
          },
        }),
      /尚未 reconciliation/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "optimization_approval", {
          updates: { optimization_ids: ["OPT-001"] },
        }),
      /尚未 reconciliation/u,
    );
    assert.equal(readRun(root, "run-001").status, "active");
    assert.throws(
      () => transitionRun(root, "run-001", "publish_pr"),
      /尚未 reconciliation/u,
    );
    const prCreateUpdates = {
      branch_push_proof: BRANCH_PUSH_PROOF,
      validation_summary: VALIDATION_SUMMARY,
      ...actionEvidence("pr_create"),
    };
    assert.throws(
      () =>
        transitionRun(
          root,
          "run-001",
          "pr_creation",
          { updates: prCreateUpdates },
        ),
      /尚未 reconciliation/u,
    );
    recordGithubActionReconciliation(
      root,
      "run-001",
      publishEvidence.action_preview,
      publishEvidence.approvals[0],
      {
        schema_version: 1,
        action: "publish_pr",
        repository: "example/skill",
        approval_fingerprint:
          publishEvidence.approvals[0].fingerprint,
        preview_fingerprint:
          publishEvidence.action_preview.fingerprint,
        observed_at: "2026-07-24T08:10:00.000Z",
        status: "partial",
        remote_state_hash: "d".repeat(64),
      },
      { providerContractHash: "provider123" },
    );
    const fallback = transitionRun(
      root,
      "run-001",
      "pr_creation",
      {
        updates: prCreateUpdates,
      },
    );
    assert.equal(fallback.phase, "pr_creation");
  });
});

test("contribute lifecycle requires verified Fork proof before branch push", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
    ]) {
      transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    const branchEvidence = actionEvidence("branch_push", {
      relationship: "contribute",
      actionTarget: {
        candidate_path_fingerprint: fingerprintCandidatePath(
          LIVE_CANDIDATE.candidate,
        ),
        expected_remote_commit: null,
        head_repository: "example-user/skill",
        operation: "create",
      },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "branch_push", {
          candidatePath: LIVE_CANDIDATE.candidate,
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...branchEvidence,
          },
        }),
      /Fork proof/u,
    );

    transitionRun(root, "run-001", "fork_creation", {
      updates: {
        validation_summary: VALIDATION_SUMMARY,
        ...actionEvidence("fork_create"),
      },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "branch_push", {
          candidatePath: LIVE_CANDIDATE.candidate,
          updates: {
            fork_proof: {
              ...FORK_PROOF,
              parent_repository: "other/skill",
            },
            validation_summary: VALIDATION_SUMMARY,
            ...branchEvidence,
          },
        }),
      /Fork proof/u,
    );
    const pushed = transitionRun(root, "run-001", "branch_push", {
      candidatePath: LIVE_CANDIDATE.candidate,
      updates: {
        fork_proof: FORK_PROOF,
        validation_summary: VALIDATION_SUMMARY,
        ...branchEvidence,
      },
    });
    assert.equal(pushed.phase, "branch_push");
    assert.deepEqual(pushed.fork_proof, FORK_PROOF);
  });
});

test("Fork attempts persist time and pending reconciliation without replay", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
    ]) {
      transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    const evidence = actionEvidence("fork_create");
    transitionRun(root, "run-001", "fork_creation", {
      updates: {
        validation_summary: VALIDATION_SUMMARY,
        ...evidence,
      },
    });
    const approval = evidence.approvals[0];
    const attemptedAt = approval.confirmed_at;
    const reserved = reserveGithubActionApply(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      {
        providerContractHash: "provider123",
        now: attemptedAt,
      },
    );
    assert.deepEqual(reserved.github_action_attempts, [
      {
        action: "fork_create",
        approval_fingerprint: approval.fingerprint,
        attempted_at: attemptedAt,
        preview_fingerprint: evidence.action_preview.fingerprint,
        repository: "example/skill",
        fork_repository: "example-user/skill",
      },
    ]);

    const pending = {
      schema_version: 1,
      action: "fork_create",
      repository: "example/skill",
      approval_fingerprint: approval.fingerprint,
      preview_fingerprint: evidence.action_preview.fingerprint,
      observed_at: new Date(
        Date.parse(attemptedAt) + 60_000,
      ).toISOString(),
      status: "pending",
      remote_state_hash: "c".repeat(64),
    };
    const recorded = recordGithubActionReconciliation(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      pending,
      { providerContractHash: "provider123" },
    );
    assert.deepEqual(recorded.github_action_reconciliations, [pending]);
    assert.throws(
      () =>
        transitionRun(root, "run-001", "aborted", {
          updates: {
            completion_disposition: {
              schema_version: 1,
              kind: "no_improvements",
              after_phase: "optimization_design",
              reason: "Pending writer must retain execution ownership.",
            },
          },
        }),
      /尚未 reconciliation/u,
    );
    assert.deepEqual(readRun(root, "run-001"), recorded);
    assert.throws(
      () =>
        transitionRun(root, "run-001", "fork_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("fork_create"),
          },
        }),
      /尚未 reconciliation/u,
    );

    const blocked = {
      ...pending,
      observed_at: new Date(
        Date.parse(attemptedAt) + 6 * 60_000,
      ).toISOString(),
      status: "blocked",
      remote_state_hash: "e".repeat(64),
    };
    const terminal = recordGithubActionReconciliation(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      blocked,
      { providerContractHash: "provider123" },
    );
    assert.deepEqual(
      terminal.github_action_reconciliations,
      [pending, blocked],
    );
    assert.throws(
      () =>
        recordGithubActionReconciliation(
          root,
          "run-001",
          evidence.action_preview,
          approval,
          {
            ...blocked,
            observed_at: new Date(
              Date.parse(attemptedAt) + 7 * 60_000,
            ).toISOString(),
          },
          { providerContractHash: "provider123" },
        ),
      /終止狀態/u,
    );
  });
});

test("GitHub apply reservation binds the active run and blocks replay", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "branch_push",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("branch_push"),
        },
      ],
    ]) {
      transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }
    const evidence = actionEvidence("pr_create");
    transitionRun(root, "run-001", "pr_creation", {
      updates: {
        branch_push_proof: BRANCH_PUSH_PROOF,
        validation_summary: VALIDATION_SUMMARY,
        ...evidence,
      },
    });
    const approval = evidence.approvals[0];
    const reserved = reserveGithubActionApply(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      {
        providerContractHash: "provider123",
      },
    );
    assert.deepEqual(
      reserved.attempted_github_action_fingerprints,
      [approval.fingerprint],
    );
    assert.deepEqual(reserved.github_action_attempts, [
      {
        action: "pr_create",
        approval_fingerprint: approval.fingerprint,
      },
    ]);
    const reconciled = authorizeGithubActionReconcile(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      {
        providerContractHash: "provider123",
      },
    );
    assert.equal(reconciled.phase, "pr_creation");
    const blockedRetryApproval = buildGithubActionApproval(
      evidence.action_preview,
      {
        confirmedAt: new Date(Date.now() - 90_000).toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            action_preview: evidence.action_preview,
            approvals: [blockedRetryApproval],
          },
        }),
      /尚未 reconciliation/u,
    );
    const absenceProof = {
      schema_version: 1,
      action: "pr_create",
      repository: "example/skill",
      approval_fingerprint: approval.fingerprint,
      preview_fingerprint: evidence.action_preview.fingerprint,
      observed_at: new Date().toISOString(),
      status: "not_applied",
      remote_state_hash: "c".repeat(64),
    };
    const recorded = recordGithubActionReconciliation(
      root,
      "run-001",
      evidence.action_preview,
      approval,
      absenceProof,
      {
        providerContractHash: "provider123",
      },
    );
    assert.deepEqual(recorded.github_action_reconciliations, [
      absenceProof,
    ]);
    assert.throws(
      () =>
        reserveGithubActionApply(
          root,
          "run-001",
          evidence.action_preview,
          approval,
          {
            providerContractHash: "provider123",
          },
        ),
      /不可重放/u,
    );
    const refreshedApproval = buildGithubActionApproval(
      evidence.action_preview,
      {
        confirmedAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    );
    transitionRun(root, "run-001", "pr_creation", {
      updates: {
        validation_summary: VALIDATION_SUMMARY,
        action_preview: evidence.action_preview,
        approvals: [refreshedApproval],
      },
    });
    const retried = reserveGithubActionApply(
      root,
      "run-001",
      evidence.action_preview,
      refreshedApproval,
      {
        providerContractHash: "provider123",
      },
    );
    assert.deepEqual(
      retried.attempted_github_action_fingerprints,
      [approval.fingerprint, refreshedApproval.fingerprint],
    );
  });
});

test("legacy terminal run migrates before current schema validation", () => {
  withStateRoot((root) => {
    const path = join(root, "runs", "run-001", "state.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "completed",
        status: "completed",
        target: { skill: "example-skill" },
        approvals: [],
      }),
      "utf8",
    );
    const migrated = readRun(root, "run-001");
    assert.equal(migrated.schema_version, 8);
    assert.equal(migrated.phase, "completed");
    assert.equal(
      migrated.completion_disposition.kind,
      "legacy_completed",
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), migrated);
  });
});

test("v5 run migrates to v8 without inventing remote evidence", () => {
  withStateRoot((root) => {
    const path = join(root, "runs", "run-001", "state.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        schema_version: 5,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "target_selection",
        status: "active",
        target: { skill: "example-skill" },
        approvals: [],
        consumed_approval_fingerprints: [],
        attempted_github_action_fingerprints: [],
        github_action_attempts: [],
        github_action_reconciliations: [],
      })}\n`,
      "utf8",
    );
    const migrated = readRun(root, "run-001");
    assert.equal(migrated.schema_version, 8);
    assert.equal(migrated.fork_proof, undefined);
    assert.deepEqual(migrated.github_action_attempts, []);
    assert.deepEqual(migrated.local_update_attempts, []);
  });
});

test("legacy active local update cannot inherit the new approval contract", () => {
  withStateRoot((root) => {
    const path = join(root, "runs", "run-001", "state.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        schema_version: 6,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "local_update",
        status: "active",
        target: {
          skill: "example-skill",
          repository: "example/skill",
        },
        approvals: [],
        consumed_approval_fingerprints: [],
        attempted_github_action_fingerprints: [],
        github_action_attempts: [],
        github_action_reconciliations: [],
      })}\n`,
      "utf8",
    );
    assert.throws(
      () => readRun(root, "run-001"),
      /缺少新版獨立審批/u,
    );
  });
});

test("legacy active remote stages are rejected without branch push proof", () => {
  withStateRoot((root) => {
    const path = join(root, "runs", "run-001", "state.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        schema_version: 3,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "merge",
        status: "active",
        target: {
          skill: "example-skill",
          repository: "example/skill",
        },
        approvals: [],
        consumed_approval_fingerprints: [
          "a".repeat(64),
          "b".repeat(64),
        ],
        attempted_github_action_fingerprints: [
          "a".repeat(64),
          "b".repeat(64),
        ],
      })}\n`,
      "utf8",
    );

    assert.throws(
      () => readRun(root, "run-001"),
      /缺少 branch push proof/u,
    );
  });
});

test("state identity mismatch and unsafe IDs are rejected", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: { skill: "example-skill" },
    });
    const path = join(root, "runs", "run-001", "state.json");
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.run_id = "run-002";
    writeFileSync(path, JSON.stringify(document), "utf8");
    assert.throws(() => readRun(root, "run-001"), /身份/u);
    assert.throws(() =>
      createRun(root, {
        runId: "../escape",
        bindingId: "binding-001",
        target: { skill: "example-skill" },
      }),
    );
  });
});

test("operation lock is binding-scoped and stale locks recover", () => {
  withStateRoot((root) => {
    withBindingLock(root, "binding-001", () => {
      assert.throws(
        () => withBindingLock(root, "binding-001", () => {}),
        LockUnavailableError,
      );
      withBindingLock(root, "binding-002", () => {
        assert.ok(true);
      });
    });
    const digest = createHash("sha256").update("binding-001").digest("hex");
    const path = join(root, "locks", `${digest}.lock`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        binding_id: "binding-001",
        pid: 999_999_999,
      }),
      "utf8",
    );
    withBindingLock(root, "binding-001", () => {
      assert.ok(true);
    });
  });
});

test("implementation lease blocks a second run until terminal cleanup", () => {
  withStateRoot((root) => {
    for (const runId of ["run-001", "run-002"]) {
      createRun(root, {
        runId,
        bindingId: "binding-001",
        target: {
          skill: "example-skill",
          skill_path: "skill",
          repository: "example/skill",
        },
      });
      for (const phase of [
        "evidence_collection",
        "feedback_validation",
        "optimization_design",
        "optimization_approval",
      ]) {
        transitionRun(root, runId, phase);
      }
    }
    transitionRun(root, "run-001", "isolation", {
      updates: {
        repository_snapshot: REPOSITORY_SNAPSHOT,
        approvals: [implementationApproval()],
      },
    });
    assert.throws(
      () => transitionRun(root, "run-002", "isolation"),
      LockUnavailableError,
    );
    transitionRun(root, "run-001", "aborted");
    assert.equal(
      transitionRun(root, "run-002", "isolation", {
        updates: {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval("run-002")],
        },
      }).phase,
      "isolation",
    );
  });
});

test("persisted lifecycle evidence is semantically revalidated", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const phase of [
      "evidence_collection",
      "feedback_validation",
      "optimization_design",
      "optimization_approval",
    ]) {
      transitionRun(root, "run-001", phase);
    }
    assert.throws(
      () =>
        transitionRun(root, "run-001", "isolation", {
          updates: {
            repository_snapshot: REPOSITORY_SNAPSHOT,
            approvals: [
              {
                ...implementationApproval(),
                fingerprint: "0".repeat(64),
              },
            ],
          },
        }),
      /fingerprint/u,
    );
    transitionRun(root, "run-001", "isolation", {
      updates: {
        repository_snapshot: REPOSITORY_SNAPSHOT,
        approvals: [implementationApproval()],
      },
    });
    transitionRun(root, "run-001", "implementation");
    assert.throws(
      () =>
        transitionRun(root, "run-001", "validation", {
          updates: {
            candidate_snapshot: {
              ...CANDIDATE_SNAPSHOT,
              approved_opt_ids: ["OPT-001", "OPT-002"],
            },
          },
        }),
      /未對應任何候選檔案/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "validation", {
          updates: {
            candidate_snapshot: {
              ...CANDIDATE_SNAPSHOT,
              repository_snapshot: {
                ...CANDIDATE_SNAPSHOT.repository_snapshot,
                process_artifact_prefixes: ["docs/plans/"],
              },
              changed_files: ["docs/plans/private-plan.md"],
              process_artifact_prefixes: ["docs/plans/"],
              file_opt_map: {
                "docs/plans/private-plan.md": ["OPT-001"],
              },
            },
          },
        }),
      /過程檔/u,
    );
    transitionRun(root, "run-001", "validation", {
      updates: { candidate_snapshot: CANDIDATE_SNAPSHOT },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("pr_create"),
          },
        }),
      /不可由 validation/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "branch_push", {
          candidatePath: LIVE_CANDIDATE.candidate,
          updates: {
            candidate_snapshot: CANDIDATE_SNAPSHOT,
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("branch_push"),
          },
        }),
      /不允許更新欄位/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "branch_push", {
          candidatePath: LIVE_CANDIDATE.candidate,
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("branch_push", { runId: "run-002" }),
          },
        }),
      /目前候選狀態不一致/u,
    );

    const preview = buildGithubActionPreview("branch_push", {
      run_id: "run-001",
      binding_id: "binding-001",
      account: "example-user",
      repository: "example/skill",
      relationship: "managed",
      base_branch: "main",
      base_commit: CANDIDATE_SNAPSHOT.repository_snapshot.merge_base,
      head_branch: "feature",
      head_commit: CANDIDATE_SNAPSHOT.repository_snapshot.head_commit,
      diff_hash: CANDIDATE_SNAPSHOT.candidate_diff_hash,
      action_target: {
        candidate_path_fingerprint: fingerprintCandidatePath(
          LIVE_CANDIDATE.candidate,
        ),
        expected_remote_commit: null,
        head_repository: "example/skill",
        operation: "create",
      },
      capability_proof: buildGithubCapabilityProof({
        account: "example-user",
        repository: "example/skill",
        permission: "ADMIN",
        defaultBranch: "main",
        immutableReleases: true,
        inspectedAt: "2026-07-28T08:00:00.000Z",
      }),
      provider_contract_hash: "provider123",
    });
    const expiredApproval = buildGithubActionApproval(preview, {
      confirmedAt: "2019-01-01T00:00:00.000Z",
      expiresAt: "2019-01-01T00:15:00.000Z",
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "branch_push", {
          candidatePath: LIVE_CANDIDATE.candidate,
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            action_preview: preview,
            approvals: [expiredApproval],
          },
        }),
      /過期/u,
    );
    transitionRun(root, "run-001", "branch_push", {
      candidatePath: LIVE_CANDIDATE.candidate,
      updates: {
        validation_summary: VALIDATION_SUMMARY,
        ...actionEvidence("branch_push"),
      },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("pr_create"),
          },
        }),
      /Branch push proof|branch-push-proof/u,
    );
  });
});

test("PR, merge, release, and publication proofs stay bound to the active repository", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: {
        skill: "example-skill",
        skill_path: "skill",
        repository: "example/skill",
      },
    });
    for (const [phase, updates] of [
      ["evidence_collection", {}],
      ["feedback_validation", {}],
      ["optimization_design", {}],
      ["optimization_approval", {}],
      [
        "isolation",
        {
          repository_snapshot: REPOSITORY_SNAPSHOT,
          approvals: [implementationApproval()],
        },
      ],
      ["implementation", {}],
      ["validation", { candidate_snapshot: CANDIDATE_SNAPSHOT }],
      [
        "branch_push",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("branch_push"),
        },
      ],
      [
        "pr_creation",
        {
          branch_push_proof: BRANCH_PUSH_PROOF,
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("pr_create"),
        },
      ],
    ]) {
      transitionRun(root, "run-001", phase, {
        updates,
        candidatePath: LIVE_CANDIDATE.candidate,
      });
    }

    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_update", {
          updates: {
            pr_proof: {
              ...PR_PROOF,
              repository: "evil/other",
              base_branch: "other",
              head_commit: "foreign123",
            },
            ...actionEvidence("pr_update"),
          },
        }),
      /PR proof/u,
    );
    transitionRun(root, "run-001", "pr_update", {
      updates: {
        pr_proof: PR_PROOF,
        ...actionEvidence("pr_update"),
      },
    });
    assert.throws(
      () => transitionRun(root, "run-001", "pr_update"),
      /缺少 pr_update 獨立確認/u,
    );
    const retryEvidence = actionEvidence("pr_update");
    transitionRun(root, "run-001", "pr_update", {
      updates: {
        pr_proof: PR_PROOF,
        ...retryEvidence,
      },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_update", {
          updates: {
            pr_proof: PR_PROOF,
            ...retryEvidence,
          },
        }),
      /確認已使用/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "merge", {
          updates: {
            pr_proof: {
              ...PR_PROOF,
              head_commit: "unvalidated999",
            },
            ...actionEvidence("merge", {
              headCommit: "unvalidated999",
            }),
          },
        }),
      /PR proof/u,
    );
    transitionRun(root, "run-001", "merge", {
      updates: {
        pr_proof: PR_PROOF,
        ...actionEvidence("merge"),
      },
    });

    const mergeProof = {
      schema_version: 1,
      repository: "example/skill",
      pr_number: 1,
      merge_commit: MERGE_COMMIT,
      default_branch: "main",
    };
    const releaseEvidence = actionEvidence("release", {
      headCommit: MERGE_COMMIT,
      actionTarget: {
        version: "v1.0.0",
        title: "Agent Skill Maintainer v1.0.0",
        notes: "Release notes.",
        draft: false,
        prerelease: false,
        release_note_coverage: RELEASE_COVERAGE,
      },
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "release", {
          updates: {
            merge_proof: {
              ...mergeProof,
              repository: "evil/other",
            },
            release_coverage: RELEASE_COVERAGE,
            ...releaseEvidence,
          },
        }),
      /Merge proof/u,
    );
    transitionRun(root, "run-001", "release", {
      updates: {
        merge_proof: mergeProof,
        release_coverage: RELEASE_COVERAGE,
        ...releaseEvidence,
      },
    });

    const publicationProof = {
      schema_version: 1,
      repository: "example/skill",
      version: "v1.0.0",
      tag: "v1.0.0",
      commit: MERGE_COMMIT,
      release_url: "https://github.com/example/skill/releases/tag/v1.0.0",
      official: true,
    };
    assert.throws(
      () =>
        transitionRun(root, "run-001", "local_update", {
          updates: {
            publication_proof: {
              ...publicationProof,
              repository: "evil/other",
              tag: "not-the-release",
              release_url:
                "https://github.com/evil/other/releases/tag/not-the-release",
            },
            ...localUpdateEvidence(),
          },
        }),
      /尚未驗證官方發布/u,
    );
  });
});
