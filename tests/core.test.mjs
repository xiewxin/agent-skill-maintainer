import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApprovalDriftError,
  PROVIDER_IDS,
  SCHEMA_NAMES,
  buildApproval,
  buildValidationResult,
  buildZeroImprovementOutcome,
  classifyRelationship,
  classifyUntrustedCommand,
  loadProviderProfiles,
  publicationGate,
  redactText,
  resolveCandidatePath,
  resolveProviderSupport,
  selectAcceptedOptimizations,
  selectProviders,
  selectTargets,
  validateDocument,
  validateDocumentationImpact,
  validateEvidenceRecords,
  validateFeedbackRecords,
  validateGithubRemote,
  validateOptimizationOutcome,
  validateOptimizationRecords,
  validateRepositorySettings,
  verifyApproval,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  candidateFixture,
  evidenceFixture,
  feedbackFixture,
  optimizationFixture,
} from "./fixtures.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = resolve(ROOT, "skills", "agent-skill-maintainer");

test("all public schemas parse and lock an explicit version", () => {
  assert.equal(SCHEMA_NAMES.length, 21);
  for (const schema of SCHEMA_NAMES) {
    const document = JSON.parse(
      readFileSync(
        resolve(SKILL_ROOT, "assets", "schemas", `${schema}.schema.json`),
        "utf8",
      ),
    );
    assert.equal(
      document.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.ok(Number.isInteger(document.properties.schema_version.const));
    assert.ok(document.required.includes("schema_version"));
  }
});

test("runtime schema validation rejects incomplete documents", () => {
  assert.throws(() => validateDocument("run-state", { schema_version: 5 }));
  assert.equal(
    validateDocument("run-state", {
      schema_version: 5,
      run_id: "run-001",
      binding_id: "binding-001",
      phase: "target_selection",
      status: "active",
      approvals: [],
      consumed_approval_fingerprints: [],
      attempted_github_action_fingerprints: [],
      github_action_attempts: [],
      github_action_reconciliations: [],
    }),
    true,
  );
});

test("target selection never scans unrelated installed Skills", () => {
  assert.deepEqual(
    selectTargets({
      explicitTargets: [],
      evidenceCandidates: ["skill-a", "skill-b"],
      installedSkills: ["private-skill"],
    }),
    {
      targets: [],
      candidates: ["skill-a", "skill-b"],
      requires_confirmation: true,
    },
  );
  assert.deepEqual(
    selectTargets({
      explicitTargets: ["skill-a"],
      evidenceCandidates: [],
      installedSkills: ["private-skill"],
    }),
    {
      targets: ["skill-a"],
      candidates: [],
      requires_confirmation: false,
    },
  );
});

test("redaction removes secrets, email, and private paths", () => {
  const value =
    "token=example-secret owner@example.com /private/example/repo C:\\private\\repo";
  const redacted = redactText(value);
  assert.doesNotMatch(redacted, /example-secret|owner@example\.com|private\/repo/u);
});

test("evidence feedback and optimization remain uniquely traceable", () => {
  const evidence = validateEvidenceRecords([evidenceFixture()]);
  const feedback = validateFeedbackRecords([feedbackFixture()], evidence);
  const optimizations = validateOptimizationRecords(
    [optimizationFixture()],
    feedback,
  );
  assert.deepEqual(evidence.map((item) => item.id), ["EV-001"]);
  assert.deepEqual(feedback.map((item) => item.id), ["FB-001"]);
  assert.deepEqual(optimizations.map((item) => item.id), ["OPT-001"]);
  assert.throws(
    () => validateEvidenceRecords([evidenceFixture(), evidenceFixture()]),
    /EV-\* ID 不可重複/u,
  );
  assert.throws(
    () =>
      validateFeedbackRecords(
        [feedbackFixture({ source_ids: ["EV-999"] })],
        evidence,
      ),
    /未知 evidence/u,
  );
  assert.throws(
    () =>
      validateOptimizationRecords(
        [optimizationFixture({ feedback_ids: ["FB-999"] })],
        feedback,
      ),
    /未知 feedback/u,
  );
});

test("raw, unredacted, and incomplete evidence is rejected", () => {
  assert.throws(() =>
    validateEvidenceRecords([
      { ...evidenceFixture(), raw_transcript: "private" },
    ]),
  );
  assert.throws(
    () =>
      validateEvidenceRecords([
        evidenceFixture({
          source_ref: "/Users/example/private/transcript.md",
        }),
      ]),
    /尚未脫敏/u,
  );
  assert.throws(
    () =>
      validateFeedbackRecords(
        [feedbackFixture({ source_ids: [] })],
        [evidenceFixture()],
      ),
    /至少需要一個 evidence/u,
  );
});

test("zero-improvement outcome is exclusive and evidence-backed", () => {
  const evidence = [evidenceFixture()];
  const feedback = [
    feedbackFixture({
      classification: "no-problem",
      phenomenon: "未觀察到違反 Skill 意圖的行為。",
      expected_behavior: "維持既有行為。",
      provisional_owner: "none",
    }),
  ];
  const outcome = buildZeroImprovementOutcome(evidence, feedback, {
    rationale: "已檢查決策與安全邊界，未發現可證實改善。",
  });
  assert.equal(outcome.conclusion, "no-proven-improvement");
  assert.deepEqual(
    validateOptimizationOutcome({
      optimizations: [],
      zeroImprovement: outcome,
      evidence,
      feedback,
    }),
    outcome,
  );
  assert.throws(
    () =>
      validateOptimizationOutcome({
        optimizations: [optimizationFixture()],
        zeroImprovement: outcome,
        evidence,
        feedback,
      }),
    /不可同時/u,
  );
  assert.throws(
    () =>
      buildZeroImprovementOutcome([], [], {
        rationale: "未發現改善。",
      }),
    /至少需要一筆 evidence/u,
  );
});

test("redacted real usage fixture produces two accepted optimizations", () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "ai-development-workflow-plan.json",
      ),
      "utf8",
    ),
  );
  const evidence = validateEvidenceRecords(fixture.evidence);
  const feedback = validateFeedbackRecords(fixture.feedback, evidence);
  const optimizations = validateOptimizationRecords(
    fixture.optimizations,
    feedback,
  );
  const outcome = validateOptimizationOutcome({
    optimizations,
    zeroImprovement: null,
    evidence,
    feedback,
  });
  assert.deepEqual(outcome.optimization_ids, ["OPT-001", "OPT-002"]);
  assert.doesNotMatch(JSON.stringify(fixture), /\/Users\/|raw_transcript/u);
});

