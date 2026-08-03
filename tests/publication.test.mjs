import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  publicTextFiles,
  validateMarkdownRelativeLinks,
  validateNeutralControllerSource,
  validatePublication,
  validateStructuredAssets,
  validateTrackedProcessArtifacts,
} from "../scripts/validate-publication.mjs";
import {
  validateForkForwardAggregate,
  validateForkForwardFixture,
  deriveBlindedForwardAggregate,
  validateForwardEvaluationAggregate,
  validateForwardEvaluationFixture,
  validateHeldoutForwardFixture,
  validateLocalUpdateForwardAggregate,
  validateLocalUpdateForwardFixture,
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
  fingerprintTree,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  COMMAND_REGISTRY,
  runMaintainerCommand,
} from "../skills/agent-skill-maintainer/scripts/maintainer.mjs";
import {
  branchPushGithubRunner,
  candidateFixture,
  codexTranscript,
  createBranchPushFixture,
  evaluationTranscriptTools,
  FORWARD_EVALUATION_PROCESS_ARTIFACT_PREFIXES,
  forwardEvaluationBindingFixture,
  forwardEvaluationRepositorySnapshot,
  githubCapability,
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
        details: forwardEvaluationBindingFixture(
          fixture.candidateSnapshot,
          fixture.candidate,
        ),
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
    transition = true,
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
    capability_proof: githubCapability({
      account,
      relationship: fixture.binding.relationship,
      defaultBranch: repository.base_ref,
    }),
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
      ...(fixture.binding.relationship === "contribute"
        ? {
            fork_proof: {
              schema_version: 1,
              repository: "example/skill",
              fork_repository: headRepository,
              account,
              relationship: "contribute",
              base_branch: repository.base_ref,
              base_commit: repository.merge_base,
              default_branch_only: true,
              operation: "reuse",
              parent_repository: "example/skill",
              base_commit_available: true,
              verified: true,
            },
          }
        : {}),
      action_preview: preview,
      approvals: [approval],
    })}\n`,
    "utf8",
  );
  const transitioned = transition
    ? runMaintainerCommand([
        "transition",
        "--state-root",
        stateRoot,
        "--run-id",
        "run-001",
        "--phase",
        "branch_push",
        "--updates",
        updatesPath,
        "--candidate",
        fixture.candidate,
      ])
    : null;
  return {
    stateRoot,
    state,
    preview,
    approval,
    actionStatePath,
    previewPath,
    approvalPath,
    updatesPath,
    transitioned,
  };
}

/** Prepares one contribute Fork action at the fork_creation lifecycle stage. */
function prepareCliForkAction(fixture) {
  const stateRoot = prepareCliValidationRun(fixture);
  const statePath = resolve(fixture.root, "fork-state.json");
  const previewPath = resolve(fixture.root, "fork-preview.json");
  const approvalPath = resolve(fixture.root, "fork-approval.json");
  const updatesPath = resolve(fixture.root, "fork-updates.json");
  const repository = fixture.candidateSnapshot.repository_snapshot;
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    account: "contributor",
    repository: "example/skill",
    relationship: "contribute",
    base_branch: repository.base_ref,
    base_commit: repository.merge_base,
    head_branch: fixture.branch,
    head_commit: repository.head_commit,
    diff_hash: fixture.candidateSnapshot.candidate_diff_hash,
    action_target: {
      fork_repository: "contributor/skill",
      default_branch_only: true,
      operation: "create",
    },
    capability_proof: githubCapability({
      account: "contributor",
      relationship: "contribute",
      defaultBranch: repository.base_ref,
    }),
    provider_contract_hash: fingerprint(loadProviderProfiles()),
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");
  const preview = runMaintainerCommand([
    "github-preview",
    "--action",
    "fork_create",
    "--state",
    statePath,
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
  runMaintainerCommand([
    "transition",
    "--state-root",
    stateRoot,
    "--run-id",
    "run-001",
    "--phase",
    "fork_creation",
    "--updates",
    updatesPath,
  ]);
  return {
    stateRoot,
    state,
    statePath,
    preview,
    previewPath,
    approval,
    approvalPath,
  };
}

/** Returns one CLI Fork runner whose destination appears after POST. */
function cliForkGithubRunner(
  state,
  {
    forkExists = false,
    appearAfterPost = true,
    postError = false,
    forkReadFailureOn = null,
  } = {},
) {
  let exists = forkExists;
  let postCount = 0;
  let forkReadCount = 0;
  const runner = (arguments_) => {
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
          viewerPermission: "READ",
          defaultBranchRef: { name: state.base_branch },
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
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === state.action_target.fork_repository
    ) {
      forkReadCount += 1;
      if (forkReadCount === forkReadFailureOn) {
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
          nameWithOwner: state.action_target.fork_repository,
          viewerPermission: "WRITE",
          parent: { nameWithOwner: state.repository },
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
      if (postError) {
        return {
          status: 1,
          stdout: "",
          stderr: "network result unknown",
        };
      }
      exists = appearAfterPost;
      return {
        status: 0,
        stdout: JSON.stringify({
          full_name: state.action_target.fork_repository,
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] ===
        `repos/${state.action_target.fork_repository}/commits/${state.base_commit}`
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({ sha: state.base_commit }),
        stderr: "",
      };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };
  return {
    runner,
    get postCount() {
      return postCount;
    },
    get forkReadCount() {
      return forkReadCount;
    },
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
    ".agents/adr/0003-deterministic-fork-creation.md",
    ".agents/adr/0004-deterministic-local-skill-update.md",
    ".agents/adr/0008-transactional-candidate-cleanup.md",
    ".agents/adr/0009-traceable-blinded-adjudication.md",
    ".agents/adr/0010-bound-legacy-remote-skill-identity.md",
    ".agents/adr/0011-exact-private-evaluation-binding.md",
    "evals/cases/sample-cleanup-forward.json",
    "evals/cases/archive-release-resumption-heldout.json",
    "evals/cases/evaluation-binding-heldout.json",
    "evals/cases/fork-creation-forward.json",
    "evals/cases/local-update-forward.json",
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
  assert.deepEqual(validateMarkdownRelativeLinks(), []);
  assert.deepEqual(
    validateMarkdownRelativeLinks([
      {
        path: resolve(ROOT, "AGENTS.md"),
        relativePath: "AGENTS.md",
        content:
          "[missing](.agents/adr/9999-missing.md) [external](https://example.com)",
        symlink: false,
      },
    ]),
    [
      "missing Markdown link target: AGENTS.md: .agents/adr/9999-missing.md",
    ],
  );
  const rootGuidance = read("AGENTS.md");
  for (const relativePath of [
    ".agents/architecture.md",
    ".agents/documentation.md",
    ".agents/releasing.md",
  ]) {
    assert.match(rootGuidance, new RegExp(relativePath.replaceAll(".", "\\.")));
  }
});

test("README documents the stable contract, npx installation, and zero-dependency Node runtime", () => {
  const content = read("README.md");
  for (const phrase of [
    "Stable contract",
    "npx skills add",
    "Codex",
    "Claude Code",
    "MIT",
    "node skills/agent-skill-maintainer/scripts/maintainer.mjs",
    "No `npm install`",
    "github-preview",
    "github-reconcile",
    "github-fork-verify",
    "update-preview",
    "update-apply",
    "update-reconcile",
    "fork_create",
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

test("Skill metadata, trigger cases, references, and stable boundary remain complete", () => {
  const skill = read("skills/agent-skill-maintainer/SKILL.md");
  assert.ok(skill.startsWith("---\n"));
  assert.ok(skill.includes("name: agent-skill-maintainer"));
  assert.ok(skill.includes("description: Use when "));
  assert.ok(skill.split("---", 3)[1].length < 1024);
  assert.ok(skill.includes("Stable capability boundary"));
  assert.ok(skill.includes("do not substitute manual GitHub commands"));
  assert.ok(skill.includes("stable workflow"));
  assert.ok(skill.includes("state-bound GitHub apply"));
  assert.ok(skill.includes("personal Fork creation"));
  assert.ok(skill.includes("branch push"));
  assert.ok(skill.includes("explicit expected-value lease"));
  assert.ok(skill.includes("replacement refs and graft files"));
  assert.ok(skill.includes("explicit confirmation"));
  assert.ok(skill.includes("`FB-001`"));
  assert.ok(skill.includes("`OPT-001`"));
  assert.ok(skill.includes("target-intent map"));
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
  for (const phrase of [
    "## Target-intent map",
    "explicit non-goals",
    "cannot override a verified target decision",
    "## Skill structure-quality lens",
    "invocation precision",
    "checkable completion",
    "progressive disclosure",
    "single ownership",
    "no-op, sprawl, and sediment",
    "does not justify an `OPT-*` by itself",
  ]) {
    assert.ok(
      evidenceContract.includes(phrase),
      `evidence contract missing: ${phrase}`,
    );
  }
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
  const adjudicationAdr = read(
    ".agents/adr/0011-exact-private-evaluation-binding.md",
  );
  assert.ok(
    adjudicationAdr.includes(
      "Preserve the stable controller as authority",
    ),
  );
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

test("CLI help is complete, scoped to Skill maintenance, and side-effect aware", () => {
  const help = runNode(CLI, "--help");
  assert.equal(help.status, 0, help.stderr);
  const document = JSON.parse(help.stdout);
  assert.equal(
    document.capability_scope,
    "selected-agent-skill-maintenance-only",
  );
  assert.equal(document.command_count, 25);
  assert.equal(document.commands.length, 25);
  assert.deepEqual(
    document.non_goals,
    [
      "general-codebase-maintenance",
      "general-repository-publication",
      "arbitrary-workflow-orchestration",
    ],
  );
  const names = document.commands.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    [...names].sort(),
    Object.keys(COMMAND_REGISTRY).sort(),
  );
  const dispatcherNames = [
    ...read("skills/agent-skill-maintainer/scripts/maintainer.mjs")
      .matchAll(/if \(command === "([^"]+)"\)/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...dispatcherNames].sort(),
    Object.keys(COMMAND_REGISTRY).sort(),
  );
  for (const command of document.commands) {
    assert.ok(command.summary.length > 0);
    assert.ok(
      [
        "direct-read-only",
        "direct-preview",
        "explicit-confirmation-only",
      ].includes(command.natural_language_policy),
    );
    if (command.side_effect !== "none") {
      assert.notEqual(
        command.natural_language_policy,
        "direct-read-only",
      );
    }
  }
  for (const name of [
    "github-apply",
    "update-apply",
    "cleanup-apply",
    "cleanup-reconcile",
  ]) {
    assert.equal(
      document.commands.find((command) => command.name === name)
        .natural_language_policy,
      "explicit-confirmation-only",
    );
  }

  const single = runNode(
    CLI,
    "help",
    "--command",
    "github-preview",
  );
  assert.equal(single.status, 0, single.stderr);
  const singleDocument = JSON.parse(single.stdout);
  assert.equal(singleDocument.command_count, 1);
  assert.equal(
    singleDocument.commands[0].natural_language_policy,
    "direct-preview",
  );
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
      "--skill-path",
      "skill",
      "--repository",
      "example/skill",
    );
    assert.equal(start.status, 0, start.stderr);
    const started = JSON.parse(start.stdout);
    assert.equal(started.phase, "target_selection");
    assert.equal(started.target.skill, "example-skill");
    assert.equal(started.target.skill_path, "skill");

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

    const legacyStatePath = resolve(
      stateRoot,
      "runs",
      "legacy-status",
      "state.json",
    );
    mkdirSync(resolve(legacyStatePath, ".."), { recursive: true });
    const legacyStateBytes = `${JSON.stringify({
      schema_version: 1,
      run_id: "legacy-status",
      binding_id: "binding-legacy",
      phase: "completed",
      status: "completed",
      target: { skill: "example-skill" },
      approvals: [],
    })}\n`;
    writeFileSync(legacyStatePath, legacyStateBytes, "utf8");
    const legacyStatus = runNode(
      CLI,
      "status",
      "--state-root",
      stateRoot,
      "--run-id",
      "legacy-status",
    );
    assert.equal(legacyStatus.status, 0, legacyStatus.stderr);
    assert.equal(JSON.parse(legacyStatus.stdout).schema_version, 8);
    assert.equal(
      readFileSync(legacyStatePath, "utf8"),
      legacyStateBytes,
    );

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

test("CLI binds schema v5 private sources to the exact candidate Skill", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-eval-bind-"));
  let privateBundle;
  try {
    const candidate = candidateFixture({
      repository_snapshot: forwardEvaluationRepositorySnapshot(ROOT),
      skill_path: "skills/agent-skill-maintainer",
      skill_name: "agent-skill-maintainer",
      candidate_skill_fingerprint: fingerprintTree(SKILL_ROOT),
      process_artifact_prefixes:
        FORWARD_EVALUATION_PROCESS_ARTIFACT_PREFIXES,
    });
    privateBundle = forwardEvaluationBindingFixture(
      candidate,
      ROOT,
      { includePrivateSources: true },
    );
    const expectedBinding = privateBundle.binding;
    const sources = privateBundle.sources;
    const candidatePath = resolve(root, "candidate.json");
    const fixturePath = resolve(root, "fixture.json");
    const assignmentPath = resolve(root, "assignment.json");
    const sessionsPath = resolve(root, "sessions.json");
    const labelAOutputPath = resolve(root, "label-a-output.json");
    const labelAEventsPath = resolve(root, "label-a-events.json");
    const labelBOutputPath = resolve(root, "label-b-output.json");
    const labelBEventsPath = resolve(root, "label-b-events.json");
    const judgePath = resolve(root, "judge.json");
    const platformPath = resolve(root, "platform.json");
    const attestationPath = resolve(root, "attestation.json");
    writeFileSync(
      candidatePath,
      `${JSON.stringify(sources.candidateSnapshot)}\n`,
      "utf8",
    );
    for (const [path, document] of [
      [fixturePath, sources.fixture],
      [assignmentPath, sources.assignment],
      [sessionsPath, sources.sessions],
      [judgePath, sources.judgeOutput],
      [platformPath, sources.platformValidationSource],
      [attestationPath, sources.evaluatorAttestation],
    ]) {
      writeFileSync(path, `${JSON.stringify(document)}\n`, "utf8");
    }
    writeFileSync(labelAOutputPath, sources.labelA.output, "utf8");
    writeFileSync(labelBOutputPath, sources.labelB.output, "utf8");
    writeFileSync(labelAEventsPath, sources.labelA.events, "utf8");
    writeFileSync(labelBEventsPath, sources.labelB.events, "utf8");
    const result = runNode(
      CLI,
      "eval-bind",
      "--candidate-snapshot",
      candidatePath,
      "--candidate",
      sources.candidatePath,
      "--fixture",
      fixturePath,
      "--assignment",
      assignmentPath,
      "--sessions",
      sessionsPath,
      "--label-a-output",
      labelAOutputPath,
      "--label-a-events",
      labelAEventsPath,
      "--label-b-output",
      labelBOutputPath,
      "--label-b-events",
      labelBEventsPath,
      "--judge-output",
      judgePath,
      "--measured-at",
      sources.measuredAt,
      "--unblinded-at",
      sources.unblindedAt,
      "--platform-validation",
      platformPath,
      "--evaluator-attestation",
      attestationPath,
    );
    assert.equal(result.status, 0, result.stderr);
    const binding = JSON.parse(result.stdout);
    assert.equal(
      binding.evidence_kind,
      "blinded-forward-evaluation-binding",
    );
    assert.equal(
      binding.candidate_skill_fingerprint,
      candidate.candidate_skill_fingerprint,
    );
    assert.equal(binding.aggregate.schema_version, 5);

    const forgedFixture = structuredClone(expectedBinding.fixture);
    forgedFixture.target_files.candidate_sha256["SKILL.md"] =
      "0".repeat(64);
    writeFileSync(
      fixturePath,
      `${JSON.stringify(forgedFixture)}\n`,
      "utf8",
    );
    const rejected = runNode(
      CLI,
      "eval-bind",
      "--candidate-snapshot",
      candidatePath,
      "--candidate",
      sources.candidatePath,
      "--fixture",
      fixturePath,
      "--assignment",
      assignmentPath,
      "--sessions",
      sessionsPath,
      "--label-a-output",
      labelAOutputPath,
      "--label-a-events",
      labelAEventsPath,
      "--label-b-output",
      labelBOutputPath,
      "--label-b-events",
      labelBEventsPath,
      "--judge-output",
      judgePath,
      "--measured-at",
      sources.measuredAt,
      "--unblinded-at",
      sources.unblindedAt,
      "--platform-validation",
      platformPath,
      "--evaluator-attestation",
      attestationPath,
    );
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /binding fixture 與 live candidate fixture 不一致/u,
    );
  } finally {
    privateBundle?.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("neutral controller independently rejects forbidden tools and provider substitution", () => {
  const root = mkdtempSync(
    join(tmpdir(), "maintainer-neutral-controller-"),
  );
  let privateBundle;
  try {
    const candidate = candidateFixture({
      repository_snapshot: forwardEvaluationRepositorySnapshot(ROOT),
      skill_path: "skills/agent-skill-maintainer",
      skill_name: "agent-skill-maintainer",
      candidate_skill_fingerprint: fingerprintTree(SKILL_ROOT),
      process_artifact_prefixes:
        FORWARD_EVALUATION_PROCESS_ARTIFACT_PREFIXES,
    });
    privateBundle = forwardEvaluationBindingFixture(
      candidate,
      ROOT,
      { includePrivateSources: true },
    );
    const sources = privateBundle.sources;
    const baseRequest = {
      candidateSkillFingerprint:
        sources.candidateSnapshot
          .candidate_skill_fingerprint,
      fixtureSha256:
        sources.candidateSnapshot.evaluation_fixture_sha256,
      fixtureRaw: sources.fixtureRaw,
      fixture: sources.fixture,
      assignment: sources.assignment,
      sessions: sources.sessions,
      labelA: sources.labelA,
      labelB: sources.labelB,
      judgeOutput: sources.judgeOutput,
      measuredAt: sources.measuredAt,
      unblindedAt: sources.unblindedAt,
      platformValidationEvidence:
        sources.platformValidationEvidence,
    };
    const forbiddenToolRequest = structuredClone(baseRequest);
    forbiddenToolRequest.labelA.events = codexTranscript(
      forbiddenToolRequest.sessions.label_a.session_nonce,
      forbiddenToolRequest.labelA.output,
      [
        ...evaluationTranscriptTools(),
        {
          type: "web_search",
          command: "search remote evidence",
        },
      ],
    );
    const providerSubstitutionRequest =
      structuredClone(baseRequest);
    const claudePlatform =
      providerSubstitutionRequest.platformValidationEvidence
        .platforms.find(
          (platform) => platform.id === "claude-code",
        );
    claudePlatform.positive_transcript = codexTranscript(
      "cross-provider-session",
      claudePlatform.positive_output,
    );
    for (const [name, request, message] of [
      [
        "forbidden-tool",
        forbiddenToolRequest,
        /tool type is not allowed/u,
      ],
      [
        "provider-substitution",
        providerSubstitutionRequest,
        /platform Claude runtime or output mismatch/u,
      ],
    ]) {
      const requestPath = resolve(root, `${name}.json`);
      writeFileSync(
        requestPath,
        `${JSON.stringify(request)}\n`,
        "utf8",
      );
      const result = spawnSync(
        process.execPath,
        [
          sources.neutralControllerPath,
          requestPath,
          sources.authorityPrivateKeyPath,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, message, name);
    }
    const keyPolicyRequestPath = resolve(
      root,
      "key-policy.json",
    );
    writeFileSync(
      keyPolicyRequestPath,
      `${JSON.stringify(baseRequest)}\n`,
      "utf8",
    );
    const relativeKey = spawnSync(
      process.execPath,
      [
        sources.neutralControllerPath,
        keyPolicyRequestPath,
        "relative-private.pem",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(relativeKey.status, 0);
    assert.match(relativeKey.stderr, /must be absolute/u);

    const symlinkedKeyPath = resolve(root, "private-link.pem");
    symlinkSync(
      sources.authorityPrivateKeyPath,
      symlinkedKeyPath,
    );
    const symlinkedKey = spawnSync(
      process.execPath,
      [
        sources.neutralControllerPath,
        keyPolicyRequestPath,
        symlinkedKeyPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(symlinkedKey.status, 0);
    assert.match(
      symlinkedKey.stderr,
      /private regular file/u,
    );

    const callerOwnedCompletion = {
      ...baseRequest,
      platformSessions: [],
    };
    const callerOwnedCompletionPath = resolve(
      root,
      "caller-owned-completion.json",
    );
    writeFileSync(
      callerOwnedCompletionPath,
      `${JSON.stringify(callerOwnedCompletion)}\n`,
      "utf8",
    );
    const callerOwnedResult = spawnSync(
      process.execPath,
      [
        sources.neutralControllerPath,
        "attest-platform-completion",
        callerOwnedCompletionPath,
        sources.authorityPrivateKeyPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(callerOwnedResult.status, 0);
    assert.match(
      callerOwnedResult.stderr,
      /session receipts are incomplete/u,
    );
  } finally {
    privateBundle?.cleanup();
    rmSync(root, { recursive: true, force: true });
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
        capability_proof: githubCapability(),
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
        capability_proof: githubCapability(),
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

test("CLI GitHub inspection returns a live capability proof", () => {
  const proof = runMaintainerCommand(
    [
      "github-inspect",
      "--repository",
      "example/skill",
      "--inspected-at",
      "2026-07-28T08:00:00.000Z",
    ],
    {
      githubRunner: (arguments_) => {
        if (arguments_[0] === "api" && arguments_[1] === "user") {
          return {
            status: 0,
            stdout: "example-user\n",
            stderr: "",
          };
        }
        if (arguments_[0] === "repo") {
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
          arguments_[1] ===
            "repos/example/skill/immutable-releases"
        ) {
          return {
            status: 0,
            stdout: JSON.stringify({ enabled: true }),
            stderr: "",
          };
        }
        throw new Error(`unexpected call: ${arguments_.join(" ")}`);
      },
    },
  );
  assert.equal(proof.relationship, "managed");
  assert.equal(proof.release_enabled, true);
  assert.equal(proof.fingerprint.length, 64);
});

test("branch push transition rejects candidate drift before consuming approval", () => {
  const fixture = createCliBranchPushFixture();
  try {
    const prepared = prepareCliBranchPushAction(fixture, {
      transition: false,
    });
    const consumedBefore = readRun(
      prepared.stateRoot,
      "run-001",
    ).consumed_approval_fingerprints;
    writeFileSync(
      resolve(fixture.candidate, "SKILL.md"),
      "source\nbranch push\ndrifted before transition\n",
      "utf8",
    );
    assert.throws(
      () =>
        runMaintainerCommand([
          "transition",
          "--state-root",
          prepared.stateRoot,
          "--run-id",
          "run-001",
          "--phase",
          "branch_push",
          "--updates",
          prepared.updatesPath,
          "--candidate",
          fixture.candidate,
        ]),
      /必須先提交|漂移/u,
    );
    const state = readRun(prepared.stateRoot, "run-001");
    assert.equal(state.phase, "validation");
    assert.deepEqual(
      state.consumed_approval_fingerprints,
      consumedBefore,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub apply revalidates the exact binding before reserving an attempt", () => {
  const fixture = createCliBranchPushFixture();
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    const statePath = resolve(
      prepared.stateRoot,
      "runs",
      "run-001",
      "state.json",
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const forward = state.validation_summary.checks.find(
      (check) => check.category === "forward",
    );
    forward.details.aggregate.evaluated_at =
      "2026-07-29T00:00:00.000Z";
    forward.details.aggregate_fingerprint = fingerprint(
      forward.details.aggregate,
    );
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

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
            githubRunner: () => {
              throw new Error("binding drift must block before GitHub access");
            },
          },
        ),
      /aggregate|binding|來源|private sources/u,
    );
    assert.deepEqual(
      readRun(prepared.stateRoot, "run-001")
        .attempted_github_action_fingerprints,
      [],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
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
    assert.equal(
      readRun(stateRoot, "run-001")
        .github_action_reconciliations.at(-1).status,
      "applied",
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

test("CLI applied reconcile releases an interrupted GitHub writer", () => {
  const fixture = createCliBranchPushFixture();
  try {
    const prepared = prepareCliBranchPushAction(fixture);
    const repository = fixture.candidateSnapshot.repository_snapshot;
    const githubRunner = branchPushGithubRunner(prepared.state);
    let pushed = false;
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
        pushed = true;
        throw new Error("synthetic response interruption after push");
      }
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    };
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
            githubRunner,
            gitRunner,
            temporaryRoot: fixture.root,
          },
        ),
      /response interruption/u,
    );
    assert.equal(
      readRun(prepared.stateRoot, "run-001")
        .github_action_reconciliations.length,
      0,
    );
    assert.throws(
      () =>
        transitionRun(
          prepared.stateRoot,
          "run-001",
          "blocked",
        ),
      /reconciliation/u,
    );

    const reconciled = runMaintainerCommand(
      [
        "github-reconcile",
        "--state-root",
        prepared.stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        prepared.previewPath,
        "--approval",
        prepared.approvalPath,
      ],
      {
        githubRunner,
        gitRunner,
        temporaryRoot: fixture.root,
      },
    );
    assert.equal(reconciled.status, "applied");
    assert.equal(reconciled.reconciliation.status, "applied");
    assert.equal(
      readRun(prepared.stateRoot, "run-001")
        .github_action_reconciliations.at(-1).status,
      "applied",
    );
    const blocked = transitionRun(
      prepared.stateRoot,
      "run-001",
      "blocked",
    );
    assert.equal(blocked.status, "blocked");
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
      "--candidate",
      fixture.candidate,
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
      /請先完成 fork_create/u,
    );
    assert.equal(gitCalls, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI creates one verified personal Fork and records its attempt time", () => {
  const fixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliForkAction(fixture);
    const fake = cliForkGithubRunner(prepared.state);
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
      ],
      { githubRunner: fake.runner },
    );
    assert.equal(result.status, "applied");
    assert.equal(result.proof.operation, "create");
    assert.equal(result.proof.verified, true);
    assert.equal(fake.postCount, 1);
    const active = readRun(prepared.stateRoot, "run-001");
    assert.equal(active.github_action_attempts.length, 1);
    assert.equal(
      active.github_action_attempts[0].action,
      "fork_create",
    );
    assert.ok(
      Number.isFinite(
        Date.parse(active.github_action_attempts[0].attempted_at),
      ),
    );

    const reuseState = {
      ...prepared.state,
      action_target: {
        ...prepared.state.action_target,
        operation: "reuse",
      },
    };
    writeFileSync(
      prepared.statePath,
      `${JSON.stringify(reuseState)}\n`,
      "utf8",
    );
    const reused = runMaintainerCommand(
      [
        "github-fork-verify",
        "--state",
        prepared.statePath,
      ],
      { githubRunner: fake.runner },
    );
    assert.equal(reused.operation, "reuse");
    assert.equal(reused.verified, true);
    assert.equal(fake.postCount, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI Fork preflight stays retryable but uncertain POST never replays", () => {
  const existingFixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliForkAction(existingFixture);
    const existing = cliForkGithubRunner(prepared.state, {
      forkExists: true,
    });
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
          ],
          { githubRunner: existing.runner },
        ),
      /重新預覽為 reuse/u,
    );
    assert.deepEqual(
      readRun(prepared.stateRoot, "run-001")
        .github_action_attempts,
      [],
    );
  } finally {
    rmSync(existingFixture.root, { recursive: true, force: true });
  }

  const reservedPreflightFixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliForkAction(reservedPreflightFixture);
    const failed = cliForkGithubRunner(prepared.state, {
      forkReadFailureOn: 2,
    });
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
      ],
      { githubRunner: failed.runner },
    );
    assert.equal(failed.forkReadCount, 2);
    assert.equal(failed.postCount, 0);
    assert.equal(result.status, "not_applied");
    assert.equal(
      readRun(prepared.stateRoot, "run-001")
        .github_action_reconciliations.at(-1).status,
      "not_applied",
    );

    const refreshedApproval = runMaintainerCommand([
      "github-approve",
      "--preview",
      prepared.previewPath,
      "--confirmed-at",
      new Date(Date.now() - 30_000).toISOString(),
      "--expires-at",
      new Date(Date.now() + 10 * 60_000).toISOString(),
    ]);
    const retryUpdatesPath = resolve(
      reservedPreflightFixture.root,
      "fork-retry-updates.json",
    );
    writeFileSync(
      retryUpdatesPath,
      `${JSON.stringify({
        validation_summary:
          reservedPreflightFixture.validationSummary,
        action_preview: prepared.preview,
        approvals: [refreshedApproval],
      })}\n`,
      "utf8",
    );
    runMaintainerCommand([
      "transition",
      "--state-root",
      prepared.stateRoot,
      "--run-id",
      "run-001",
      "--phase",
      "fork_creation",
      "--updates",
      retryUpdatesPath,
    ]);
    assert.equal(
      readRun(
        prepared.stateRoot,
        "run-001",
      ).consumed_approval_fingerprints.at(-1),
      refreshedApproval.fingerprint,
    );
  } finally {
    rmSync(reservedPreflightFixture.root, {
      recursive: true,
      force: true,
    });
  }

  const uncertainFixture = createCliBranchPushFixture({
    relationship: "contribute",
  });
  try {
    const prepared = prepareCliForkAction(uncertainFixture);
    const uncertain = cliForkGithubRunner(prepared.state, {
      postError: true,
    });
    const apply = () =>
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
        ],
        { githubRunner: uncertain.runner },
      );
    const uncertainResult = apply();
    assert.equal(uncertainResult.status, "pending");
    assert.equal(
      readRun(prepared.stateRoot, "run-001")
        .github_action_reconciliations.at(-1).status,
      "pending",
    );
    assert.equal(uncertain.postCount, 1);
    assert.throws(apply, /不可重放/u);
    assert.equal(uncertain.postCount, 1);

    const reconciled = runMaintainerCommand(
      [
        "github-reconcile",
        "--state-root",
        prepared.stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        prepared.previewPath,
        "--approval",
        prepared.approvalPath,
      ],
      { githubRunner: uncertain.runner },
    );
    assert.equal(reconciled.status, "pending");
    assert.equal(uncertain.postCount, 1);
    assert.equal(
      readRun(prepared.stateRoot, "run-001")
        .github_action_reconciliations.at(-1).status,
      "pending",
    );
  } finally {
    rmSync(uncertainFixture.root, { recursive: true, force: true });
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
  assert.equal(report.stable_candidate_ready, true);
  assert.equal(report.release_ready, true);
  assert.equal(report.publication_verified, false);
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
    19,
  );
  assert.equal(report.agent_forward_evaluation.candidate_regressions, 0);
  assert.equal(report.platform_validation.passed, true);
  assert.equal(report.fork_forward_fixture_contract_passed, true);
  assert.equal(report.fork_forward_evaluation.passed, true);
  assert.equal(
    report.local_update_forward_fixture_contract_passed,
    true,
  );
  assert.equal(
    report.local_update_forward_evaluation.passed,
    true,
  );
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
  assert.equal(
    report.release_blockers.includes("fork_forward_evaluation_pending"),
    false,
  );
  assert.equal(
    report.release_blockers.includes(
      "local_update_forward_evaluation_pending",
    ),
    false,
  );
  assert.equal(report.provider_validation.passed, true);
  assert.deepEqual(report.release_blockers, []);

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
    read("evals/evidence/preview-v1.0.0.json"),
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
  assert.ok(
    fixture.required_behaviors.includes("target-intent-preserved"),
  );
  assert.ok(
    fixture.required_behaviors.includes("structure-finding-evidence-bound"),
  );
  assert.equal(fixture.positive_expectations.target_decision_read, true);
  assert.equal(
    fixture.positive_expectations.automatic_release_not_proposed,
    true,
  );
  assert.equal(
    fixture.positive_expectations.untestable_completion_identified,
    true,
  );
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

test("held-out fixture locks final evaluation binding A/B before outputs", () => {
  const fixture = JSON.parse(
    read("evals/cases/evaluation-binding-heldout.json"),
  );
  assert.equal(validateHeldoutForwardFixture(fixture), true);
  assert.equal(
    fixture.id,
    "agent-skill-maintainer-eval-binding-heldout-v37",
  );
  assert.equal(fixture.required_behaviors.length, 19);
  assert.equal(fixture.tool_profile.filesystem_writes, false);
  assert.equal(
    validateHeldoutForwardFixture({
      ...fixture,
      locked_at: "not-a-time",
    }),
    false,
  );
  const contentDrift = structuredClone(fixture);
  contentDrift.target_files.candidate_sha256["SKILL.md"] =
    "f".repeat(64);
  assert.equal(validateHeldoutForwardFixture(contentDrift), false);
  const traversal = structuredClone(fixture);
  traversal.target_files.paths[0] = "../SKILL.md";
  for (const hashes of [
    traversal.target_files.baseline_sha256,
    traversal.target_files.candidate_sha256,
  ]) {
    hashes["../SKILL.md"] = hashes["SKILL.md"];
    delete hashes["SKILL.md"];
  }
  assert.equal(validateHeldoutForwardFixture(traversal), false);
});

test("Fork forward fixture and aggregate stay bound to the candidate Skill", () => {
  const fixture = JSON.parse(
    read("evals/cases/fork-creation-forward.json"),
  );
  assert.equal(validateForkForwardFixture(fixture), true);
  assert.equal(
    validateForkForwardFixture({
      ...fixture,
      remote_actions_executed: true,
    }),
    false,
  );

  const aggregate = JSON.parse(
    read("evals/evidence/fork-creation-preview.json"),
  );
  const currentSkillFingerprint =
    aggregate.candidate_skill_fingerprint;
  assert.equal(
    validateForkForwardAggregate(aggregate, {
      currentSkillFingerprint,
    }).passed,
    true,
  );
  assert.equal(
    validateForkForwardAggregate(aggregate, {
      currentSkillFingerprint: "f".repeat(64),
    }).passed,
    false,
  );
});

test("local update forward fixture and aggregate stay bound to exact release behavior", () => {
  const fixture = JSON.parse(
    read("evals/cases/local-update-forward.json"),
  );
  assert.equal(validateLocalUpdateForwardFixture(fixture), true);
  assert.equal(
    validateLocalUpdateForwardFixture({
      ...fixture,
      local_installations_modified: true,
    }),
    false,
  );

  const aggregate = JSON.parse(
    read("evals/evidence/local-update-preview.json"),
  );
  const currentSkillFingerprint =
    aggregate.candidate_skill_fingerprint;
  assert.equal(
    validateLocalUpdateForwardAggregate(aggregate, {
      currentSkillFingerprint,
    }).passed,
    true,
  );
  assert.equal(
    validateLocalUpdateForwardAggregate(aggregate, {
      currentSkillFingerprint: "f".repeat(64),
    }).passed,
    false,
  );
  assert.equal(
    validateLocalUpdateForwardAggregate({
      ...aggregate,
      controlled_installation: {
        ...aggregate.controlled_installation,
        official_update_check_current: false,
      },
    }, {
      currentSkillFingerprint,
    }).passed,
    false,
  );
});

test("neutral platform profile binds current k3 routing and constrains Codex output", () => {
  const controller = read("scripts/neutral-evaluation-controller.mjs");
  const skill = read("skills/agent-skill-maintainer/SKILL.md");
  const evaluation = read(
    "skills/agent-skill-maintainer/references/evaluation.md",
  );
  const security = read(
    "skills/agent-skill-maintainer/references/security-and-privacy.md",
  );
  assert.match(controller, /"ANTHROPIC_AUTH_TOKEN"/u);
  assert.match(controller, /"ANTHROPIC_BASE_URL"/u);
  assert.match(controller, /model: "k3"/u);
  assert.match(controller, /routing_policy: "current-environment-bound"/u);
  assert.match(controller, /portability_policy: "default-only-nonblocking"/u);
  assert.match(controller, /"--output-schema"/u);
  assert.match(
    controller,
    /output mismatch: \$\{mismatches\.join\(", "\)\}/u,
  );
  for (const document of [skill, evaluation, security]) {
    assert.match(document, /Codex.+default-only/isu);
    assert.match(document, /Claude Code.+current-environment-bound/isu);
    assert.match(document, /canonical model `k3`/u);
    assert.match(document, /default-route portability/u);
  }
  assert.doesNotMatch(
    skill,
    /a default-only minimal environment policy/u,
  );
  assert.doesNotMatch(
    skill,
    /rejects caller prompts and provider route\/model\/proxy overrides/u,
  );
  assert.doesNotMatch(
    evaluation,
    /owns the prompt, default-only minimal environment/u,
  );
  assert.doesNotMatch(
    evaluation,
    /Caller prompt text and provider route\/model\/proxy overrides are rejected/u,
  );
  assert.doesNotMatch(
    security,
    /values are salted before the challenge commits them; endpoint, proxy, provider, and model selectors remain forbidden/u,
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

test("publication controller verification reads the live source bytes", () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), "maintainer-controller-source-"),
  );
  const controllerDirectory = resolve(temporaryRoot, "scripts");
  const fixtureDirectory = resolve(
    temporaryRoot,
    "evals",
    "cases",
  );
  mkdirSync(controllerDirectory, { recursive: true });
  mkdirSync(fixtureDirectory, { recursive: true });
  const controllerPath = resolve(
    controllerDirectory,
    "neutral-evaluation-controller.mjs",
  );
  const fixturePath = resolve(
    fixtureDirectory,
    "evaluation-binding-heldout.json",
  );
  writeFileSync(controllerPath, "stable controller\n", "utf8");
  writeFileSync(
    fixturePath,
    `${JSON.stringify({
      evaluator_authority: {
        controller_sha256: createHash("sha256")
          .update(readFileSync(controllerPath))
          .digest("hex"),
      },
    })}\n`,
    "utf8",
  );
  try {
    assert.deepEqual(
      validateNeutralControllerSource(temporaryRoot),
      [],
    );
    writeFileSync(
      controllerPath,
      "drifted controller\n",
      "utf8",
    );
    assert.deepEqual(
      validateNeutralControllerSource(temporaryRoot),
      [
        "neutral evaluator controller does not match the locked fixture",
      ],
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("publication disclosure scan includes tracked node_modules only", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "maintainer-disclosure-"));
  const dependencyRoot = join(
    temporaryRoot,
    "node_modules",
    "forced",
  );
  mkdirSync(dependencyRoot, { recursive: true });
  writeFileSync(
    join(dependencyRoot, "tracked.txt"),
    `${["/Users", "private-user/secret"].join("/")}\n`,
    "utf8",
  );
  writeFileSync(
    join(dependencyRoot, "untracked.txt"),
    "ignored dependency cache\n",
    "utf8",
  );
  try {
    const files = publicTextFiles(temporaryRoot, [
      "node_modules/forced/tracked.txt",
    ]);
    assert.deepEqual(
      files.map(({ relativePath }) => relativePath),
      ["node_modules/forced/tracked.txt"],
    );
    assert.match(files[0].content, /\/Users\/private-user\//u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("publication disclosure scan rejects private paths under tests", () => {
  const probe = resolve(ROOT, "tests", "private-path-probe.md");
  writeFileSync(
    probe,
    `${["/Users", "real-user/private"].join("/")}\n`,
    "utf8",
  );
  try {
    const errors = validatePublication();
    assert.ok(
      errors.some((error) =>
        error.includes("tests/private-path-probe.md")),
      errors.join("\n"),
    );
  } finally {
    rmSync(probe, { force: true });
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
