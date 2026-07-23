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
} from "../scripts/validate-publication.mjs";

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
  assert.ok(report.release_blockers.includes("agent_forward_evaluation_pending"));

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