test("only accepted complete optimizations enter approval", () => {
  const records = [
    optimizationFixture(),
    optimizationFixture({
      id: "OPT-002",
      decision_status: "rejected",
      decision_reason: "超出能力初衷",
    }),
  ];
  const accepted = selectAcceptedOptimizations(records);
  assert.deepEqual(accepted.map((item) => item.id), ["OPT-001"]);
  const approval = buildApproval(accepted, {
    runId: "run-001",
    bindingId: "binding-001",
    relationship: "managed",
    repository: "example/skill",
    headCommit: "abc123",
    diffHash: "diff123",
    processArtifactPrefixes: [],
  });
  assert.deepEqual(approval.approved_opt_ids, ["OPT-001"]);
  assert.equal(validateDocument("approval", approval), true);
  assert.throws(() =>
    buildApproval(
      [
        {
          id: "OPT-001",
          decision_status: "accepted",
          decision_reason: "incomplete",
        },
      ],
      {
        runId: "run-001",
        bindingId: "binding-001",
        relationship: "managed",
        repository: "example/skill",
        headCommit: "abc123",
        diffHash: "diff123",
        processArtifactPrefixes: [],
      },
    ),
  );
});

test("approval drift invalidates implementation permission", () => {
  const accepted = [optimizationFixture()];
  const approval = buildApproval(accepted, {
    runId: "run-001",
    bindingId: "binding-001",
    relationship: "managed",
    repository: "example/skill",
    headCommit: "abc123",
    diffHash: "diff123",
    processArtifactPrefixes: [],
  });
  accepted[0].minimum_change = "內容已改變";
  assert.throws(
    () =>
      verifyApproval(approval, accepted, {
        runId: "run-001",
        bindingId: "binding-001",
        relationship: "managed",
        repository: "example/skill",
        headCommit: "abc123",
        diffHash: "diff123",
        processArtifactPrefixes: [],
      }),
    ApprovalDriftError,
  );
});

