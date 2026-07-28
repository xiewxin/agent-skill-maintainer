import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMAL_PROVIDER_IDS,
  LEGACY_PROVIDER_IDS,
  PROVIDER_IDS,
  clone,
  loadProviderProfiles,
  resolveProviderSupport,
  selectProviders,
  stableReleaseGate,
  validateProviderValidationAggregate,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = resolve(ROOT, "skills", "agent-skill-maintainer");
const FINGERPRINT = "a".repeat(64);
const RELEASE_COMMITS = Object.freeze({
  superpowers: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
  "spec-kit": "2930d06f41e3ab491ef7d111cfe7676de5ddeabd",
  openspec: "e1b51d111ab446b54dee2d6159ac245f0339ae52",
  bmad: "081e64ee5aab2316b912883f7bee528ee143ce36",
  "matt-pocock-skills": "d574778f94cf620fcc8ce741584093bc650a61d3",
});
const EXPECTED_VERSIONS = Object.freeze({
  superpowers: "v6.2.0",
  "spec-kit": "v0.14.2",
  openspec: "v1.6.0",
  bmad: "v6.10.0",
  "matt-pocock-skills": "v1.1.0",
});

/** Returns command-verified profile fixtures for aggregate gate tests. */
function verifiedProfiles() {
  const profiles = clone(loadProviderProfiles());
  for (const providerId of FORMAL_PROVIDER_IDS) {
    profiles[providerId].verification_evidence[0].scope = "commands";
    profiles[providerId].supported_platforms = ["codex", "claude-code"];
  }
  return profiles;
}

/** Builds a redacted controlled aggregate for stable-gate tests. */
function providerAggregate(overrides = {}, profiles = verifiedProfiles()) {
  const cases = FORMAL_PROVIDER_IDS.map((providerId) => {
    const profile = profiles[providerId];
    return {
      provider_id: providerId,
      provider_version: profile.tested_versions[0],
      release_commit: profile.verification_evidence[0].release_commit,
      evidence_kind: "controlled-redacted-real-usage",
      capability_gap: `${providerId}-planning-gap`,
      owner: `${providerId}-workflow`,
      required_access: "commands",
      command_ids: [profile.command_policy.allowed_when_verified[0]],
      artifact_kinds: [profile.artifact_contracts[0].capability],
      artifact_fingerprint: "d".repeat(64),
      isolated_home: true,
      isolated_repository: true,
      primary_provider_installation_modified: false,
      remote_writes_executed: false,
      telemetry_disabled: true,
      fallback_validated: true,
      owner_unique: true,
      quality: {
        assessment_method: "manual-criteria-v1",
        baseline_score: 4,
        candidate_score: 5,
        max_score: 5,
        improvements: ["implementation_actionability"],
        regressions: [],
      },
      cost: {
        elapsed_seconds: 60,
        tool_calls: 5,
        artifact_bytes: 4096,
      },
      safety_passed: true,
      passed: true,
    };
  });
  return {
    schema_version: 1,
    evidence_kind: "provider-validation-aggregate",
    evaluated_at: "2026-07-27T00:00:00.000Z",
    candidate_skill_fingerprint: FINGERPRINT,
    raw_outputs_published: false,
    local_installations_modified: false,
    cases,
    platforms: [
      {
        id: "codex",
        version: "fixture",
        installation_validated: true,
        positive_trigger: true,
        negative_non_trigger: true,
        provider_selection: true,
        artifact_bridge: true,
        fallback: true,
        local_analysis_only: true,
        files_modified: false,
        passed: true,
      },
      {
        id: "claude-code",
        version: "fixture",
        installation_validated: true,
        positive_trigger: true,
        negative_non_trigger: true,
        provider_selection: true,
        artifact_bridge: true,
        fallback: true,
        local_analysis_only: true,
        files_modified: false,
        passed: true,
      },
    ],
    passed: true,
    ...overrides,
  };
}

test("Provider catalog contains five formal integrations and one legacy GSD", () => {
  const profiles = loadProviderProfiles();
  assert.deepEqual(Object.keys(profiles).sort(), [...PROVIDER_IDS].sort());
  assert.deepEqual([...FORMAL_PROVIDER_IDS].sort(), [
    "bmad",
    "matt-pocock-skills",
    "openspec",
    "spec-kit",
    "superpowers",
  ]);
  assert.deepEqual(LEGACY_PROVIDER_IDS, ["gsd"]);
  assert.equal(profiles.gsd.role_type, "legacy");
  assert.equal(
    profiles.gsd.verification_evidence[0].repository_status,
    "archived",
  );
  assert.deepEqual(profiles.gsd.command_policy.allowed_when_verified, []);
  assert.equal(
    resolveProviderSupport(profiles.gsd, {
      detectedVersion: "v1.42.3",
    }).commands_allowed,
    false,
  );
});

test("formal Provider versions and immutable release commits are exact", () => {
  const profiles = loadProviderProfiles();
  for (const providerId of FORMAL_PROVIDER_IDS) {
    const profile = profiles[providerId];
    assert.equal(profile.schema_version, 2, providerId);
    assert.equal(profile.profile_schema_version, 2, providerId);
    assert.deepEqual(
      profile.tested_versions,
      [EXPECTED_VERSIONS[providerId]],
      providerId,
    );
    assert.equal(
      profile.verification_evidence[0].release_commit,
      RELEASE_COMMITS[providerId],
      providerId,
    );
    assert.ok(
      profile.command_policy.allowed_when_verified.length > 0,
      providerId,
    );
  }
});

