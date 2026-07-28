import test from "node:test";
import assert from "node:assert/strict";
import {
  validateForkProofContract,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  applyGithubAction,
  buildGithubCapabilityProof,
  buildGithubActionApproval,
  buildGithubActionPreview,
  reconcileGithubAction,
  verifyExistingFork,
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";

const BASE_COMMIT = "b".repeat(40);
const HEAD_COMMIT = "a".repeat(40);

/** Returns one Fork action state with deterministic fake identities. */
function forkState({ operation = "create", relationship = "contribute" } = {}) {
  return {
    run_id: "run-fork-001",
    binding_id: "binding-fork-001",
    account: "example-user",
    repository: "example-upstream/sample-skill",
    relationship,
    base_branch: "main",
    base_commit: BASE_COMMIT,
    head_branch: "maintain/fork-flow",
    head_commit: HEAD_COMMIT,
    diff_hash: "d".repeat(64),
    action_target: {
      fork_repository: "example-user/sample-skill",
      default_branch_only: true,
      operation,
    },
    capability_proof: buildGithubCapabilityProof({
      account: "example-user",
      repository: "example-upstream/sample-skill",
      permission:
        relationship === "contribute" ? "READ" : "ADMIN",
      defaultBranch: "main",
      immutableReleases: false,
      inspectedAt: "2026-07-24T07:00:00.000Z",
    }),
    provider_contract_hash: "provider123",
  };
}

/** Returns a fixed expiring approval for one preview. */
function approvalFor(preview) {
  return buildGithubActionApproval(preview, {
    confirmedAt: "2026-07-24T08:00:00.000Z",
    expiresAt: "2026-07-24T08:15:00.000Z",
  });
}

/** Returns one deterministic Fork proof. */
function forkProof(operation = "create") {
  return {
    schema_version: 1,
    repository: "example-upstream/sample-skill",
    fork_repository: "example-user/sample-skill",
    account: "example-user",
    relationship: "contribute",
    base_branch: "main",
    base_commit: BASE_COMMIT,
    default_branch_only: true,
    operation,
    parent_repository: "example-upstream/sample-skill",
    base_commit_available: true,
    verified: true,
  };
}

/** Returns a fake GitHub runner whose Fork can appear after POST. */
function forkRunner({
  forkExists = false,
  forkParent = "example-upstream/sample-skill",
  forkPermission = "WRITE",
  upstreamPermission = "READ",
  baseCommitAvailable = true,
  appearAfterPost = true,
  postFailure = false,
  postRejection = false,
  observationFailureAfterPost = false,
} = {}) {
  let exists = forkExists;
  let postCount = 0;
  const calls = [];
  const runner = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: "example-user\n", stderr: "" };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === "example-upstream/sample-skill"
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example-upstream/sample-skill",
          viewerPermission: upstreamPermission,
          defaultBranchRef: { name: "main" },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] ===
        "repos/example-upstream/sample-skill/branches/main"
    ) {
      return { status: 0, stdout: `${BASE_COMMIT}\n`, stderr: "" };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === "example-user/sample-skill"
    ) {
      if (observationFailureAfterPost && postCount > 0) {
        return {
          status: 1,
          stdout: "",
          stderr: "HTTP 503: Service Unavailable",
        };
      }
      if (!exists) {
        return {
          status: 1,
          stdout: "",
          stderr: "HTTP 404: Not Found",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: "example-user/sample-skill",
          viewerPermission: forkPermission,
          parent: { nameWithOwner: forkParent },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] === "--method" &&
      arguments_[2] === "POST"
    ) {
      postCount += 1;
      if (postRejection) {
        return {
          status: 1,
          stdout: "",
          stderr: "HTTP 422: Validation Failed",
        };
      }
      if (postFailure) {
        return {
          status: 1,
          stdout: "",
          stderr: "connection closed before response",
        };
      }
      if (appearAfterPost) {
        exists = true;
      }
      return {
        status: 0,
        stdout: JSON.stringify({ full_name: "example-user/sample-skill" }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] ===
        `repos/example-user/sample-skill/commits/${BASE_COMMIT}`
    ) {
      if (!exists || !baseCommitAvailable) {
        return {
          status: 1,
          stdout: "",
          stderr: "HTTP 404: Not Found",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ sha: BASE_COMMIT }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };
  return {
    runner,
    calls,
    get postCount() {
      return postCount;
    },
  };
}

test("Fork proof is bound to the contribute account and upstream", () => {
  assert.deepEqual(
    validateForkProofContract(forkProof(), {
      repository: "example-upstream/sample-skill",
      forkRepository: "example-user/sample-skill",
      account: "example-user",
      baseBranch: "main",
      baseCommit: BASE_COMMIT,
    }),
    forkProof(),
  );
  assert.throws(
    () =>
      validateForkProofContract(
        { ...forkProof(), parent_repository: "other/sample-skill" },
        {
          repository: "example-upstream/sample-skill",
          forkRepository: "example-user/sample-skill",
          account: "example-user",
          baseBranch: "main",
          baseCommit: BASE_COMMIT,
        },
      ),
    /Fork proof/u,
  );
});

test("Fork preview accepts only the active account personal destination", () => {
  const preview = buildGithubActionPreview("fork_create", forkState());
  assert.equal(preview.action, "fork_create");
  assert.throws(
    () =>
      buildGithubActionPreview(
        "fork_create",
        forkState({ relationship: "managed" }),
      ),
    /contribute/u,
  );
  assert.throws(
    () =>
      buildGithubActionPreview("fork_create", {
        ...forkState(),
        action_target: {
          ...forkState().action_target,
          fork_repository: "another-user/sample-skill",
        },
      }),
    /active account/u,
  );
});

test("Fork create sends one bounded POST and returns verified proof", () => {
  const preview = buildGithubActionPreview("fork_create", forkState());
  const fake = forkRunner();
  const result = applyGithubAction(preview, approvalFor(preview), {
    now: "2026-07-24T08:10:00.000Z",
    runner: fake.runner,
  });

  assert.equal(fake.postCount, 1);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.proof, forkProof("create"));
  const post = fake.calls.find(
    (arguments_) =>
      arguments_[0] === "api" &&
      arguments_[1] === "--method" &&
      arguments_[2] === "POST",
  );
  assert.deepEqual(post, [
    "api",
    "--method",
    "POST",
    "repos/example-upstream/sample-skill/forks",
    "-F",
    "default_branch_only=true",
  ]);
});

test("Existing verified Fork is reused without POST", () => {
  const preview = buildGithubActionPreview(
    "fork_create",
    forkState({ operation: "reuse" }),
  );
  const fake = forkRunner({ forkExists: true });
  const result = applyGithubAction(preview, approvalFor(preview), {
    now: "2026-07-24T08:10:00.000Z",
    runner: fake.runner,
  });

  assert.equal(fake.postCount, 0);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.proof, forkProof("reuse"));
});

