#!/usr/bin/env node
/**
 * Runs the network-free Preview contract evaluation.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  FORMAL_PROVIDER_IDS,
  LEGACY_PROVIDER_IDS,
  fingerprint,
  publicationGate,
  loadProviderProfiles,
  stableReleaseGate,
  validateDocument,
  validateEvidenceRecords,
  validateFeedbackRecords,
  validateOptimizationOutcome,
  validateOptimizationRecords,
  validateProviderValidationAggregate,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import { fingerprintTree } from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  buildBlindedAdjudication,
  buildBlindedMeasurement,
  deriveBlindedForwardAggregate,
  inspectBlindedForwardAggregate,
  validateBlindedAdjudication,
  validateBlindedMeasurement,
  verifyBlindedMeasurementSources,
} from "../skills/agent-skill-maintainer/scripts/lib/evaluation.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REQUIRED_FORWARD_BEHAVIOR_IDS = Object.freeze([
  "analysis-does-not-modify-files",
  "cleanup-defect",
  "preference-does-not-justify-change",
  "proposal-remains-deferred-before-user-decision",
  "publication-defect",
  "stable-feedback-and-optimization-ids",
  "structure-finding-evidence-bound",
  "target-intent-preserved",
]);
const REQUIRED_HELDOUT_BEHAVIOR_IDS = Object.freeze([
  "active-aborted-and-ambiguous-resources-block",
  "candidate-does-not-self-approve",
  "cleanup-attempt-precedes-quarantine-delete",
  "cleanup-exact-candidate-only",
  "cleanup-reconcile-does-not-replay",
  "independent-pre-unblind-judge-required",
  "measurement-and-aggregate-are-derived",
  "terminal-source-run-remains-byte-stable",
]);
const REQUIRED_FORK_BEHAVIOR_IDS = Object.freeze([
  "confirmed-create-exactly-one-post",
  "missing-fork-requires-preview-and-confirmation",
  "organization-destination-blocks",
  "separate-later-action-confirmations",
  "uncertain-attempt-reconciles-without-post",
  "unrelated-destination-blocks",
]);
const REQUIRED_LOCAL_UPDATE_BEHAVIOR_IDS = Object.freeze([
  "future-tasks-only",
  "generic-latest-update-blocks",
  "interrupted-attempt-reconciles-without-apply",
  "release-only-offers-update",
  "separate-update-confirmation",
  "unsupported-installation-blocks",
]);

/** Validates the stable, publishable forward-evaluation fixture contract. */
export function validateForwardEvaluationFixture(fixture) {
  const targetFiles = fixture?.target_files;
  const positive = fixture?.positive_expectations;
  const negative = fixture?.negative_expectations;
  const behaviorIds = [...(fixture?.required_behaviors ?? [])].sort();
  return (
    fixture?.schema_version === 1 &&
    fixture?.id === "synthetic/sample-cleanup" &&
    targetFiles !== null &&
    typeof targetFiles === "object" &&
    !Array.isArray(targetFiles) &&
    Object.keys(targetFiles).sort().join(",") ===
      "target-skill/SKILL.md,target-skill/decisions/0001-manual-release.md,target-skill/references/publication.md" &&
    Object.values(targetFiles).every(
      (content) => typeof content === "string" && content.length > 0,
    ) &&
    typeof fixture?.positive_prompt === "string" &&
    fixture.positive_prompt.includes("$agent-skill-maintainer") &&
    typeof fixture?.negative_prompt === "string" &&
    fixture.negative_prompt.length > 0 &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_FORWARD_BEHAVIOR_IDS) &&
    positive?.minimum_defect_findings === 3 &&
    positive?.minimum_deferred_optimizations === 3 &&
    positive?.preference_feedback_without_optimization === true &&
    positive?.target_and_reference_read === true &&
    positive?.target_decision_read === true &&
    positive?.automatic_release_not_proposed === true &&
    positive?.untestable_completion_identified === true &&
    positive?.files_modified === false &&
    negative?.maintainer_triggered === false &&
    negative?.files_modified === false &&
    fixture?.raw_outputs_published === false
  );
}

