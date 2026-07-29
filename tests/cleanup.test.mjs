import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  applyCleanup,
  approveCleanup,
  previewCleanup,
  readCleanupState,
  reconcileCleanup,
} from "../skills/agent-skill-maintainer/scripts/lib/cleanup.mjs";
import {
  createBranchPushFixture,
} from "./fixtures.mjs";

function terminalRun(fixture, overrides = {}) {
  return {
    schema_version: 8,
    run_id: "source-run",
    binding_id: "binding-001",
    phase: "completed",
    status: "completed",
    target: {
      skill: "example-skill",
      repository: "example/skill",
    },
    approvals: [],
    consumed_approval_fingerprints: [],
    attempted_github_action_fingerprints: [],
    github_action_attempts: [],
    github_action_reconciliations: [],
    attempted_local_update_fingerprints: [],
    local_update_attempts: [],
    local_update_reconciliations: [],
    candidate_snapshot: fixture.candidateSnapshot,
    completion_disposition: {
      schema_version: 1,
      kind: "local_update_verified",
      after_phase: "local_update",
      reason: "The exact published candidate was installed and verified.",
    },
    ...overrides,
  };
}

function writeRun(stateRoot, document) {
  const directory = resolve(stateRoot, "runs", document.run_id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "state.json"),
    `${JSON.stringify(document)}\n`,
    "utf8",
  );
}

function createCleanupFixture() {
  const fixture = createBranchPushFixture({
    prefix: "maintainer-cleanup-",
    candidateName: "cleanup-candidate",
    branchName: "maintain/cleanup-candidate",
  });
  const stateRoot = resolve(fixture.root, "state");
  writeRun(stateRoot, terminalRun(fixture));
  return {
    ...fixture,
    stateRoot,
    candidateName: "cleanup-candidate",
  };
}

function approvedCleanup(fixture) {
  const preview = previewCleanup({
    stateRoot: fixture.stateRoot,
    sourceRunId: "source-run",
    candidateName: fixture.candidateName,
    candidatesRoot: fixture.candidates,
    previewedAt: "2026-07-29T01:00:00.000Z",
  });
  const approval = approveCleanup(fixture.stateRoot, preview, {
    confirmedAt: "2026-07-29T01:01:00.000Z",
    expiresAt: "2026-07-29T01:11:00.000Z",
  });
  return { preview, approval };
}