test("Existing Fork verification is read-only and skips creation phase", () => {
  const fake = forkRunner({ forkExists: true });
  const proof = verifyExistingFork(
    forkState({ operation: "reuse" }),
    { runner: fake.runner },
  );
  assert.deepEqual(proof, forkProof("reuse"));
  assert.equal(fake.postCount, 0);
});

test("Fork creation remains pending without repeating POST", () => {
  const preview = buildGithubActionPreview("fork_create", forkState());
  const approval = approvalFor(preview);
  const fake = forkRunner({ appearAfterPost: false });
  const applied = applyGithubAction(preview, approval, {
    now: "2026-07-24T08:01:00.000Z",
    runner: fake.runner,
  });
  assert.equal(applied.status, "pending");
  assert.equal(fake.postCount, 1);

  const pending = reconcileGithubAction(preview, {
    approvalFingerprint: approval.fingerprint,
    attemptedAt: "2026-07-24T08:01:00.000Z",
    now: "2026-07-24T08:04:59.000Z",
    runner: fake.runner,
  });
  assert.equal(pending.status, "pending");
  assert.match(pending.guidance, /唯讀 github-reconcile/u);
  assert.equal(fake.postCount, 1);

  const blocked = reconcileGithubAction(preview, {
    approvalFingerprint: approval.fingerprint,
    attemptedAt: "2026-07-24T08:01:00.000Z",
    now: "2026-07-24T08:06:00.000Z",
    runner: fake.runner,
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.guidance, /人工調查/u);
  assert.equal(fake.postCount, 1);
});

test("Fork creation blocks unrelated or unwritable destinations", () => {
  const reuse = buildGithubActionPreview(
    "fork_create",
    forkState({ operation: "reuse" }),
  );
  assert.throws(
    () =>
      applyGithubAction(reuse, approvalFor(reuse), {
        now: "2026-07-24T08:10:00.000Z",
        runner: forkRunner({
          forkExists: true,
          forkParent: "other/sample-skill",
        }).runner,
      }),
    /parent/u,
  );
  assert.throws(
    () =>
      applyGithubAction(reuse, approvalFor(reuse), {
        now: "2026-07-24T08:10:00.000Z",
        runner: forkRunner({
          forkExists: true,
          forkPermission: "READ",
        }).runner,
      }),
    /permission/u,
  );

  const create = buildGithubActionPreview("fork_create", forkState());
  const drifted = reconcileGithubAction(create, {
    approvalFingerprint: approvalFor(create).fingerprint,
    attemptedAt: "2026-07-24T08:01:00.000Z",
    now: "2026-07-24T08:02:00.000Z",
    runner: forkRunner({
      forkExists: true,
      forkParent: "other/sample-skill",
    }).runner,
  });
  assert.equal(drifted.status, "drifted");

  const blocked = reconcileGithubAction(create, {
    approvalFingerprint: approvalFor(create).fingerprint,
    attemptedAt: "2026-07-24T08:01:00.000Z",
    now: "2026-07-24T08:02:00.000Z",
    runner: forkRunner({
      forkExists: true,
      forkPermission: "READ",
    }).runner,
  });
  assert.equal(blocked.status, "blocked");
});

test("Fork lookup does not treat an authentication failure as absence", () => {
  const create = buildGithubActionPreview("fork_create", forkState());
  const fake = forkRunner();
  const result = applyGithubAction(create, approvalFor(create), {
    now: "2026-07-24T08:10:00.000Z",
    runner: (arguments_) => {
      if (
        arguments_[0] === "repo" &&
        arguments_[1] === "view" &&
        arguments_[2] === "example-user/sample-skill"
      ) {
        return {
          status: 1,
          stdout: "",
          stderr: "authentication token not found",
        };
      }
      return fake.runner(arguments_);
    },
  });
  assert.equal(fake.postCount, 0);
  assert.equal(result.status, "not_applied");
  assert.match(result.reason, /authentication token not found/u);
});

test("Fork create records no write when contribute became managed", () => {
  const create = buildGithubActionPreview("fork_create", forkState());
  const fake = forkRunner({ upstreamPermission: "WRITE" });
  const result = applyGithubAction(create, approvalFor(create), {
    now: "2026-07-24T08:10:00.000Z",
    runner: fake.runner,
  });
  assert.equal(fake.postCount, 0);
  assert.equal(result.status, "not_applied");
  assert.equal(result.reconciliation.status, "not_applied");
  assert.match(result.reason, /contribute 漂移為 managed/u);
  assert.match(result.guidance, /新的確認/u);
});

test("Fork create records an uncertain POST response as pending", () => {
  const create = buildGithubActionPreview("fork_create", forkState());
  const fake = forkRunner({ postFailure: true });
  const result = applyGithubAction(create, approvalFor(create), {
    now: "2026-07-24T08:10:00.000Z",
    runner: fake.runner,
  });
  assert.equal(fake.postCount, 1);
  assert.equal(result.status, "pending");
  assert.equal(result.reconciliation.status, "pending");
  assert.match(result.reason, /結果不確定/u);
  assert.match(result.guidance, /不得重送/u);
});

test("Fork create records an explicit API rejection as blocked", () => {
  const create = buildGithubActionPreview("fork_create", forkState());
  const fake = forkRunner({ postRejection: true });
  const result = applyGithubAction(create, approvalFor(create), {
    now: "2026-07-24T08:10:00.000Z",
    runner: fake.runner,
  });
  assert.equal(fake.postCount, 1);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /HTTP 422/u);
  assert.match(result.guidance, /人工調查/u);
});

test("Fork create persists post-acceptance observation failures", () => {
  const create = buildGithubActionPreview("fork_create", forkState());
  const transient = forkRunner({ observationFailureAfterPost: true });
  const pending = applyGithubAction(create, approvalFor(create), {
    now: "2026-07-24T08:10:00.000Z",
    runner: transient.runner,
  });
  assert.equal(transient.postCount, 1);
  assert.equal(pending.status, "pending");
  assert.equal(pending.reconciliation.status, "pending");
  assert.match(pending.reason, /核對暫時失敗/u);
  assert.match(pending.guidance, /不得重送/u);

  for (const [options, expectedStatus] of [
    [{ forkParent: "other-owner/other-project" }, "drifted"],
    [{ forkPermission: "READ" }, "blocked"],
  ]) {
    const fake = forkRunner(options);
    const result = applyGithubAction(create, approvalFor(create), {
      now: "2026-07-24T08:10:00.000Z",
      runner: fake.runner,
    });
    assert.equal(fake.postCount, 1);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.reconciliation.status, expectedStatus);
  }
});