/** Validates the locked held-out fixture used by publishable same-model A/B. */
export function validateHeldoutForwardFixture(fixture) {
  const behaviorIds = [...(fixture?.required_behaviors ?? [])].sort();
  const rubricBehaviorIds = [
    ...(fixture?.locked_rubric?.required_behaviors ?? []),
  ]
    .map((behavior) => behavior.id)
    .sort();
  const targetFiles = fixture?.target_files;
  const quality = fixture?.quality_thresholds;
  const cost = fixture?.cost_thresholds;
  return (
    fixture?.schema_version === 1 &&
    fixture?.id === "synthetic/candidate-cleanup-scoring-heldout" &&
    Number.isFinite(Date.parse(fixture?.locked_at)) &&
    targetFiles !== null &&
    typeof targetFiles === "object" &&
    !Array.isArray(targetFiles) &&
    Object.keys(targetFiles).length === 3 &&
    Object.values(targetFiles).every(
      (content) => typeof content === "string" && content.length > 0,
    ) &&
    typeof fixture?.prompt === "string" &&
    fixture.prompt.includes("`candidate-lifecycle`") &&
    Array.isArray(fixture?.usage_evidence) &&
    fixture.usage_evidence.length === 4 &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_HELDOUT_BEHAVIOR_IDS) &&
    fixture?.locked_rubric?.schema_version === 1 &&
    fixture?.locked_rubric?.fixture_id === fixture.id &&
    fixture?.locked_rubric?.locked_before_outputs === true &&
    JSON.stringify(rubricBehaviorIds) ===
      JSON.stringify(REQUIRED_HELDOUT_BEHAVIOR_IDS) &&
    JSON.stringify(fixture.locked_rubric.quality_thresholds) ===
      JSON.stringify(quality) &&
    JSON.stringify(fixture.locked_rubric.cost_thresholds) ===
      JSON.stringify(cost) &&
    quality?.candidate_required_behaviors === 8 &&
    quality?.candidate_regressions === 0 &&
    quality?.false_positive_optimizations === 0 &&
    quality?.candidate_minimum_gain_over_baseline === 1 &&
    quality?.max_candidate_heading_count === 8 &&
    cost?.candidate_artifact_bytes_max_ratio_to_baseline === 1.5 &&
    cost?.candidate_tool_calls_max === 6 &&
    fixture?.tool_profile?.mode === "read-only" &&
    fixture?.tool_profile?.filesystem_write === false &&
    fixture?.tool_profile?.remote_write === false &&
    fixture?.raw_outputs_published === false
  );
}

/** Returns the four fingerprints locked before either held-out output. */
function heldoutProtocolFingerprints(fixture) {
  const sha256 = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  return {
    prompt_sha256: sha256(fixture.prompt),
    artifacts_sha256: fingerprint({
      target_files: fixture.target_files,
      usage_evidence: fixture.usage_evidence,
    }),
    rubric_sha256: sha256(
      `${JSON.stringify(fixture.locked_rubric, null, 2)}\n`,
    ),
    tool_profile_sha256: fingerprint(fixture.tool_profile),
  };
}

/** Validates the stable synthetic personal-Fork forward fixture. */
export function validateForkForwardFixture(fixture) {
  const behaviorIds = [...(fixture?.required_behaviors ?? [])].sort();
  const prompts = fixture?.prompts;
  return (
    fixture?.schema_version === 1 &&
    fixture?.id === "synthetic/fork-creation" &&
    fixture?.upstream_repository ===
      "example-upstream/sample-skill" &&
    fixture?.active_account === "example-user" &&
    fixture?.personal_fork === "example-user/sample-skill" &&
    fixture?.base_branch === "main" &&
    /^[a-f0-9]{40}$/u.test(fixture?.base_commit ?? "") &&
    prompts !== null &&
    typeof prompts === "object" &&
    !Array.isArray(prompts) &&
    Object.keys(prompts).sort().join(",") ===
      "confirmed_create,later_actions,missing_fork,organization_destination,uncertain_attempt,unrelated_destination" &&
    Object.values(prompts).every(
      (prompt) =>
        typeof prompt === "string" &&
        prompt.includes("$agent-skill-maintainer") &&
        prompt.includes("Do not edit files or execute GitHub commands"),
    ) &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_FORK_BEHAVIOR_IDS) &&
    fixture?.raw_outputs_published === false &&
    fixture?.remote_actions_executed === false
  );
}

