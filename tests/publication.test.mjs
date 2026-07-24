import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validatePublication,
  validateStructuredAssets,
  validateTrackedProcessArtifacts,
} from "../scripts/validate-publication.mjs";
import {
  validateForwardEvaluationAggregate,
  validateForwardEvaluationFixture,
} from "../evals/run-evals.mjs";
import {
  buildValidationResult,
  fingerprint,
  loadProviderProfiles,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  createRun,
  readRun,
  transitionRun,
} from "../skills/agent-skill-maintainer/scripts/lib/state.mjs";
import {
  runMaintainerCommand,
} from "../skills/agent-skill-maintainer/scripts/maintainer.mjs";
import {
  branchPushGithubRunner,
  createBranchPushFixture,
  initializeRepository,
  localRemoteGitRunner,
  runGit,
} from "./fixtures.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = resolve(ROOT, "skills", "agent-skill-maintainer");
const CLI = resolve(SKILL_ROOT, "scripts", "maintainer.mjs");

/** Runs one repository Node entrypoint without shell expansion. */
function runNode(...arguments_) {
  return spawnSync(process.execPath, arguments_, {
    cwd: ROOT,
    encoding: "utf8",
  });
}

/** Reads a repository-relative UTF-8 file. */
function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
}

/** Creates one committed branch-push candidate for CLI contract tests. */
function createCliBranchPushFixture({ relationship = "managed" } = {}) {
  const fixture = createBranchPushFixture({
    prefix: "maintainer-cli-push-",
    candidateName: "cli-push",
    branchName: "maintain/cli-push",
    relationship,
  });
  const documentationImpact = {
    schema_version: 1,
    status: "updated",
    changed_guides: ["README.md"],
    root_index_action: "verified-current",
    contract_preserved: true,
    reason: "README reflects the approved branch-push behavior.",
  };
  const validationSummary = buildValidationResult(
    fixture.candidateSnapshot,
    {
    checks: [
      {
        id: "publication",
        category: "safety",
        status: "passed",
        summary: "Publication safety passed.",
      },
      {
        id: "regression",
        category: "regression",
        status: "passed",
        summary: "Regression tests passed.",
      },
      {
        id: "forward",
        category: "forward",
        status: "passed",
        summary: "Forward contracts passed.",
      },
      {
        id: "quality",
        category: "quality",
        status: "passed",
        summary: "Quality checks passed.",
      },
      {
        id: "agent-documentation-impact",
        category: "documentation",
        status: "passed",
        summary: "Maintainer guidance is current.",
        details: documentationImpact,
      },
    ],
    requiredCheckIds: new Set([
      "publication",
      "regression",
      "forward",
      "quality",
      "agent-documentation-impact",
    ]),
    },
  );
  return {
    ...fixture,
    validationSummary,
  };
}

/** Advances one CLI test run to the validation phase. */
function prepareCliValidationRun(fixture) {
  const stateRoot = join(fixture.root, "state");
  createRun(stateRoot, {
    runId: "run-001",
    bindingId: "binding-001",
    target: {
      skill: "example-skill",
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
        repository_snapshot: fixture.repositorySnapshot,
        approvals: [fixture.implementationApproval],
      },
    ],
    ["implementation", {}],
    [
      "validation",
      { candidate_snapshot: fixture.candidateSnapshot },
    ],
  ]) {
    transitionRun(stateRoot, "run-001", phase, { updates });
  }
  return stateRoot;
}

