import test from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";
import {
  evaluateReleaseNoteCoverage,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  authorizeGithubActionReconcile,
  InvalidStateTransition,
  LockUnavailableError,
  createRun,
  readRun,
  recordGithubActionReconciliation,
  reserveGithubActionApply,
  transitionRun,
  withBindingLock,
} from "../skills/agent-skill-maintainer/scripts/lib/state.mjs";

const REPOSITORY_SNAPSHOT = Object.freeze({
  schema_version: 1,
  base_ref: "main",
  merge_base: "base123",
  head_commit: "abc123",
  diff_hash: "a".repeat(64),
  changed_files: ["SKILL.md"],
  process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
});

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

const CANDIDATE_SNAPSHOT = Object.freeze({
  schema_version: 1,
  repository_snapshot: REPOSITORY_SNAPSHOT,
  candidate_diff_hash: "f".repeat(64),
  changed_files: ["SKILL.md"],
  approved_opt_ids: ["OPT-001"],
  process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
  file_opt_map: { "SKILL.md": ["OPT-001"] },
  diff_mapping_complete: true,
  isolated: true,
});

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
  head_commit: REPOSITORY_SNAPSHOT.head_commit,
  base_branch: "main",
  state: "open",
  checks_passed: true,
  documentation_impact: DOCUMENTATION_IMPACT,
});