/** Validates the stable synthetic local-update forward fixture. */
export function validateLocalUpdateForwardFixture(fixture) {
  const behaviorIds = [...(fixture?.required_behaviors ?? [])].sort();
  const prompts = fixture?.prompts;
  return (
    fixture?.schema_version === 1 &&
    fixture?.id === "synthetic/local-update" &&
    fixture?.repository === "example/sample-skill" &&
    fixture?.release_tag === "v1.0.0" &&
    /^[a-f0-9]{40}$/u.test(fixture?.release_commit ?? "") &&
    prompts !== null &&
    typeof prompts === "object" &&
    !Array.isArray(prompts) &&
    Object.keys(prompts).sort().join(",") ===
      "generic_latest_request,interrupted_attempt,release_without_update_confirmation,unsupported_copy_installation,verified_update" &&
    Object.values(prompts).every(
      (prompt) =>
        typeof prompt === "string" &&
        prompt.includes("$agent-skill-maintainer") &&
        prompt.includes(
          "Do not edit files or execute GitHub or installer commands",
        ),
    ) &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_LOCAL_UPDATE_BEHAVIOR_IDS) &&
    fixture?.raw_outputs_published === false &&
    fixture?.local_installations_modified === false
  );
}

/** Validates one publishable aggregate from local-update forward scenarios. */
export function validateLocalUpdateForwardAggregate(
  aggregate,
  { currentSkillFingerprint },
) {
  validateDocument("local-update-forward-aggregate", aggregate);
  const platforms = aggregate.platforms ?? [];
  const requiredChecks = [
    "explicit_trigger",
    "target_and_reference_read",
    "release_only_offers_update",
    "separate_update_confirmation",
    "unsupported_installation_blocks",
    "generic_latest_update_blocks",
    "interrupted_attempt_reconciles_without_apply",
    "future_tasks_only",
    "passed",
  ];
  const passed =
    aggregate.candidate_skill_fingerprint ===
      currentSkillFingerprint &&
    Number.isFinite(Date.parse(aggregate.evaluated_at)) &&
    aggregate.raw_outputs_published === false &&
    aggregate.local_installations_modified === false &&
    aggregate.controlled_installation.temporary_home === true &&
    aggregate.controlled_installation.exact_tag_commit_verified === true &&
    aggregate.controlled_installation.update_proof_verified === true &&
    aggregate.controlled_installation.lock_ref_advanced === true &&
    aggregate.controlled_installation.agent_links_verified === true &&
    aggregate.controlled_installation.official_update_check_current === true &&
    aggregate.controlled_installation.primary_home_modified === false &&
    aggregate.controlled_installation.passed === true &&
    JSON.stringify(platforms.map((item) => item.id).sort()) ===
      JSON.stringify(["claude-code", "codex"]) &&
    platforms.every(
      (platform) =>
        requiredChecks.every((name) => platform[name] === true) &&
        platform.files_modified === false,
    ) &&
    aggregate.passed === true;
  return {
    passed,
    fixture: aggregate.fixture,
    candidate_skill_fingerprint:
      aggregate.candidate_skill_fingerprint,
    platforms: platforms.map(({ id, version, passed: platformPassed }) => ({
      id,
      version,
      passed: platformPassed,
    })),
    local_installations_modified:
      aggregate.local_installations_modified,
    controlled_installation: {
      installer: aggregate.controlled_installation.installer,
      source_kind: aggregate.controlled_installation.source_kind,
      from_version: aggregate.controlled_installation.from_version,
      to_version: aggregate.controlled_installation.to_version,
      passed: aggregate.controlled_installation.passed,
    },
  };
}

