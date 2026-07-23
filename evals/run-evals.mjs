#!/usr/bin/env node
/**
 * Runs the network-free Preview contract evaluation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  publicationGate,
  validateEvidenceRecords,
  validateFeedbackRecords,
  validateOptimizationOutcome,
  validateOptimizationRecords,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

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
  const report = {
    passed:
      triggerContractPassed &&
      realUsageContractPassed &&
      gate.allowed,
    trigger_cases: cases.length,
    trigger_contract_passed: triggerContractPassed,
    redacted_real_usage_cases: 1,
    real_usage_contract_passed: realUsageContractPassed,
    publication_gate: gate,
    agent_forward_evaluation: "pending",
    release_ready: false,
    release_blockers: [
      "agent_forward_evaluation_pending",
      "platform_validation_pending",
      "provider_version_validation_pending",
      "controlled_github_e2e_pending",
    ],
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