test("cleanup preview, approval, apply and proof preserve terminal source bytes", () => {
  const fixture = createCleanupFixture();
  try {
    const sourcePath = resolve(
      fixture.stateRoot,
      "runs",
      "source-run",
      "state.json",
    );
    const sourceBefore = readFileSync(sourcePath);
    const { preview, approval } = approvedCleanup(fixture);
    assert.equal(preview.candidate.relative_path, fixture.candidateName);
    assert.match(preview.candidate.tree_fingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(preview.completion_kind, "local_update_verified");
    const proof = applyCleanup({
      stateRoot: fixture.stateRoot,
      preview,
      approval,
      candidatesRoot: fixture.candidates,
      now: new Date("2026-07-29T01:02:00.000Z"),
    });
    assert.equal(proof.applied, true);
    assert.equal(proof.quarantined_before_delete, true);
    assert.equal(existsSync(fixture.candidate), false);
    assert.equal(
      existsSync(
        resolve(
          fixture.candidates,
          ".quarantine",
          preview.transaction_id,
        ),
      ),
      false,
    );
    assert.deepEqual(readFileSync(sourcePath), sourceBefore);
    assert.equal(
      readCleanupState(
        fixture.stateRoot,
        preview.transaction_id,
      ).status,
      "applied",
    );
    assert.throws(
      () =>
        applyCleanup({
          stateRoot: fixture.stateRoot,
          preview,
          approval,
          candidatesRoot: fixture.candidates,
          now: new Date("2026-07-29T01:03:00.000Z"),
        }),
      /已使用|已漂移/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup blocks non-integrated states, traversal and candidate drift", () => {
  for (const overrides of [
    { phase: "implementation", status: "active" },
    { phase: "aborted", status: "aborted" },
    {
      completion_disposition: {
        schema_version: 1,
        kind: "stop_after_pr",
        after_phase: "pr_creation",
        reason: "PR remains the continuation boundary.",
      },
    },
  ]) {
    const fixture = createCleanupFixture();
    try {
      writeRun(fixture.stateRoot, terminalRun(fixture, overrides));
      assert.throws(
        () =>
          previewCleanup({
            stateRoot: fixture.stateRoot,
            sourceRunId: "source-run",
            candidateName: fixture.candidateName,
            candidatesRoot: fixture.candidates,
          }),
        /尚未完成可清理/u,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const traversal = createCleanupFixture();
  try {
    assert.throws(
      () =>
        previewCleanup({
          stateRoot: traversal.stateRoot,
          sourceRunId: "source-run",
          candidateName: "../outside",
          candidatesRoot: traversal.candidates,
        }),
      /candidate 格式不合法/u,
    );
    writeFileSync(resolve(traversal.candidate, "drift.txt"), "drift\n");
    assert.throws(
      () =>
        previewCleanup({
          stateRoot: traversal.stateRoot,
          sourceRunId: "source-run",
          candidateName: traversal.candidateName,
          candidatesRoot: traversal.candidates,
        }),
      /漂移|尚未提交/u,
    );
  } finally {
    rmSync(traversal.root, { recursive: true, force: true });
  }
});

test("cleanup blocks active candidate references and unsafe tree entries", (context) => {
  const referenced = createCleanupFixture();
  try {
    writeRun(
      referenced.stateRoot,
      terminalRun(referenced, {
        run_id: "active-run",
        phase: "validation",
        status: "active",
        completion_disposition: undefined,
      }),
    );
    assert.throws(
      () =>
        previewCleanup({
          stateRoot: referenced.stateRoot,
          sourceRunId: "source-run",
          candidateName: referenced.candidateName,
          candidatesRoot: referenced.candidates,
        }),
      /仍有 1 筆/u,
    );
  } finally {
    rmSync(referenced.root, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    context.skip("Windows symlink privileges are not guaranteed");
    return;
  }
  const unsafe = createCleanupFixture();
  try {
    symlinkSync(
      resolve(unsafe.root, "outside"),
      resolve(unsafe.candidate, ".git", "unsafe-link"),
    );
    assert.throws(
      () =>
        previewCleanup({
          stateRoot: unsafe.stateRoot,
          sourceRunId: "source-run",
          candidateName: unsafe.candidateName,
          candidatesRoot: unsafe.candidates,
        }),
      /symbolic link/u,
    );
  } finally {
    rmSync(unsafe.root, { recursive: true, force: true });
  }

  const special = createCleanupFixture();
  try {
    execFileSync(
      "mkfifo",
      [resolve(special.candidate, ".git", "unsafe-pipe")],
      { stdio: "ignore" },
    );
    assert.throws(
      () =>
        previewCleanup({
          stateRoot: special.stateRoot,
          sourceRunId: "source-run",
          candidateName: special.candidateName,
          candidatesRoot: special.candidates,
        }),
      /特殊檔案/u,
    );
  } finally {
    rmSync(special.root, { recursive: true, force: true });
  }
});

test("cleanup approval is short-lived and starts after the preview", () => {
  const fixture = createCleanupFixture();
  try {
    const preview = previewCleanup({
      stateRoot: fixture.stateRoot,
      sourceRunId: "source-run",
      candidateName: fixture.candidateName,
      candidatesRoot: fixture.candidates,
      previewedAt: "2026-07-29T01:00:00.000Z",
    });
    assert.throws(
      () =>
        approveCleanup(fixture.stateRoot, preview, {
          confirmedAt: "2026-07-29T00:59:00.000Z",
          expiresAt: "2026-07-29T01:09:00.000Z",
        }),
      /時間範圍/u,
    );
    assert.throws(
      () =>
        approveCleanup(fixture.stateRoot, preview, {
          confirmedAt: "2026-07-29T01:01:00.000Z",
          expiresAt: "2026-07-29T02:01:00.000Z",
        }),
      /時間範圍/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup reconciliation distinguishes reserved and quarantined attempts", () => {
  const reserved = createCleanupFixture();
  try {
    const { preview, approval } = approvedCleanup(reserved);
    assert.throws(
      () =>
        applyCleanup({
          stateRoot: reserved.stateRoot,
          preview,
          approval,
          candidatesRoot: reserved.candidates,
          now: new Date("2026-07-29T01:02:00.000Z"),
          fault: "after-reserve",
        }),
      /injected/u,
    );
    const result = reconcileCleanup({
      stateRoot: reserved.stateRoot,
      transactionId: preview.transaction_id,
      candidatesRoot: reserved.candidates,
      now: new Date("2026-07-29T01:03:00.000Z"),
    });
    assert.equal(result.status, "not_applied");
    assert.equal(existsSync(reserved.candidate), true);
  } finally {
    rmSync(reserved.root, { recursive: true, force: true });
  }

  const quarantined = createCleanupFixture();
  try {
    const { preview, approval } = approvedCleanup(quarantined);
    assert.throws(
      () =>
        applyCleanup({
          stateRoot: quarantined.stateRoot,
          preview,
          approval,
          candidatesRoot: quarantined.candidates,
          now: new Date("2026-07-29T01:02:00.000Z"),
          fault: "after-rename",
        }),
      /injected/u,
    );
    assert.equal(existsSync(quarantined.candidate), false);
    const pending = reconcileCleanup({
      stateRoot: quarantined.stateRoot,
      transactionId: preview.transaction_id,
      candidatesRoot: quarantined.candidates,
      now: new Date("2026-07-29T01:03:00.000Z"),
    });
    assert.equal(pending.status, "pending");
    const proof = reconcileCleanup({
      stateRoot: quarantined.stateRoot,
      transactionId: preview.transaction_id,
      candidatesRoot: quarantined.candidates,
      finish: true,
      now: new Date("2026-07-29T01:04:00.000Z"),
    });
    assert.equal(proof.applied, true);
    assert.equal(
      readCleanupState(
        quarantined.stateRoot,
        preview.transaction_id,
      ).status,
      "applied",
    );
  } finally {
    rmSync(quarantined.root, { recursive: true, force: true });
  }

  const ambiguous = createCleanupFixture();
  try {
    const { preview, approval } = approvedCleanup(ambiguous);
    assert.throws(
      () =>
        applyCleanup({
          stateRoot: ambiguous.stateRoot,
          preview,
          approval,
          candidatesRoot: ambiguous.candidates,
          now: new Date("2026-07-29T01:02:00.000Z"),
          fault: "after-reserve",
        }),
      /injected/u,
    );
    rmSync(ambiguous.candidate, { recursive: true, force: true });
    const result = reconcileCleanup({
      stateRoot: ambiguous.stateRoot,
      transactionId: preview.transaction_id,
      candidatesRoot: ambiguous.candidates,
      now: new Date("2026-07-29T01:03:00.000Z"),
    });
    assert.equal(result.status, "blocked");
  } finally {
    rmSync(ambiguous.root, { recursive: true, force: true });
  }
});

test("cleanup reconciliation rejects a replaced quarantine parent", (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink privileges are not guaranteed");
    return;
  }
  const fixture = createCleanupFixture();
  try {
    const { preview, approval } = approvedCleanup(fixture);
    assert.throws(
      () =>
        applyCleanup({
          stateRoot: fixture.stateRoot,
          preview,
          approval,
          candidatesRoot: fixture.candidates,
          now: new Date("2026-07-29T01:02:00.000Z"),
          fault: "after-rename",
        }),
      /injected/u,
    );
    const quarantineRoot = resolve(fixture.candidates, ".quarantine");
    const movedRoot = resolve(fixture.root, "moved-quarantine");
    renameSync(quarantineRoot, movedRoot);
    symlinkSync(movedRoot, quarantineRoot, "dir");

    assert.throws(
      () =>
        reconcileCleanup({
          stateRoot: fixture.stateRoot,
          transactionId: preview.transaction_id,
          candidatesRoot: fixture.candidates,
          finish: true,
          now: new Date("2026-07-29T01:03:00.000Z"),
        }),
      /quarantine root 必須是非 symlink 目錄/u,
    );
    assert.equal(
      existsSync(resolve(movedRoot, preview.transaction_id)),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