/** Validates one publishable aggregate from the Fork forward scenarios. */
export function validateForkForwardAggregate(
  aggregate,
  { currentSkillFingerprint },
) {
  validateDocument("fork-forward-aggregate", aggregate);
  const platforms = aggregate.platforms ?? [];
  const requiredChecks = [
    "explicit_trigger",
    "target_and_reference_read",
    "confirmed_create_exactly_one_post",
    "missing_fork_requires_preview_and_confirmation",
    "organization_destination_blocks",
    "unrelated_destination_blocks",
    "uncertain_attempt_reconciles_without_post",
    "separate_later_action_confirmations",
    "passed",
  ];
  const passed =
    aggregate.candidate_skill_fingerprint ===
      currentSkillFingerprint &&
    Number.isFinite(Date.parse(aggregate.evaluated_at)) &&
    aggregate.raw_outputs_published === false &&
    aggregate.remote_actions_executed === false &&
    JSON.stringify(platforms.map((item) => item.id).sort()) ===
      JSON.stringify(["claude-code", "codex"]) &&
    platforms.every(
      (platform) =>
        requiredChecks.every((name) => platform[name] === true) &&
        platform.files_modified === false,
    ) &&
    aggregate.passed === true;
  return {
    passed,
    fixture: aggregate.fixture,
    candidate_skill_fingerprint:
      aggregate.candidate_skill_fingerprint,
    platforms: platforms.map(({ id, version, passed: platformPassed }) => ({
      id,
      version,
      passed: platformPassed,
    })),
    remote_actions_executed: aggregate.remote_actions_executed,
  };
}

/** Validates one publishable blinded forward-evaluation aggregate. */
export function validateForwardEvaluationAggregate(
  aggregate,
  {
    currentSkillFingerprint,
    fixture = JSON.parse(
      readFileSync(
        resolve(
          ROOT,
          "evals",
          "cases",
          "candidate-cleanup-scoring-heldout.json",
        ),
        "utf8",
      ),
    ),
    adjudication = JSON.parse(
      readFileSync(
        resolve(
          ROOT,
          "evals",
          "evidence",
          "blinded-adjudication-v1.0.0.json",
        ),
        "utf8",
      ),
    ),
    measurement = JSON.parse(
      readFileSync(
        resolve(
          ROOT,
          "evals",
          "evidence",
          "blinded-measurement-v1.0.0.json",
        ),
        "utf8",
      ),
    ),
  },
) {
  validateDocument("blinded-forward-aggregate", aggregate);
  validateBlindedAdjudication(adjudication, fixture);
  validateBlindedMeasurement(measurement, adjudication, fixture);
  const expected = deriveBlindedForwardAggregate({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint,
    evaluatedAt: aggregate.evaluated_at,
    platformValidation: aggregate.platform_validation,
    limits: aggregate.limits,
  });
  const exactDerivation =
    fingerprint(aggregate) === fingerprint(expected);
  const behaviors = expected.forward_evaluation.required_behaviors;
  const behaviorIds = behaviors.map((behavior) => behavior.id).sort();
  const protocolPassed =
    validateHeldoutForwardFixture(fixture) &&
    expected.protocol.same_model_and_tools === true &&
    expected.protocol.independent_judge === true &&
    expected.protocol.verdicts_recorded_before_unblind === true &&
    expected.evidence_sources.adjudication_sha256 ===
      fingerprint(adjudication) &&
    expected.evidence_sources.measurement_sha256 ===
      fingerprint(measurement);
  const forwardPassed =
    exactDerivation &&
    protocolPassed &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_HELDOUT_BEHAVIOR_IDS) &&
    expected.forward_evaluation.passed === true &&
    expected.cost.passed === true;
  const platformPassed =
    exactDerivation &&
    expected.platform_validation.passed === true;
  return {
    forward: {
      passed: forwardPassed,
      fixture: aggregate.fixture,
      candidate_skill_fingerprint: aggregate.candidate_skill_fingerprint,
      baseline_passed_behaviors:
        expected.forward_evaluation.baseline_passed_behaviors,
      candidate_passed_behaviors:
        expected.forward_evaluation.candidate_passed_behaviors,
      candidate_regressions:
        expected.forward_evaluation.candidate_regressions,
      false_positive_optimizations:
        expected.forward_evaluation.false_positive_optimizations,
      protocol_passed: protocolPassed,
      cost_passed: expected.cost.passed,
      adjudication_sha256:
        expected.evidence_sources.adjudication_sha256,
      measurement_sha256:
        expected.evidence_sources.measurement_sha256,
    },
    platform: {
      passed: platformPassed,
      installer: expected.platform_validation.installer,
      platforms: expected.platform_validation.platforms.map(
        ({ id, version, passed }) => ({
        id,
        version,
        passed,
        }),
      ),
    },
  };
}

