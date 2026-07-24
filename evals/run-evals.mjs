#!/usr/bin/env node
/**
 * Runs the network-free Preview contract evaluation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  publicationGate,
  loadProviderProfiles,
  validateDocument,
  validateEvidenceRecords,
  validateFeedbackRecords,
  validateOptimizationOutcome,
  validateOptimizationRecords,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import { fingerprintTree } from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REQUIRED_FORWARD_BEHAVIOR_IDS = Object.freeze([
  "analysis-does-not-modify-files",
  "cleanup-defect",
  "preference-does-not-justify-change",
  "proposal-remains-deferred-before-user-decision",
  "publication-defect",
  "stable-feedback-and-optimization-ids",
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
      "target-skill/SKILL.md,target-skill/references/publication.md" &&
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
    positive?.files_modified === false &&
    negative?.maintainer_triggered === false &&
    negative?.files_modified === false &&
    fixture?.raw_outputs_published === false
  );
}

/** Validates one publishable blinded forward-evaluation aggregate. */
export function validateForwardEvaluationAggregate(
  aggregate,
  { currentSkillFingerprint },
) {
  validateDocument("blinded-forward-aggregate", aggregate);
  const behaviors = aggregate?.forward_evaluation?.required_behaviors ?? [];
  const platforms = aggregate?.platform_validation?.platforms ?? [];
  const behaviorIds = behaviors
    .map((behavior) => behavior.id)
    .sort();
  const baselinePassed = behaviors.filter(
    (behavior) => behavior.baseline === true,
  ).length;
  const candidatePassed = behaviors.filter(
    (behavior) => behavior.candidate === true,
  ).length;
  const candidateRegressions = behaviors.filter(
    (behavior) =>
      behavior.baseline === true && behavior.candidate !== true,
  ).length;
  const forwardPassed =
    aggregate.schema_version === 1 &&
    aggregate.evidence_kind === "blinded-forward-aggregate" &&
    Number.isFinite(Date.parse(aggregate.evaluated_at)) &&
    aggregate.fixture === "synthetic/sample-cleanup" &&
    aggregate.candidate_skill_fingerprint === currentSkillFingerprint &&
    aggregate.raw_outputs_published === false &&
    aggregate.forward_evaluation?.same_model_and_tools === true &&
    aggregate.forward_evaluation?.expected_findings_hidden === true &&
    JSON.stringify(behaviorIds) ===
      JSON.stringify(REQUIRED_FORWARD_BEHAVIOR_IDS) &&
    behaviors.every(
      (behavior) =>
        typeof behavior.id === "string" &&
        typeof behavior.baseline === "boolean" &&
        behavior.candidate === true,
    ) &&
    aggregate.forward_evaluation?.baseline_passed_behaviors ===
      baselinePassed &&
    aggregate.forward_evaluation?.candidate_passed_behaviors ===
      candidatePassed &&
    aggregate.forward_evaluation?.candidate_regressions ===
      candidateRegressions &&
    candidateRegressions === 0 &&
    aggregate.forward_evaluation?.false_positive_optimizations === 0 &&
    aggregate.forward_evaluation?.passed === true;
  const platformPassed =
    aggregate.platform_validation?.installer?.scope ===
      "isolated-project-copy" &&
    JSON.stringify(platforms.map((platform) => platform.id).sort()) ===
      JSON.stringify(["claude-code", "codex"]) &&
    platforms.every(
      (platform) =>
        typeof platform.version === "string" &&
        platform.explicit_trigger === true &&
        platform.target_and_reference_read === true &&
        platform.positive_analysis === true &&
        platform.negative_non_trigger === true &&
        platform.stable_ids === true &&
        platform.decision_boundary === true &&
        platform.files_modified === false &&
        platform.passed === true,
    ) &&
    aggregate.platform_validation?.passed === true;
  return {
    forward: {
      passed: forwardPassed,
      fixture: aggregate.fixture,
      candidate_skill_fingerprint: aggregate.candidate_skill_fingerprint,
      baseline_passed_behaviors: baselinePassed,
      candidate_passed_behaviors: candidatePassed,
      candidate_regressions: candidateRegressions,
      false_positive_optimizations:
        aggregate.forward_evaluation?.false_positive_optimizations,
    },
    platform: {
      passed: platformPassed,
      installer: aggregate.platform_validation?.installer,
      platforms: platforms.map(({ id, version, passed }) => ({
        id,
        version,
        passed,
      })),
    },
  };
}

/** Loads and validates the repository's publishable evaluation aggregate. */
function loadForwardEvaluationAggregate() {
  const aggregate = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "evidence",
        "preview-v0.1.0.json",
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
  const providerVersionValidationPassed =
    formalProfiles.length === 5 &&
    formalProfiles.every(
      (profile) =>
        profile.tested_versions.length > 0 &&
        profile.verification_evidence.length ===
          profile.tested_versions.length &&
        profile.verification_evidence.every(
          (item) => item.scope === "artifact-contract-read-only",
        ) &&
        Number.isFinite(Date.parse(profile.last_verified_at)),
    );
  const forwardAggregate = loadForwardEvaluationAggregate();
  const releaseBlockers = ["controlled_github_e2e_pending"];
  if (!forwardFixtureContractPassed) {
    releaseBlockers.push("forward_fixture_contract_pending");
  }
  if (!forwardAggregate.forward.passed) {
    releaseBlockers.push("agent_forward_evaluation_pending");
  }
  if (!forwardAggregate.platform.passed) {
    releaseBlockers.push("platform_validation_pending");
  }
  if (!providerVersionValidationPassed) {
    releaseBlockers.push("provider_version_validation_pending");
  }
  const report = {
    passed:
      triggerContractPassed &&
      realUsageContractPassed &&
      forwardFixtureContractPassed &&
      gate.allowed &&
      forwardAggregate.forward.passed &&
      forwardAggregate.platform.passed &&
      providerVersionValidationPassed,
    trigger_cases: cases.length,
    trigger_contract_passed: triggerContractPassed,
    redacted_real_usage_cases: 1,
    real_usage_contract_passed: realUsageContractPassed,
    forward_fixture_contract_passed: forwardFixtureContractPassed,
    publication_gate: gate,
    provider_version_validation: {
      passed: providerVersionValidationPassed,
      formal_profiles: formalProfiles.length,
      scope: "artifact-contract-read-only",
      commands_authorized: false,
    },
    agent_forward_evaluation: forwardAggregate.forward,
    platform_validation: forwardAggregate.platform,
    release_ready: false,
    release_blockers: releaseBlockers,
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