test("repository paths remotes and untrusted programs are guarded", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-core-"));
  try {
    assert.throws(() => resolveCandidatePath(root, "../outside"), /不可逃逸/u);
    assert.equal(
      validateGithubRemote("https://github.com/example/skill.git"),
      "https://github.com/example/skill.git",
    );
    assert.equal(
      validateGithubRemote("git@github.com:example/skill.git"),
      "git@github.com:example/skill.git",
    );
    for (const remote of [
      "file:///tmp/repo",
      "https://example.invalid/a.git",
      "git@github.com:repo",
    ]) {
      assert.throws(() => validateGithubRemote(remote));
    }
    for (const source of [
      "git-hook",
      "install-script",
      "test-script",
      "workflow",
    ]) {
      const result = classifyUntrustedCommand(["node", "verify.mjs"], {
        source,
        cwd: root,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.requires_confirmation, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository modes separate relation from gh and release flags", () => {
  const managed = classifyRelationship({
    bindingValid: true,
    remoteVerified: true,
    permission: "maintain",
    canFork: false,
    ghAvailable: false,
    releaseEnabled: true,
  });
  assert.equal(managed.relationship, "managed");
  assert.equal(managed.capabilities.implementation, true);
  assert.equal(managed.capabilities.pr, false);

  const contribute = classifyRelationship({
    bindingValid: true,
    remoteVerified: true,
    permission: "read",
    canFork: true,
    ghAvailable: true,
    releaseEnabled: true,
  });
  assert.equal(contribute.relationship, "contribute");
  assert.equal(contribute.capabilities.pr, true);
  assert.equal(contribute.capabilities.merge, false);
  assert.equal(contribute.capabilities.release, false);

  const analyzeOnly = classifyRelationship({
    bindingValid: false,
    remoteVerified: false,
    permission: null,
    canFork: true,
    ghAvailable: true,
    releaseEnabled: true,
  });
  assert.equal(analyzeOnly.relationship, "analyze-only");
  assert.equal(analyzeOnly.capabilities.implementation, false);
});

test("repository mode inputs reject string booleans and unknown permissions", () => {
  const base = {
    bindingValid: true,
    remoteVerified: true,
    permission: "write",
    canFork: true,
    ghAvailable: true,
    releaseEnabled: true,
  };
  for (const [name, value] of [
    ["bindingValid", "true"],
    ["remoteVerified", 1],
    ["canFork", "false"],
    ["ghAvailable", null],
    ["releaseEnabled", "false"],
    ["permission", "owner"],
  ]) {
    assert.throws(() => classifyRelationship({ ...base, [name]: value }));
  }
});

test("repository settings enumerate missing safety controls", () => {
  const result = validateRepositorySettings({
    default_branch: "main",
    ruleset_required: false,
    required_checks: true,
    force_push_blocked: true,
    branch_deletion_blocked: true,
    actions_read_only: true,
    fork_secrets_blocked: true,
    release_immutability: false,
    private_vulnerability_reporting: true,
  });
  assert.deepEqual(result, {
    compliant: false,
    missing: ["ruleset_required", "release_immutability"],
  });
});

test("documentation impact is structured, scoped, and contract-preserving", () => {
  const notRequired = validateDocumentationImpact({
    schema_version: 1,
    status: "not-required",
    changed_guides: [],
    root_index_action: "not-applicable",
    contract_preserved: true,
    reason: "本次只調整回歸測試，沒有改變長期維護規則。",
  });
  assert.equal(notRequired.status, "not-required");
  assert.throws(
    () =>
      validateDocumentationImpact({
        ...notRequired,
        status: "updated",
      }),
    /changed_guides/u,
  );
  assert.throws(
    () =>
      validateDocumentationImpact({
        ...notRequired,
        contract_preserved: false,
      }),
    /既有合同/u,
  );
});

test("Provider profiles publish version-scoped read-only evidence", () => {
  const profiles = loadProviderProfiles(
    resolve(SKILL_ROOT, "assets", "providers"),
  );
  assert.deepEqual(Object.keys(profiles).sort(), [...PROVIDER_IDS].sort());
  for (const [id, profile] of Object.entries(profiles)) {
    const missing = resolveProviderSupport(profile, { detectedVersion: null });
    assert.ok(["compatible-read-only", "unavailable"].includes(missing.status));
    assert.equal(missing.commands_allowed, false);
    if (profile.role_type === "formal") {
      assert.equal(profile.tested_versions.length, 1, id);
      assert.equal(profile.verification_evidence.length, 1, id);
      assert.equal(
        profile.verification_evidence[0].version,
        profile.tested_versions[0],
        id,
      );
      assert.equal(
        profile.verification_evidence[0].scope,
        "artifact-contract-read-only",
        id,
      );
      assert.ok(profile.verification_evidence[0].artifacts.length > 0, id);
      assert.ok(Number.isFinite(Date.parse(profile.last_verified_at)), id);
      const verified = resolveProviderSupport(profile, {
        detectedVersion: profile.tested_versions[0],
      });
      assert.equal(verified.status, "verified", id);
      assert.equal(verified.commands_allowed, false, id);
    } else {
      assert.deepEqual(profile.tested_versions, [], id);
      assert.deepEqual(profile.verification_evidence, [], id);
      assert.equal(profile.last_verified_at, null, id);
    }
  }
  const unknown = resolveProviderSupport(profiles.superpowers, {
    detectedVersion: "999.0.0",
  });
  assert.equal(unknown.status, "compatible-read-only");
  assert.equal(unknown.commands_allowed, false);
  assert.equal(profiles["agents-doc-maintainer"].role_type, "auxiliary");
  assert.ok(
    profiles["agents-doc-maintainer"].capabilities.includes(
      "generated-contract-preservation",
    ),
  );
  assert.equal(
    profiles.gsd.verification_evidence[0].repository_status,
    "archived",
  );
});

test("Provider activation requires a gap and unique ownership", () => {
  const result = selectProviders([
    {
      id: "superpowers",
      role: "main",
      installed: true,
      capability_gap: null,
      owner: "requirements",
    },
  ]);
  assert.deepEqual(result.active, []);
  assert.equal(result.inactive[0].inactive_reason, "no_capability_gap");
  assert.throws(() =>
    selectProviders([
      {
      id: "spec-kit",
      role: "main",
      installed: true,
      capability_gap: "requirements",
      owner: "requirements",
      detected_version: "999.0.0",
      support_status: "compatible-read-only",
      required_access: "read-only",
      version_evidence: "fixture:verified",
      expected_benefit: "補足需求結構。",
      estimated_cost: "低",
      risk: "低",
      validation: "檢查輸出合同。",
      fallback: "回退原生流程。",
    },
    {
      id: "openspec",
        role: "auxiliary",
        installed: true,
        capability_gap: "delta",
      owner: "requirements",
      detected_version: "999.0.0",
      support_status: "compatible-read-only",
      required_access: "read-only",
      version_evidence: "fixture:verified",
      expected_benefit: "補足 delta。",
      estimated_cost: "低",
      risk: "低",
      validation: "檢查輸出合同。",
      fallback: "回退原生流程。",
    },
    ]),
  );
  const readOnly = selectProviders([
    {
      id: "agents-doc-maintainer",
      role: "auxiliary",
      installed: true,
      capability_gap: "agent-guidance-maintenance",
      owner: "agent-guidance",
      detected_version: "1.0.0",
      support_status: "compatible-read-only",
      required_access: "read-only",
      version_evidence: "偵測到 Skill metadata，但版本未驗證。",
      expected_benefit: "補足 Agent 指引增量審查。",
      estimated_cost: "低",
      risk: "未知版本只可唯讀。",
      validation: "以原生文檔合同重驗結果。",
      fallback: "使用原生 Agent 指引維護合同。",
    },
  ], { nativeGap: "agent-guidance-maintenance" });
  assert.deepEqual(
    readOnly.active.map((item) => item.id),
    ["agents-doc-maintainer"],
  );
  assert.equal(
    validateDocument("provider-selection", readOnly),
    true,
  );
  assert.throws(
    () =>
      selectProviders([
        {
          ...readOnly.active[0],
          support_status: "verified",
        },
      ]),
    /版本證據不一致/u,
  );
});

test("publication gate requires measurable gain without regression", () => {
  const baseline = {
    discovery: 0.6,
    ownership: 0.7,
    closure: 0.65,
    actionability: 0.7,
  };
  const common = {
    baseline,
    safetyPassRate: 1,
    falsePositiveRate: 0.05,
    cost: 1000,
    thresholds: { max_false_positive_rate: 0.1, max_cost: 1200 },
    supportedPlatforms: { codex: true, "claude-code": true },
  };
  assert.equal(
    publicationGate({
      ...common,
      candidate: { ...baseline, closure: 0.8 },
    }).allowed,
    true,
  );
  assert.ok(
    publicationGate({ ...common, candidate: { ...baseline } }).reasons.includes(
      "no_proven_gain",
    ),
  );
  const blocked = publicationGate({
    ...common,
    candidate: { ...baseline, closure: 0.8, ownership: 0.6 },
    supportedPlatforms: { codex: true, "claude-code": false },
  });
  assert.ok(blocked.reasons.includes("core_quality_regression"));
  assert.ok(blocked.reasons.includes("unsupported_claimed_platform"));
});

test("validation result requires complete mapping and safety pass", () => {
  const checks = [
    {
      id: "publication",
      category: "safety",
      status: "passed",
      summary: "公開資料檢查通過。",
    },
    {
      id: "regression",
      category: "regression",
      status: "passed",
      summary: "回歸案例通過。",
    },
    {
      id: "agent-documentation-impact",
      category: "documentation",
      status: "passed",
      summary: "本次未改變長期維護規則，無須更新 Agent 指引。",
      details: {
        schema_version: 1,
        status: "not-required",
        changed_guides: [],
        root_index_action: "not-applicable",
        contract_preserved: true,
        reason: "本次只調整回歸測試，沒有改變長期維護規則。",
      },
    },
  ];
  const result = buildValidationResult(candidateFixture(), {
    checks,
    requiredCheckIds: new Set(["publication", "regression"]),
  });
  assert.equal(result.passed, true);
  assert.equal(result.safety_pass_rate, 1);
  const failed = buildValidationResult(candidateFixture(), {
    checks: [{ ...checks[0], status: "failed" }, checks[1], checks[2]],
    requiredCheckIds: new Set(["publication"]),
  });
  assert.equal(failed.passed, false);
  assert.ok(failed.blockers.includes("safety_gate_failed"));
  assert.throws(
    () =>
      buildValidationResult(candidateFixture(), {
        checks,
        requiredCheckIds: new Set(["missing"]),
      }),
    /缺少必要檢查/u,
  );
  assert.throws(
    () =>
      buildValidationResult(
        candidateFixture({ diff_mapping_complete: false }),
        {
          checks,
          requiredCheckIds: new Set(["publication"]),
        },
    ),
    /Diff 映射/u,
  );
  assert.throws(
    () =>
      buildValidationResult(candidateFixture(), {
        checks: checks.filter(
          (check) => check.category !== "documentation",
        ),
        requiredCheckIds: new Set(["publication"]),
      }),
    /文檔影響檢查/u,
  );
});