test("read-only evidence and unknown versions never authorize commands", () => {
  const profiles = loadProviderProfiles();
  const readOnly = clone(profiles.superpowers);
  readOnly.verification_evidence[0].scope =
    "artifact-contract-read-only";
  const exactVersion = resolveProviderSupport(readOnly, {
    detectedVersion: "v6.2.0",
  });
  assert.equal(exactVersion.status, "verified");
  assert.equal(exactVersion.commands_allowed, false);

  const unknownVersion = resolveProviderSupport(profiles.superpowers, {
    detectedVersion: "v999.0.0",
  });
  assert.equal(unknownVersion.status, "compatible-read-only");
  assert.equal(unknownVersion.commands_allowed, false);
});

test("Provider selection blocks command access without command evidence", () => {
  assert.deepEqual(
    selectProviders([
      {
        id: "superpowers",
        role: "main",
        installed: true,
        capability_gap: "planning",
        owner: "requirements",
        detected_version: "v6.1.1",
        required_access: "commands",
      },
    ]).inactive.map((item) => item.inactive_reason),
    ["commands_not_verified"],
  );
});

test("Provider aggregate rejects raw fields and synthetic evidence", () => {
  const profiles = verifiedProfiles();
  assert.throws(
    () =>
      validateProviderValidationAggregate(
        {
          ...providerAggregate({}, profiles),
          raw_output: "not publishable",
        },
        {
          currentSkillFingerprint: FINGERPRINT,
          profiles,
        },
      ),
    /未知欄位/u,
  );
  const aggregate = providerAggregate({}, profiles);
  aggregate.cases[0].evidence_kind = "synthetic";
  const result = validateProviderValidationAggregate(aggregate, {
    currentSkillFingerprint: FINGERPRINT,
    profiles,
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes("synthetic_provider_evidence"));
});

test("Provider aggregate blocks missing duplicates drift and quality regression", () => {
  const profiles = verifiedProfiles();
  const missing = providerAggregate({}, profiles);
  missing.cases.pop();
  assert.ok(
    validateProviderValidationAggregate(missing, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("missing_provider_case"),
  );

  const duplicate = providerAggregate({}, profiles);
  duplicate.cases[1] = clone(duplicate.cases[0]);
  assert.ok(
    validateProviderValidationAggregate(duplicate, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("duplicate_provider_case"),
  );

  const drifted = providerAggregate({}, profiles);
  drifted.candidate_skill_fingerprint = "b".repeat(64);
  assert.ok(
    validateProviderValidationAggregate(drifted, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("candidate_fingerprint_mismatch"),
  );

  const regression = providerAggregate({}, profiles);
  regression.cases[0].quality.candidate_score =
    regression.cases[0].quality.baseline_score;
  assert.ok(
    validateProviderValidationAggregate(regression, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_quality_regression"),
  );

  const hiddenRegression = providerAggregate({}, profiles);
  hiddenRegression.cases[0].quality.regressions = ["concision"];
  assert.ok(
    validateProviderValidationAggregate(hiddenRegression, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_quality_regression"),
  );

  const invalidCost = providerAggregate({}, profiles);
  invalidCost.cases[0].cost.tool_calls = -1;
  assert.ok(
    validateProviderValidationAggregate(invalidCost, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_cost_invalid"),
  );
});

test("Provider aggregate requires unique owners and matching commands", () => {
  const profiles = verifiedProfiles();
  const conflict = providerAggregate({}, profiles);
  conflict.cases[1].owner = conflict.cases[0].owner;
  assert.ok(
    validateProviderValidationAggregate(conflict, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_owner_conflict"),
  );

  const commandDrift = providerAggregate({}, profiles);
  commandDrift.cases[0].command_ids = ["unreviewed-command"];
  assert.ok(
    validateProviderValidationAggregate(commandDrift, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_command_mismatch"),
  );

  const artifactDrift = providerAggregate({}, profiles);
  artifactDrift.cases[0].artifact_kinds = ["unreviewed-artifact"];
  assert.ok(
    validateProviderValidationAggregate(artifactDrift, {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    }).blockers.includes("provider_artifact_mismatch"),
  );
});

test("stable candidate readiness does not depend on an existing release", () => {
  const profiles = verifiedProfiles();
  const providerValidation = validateProviderValidationAggregate(
    providerAggregate({}, profiles),
    {
      currentSkillFingerprint: FINGERPRINT,
      profiles,
    },
  );
  const candidate = stableReleaseGate({
    providerValidation,
    expectedRepository: "example/agent-skill-maintainer",
    expectedVersion: "1.0.0",
    expectedCommit: "c".repeat(40),
    publicationProof: null,
  });
  assert.equal(candidate.stable_candidate_ready, true);
  assert.equal(candidate.release_preview_allowed, true);
  assert.equal(candidate.publication_verified, false);

  const published = stableReleaseGate({
    providerValidation,
    expectedRepository: "example/agent-skill-maintainer",
    expectedVersion: "1.0.0",
    expectedCommit: "c".repeat(40),
    publicationProof: {
      schema_version: 1,
      repository: "example/agent-skill-maintainer",
      version: "1.0.0",
      tag: "v1.0.0",
      commit: "c".repeat(40),
      release_url:
        "https://github.com/example/agent-skill-maintainer/releases/tag/v1.0.0",
      official: true,
    },
  });
  assert.equal(published.stable_candidate_ready, true);
  assert.equal(published.publication_verified, true);
});

test("public Provider aggregate schema is present and versioned", () => {
  const schema = JSON.parse(
    readFileSync(
      resolve(
        SKILL_ROOT,
        "assets",
        "schemas",
        "provider-validation-aggregate.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(schema.properties.schema_version.const, 1);
  assert.ok(schema.required.includes("schema_version"));
});