const RELEASE_COVERAGE = Object.freeze(
  evaluateReleaseNoteCoverage(
    {
      schema_version: 1,
      previous_ref: "v0.9.0",
      previous_commit: "base123",
      candidate_ref: "HEAD",
      candidate_commit: "merge123",
      commits: [
        {
          commit: "merge123",
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
          source_commits: ["merge123"],
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

/** Returns one exact Preview and expiring confirmation for a lifecycle action. */
function actionEvidence(
  action,
  {
    headCommit = REPOSITORY_SNAPSHOT.head_commit,
    baseCommit = action === "release"
      ? headCommit
      : REPOSITORY_SNAPSHOT.merge_base,
    runId = "run-001",
    actionTarget = action === "pr_update" || action === "merge"
      ? { pr_number: 1, summary: `${action} workflow improvement` }
      : { title: `${action} workflow improvement` },
  } = {},
) {
  const preview = buildGithubActionPreview(action, {
    run_id: runId,
    binding_id: "binding-001",
    account: "example-user",
    repository: "example/skill",
    relationship: "managed",
    base_branch: "main",
    base_commit: baseCommit,
    head_branch: "feature",
    head_commit: headCommit,
    diff_hash: CANDIDATE_SNAPSHOT.candidate_diff_hash,
    action_target: actionTarget,
    release_enabled: true,
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
      target: { skill: "example-skill", repository: "example/skill" },
    });
    assert.equal(created.schema_version, 4);
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

test("full managed lifecycle includes PR update and local update", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: { skill: "example-skill", repository: "example/skill" },
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
        "pr_creation",
        {
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
            merge_commit: "merge123",
            default_branch: "main",
          },
          release_coverage: RELEASE_COVERAGE,
          ...actionEvidence("release", {
            headCommit: "merge123",
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
      [
        "local_update",
        {
          publication_proof: {
            schema_version: 1,
            repository: "example/skill",
            version: "v1.0.0",
            tag: "v1.0.0",
            commit: "merge123",
            release_url: "https://github.com/example/skill/releases/tag/v1.0.0",
            official: true,
          },
          ...actionEvidence("local_update", {
            headCommit: "merge123",
            actionTarget: {
              skill: "example-skill",
              version: "v1.0.0",
            },
          }),
        },
      ],
      ["completed", {}],
    ];
    let document;
    for (const [phase, updates] of phases) {
      document = transitionRun(root, "run-001", phase, { updates });
      assert.equal(document.phase, phase);
    }
    assert.equal(document.status, "completed");
  });
});

test("GitHub apply reservation binds the active run and blocks replay", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: { skill: "example-skill", repository: "example/skill" },
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
      transitionRun(root, "run-001", phase, { updates });
    }
    const evidence = actionEvidence("pr_create");
    transitionRun(root, "run-001", "pr_creation", {
      updates: {
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
      /尚未證明未寫入/u,
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

test("legacy v1 run migrates before current schema validation", () => {
  withStateRoot((root) => {
    const path = join(root, "runs", "run-001", "state.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "waiting_ci",
        status: "active",
        target: { skill: "example-skill" },
        approvals: [],
      }),
      "utf8",
    );
    const migrated = readRun(root, "run-001");
    assert.equal(migrated.schema_version, 4);
    assert.equal(migrated.phase, "pr_creation");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), migrated);
  });
});

test("legacy v3 attempts are conservatively mapped and block ambiguous retry", () => {
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

    const migrated = readRun(root, "run-001");
    assert.deepEqual(migrated.github_action_attempts, [
      {
        action: "unknown",
        approval_fingerprint: "a".repeat(64),
      },
      {
        action: "merge",
        approval_fingerprint: "b".repeat(64),
      },
    ]);
    assert.throws(
      () => transitionRun(root, "run-001", "merge"),
      /舊版 GitHub action attempt/u,
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
        target: { skill: "example-skill", repository: "example/skill" },
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
      target: { skill: "example-skill", repository: "example/skill" },
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
                ...REPOSITORY_SNAPSHOT,
                process_artifact_prefixes: [],
              },
              changed_files: ["docs/plans/private-plan.md"],
              process_artifact_prefixes: [],
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
            candidate_snapshot: CANDIDATE_SNAPSHOT,
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("pr_create"),
          },
        }),
      /不允許更新欄位/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            ...actionEvidence("pr_create", { runId: "run-002" }),
          },
        }),
      /目前候選狀態不一致/u,
    );
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: {
              ...VALIDATION_SUMMARY,
              checks: [],
            },
            ...actionEvidence("pr_create"),
          },
        }),
      /重建|必要類別|檢查|required_check_ids/u,
    );

    const preview = buildGithubActionPreview("pr_create", {
      run_id: "run-001",
      binding_id: "binding-001",
      account: "example-user",
      repository: "example/skill",
      relationship: "managed",
      base_branch: "main",
      base_commit: REPOSITORY_SNAPSHOT.merge_base,
      head_branch: "feature",
      head_commit: REPOSITORY_SNAPSHOT.head_commit,
      diff_hash: CANDIDATE_SNAPSHOT.candidate_diff_hash,
      action_target: { title: "expired approval" },
      release_enabled: true,
      provider_contract_hash: "provider123",
    });
    const expiredApproval = buildGithubActionApproval(preview, {
      confirmedAt: "2019-01-01T00:00:00.000Z",
      expiresAt: "2019-01-01T00:15:00.000Z",
    });
    assert.throws(
      () =>
        transitionRun(root, "run-001", "pr_creation", {
          updates: {
            validation_summary: VALIDATION_SUMMARY,
            action_preview: preview,
            approvals: [expiredApproval],
          },
        }),
      /過期/u,
    );
  });
});

test("PR, merge, release, and publication proofs stay bound to the active repository", () => {
  withStateRoot((root) => {
    createRun(root, {
      runId: "run-001",
      bindingId: "binding-001",
      target: { skill: "example-skill", repository: "example/skill" },
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
        "pr_creation",
        {
          validation_summary: VALIDATION_SUMMARY,
          ...actionEvidence("pr_create"),
        },
      ],
    ]) {
      transitionRun(root, "run-001", phase, { updates });
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
      merge_commit: "merge123",
      default_branch: "main",
    };
    const releaseEvidence = actionEvidence("release", {
      headCommit: "merge123",
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
      commit: "merge123",
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
            ...actionEvidence("local_update", {
              headCommit: "merge123",
              actionTarget: {
                skill: "example-skill",
                version: "v1.0.0",
              },
            }),
          },
        }),
      /尚未驗證官方發布/u,
    );
  });
});