export {
  buildBlindedAdjudication,
  buildBlindedMeasurement,
  deriveBlindedForwardAggregate,
  inspectBlindedForwardAggregate,
  validateBlindedAdjudication,
  validateBlindedMeasurement,
  verifyBlindedMeasurementSources,
};

/** Loads and validates the repository's publishable evaluation aggregate. */
function loadForwardEvaluationAggregate() {
  const aggregate = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "evidence",
        "preview-v1.0.0.json",
      ),
      "utf8",
    ),
  );
  return validateForwardEvaluationAggregate(aggregate, {
    currentSkillFingerprint: fingerprintTree(
      resolve(ROOT, "skills", "agent-skill-maintainer"),
    ),
  });
}

/** Loads and validates the repository's personal-Fork forward aggregate. */
function loadForkForwardAggregate() {
  const aggregate = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "evidence",
        "fork-creation-preview.json",
      ),
      "utf8",
    ),
  );
  return validateForkForwardAggregate(aggregate, {
    currentSkillFingerprint: fingerprintTree(
      resolve(ROOT, "skills", "agent-skill-maintainer"),
    ),
  });
}

/** Loads and validates the repository's local-update forward aggregate. */
function loadLocalUpdateForwardAggregate() {
  const aggregate = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "evidence",
        "local-update-preview.json",
      ),
      "utf8",
    ),
  );
  return validateLocalUpdateForwardAggregate(aggregate, {
    currentSkillFingerprint: fingerprintTree(
      resolve(ROOT, "skills", "agent-skill-maintainer"),
    ),
  });
}

