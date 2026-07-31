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
  compareUtf8,
  fingerprint,
  loadSchema,
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
  buildForwardEvaluationBinding,
  deriveBlindedForwardAggregate,
  validateForwardEvaluationBinding,
  validateLegacyTerminalValidation,
  validatePrReadyValidation,
} from "../skills/agent-skill-maintainer/scripts/lib/evaluation.mjs";
import {
  fingerprintTree,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  candidateFixture,
  evidenceFixture,
  forwardEvaluationBindingFixture,
  feedbackFixture,
  optimizationFixture,
} from "./fixtures.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = resolve(ROOT, "skills", "agent-skill-maintainer");

/** Builds one minimal valid value from the supported schema subset. */
function schemaExample(rule, rootSchema) {
  if (typeof rule.$ref === "string") {
    const target = rule.$ref
      .slice(2)
      .split("/")
      .reduce(
        (current, segment) =>
          current[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
        rootSchema,
      );
    return schemaExample(target, rootSchema);
  }
  if (Object.hasOwn(rule, "const")) {
    return rule.const;
  }
  if (Array.isArray(rule.enum)) {
    return rule.enum[0];
  }
  if (rule.type === "object") {
    return Object.fromEntries(
      (rule.required ?? []).map((name) => [
        name,
        schemaExample(rule.properties[name], rootSchema),
      ]),
    );
  }
  if (rule.type === "array") {
    return Array.from(
      { length: rule.minItems ?? 0 },
      () => schemaExample(rule.items, rootSchema),
    );
  }
  if (rule.type === "string") {
    if (rule.format === "date-time") {
      return "2030-01-01T00:00:00.000Z";
    }
    if (rule.pattern === "[a-f0-9]{64}") {
      return "a".repeat(64);
    }
    return "x".repeat(Math.max(rule.minLength ?? 0, 1));
  }
  if (rule.type === "integer" || rule.type === "number") {
    return rule.minimum ?? 0;
  }
  if (rule.type === "boolean") {
    return false;
  }
  if (rule.type === "null") {
    return null;
  }
  throw new Error(`unsupported test schema rule: ${JSON.stringify(rule)}`);
}

test("all public schemas parse and lock an explicit version", () => {
  assert.equal(SCHEMA_NAMES.length, 40);
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

test("tree ordering uses deterministic UTF-8 bytes", () => {
  const names = ["é.txt", "z.txt", "e\u0301.txt"];
  assert.deepEqual(
    [...names].sort(compareUtf8),
    [...names].sort((first, second) =>
      Buffer.compare(Buffer.from(first), Buffer.from(second))),
  );
  assert.notEqual(compareUtf8("é.txt", "e\u0301.txt"), 0);
});

test("runtime schema validation rejects incomplete documents", () => {
  assert.throws(() => validateDocument("run-state", { schema_version: 8 }));
  assert.equal(
    validateDocument("run-state", {
      schema_version: 8,
      run_id: "run-001",
      binding_id: "binding-001",
      phase: "target_selection",
      status: "active",
      approvals: [],
      consumed_approval_fingerprints: [],
      attempted_github_action_fingerprints: [],
      github_action_attempts: [],
      github_action_reconciliations: [],
      attempted_local_update_fingerprints: [],
      local_update_attempts: [],
      local_update_reconciliations: [],
    }),
    true,
  );
});

test("platform schemas enforce local refs, date-time, and matching attestation definitions", () => {
  const sourceSchema = loadSchema("platform-validation");
  const evidenceSchema = loadSchema(
    "platform-validation-evidence",
  );
  assert.deepEqual(sourceSchema.$defs, evidenceSchema.$defs);

  const document = schemaExample(sourceSchema, sourceSchema);
  assert.equal(
    validateDocument("platform-validation", document),
    true,
  );
  const nullAttestation = structuredClone(document);
  nullAttestation.challenge_attestation = null;
  assert.throws(
    () => validateDocument("platform-validation", nullAttestation),
    /必須是 object/u,
  );
  const invalidAttestedAt = structuredClone(document);
  invalidAttestedAt.completion_attestation.attested_at =
    "definitely-not-a-date";
  assert.throws(
    () => validateDocument("platform-validation", invalidAttestedAt),
    /RFC 3339 date-time/u,
  );
  for (const invalidDateTime of [
    "2026-02-30T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:00+24:00",
    "2026-01-01T00:00:60Z",
  ]) {
    const invalidCalendar = structuredClone(document);
    invalidCalendar.completion_attestation.attested_at =
      invalidDateTime;
    assert.throws(
      () =>
        validateDocument(
          "platform-validation",
          invalidCalendar,
        ),
      /RFC 3339 date-time/u,
      invalidDateTime,
    );
  }
  for (const validDateTime of [
    "2024-02-29T23:59:59.123456789Z",
    "1990-12-31T23:59:60Z",
    "1990-12-31T15:59:60-08:00",
  ]) {
    const validCalendar = structuredClone(document);
    validCalendar.completion_attestation.attested_at = validDateTime;
    assert.equal(
      validateDocument("platform-validation", validCalendar),
      true,
      validDateTime,
    );
  }

  const portabilityFailure = {
    platform: "claude-code",
    profile: "default-only",
    status: "unavailable",
    reason_code: "authentication_unavailable",
    blocking_current_environment_gate: false,
  };
  const disclosed = structuredClone(document);
  disclosed.environment_baseline_failures = [
    portabilityFailure,
  ];
  assert.equal(
    validateDocument("platform-validation", disclosed),
    true,
  );
  disclosed.environment_baseline_failures.push(
    portabilityFailure,
  );
  assert.throws(
    () => validateDocument("platform-validation", disclosed),
    /最多允許 1 項/u,
  );
  const blocking = structuredClone(document);
  blocking.environment_baseline_failures = [{
    ...portabilityFailure,
    blocking_current_environment_gate: true,
  }];
  assert.throws(
    () => validateDocument("platform-validation", blocking),
    /必須等於 false/u,
  );
  const expanded = structuredClone(document);
  expanded.environment_baseline_failures = [{
    ...portabilityFailure,
    detail: "unbounded provider response",
  }];
  assert.throws(
    () => validateDocument("platform-validation", expanded),
    /含未知欄位：detail/u,
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
          source_ref: [
            "/Users",
            "example/private/transcript.md",
          ].join("/"),
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

test("Provider profiles publish version-scoped evidence without overclaiming", () => {
  const profiles = loadProviderProfiles(
    resolve(SKILL_ROOT, "assets", "providers"),
  );
  assert.deepEqual(Object.keys(profiles).sort(), [...PROVIDER_IDS].sort());
  for (const [id, profile] of Object.entries(profiles)) {
    const missing = resolveProviderSupport(profile, { detectedVersion: null });
    assert.ok(["compatible-read-only", "unavailable"].includes(missing.status));
    assert.equal(missing.commands_allowed, false);
    if (["formal", "legacy"].includes(profile.role_type)) {
      assert.equal(profile.tested_versions.length, 1, id);
      assert.equal(profile.verification_evidence.length, 1, id);
      assert.equal(
        profile.verification_evidence[0].version,
        profile.tested_versions[0],
        id,
      );
      assert.ok(
        ["artifact-contract-read-only", "commands"].includes(
          profile.verification_evidence[0].scope,
        ),
        id,
      );
      assert.ok(profile.verification_evidence[0].artifacts.length > 0, id);
      assert.ok(Number.isFinite(Date.parse(profile.last_verified_at)), id);
      const verified = resolveProviderSupport(profile, {
        detectedVersion: profile.tested_versions[0],
      });
      if (profile.role_type === "legacy") {
        assert.equal(verified.status, "compatible-read-only", id);
        assert.equal(verified.commands_allowed, false, id);
      } else {
        assert.equal(verified.status, "verified", id);
        assert.equal(
          verified.commands_allowed,
          profile.verification_evidence[0].scope === "commands",
          id,
        );
      }
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

test("PR-ready validation requires a matching schema v5 aggregate binding", (t) => {
  const sourceCandidate = candidateFixture({
    skill_path: "skills/agent-skill-maintainer",
    skill_name: "agent-skill-maintainer",
    candidate_skill_fingerprint: fingerprintTree(SKILL_ROOT),
  });
  const prepared = forwardEvaluationBindingFixture(
    sourceCandidate,
    ROOT,
    { includePrivateSources: true },
  );
  t.after(prepared.cleanup);
  const candidate = prepared.sources.candidateSnapshot;
  const candidatePath = prepared.sources.candidatePath;
  const binding = prepared.binding;
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
      id: "forward",
      category: "forward",
      status: "passed",
      summary: "前向評估通過。",
      details: binding,
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
      summary: "Agent 指引已更新。",
      details: {
        schema_version: 1,
        status: "updated",
        changed_guides: ["SKILL.md"],
        root_index_action: "verified-current",
        contract_preserved: true,
        reason: "前向評估合同已更新。",
      },
    },
  ];
  const summary = buildValidationResult(candidate, {
    checks,
    requiredCheckIds: new Set(checks.map((check) => check.id)),
  });
  assert.deepEqual(
    validatePrReadyValidation(summary, candidate, candidatePath),
    summary,
  );

  const unbound = buildValidationResult(candidate, {
    checks: checks.map((check) =>
      check.id === "forward"
        ? { ...check, details: undefined }
        : check,
    ),
    requiredCheckIds: new Set(checks.map((check) => check.id)),
  });
  assert.throws(
    () =>
      validatePrReadyValidation(
        unbound,
        candidate,
        candidatePath,
      ),
    /文件必須是 JSON object/u,
  );
});

test("forward binding rejects legacy, drifted, failed, and edited aggregates", (t) => {
  const sourceCandidate = candidateFixture({
    skill_path: "skills/agent-skill-maintainer",
    skill_name: "agent-skill-maintainer",
    candidate_skill_fingerprint: fingerprintTree(SKILL_ROOT),
  });
  const prepared = forwardEvaluationBindingFixture(
    sourceCandidate,
    ROOT,
    { includePrivateSources: true },
  );
  t.after(prepared.cleanup);
  const candidate = prepared.sources.candidateSnapshot;
  const candidatePath = prepared.sources.candidatePath;
  const binding = prepared.binding;
  const sources = {
    fixture: binding.fixture,
    candidatePath,
  };
  assert.throws(
    () =>
      buildForwardEvaluationBinding(candidate, sources),
    /output|private|measurement/u,
  );

  const legacyBinding = structuredClone(binding);
  legacyBinding.schema_version = 1;
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        legacyBinding,
        candidate,
        candidatePath,
      ),
    /schema_version/u,
  );

  const publicOnly = structuredClone(binding);
  delete publicOnly.private_sources;
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        publicOnly,
        candidate,
        candidatePath,
      ),
    /private_sources/u,
  );

  const forgedAuthority = structuredClone(binding);
  forgedAuthority.evaluator_attestation.signature_base64 =
    Buffer.alloc(64).toString("base64");
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        forgedAuthority,
        candidate,
        candidatePath,
      ),
    /neutral evaluator attestation signature/u,
  );

  for (const field of [
    "assignment_sha256",
    "sessions_sha256",
    "measured_at_sha256",
    "unblinded_at_sha256",
  ]) {
    const forgedPrivateSource = structuredClone(binding);
    forgedPrivateSource.source_manifest[field] =
      field === "assignment_sha256"
        ? "0".repeat(64)
        : "1".repeat(64);
    assert.throws(
      () =>
        validateForwardEvaluationBinding(
          forgedPrivateSource,
          candidate,
          candidatePath,
        ),
      /private source manifest/u,
    );
  }

  const driftedCandidate = candidateFixture({
    candidate_skill_fingerprint: "d".repeat(64),
  });
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        binding,
        driftedCandidate,
        candidatePath,
      ),
    /candidate snapshot fingerprint/u,
  );

  const edited = structuredClone(binding);
  edited.aggregate.cost.candidate_tool_calls += 1;
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        edited,
        candidate,
        candidatePath,
      ),
    /private sources 精確重建|aggregate fingerprint/u,
  );

  const forgedQuality = structuredClone(binding);
  forgedQuality.aggregate.forward_evaluation
    .false_positive_optimizations = 1;
  forgedQuality.aggregate_fingerprint =
    fingerprint(forgedQuality.aggregate);
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        forgedQuality,
        candidate,
        candidatePath,
      ),
    /private sources 精確重建/u,
  );

  const forgedCost = structuredClone(binding);
  forgedCost.aggregate.cost.artifact_byte_ratio = 0;
  forgedCost.aggregate_fingerprint = fingerprint(forgedCost.aggregate);
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        forgedCost,
        candidate,
        candidatePath,
      ),
    /private sources 精確重建/u,
  );

  const forgedProtocol = structuredClone(binding);
  forgedProtocol.aggregate.protocol.judge_model_id = "other-model";
  forgedProtocol.aggregate_fingerprint =
    fingerprint(forgedProtocol.aggregate);
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        forgedProtocol,
        candidate,
        candidatePath,
      ),
    /private sources 精確重建/u,
  );

  const contentDrift = structuredClone(binding);
  contentDrift.fixture.target_files.candidate_sha256["SKILL.md"] =
    "f".repeat(64);
  assert.throws(
    () =>
      deriveBlindedForwardAggregate({
        adjudication: contentDrift.adjudication,
        measurement: contentDrift.measurement,
        fixture: contentDrift.fixture,
        currentSkillFingerprint:
          candidate.candidate_skill_fingerprint,
      }),
    /locked fixture/u,
  );

  const forgedFixture = structuredClone(binding);
  forgedFixture.fixture.aggregate_template.platform_requirements
    .platforms = ["codex"];
  forgedFixture.fixture.aggregate_template.limits = ["forged-limit"];
  assert.throws(
    () =>
      deriveBlindedForwardAggregate({
        adjudication: forgedFixture.adjudication,
        measurement: forgedFixture.measurement,
        fixture: forgedFixture.fixture,
        currentSkillFingerprint:
          candidate.candidate_skill_fingerprint,
      }),
    /locked fixture/u,
  );

  for (const mutate of [
    (item) => {
      item.aggregate.evaluated_at = "2026-07-29T12:00:00.000Z";
    },
    (item) => {
      item.aggregate.platform_validation.platforms[0].version =
        "forged-version";
    },
    (item) => {
      item.aggregate.limits = ["forged-limit"];
    },
  ]) {
    const forgedSourceField = structuredClone(binding);
    mutate(forgedSourceField);
    forgedSourceField.aggregate_fingerprint =
      fingerprint(forgedSourceField.aggregate);
    assert.throws(
      () =>
        validateForwardEvaluationBinding(
          forgedSourceField,
          candidate,
          candidatePath,
        ),
      /private sources 精確重建|private source manifest/u,
    );
  }

  const failed = structuredClone(binding);
  failed.aggregate.forward_evaluation.passed = false;
  failed.aggregate_fingerprint = fingerprint(failed.aggregate);
  assert.throws(
    () =>
      validateForwardEvaluationBinding(
        failed,
        candidate,
        candidatePath,
      ),
    /private sources 精確重建/u,
  );
});

test("legacy candidate validation is read-only compatible but not PR-ready", () => {
  const legacyCandidate = candidateFixture();
  delete legacyCandidate.skill_path;
  delete legacyCandidate.skill_name;
  delete legacyCandidate.candidate_skill_fingerprint;
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
      id: "forward",
      category: "forward",
      status: "passed",
      summary: "舊版前向檢查通過。",
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
      summary: "舊版 Agent 指引檢查通過。",
      details: {
        schema_version: 1,
        status: "not-required",
        changed_guides: [],
        root_index_action: "not-applicable",
        contract_preserved: true,
        reason: "保留舊版終態記錄的唯讀解析。",
      },
    },
  ];
  const summary = buildValidationResult(legacyCandidate, {
    checks,
    requiredCheckIds: new Set(checks.map((check) => check.id)),
  });
  assert.throws(
    () =>
      validatePrReadyValidation(
        summary,
        legacyCandidate,
        SKILL_ROOT,
      ),
    /缺少 Skill 或 fixture fingerprint/u,
  );
  assert.deepEqual(
    validateLegacyTerminalValidation(summary, legacyCandidate),
    summary,
  );
});