/** Prepares one branch-push preview, approval, and lifecycle transition. */
function prepareCliBranchPushAction(
  fixture,
  {
    account =
      fixture.binding.relationship === "managed"
        ? "example-user"
        : "contributor",
    headRepository =
      fixture.binding.relationship === "managed"
        ? "example/skill"
        : "contributor/skill",
  } = {},
) {
  const stateRoot = prepareCliValidationRun(fixture);
  const actionStatePath = resolve(fixture.root, "branch-state.json");
  const previewPath = resolve(fixture.root, "branch-preview.json");
  const approvalPath = resolve(fixture.root, "branch-approval.json");
  const updatesPath = resolve(fixture.root, "branch-updates.json");
  const repository = fixture.candidateSnapshot.repository_snapshot;
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account,
    repository: "example/skill",
    relationship: fixture.binding.relationship,
    base_branch: repository.base_ref,
    base_commit: repository.merge_base,
    head_branch: fixture.branch,
    head_commit: repository.head_commit,
    diff_hash: fixture.candidateSnapshot.candidate_diff_hash,
    action_target: {
      expected_remote_commit: null,
      head_repository: headRepository,
      operation: "create",
    },
    release_enabled: false,
    provider_contract_hash: fingerprint(loadProviderProfiles()),
  };
  writeFileSync(
    actionStatePath,
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
  const preview = runMaintainerCommand([
    "github-preview",
    "--action",
    "branch_push",
    "--state",
    actionStatePath,
    "--candidate",
    fixture.candidate,
  ]);
  writeFileSync(previewPath, `${JSON.stringify(preview)}\n`, "utf8");
  const now = Date.now();
  const approval = runMaintainerCommand([
    "github-approve",
    "--preview",
    previewPath,
    "--confirmed-at",
    new Date(now - 60_000).toISOString(),
    "--expires-at",
    new Date(now + 10 * 60_000).toISOString(),
  ]);
  writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`, "utf8");
  writeFileSync(
    updatesPath,
    `${JSON.stringify({
      validation_summary: fixture.validationSummary,
      action_preview: preview,
      approvals: [approval],
    })}\n`,
    "utf8",
  );
  const transitioned = runMaintainerCommand([
    "transition",
    "--state-root",
    stateRoot,
    "--run-id",
    "run-001",
    "--phase",
    "branch_push",
    "--updates",
    updatesPath,
  ]);
  return {
    stateRoot,
    state,
    preview,
    approval,
    actionStatePath,
    previewPath,
    approvalPath,
    transitioned,
  };
}

test("required public files and maintainer guidance exist", () => {
  const required = [
    ".gitattributes",
    "LICENSE",
    "AGENTS.md",
    "README.md",
    "README.zh-TW.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "package.json",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/skill-feedback.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/workflows/validation.yml",
    ".github/dependabot.yml",
    ".agents/architecture.md",
    ".agents/documentation.md",
    ".agents/releasing.md",
    ".agents/adr/0001-node-runtime.md",
    ".agents/adr/0002-deterministic-branch-push.md",
    "evals/cases/sample-cleanup-forward.json",
  ];
  assert.deepEqual(
    required.filter((relativePath) => {
      try {
        read(relativePath);
        return false;
      } catch {
        return true;
      }
    }),
    [],
  );
  assert.equal(read(".gitattributes").trim(), "* text=auto eol=lf");
  const rootGuidance = read("AGENTS.md");
  for (const relativePath of [
    ".agents/architecture.md",
    ".agents/documentation.md",
    ".agents/releasing.md",
  ]) {
    assert.match(rootGuidance, new RegExp(relativePath.replaceAll(".", "\\.")));
  }
});

test("README documents Preview, npx installation, and zero-dependency Node runtime", () => {
  const content = read("README.md");
  for (const phrase of [
    "Preview",
    "npx skills add",
    "Codex",
    "Claude Code",
    "MIT",
    "node skills/agent-skill-maintainer/scripts/maintainer.mjs",
    "No `npm install`",
    "github-preview",
    "github-reconcile",
    "branch_push",
    "--candidate",
    "explicit confirmation",
  ]) {
    assert.ok(content.includes(phrase), `README missing: ${phrase}`);
  }
  const packageDocument = JSON.parse(read("package.json"));
  assert.equal(packageDocument.type, "module");
  assert.equal(packageDocument.engines.node, ">=22");
  assert.deepEqual(packageDocument.dependencies ?? {}, {});
});

test("workflow is read-only and validates supported Node versions without installing packages", () => {
  const content = read(".github/workflows/validation.yml");
  assert.ok(content.includes("permissions:\n  contents: read"));
  assert.ok(content.includes("actions/setup-node@"));
  assert.ok(content.includes("node-version:"));
  assert.ok(content.includes("node --test tests/*.test.mjs"));
  assert.ok(!content.includes("pull_request_target"));
  assert.ok(!content.includes("contents: write"));
  assert.ok(!content.includes("npm install"));
  assert.ok(!content.includes("npm ci"));
  assert.ok(!content.includes("python"));
});

test("Skill metadata, trigger cases, references, and Preview boundary remain complete", () => {
  const skill = read("skills/agent-skill-maintainer/SKILL.md");
  assert.ok(skill.startsWith("---\n"));
  assert.ok(skill.includes("name: agent-skill-maintainer"));
  assert.ok(skill.includes("description: Use when "));
  assert.ok(skill.split("---", 3)[1].length < 1024);
  assert.ok(skill.includes("Current Preview boundary"));
  assert.ok(skill.includes("do not substitute manual GitHub commands"));
  assert.ok(skill.includes("local-candidate Preview"));
  assert.ok(skill.includes("state-bound GitHub apply"));
  assert.ok(skill.includes("branch push"));
  assert.ok(skill.includes("explicit expected-value lease"));
  assert.ok(skill.includes("replacement refs and graft files"));
  assert.ok(skill.includes("explicit confirmation"));
  assert.ok(skill.includes("`FB-001`"));
  assert.ok(skill.includes("`OPT-001`"));
  assert.ok(skill.includes("Never mark an `OPT-*` as `accepted`"));

  const references = [
    "agent-documentation.md",
    "evidence-and-optimization.md",
    "repository-and-lifecycle.md",
    "provider-integration.md",
    "publication-and-update.md",
    "security-and-privacy.md",
    "evaluation.md",
    "self-maintenance.md",
  ];
  for (const name of references) {
    const content = read(`skills/agent-skill-maintainer/references/${name}`);
    assert.ok(!content.includes("TODO"));
    assert.ok(skill.includes(`references/${name}`));
  }
  const evidenceContract = read(
    "skills/agent-skill-maintainer/references/evidence-and-optimization.md",
  );
  assert.ok(evidenceContract.includes("Do not create an `OPT-*`"));
  assert.ok(evidenceContract.includes("three or more digits"));
  const documentation = read(
    "skills/agent-skill-maintainer/references/agent-documentation.md",
  );
  for (const phrase of [
    "`.agents/` is one convention",
    "`docs/agents/`",
    "machine-owned",
    "`agents-doc-maintainer`",
    "`not-required`",
  ]) {
    assert.ok(documentation.includes(phrase));
  }

  const cases = JSON.parse(read("evals/cases/triggering.json"));
  const labels = new Set(cases.map((item) => item.label));
  assert.ok(
    ["explicit", "paraphrase", "missing-target", "negative"].every((label) =>
      labels.has(label),
    ),
  );
  assert.ok(cases.some((item) => item.should_trigger));
  assert.ok(cases.some((item) => !item.should_trigger));

  const metadata = read(
    "skills/agent-skill-maintainer/agents/openai.yaml",
  );
  assert.ok(metadata.includes('display_name: "Agent Skill Maintainer"'));
  assert.ok(metadata.includes("$agent-skill-maintainer"));
});

test("isolation reference requires non-executing Git materialization", () => {
  const content = read(
    "skills/agent-skill-maintainer/references/repository-and-lifecycle.md",
  );
  for (const phrase of [
    "installed fingerprint",
    "canonical paths",
    "clone --no-checkout",
    "git cat-file",
    "symlink",
    "submodule",
    "smudge filter",
  ]) {
    assert.ok(content.includes(phrase), `reference missing: ${phrase}`);
  }
});

test("CLI target, state recovery, and schema validation are machine-readable", () => {
  const target = runNode(CLI, "target", "--explicit", "skill-a");
  assert.equal(target.status, 0, target.stderr);
  assert.deepEqual(JSON.parse(target.stdout), {
    targets: ["skill-a"],
    candidates: [],
    requires_confirmation: false,
  });

  const stateRoot = mkdtempSync(join(tmpdir(), "maintainer-cli-"));
  try {
    const start = runNode(
      CLI,
      "start",
      "--state-root",
      stateRoot,
      "--run-id",
      "run-001",
      "--binding-id",
      "binding-001",
      "--skill",
      "example-skill",
      "--repository",
      "example/skill",
    );
    assert.equal(start.status, 0, start.stderr);
    const started = JSON.parse(start.stdout);
    assert.equal(started.phase, "target_selection");
    assert.equal(started.target.skill, "example-skill");

    const status = runNode(
      CLI,
      "status",
      "--state-root",
      stateRoot,
      "--run-id",
      "run-001",
    );
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), started);

    const evidencePath = resolve(stateRoot, "evidence.json");
    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        schema_version: 1,
        id: "EV-001",
        source_type: "current-run",
        source_ref: "sha256:example",
        skill_version: "0.1.0",
        redacted_summary: "虛構且已脫敏的摘要。",
        confidence: "high",
      })}\n`,
      "utf8",
    );
    const valid = runNode(
      CLI,
      "validate",
      "--schema",
      "evidence",
      "--input",
      evidencePath,
    );
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), {
      schema: "evidence",
      valid: true,
    });

    writeFileSync(evidencePath, "{}\n", "utf8");
    const invalid = runNode(
      CLI,
      "validate",
      "--schema",
      "evidence",
      "--input",
      evidencePath,
    );
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).valid, false);
    assert.ok(!invalid.stderr.includes("Traceback"));
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("CLI creates state-bound GitHub previews and expiring approvals", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-github-cli-"));
  try {
    const statePath = resolve(root, "github-state.json");
    const previewPath = resolve(root, "github-preview.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        run_id: "run-001",
        binding_id: "binding-001",
        account: "example-user",
        repository: "example/skill",
        relationship: "managed",
        base_branch: "main",
        base_commit: "0".repeat(40),
        head_branch: "feature",
        head_commit: "a".repeat(40),
        diff_hash: "b".repeat(64),
        action_target: {
          title: "Improve workflow",
          body: "Adds the verified improvement.",
          draft: true,
          head_repository: "example/skill",
        },
        release_enabled: false,
        provider_contract_hash: "c".repeat(64),
      })}\n`,
      "utf8",
    );
    const preview = runNode(
      CLI,
      "github-preview",
      "--action",
      "pr_create",
      "--state",
      statePath,
    );
    assert.equal(preview.status, 0, preview.stderr);
    const previewDocument = JSON.parse(preview.stdout);
    assert.equal(previewDocument.action, "pr_create");
    assert.equal(previewDocument.fingerprint.length, 64);
    writeFileSync(
      previewPath,
      `${JSON.stringify(previewDocument)}\n`,
      "utf8",
    );

    const approval = runNode(
      CLI,
      "github-approve",
      "--preview",
      previewPath,
      "--confirmed-at",
      "2026-07-23T08:00:00.000Z",
      "--expires-at",
      "2026-07-23T08:15:00.000Z",
    );
    assert.equal(approval.status, 0, approval.stderr);
    const approvalDocument = JSON.parse(approval.stdout);
    assert.equal(approvalDocument.action, "pr_create");
    assert.equal(
      approvalDocument.preview_fingerprint,
      previewDocument.fingerprint,
    );
    assert.equal(approvalDocument.fingerprint.length, 64);

    const candidate = resolve(root, "candidate");
    initializeRepository(candidate);
    runGit(candidate, "switch", "-c", "maintain/preview");
    const candidateHead = runGit(candidate, "rev-parse", "HEAD");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        run_id: "run-001",
        binding_id: "binding-001",
        account: "example-user",
        repository: "example/skill",
        relationship: "managed",
        base_branch: "main",
        base_commit: candidateHead,
        head_branch: "maintain/preview",
        head_commit: candidateHead,
        diff_hash: "b".repeat(64),
        action_target: {
          expected_remote_commit: null,
          head_repository: "example/skill",
          operation: "create",
        },
        release_enabled: false,
        provider_contract_hash: "c".repeat(64),
      })}\n`,
      "utf8",
    );
    const branchPreview = runNode(
      CLI,
      "github-preview",
      "--action",
      "branch_push",
      "--state",
      statePath,
      "--candidate",
      candidate,
    );
    assert.equal(branchPreview.status, 0, branchPreview.stderr);
    const branchDocument = JSON.parse(branchPreview.stdout);
    assert.equal(branchDocument.action, "branch_push");
    assert.equal(
      branchDocument.state.action_target.candidate_path_fingerprint.length,
      64,
    );
    assert.equal(branchDocument.state.action_target.operation, "create");

    const invalidCandidate = runNode(
      CLI,
      "github-preview",
      "--action",
      "pr_create",
      "--state",
      statePath,
      "--candidate",
      candidate,
    );
    assert.equal(invalidCandidate.status, 1);
    assert.match(invalidCandidate.stderr, /只適用於 branch_push/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI branch push completes approval apply and reconcile", () => {
  const fixture = createCliBranchPushFixture();
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    const {
      stateRoot,
      state,
      previewPath,
      approvalPath,
      transitioned,
    } = prepared;
    const repository = fixture.candidateSnapshot.repository_snapshot;
    assert.equal(transitioned.phase, "branch_push");

    let pushed = false;
    const githubRunner = branchPushGithubRunner(state);
    const gitRunner = (candidate, arguments_) => {
      if (arguments_[0] === "ls-remote") {
        return pushed
          ? `${repository.head_commit}\trefs/heads/${fixture.branch}\n`
          : "";
      }
      if (arguments_[0] === "cat-file") {
        assert.notEqual(candidate, fixture.candidate);
        return "";
      }
      if (arguments_[0] === "push") {
        assert.notEqual(candidate, fixture.candidate);
        assert.ok(
          arguments_.includes(
            `--force-with-lease=refs/heads/${fixture.branch}:`,
          ),
        );
        assert.equal(
          arguments_.at(-1),
          `${repository.head_commit}:refs/heads/${fixture.branch}`,
        );
        pushed = true;
        return [
          "To https://github.com/example/skill.git",
          `*\t${repository.head_commit}:refs/heads/${fixture.branch}\t[new branch]`,
        ].join("\n");
      }
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    };
    const applied = runMaintainerCommand(
      [
        "github-apply",
        "--state-root",
        stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        previewPath,
        "--approval",
        approvalPath,
        "--candidate",
        fixture.candidate,
      ],
      {
        githubRunner,
        gitRunner,
        temporaryRoot: fixture.root,
      },
    );
    assert.equal(applied.action, "branch_push");
    assert.equal(applied.proof.verified, true);
    assert.equal(
      readRun(stateRoot, "run-001")
        .github_action_attempts.at(-1).action,
      "branch_push",
    );

    const reconciled = runMaintainerCommand(
      [
        "github-reconcile",
        "--state-root",
        stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        previewPath,
        "--approval",
        approvalPath,
      ],
      {
        githubRunner,
        gitRunner,
        temporaryRoot: fixture.root,
      },
    );
    assert.equal(reconciled.status, "applied");
    assert.equal(reconciled.proof.commit, repository.head_commit);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI branch push records not-applied proof before allowing a new approval", () => {
  const fixture = createCliBranchPushFixture();
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    const {
      stateRoot,
      state,
      preview,
      actionStatePath,
      previewPath,
      approvalPath,
    } = prepared;
    const githubRunner = branchPushGithubRunner(state);
    assert.throws(
      () =>
        runMaintainerCommand(
          [
            "github-apply",
            "--state-root",
            stateRoot,
            "--run-id",
            "run-001",
            "--preview",
            previewPath,
            "--approval",
            approvalPath,
            "--candidate",
            fixture.candidate,
          ],
          {
            githubRunner,
            gitRunner: () => {
              throw new Error("simulated pre-push interruption");
            },
            temporaryRoot: fixture.root,
          },
        ),
      /simulated pre-push interruption/u,
    );
    assert.equal(
      readRun(stateRoot, "run-001").github_action_attempts.length,
      1,
    );

    const reconciled = runMaintainerCommand(
      [
        "github-reconcile",
        "--state-root",
        stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        previewPath,
        "--approval",
        approvalPath,
      ],
      {
        githubRunner,
        gitRunner: () => "",
        temporaryRoot: fixture.root,
      },
    );
    assert.equal(reconciled.status, "not_applied");
    const afterReconcile = readRun(stateRoot, "run-001");
    assert.equal(
      afterReconcile.github_action_reconciliations.at(-1).status,
      "not_applied",
    );

    const retryPreviewPath = resolve(
      fixture.root,
      "branch-retry-preview.json",
    );
    const retryApprovalPath = resolve(
      fixture.root,
      "branch-retry-approval.json",
    );
    const retryUpdatesPath = resolve(
      fixture.root,
      "branch-retry-updates.json",
    );
    const retryPreview = runMaintainerCommand([
      "github-preview",
      "--action",
      "branch_push",
      "--state",
      actionStatePath,
      "--candidate",
      fixture.candidate,
    ]);
    assert.deepEqual(retryPreview, preview);
    writeFileSync(
      retryPreviewPath,
      `${JSON.stringify(retryPreview)}\n`,
      "utf8",
    );
    const retryNow = Date.now();
    const retryApproval = runMaintainerCommand([
      "github-approve",
      "--preview",
      retryPreviewPath,
      "--confirmed-at",
      new Date(retryNow - 30_000).toISOString(),
      "--expires-at",
      new Date(retryNow + 10 * 60_000).toISOString(),
    ]);
    writeFileSync(
      retryApprovalPath,
      `${JSON.stringify(retryApproval)}\n`,
      "utf8",
    );
    writeFileSync(
      retryUpdatesPath,
      `${JSON.stringify({
        validation_summary: fixture.validationSummary,
        action_preview: retryPreview,
        approvals: [retryApproval],
      })}\n`,
      "utf8",
    );
    const retried = runMaintainerCommand([
      "transition",
      "--state-root",
      stateRoot,
      "--run-id",
      "run-001",
      "--phase",
      "branch_push",
      "--updates",
      retryUpdatesPath,
    ]);
    assert.equal(retried.phase, "branch_push");
    assert.equal(
      retried.consumed_approval_fingerprints.includes(
        retryApproval.fingerprint,
      ),
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI contributor branch push writes only the verified existing Fork", () => {
  const fixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    const upstreamRemote = resolve(fixture.root, "upstream.git");
    const forkRemote = resolve(fixture.root, "fork.git");
    runGit(
      fixture.root,
      "clone",
      "--bare",
      fixture.candidate,
      upstreamRemote,
    );
    runGit(
      fixture.root,
      "clone",
      "--bare",
      fixture.candidate,
      forkRemote,
    );
    const remoteRef = `refs/heads/${fixture.branch}`;
    runGit(upstreamRemote, "update-ref", "-d", remoteRef);
    runGit(forkRemote, "update-ref", "-d", remoteRef);
    const result = runMaintainerCommand(
      [
        "github-apply",
        "--state-root",
        prepared.stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        prepared.previewPath,
        "--approval",
        prepared.approvalPath,
        "--candidate",
        fixture.candidate,
      ],
      {
        githubRunner: branchPushGithubRunner(prepared.state),
        gitRunner: localRemoteGitRunner(
          new Map([
            [
              "https://github.com/example/skill.git",
              upstreamRemote,
            ],
            [
              "https://github.com/contributor/skill.git",
              forkRemote,
            ],
          ]),
        ),
        temporaryRoot: fixture.root,
      },
    );
    assert.equal(result.action, "branch_push");
    assert.equal(result.proof.relationship, "contribute");
    assert.equal(result.proof.head_repository, "contributor/skill");
    assert.equal(
      runGit(forkRemote, "rev-parse", remoteRef),
      fixture.candidateSnapshot.repository_snapshot.head_commit,
    );
    assert.equal(
      runGit(
        upstreamRemote,
        "for-each-ref",
        "--format=%(objectname)",
        remoteRef,
      ),
      "",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI contributor branch push blocks a missing Fork before Git access", () => {
  const fixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    let gitCalls = 0;
    assert.throws(
      () =>
        runMaintainerCommand(
          [
            "github-apply",
            "--state-root",
            prepared.stateRoot,
            "--run-id",
            "run-001",
            "--preview",
            prepared.previewPath,
            "--approval",
            prepared.approvalPath,
            "--candidate",
            fixture.candidate,
          ],
          {
            githubRunner: branchPushGithubRunner(
              prepared.state,
              { forkAvailable: false },
            ),
            gitRunner: () => {
              gitCalls += 1;
              return "";
            },
            temporaryRoot: fixture.root,
          },
        ),
      /不支援自動建立 Fork/u,
    );
    assert.equal(gitCalls, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publication, evaluation, and repository validators execute directly", () => {
  const publication = runNode("scripts/validate-publication.mjs");
  assert.equal(publication.status, 0, publication.stdout + publication.stderr);
  assert.ok(publication.stdout.includes("publication validation passed"));

  const evaluation = runNode("evals/run-evals.mjs", "--suite", "all");
  assert.equal(evaluation.status, 0, evaluation.stdout + evaluation.stderr);
  const report = JSON.parse(evaluation.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.trigger_cases, 6);
  assert.equal(report.publication_gate.allowed, true);
  assert.equal(
    report.publication_gate.evidence_kind,
    "synthetic-contract-fixture",
  );
  assert.equal(report.publication_gate.authorizes_release, false);
  assert.equal(report.release_ready, false);
  assert.equal(report.redacted_real_usage_cases, 1);
  assert.equal(report.real_usage_contract_passed, true);
  assert.equal(report.provider_version_validation.passed, true);
  assert.equal(report.provider_version_validation.formal_profiles, 5);
  assert.equal(
    report.release_blockers.includes(
      "provider_version_validation_pending",
    ),
    false,
  );
  assert.equal(report.agent_forward_evaluation.passed, true);
  assert.match(
    report.agent_forward_evaluation.candidate_skill_fingerprint,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    report.agent_forward_evaluation.candidate_passed_behaviors,
    6,
  );
  assert.equal(report.agent_forward_evaluation.candidate_regressions, 0);
  assert.equal(report.platform_validation.passed, true);
  assert.deepEqual(
    report.platform_validation.platforms.map((platform) => platform.id).sort(),
    ["claude-code", "codex"],
  );
  assert.equal(
    report.release_blockers.includes("agent_forward_evaluation_pending"),
    false,
  );
  assert.equal(
    report.release_blockers.includes("platform_validation_pending"),
    false,
  );
  assert.deepEqual(report.release_blockers, ["controlled_github_e2e_pending"]);

  const repository = runNode(
    "scripts/validate-repository.mjs",
    "--input",
    "tests/fixtures/repository-settings-missing.json",
  );
  assert.equal(repository.status, 1);
  const repositoryReport = JSON.parse(repository.stdout);
  assert.equal(repositoryReport.compliant, false);
  assert.ok(repositoryReport.missing.includes("ruleset_required"));
  assert.ok(repositoryReport.missing.includes("release_immutability"));
});

test("publication blocks tracked process artifacts but permits focused product files", () => {
  assert.deepEqual(
    validateTrackedProcessArtifacts([
      "skills/agent-skill-maintainer/SKILL.md",
      "tests/git.test.mjs",
      "docs/plans/private-plan.md",
      "evals/results/raw-output.json",
      ".agent-skill-maintainer/runs/run-001.json",
    ]),
    [
      "tracked process artifact is not allowed: docs/plans/private-plan.md",
      "tracked process artifact is not allowed: evals/results/raw-output.json",
      "tracked process artifact is not allowed: .agent-skill-maintainer/runs/run-001.json",
    ],
  );
});

test("forward evaluation aggregate rejects self-reported count drift", () => {
  const aggregate = JSON.parse(
    read("evals/evidence/preview-v0.1.0.json"),
  );
  const currentSkillFingerprint = aggregate.candidate_skill_fingerprint;
  assert.equal(
    validateForwardEvaluationAggregate(aggregate, {
      currentSkillFingerprint,
    }).forward.passed,
    true,
  );
  aggregate.forward_evaluation.candidate_passed_behaviors = 5;
  assert.equal(
    validateForwardEvaluationAggregate(aggregate, {
      currentSkillFingerprint,
    }).forward.passed,
    false,
  );
});

test("forward fixture keeps positive discovery and negative non-trigger contracts stable", () => {
  const fixture = JSON.parse(
    read("evals/cases/sample-cleanup-forward.json"),
  );
  assert.equal(validateForwardEvaluationFixture(fixture), true);
  assert.equal(
    validateForwardEvaluationFixture({
      ...fixture,
      positive_expectations: {
        ...fixture.positive_expectations,
        minimum_defect_findings: 1,
      },
    }),
    false,
  );
});

test("publication validator scans public docs but excludes local process artifacts", () => {
  const publicDirectory = resolve(ROOT, "docs", "public");
  const publicDocument = resolve(publicDirectory, "sample.md");
  mkdirSync(publicDirectory, { recursive: true });
  writeFileSync(publicDocument, "TODO: remove placeholder\n", "utf8");
  try {
    const errors = validatePublication();
    assert.ok(
      errors.some((error) => error.includes("docs/public/sample.md")),
      errors.join("\n"),
    );
  } finally {
    rmSync(publicDocument, { force: true });
    rmSync(publicDirectory, { recursive: true, force: true });
  }
});

test("structured asset validation rejects malformed schemas", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "maintainer-assets-"));
  try {
    const candidate = resolve(temporaryRoot, "skill");
    cpSync(resolve(SKILL_ROOT, "assets"), resolve(candidate, "assets"), {
      recursive: true,
    });
    writeFileSync(
      resolve(candidate, "assets", "schemas", "target.schema.json"),
      "{invalid",
      "utf8",
    );
    const errors = validateStructuredAssets(candidate);
    assert.ok(
      errors.some((error) => error.includes("target.schema.json")),
      errors.join("\n"),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