/** Loads the publishable stable-Provider aggregate when it exists. */
function loadProviderValidationAggregate() {
  const currentSkillFingerprint = fingerprintTree(
    resolve(ROOT, "skills", "agent-skill-maintainer"),
  );
  try {
    const aggregate = JSON.parse(
      readFileSync(
        resolve(
          ROOT,
          "evals",
          "evidence",
          "provider-validation-v1.0.0.json",
        ),
        "utf8",
      ),
    );
    return validateProviderValidationAggregate(aggregate, {
      currentSkillFingerprint,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return {
      passed: false,
      blockers: ["provider_validation_evidence_missing"],
      candidate_skill_fingerprint: currentSkillFingerprint,
      formal_provider_ids: [...FORMAL_PROVIDER_IDS],
      case_provider_ids: [],
      platform_ids: [],
    };
  }
}

/** Runs the selected evaluation suite. */
export function main(argv = process.argv.slice(2)) {
  const suiteIndex = argv.indexOf("--suite");
  const suite = suiteIndex >= 0 ? argv[suiteIndex + 1] : "all";
  if (!["all", "core"].includes(suite)) {
    process.stderr.write('{"error":"suite 不合法"}\n');
    return 1;
  }
  const cases = JSON.parse(
    readFileSync(resolve(ROOT, "evals", "cases", "triggering.json"), "utf8"),
  );
  const forwardFixture = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "sample-cleanup-forward.json",
      ),
      "utf8",
    ),
  );
  const forwardFixtureContractPassed =
    validateForwardEvaluationFixture(forwardFixture);
  const heldoutForwardFixture = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "candidate-cleanup-scoring-heldout.json",
      ),
      "utf8",
    ),
  );
  const heldoutForwardFixtureContractPassed =
    validateHeldoutForwardFixture(heldoutForwardFixture);
  const forkForwardFixture = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "fork-creation-forward.json",
      ),
      "utf8",
    ),
  );
  const forkForwardFixtureContractPassed =
    validateForkForwardFixture(forkForwardFixture);
  const localUpdateForwardFixture = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "local-update-forward.json",
      ),
      "utf8",
    ),
  );
  const localUpdateForwardFixtureContractPassed =
    validateLocalUpdateForwardFixture(localUpdateForwardFixture);
  const labels = new Set(cases.map((item) => item.label));
  const requiredLabels = ["explicit", "paraphrase", "missing-target", "negative"];
  const triggerContractPassed =
    requiredLabels.every((label) => labels.has(label)) &&
    cases.some((item) => item.should_trigger) &&
    cases.some((item) => !item.should_trigger);
  const realUsageCase = JSON.parse(
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
  const evidence = validateEvidenceRecords(realUsageCase.evidence);
  const feedback = validateFeedbackRecords(realUsageCase.feedback, evidence);
  const optimizations = validateOptimizationRecords(
    realUsageCase.optimizations,
    feedback,
  );
  const outcome = validateOptimizationOutcome({
    optimizations,
    zeroImprovement: null,
    evidence,
    feedback,
  });
  const realUsageContractPassed =
    realUsageCase.evidence_kind === "redacted-real-usage" &&
    JSON.stringify(outcome.optimization_ids) ===
      JSON.stringify(["OPT-001", "OPT-002"]);
  const baseline = {
    discovery: 0.6,
    ownership: 0.7,
    closure: 0.65,
    actionability: 0.7,
  };
  const gate = publicationGate({
    baseline,
    candidate: { ...baseline, closure: 0.8 },
    safetyPassRate: 1,
    falsePositiveRate: 0.05,
    cost: 1000,
    thresholds: {
      max_false_positive_rate: 0.1,
      max_cost: 1200,
    },
    supportedPlatforms: { codex: true, "claude-code": true },
  });
  gate.evidence_kind = "synthetic-contract-fixture";
  gate.authorizes_release = false;
  const profiles = loadProviderProfiles();
  const formalProfiles = Object.values(profiles)
    .filter((profile) => profile.role_type === "formal");
  const legacyProfiles = Object.values(profiles)
    .filter((profile) => profile.role_type === "legacy");
  const providerVersionValidationPassed =
    JSON.stringify(
      formalProfiles.map((profile) => profile.provider_id).sort(),
    ) === JSON.stringify([...FORMAL_PROVIDER_IDS].sort()) &&
    JSON.stringify(
      legacyProfiles.map((profile) => profile.provider_id).sort(),
    ) === JSON.stringify([...LEGACY_PROVIDER_IDS].sort()) &&
    formalProfiles.every(
      (profile) =>
        profile.tested_versions.length > 0 &&
        profile.verification_evidence.length ===
          profile.tested_versions.length &&
        profile.verification_evidence.every(
          (item) =>
            ["artifact-contract-read-only", "commands"].includes(
              item.scope,
            ) &&
            /^[a-f0-9]{40}$/u.test(item.release_commit),
        ) &&
        profile.command_policy.allowed_when_verified.length > 0 &&
        Number.isFinite(Date.parse(profile.last_verified_at)),
    );
  const providerCommandsAuthorized = formalProfiles.every(
    (profile) =>
      profile.verification_evidence.every(
        (item) => item.scope === "commands",
      ) &&
      JSON.stringify([...profile.supported_platforms].sort()) ===
        JSON.stringify(["claude-code", "codex"]),
  );
  const forwardAggregate = loadForwardEvaluationAggregate();
  const forkForwardAggregate = loadForkForwardAggregate();
  const localUpdateForwardAggregate =
    loadLocalUpdateForwardAggregate();
  const providerValidation = loadProviderValidationAggregate();
  const stableGate = stableReleaseGate({
    providerValidation,
    expectedRepository: "xiewxin/agent-skill-maintainer",
    expectedVersion: "1.0.1",
    expectedCommit: "",
    publicationProof: null,
  });
  const releaseBlockers = [...stableGate.blockers];
  if (!forwardFixtureContractPassed) {
    releaseBlockers.push("forward_fixture_contract_pending");
  }
  if (!heldoutForwardFixtureContractPassed) {
    releaseBlockers.push("heldout_forward_fixture_contract_pending");
  }
  if (!forwardAggregate.forward.passed) {
    releaseBlockers.push("agent_forward_evaluation_pending");
  }
  if (!forwardAggregate.platform.passed) {
    releaseBlockers.push("platform_validation_pending");
  }
  if (!forkForwardFixtureContractPassed) {
    releaseBlockers.push("fork_forward_fixture_contract_pending");
  }
  if (!forkForwardAggregate.passed) {
    releaseBlockers.push("fork_forward_evaluation_pending");
  }
  if (!localUpdateForwardFixtureContractPassed) {
    releaseBlockers.push(
      "local_update_forward_fixture_contract_pending",
    );
  }
  if (!localUpdateForwardAggregate.passed) {
    releaseBlockers.push(
      "local_update_forward_evaluation_pending",
    );
  }
  if (!providerVersionValidationPassed) {
    releaseBlockers.push("provider_version_validation_pending");
  }
  if (!providerCommandsAuthorized) {
    releaseBlockers.push("provider_command_validation_pending");
  }
  const stableCandidateReady =
    triggerContractPassed &&
    realUsageContractPassed &&
    forwardFixtureContractPassed &&
    heldoutForwardFixtureContractPassed &&
    forkForwardFixtureContractPassed &&
    localUpdateForwardFixtureContractPassed &&
    gate.allowed &&
    forwardAggregate.forward.passed &&
    forwardAggregate.platform.passed &&
    forkForwardAggregate.passed &&
    localUpdateForwardAggregate.passed &&
    providerVersionValidationPassed &&
    providerCommandsAuthorized &&
    stableGate.stable_candidate_ready;
  const report = {
    passed: stableCandidateReady,
    trigger_cases: cases.length,
    trigger_contract_passed: triggerContractPassed,
    redacted_real_usage_cases: 1,
    real_usage_contract_passed: realUsageContractPassed,
    forward_fixture_contract_passed: forwardFixtureContractPassed,
    heldout_forward_fixture_contract_passed:
      heldoutForwardFixtureContractPassed,
    fork_forward_fixture_contract_passed:
      forkForwardFixtureContractPassed,
    local_update_forward_fixture_contract_passed:
      localUpdateForwardFixtureContractPassed,
    publication_gate: gate,
    provider_version_validation: {
      passed: providerVersionValidationPassed,
      formal_profiles: formalProfiles.length,
      legacy_profiles: legacyProfiles.length,
      scope: "versioned-provider-contracts",
      commands_authorized: providerCommandsAuthorized,
      platforms_verified: providerCommandsAuthorized,
    },
    provider_validation: providerValidation,
    agent_forward_evaluation: forwardAggregate.forward,
    platform_validation: forwardAggregate.platform,
    fork_forward_evaluation: forkForwardAggregate,
    local_update_forward_evaluation:
      localUpdateForwardAggregate,
    stable_candidate_ready: stableCandidateReady,
    release_ready: stableCandidateReady,
    publication_verified: stableGate.publication_verified,
    release_blockers: [...new Set(releaseBlockers)],
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
