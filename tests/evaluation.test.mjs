import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBlindedAdjudication,
  buildBlindedMeasurement,
  deriveBlindedForwardAggregate,
  inspectBlindedForwardAggregate,
  validateBlindedAdjudication,
  validateForwardEvaluationAggregate,
  verifyBlindedMeasurementSources,
} from "../evals/run-evals.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const fixture = JSON.parse(
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
const passingPlatformValidation = {
  installer: {
    name: "skills",
    version: "test-version",
    scope: "isolated-project-copy",
  },
  platforms: ["codex", "claude-code"].map((id) => ({
    id,
    version: "test-version",
    explicit_trigger: true,
    target_and_reference_read: true,
    positive_analysis: true,
    negative_non_trigger: true,
    stable_ids: true,
    decision_boundary: true,
    files_modified: false,
    passed: true,
  })),
  passed: true,
};
const legacyAggregate = { schema_version: 2 };

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evaluationBundle() {
  const labelA = {
    output: "# Candidate\nAll required evidence is preserved.\n",
    events: [
      { type: "tool_call", name: "read" },
      { type: "message", role: "assistant" },
    ],
  };
  const labelB = {
    output:
      "Baseline output preserves most evidence but misses two boundaries.\n",
    events: [],
  };
  const measurement = buildBlindedMeasurement({
    fixture,
    labelA,
    labelB,
    measuredAt: "2026-07-29T02:34:20.000Z",
  });
  const baselineFailures = new Set([
    "cleanup-attempt-precedes-quarantine-delete",
    "measurement-and-aggregate-are-derived",
  ]);
  const verdict = (id, condition) => {
    const passed =
      condition === "candidate" || !baselineFailures.has(id);
    const value = passed ? "pass" : "fail";
    return {
      verdict: value,
      rationale_summary:
        `${condition} ${value} for synthetic behavior ${id}.`,
      evidence_summary:
        `${condition} evidence for synthetic behavior ${id}.`,
    };
  };
  const judgeOutput = {
    behaviors: fixture.required_behaviors.map((id) => ({
      id,
      label_a: verdict(id, "candidate"),
      label_b: verdict(id, "baseline"),
    })),
    quality: {
      false_positive_optimizations: 0,
      rationale_summary:
        "No unsupported optimization was found in either synthetic output.",
      evidence_summary:
        "The synthetic outputs contain no unsupported optimization IDs.",
    },
  };
  const seed = Buffer.alloc(32);
  seed[0] = 1;
  const assignment = {
    seed_base64: seed.toString("base64"),
    seed_commitment_sha256:
      createHash("sha256").update(seed).digest("hex"),
    baseline_label: "b",
    candidate_label: "a",
    model_id: "same-model",
    committed_at: "2026-07-29T02:31:12.000Z",
  };
  const sessions = {
    model_id: "same-model",
    label_a: {
      session_nonce: "candidate-session",
      started_at: "2026-07-29T02:32:00.000Z",
      completed_at: "2026-07-29T02:33:00.000Z",
    },
    label_b: {
      session_nonce: "baseline-session",
      started_at: "2026-07-29T02:32:10.000Z",
      completed_at: "2026-07-29T02:33:10.000Z",
    },
    judge: {
      session_nonce: "judge-session",
      started_at: "2026-07-29T02:33:20.000Z",
      completed_at: "2026-07-29T02:34:00.000Z",
    },
  };
  const adjudication = buildBlindedAdjudication({
    fixture,
    assignment,
    sessions,
    judgeOutput,
    measurement,
    unblindedAt: "2026-07-29T02:34:10.000Z",
  });
  const aggregate = deriveBlindedForwardAggregate({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint: "f".repeat(64),
    evaluatedAt: "2026-07-29T02:34:30.000Z",
    platformValidation: passingPlatformValidation,
    limits: [
      "Synthetic fixtures verify the evidence contract, not semantic truth.",
      "Raw outputs remain local and are represented by SHA-256 identities.",
    ],
  });
  return {
    labelA,
    labelB,
    measurement,
    adjudication,
    aggregate,
    assignment,
    sessions,
    judgeOutput,
  };
}

test("measurement is recomputed from private outputs and aggregate is derived", () => {
  const bundle = evaluationBundle();
  assert.equal(bundle.measurement.labels.a.tool_calls, 1);
  assert.equal(bundle.measurement.labels.a.heading_count, 1);
  assert.equal(
    verifyBlindedMeasurementSources(bundle.measurement, {
      fixture,
      labelA: bundle.labelA,
      labelB: bundle.labelB,
    }),
    true,
  );
  assert.equal(
    bundle.aggregate.forward_evaluation.baseline_passed_behaviors,
    6,
  );
  assert.equal(
    bundle.aggregate.forward_evaluation.candidate_passed_behaviors,
    8,
  );
  assert.equal(bundle.aggregate.forward_evaluation.candidate_regressions, 0);
  const result = validateForwardEvaluationAggregate(bundle.aggregate, {
    currentSkillFingerprint: "f".repeat(64),
    fixture,
    adjudication: bundle.adjudication,
    measurement: bundle.measurement,
  });
  assert.equal(result.forward.passed, true);
  assert.equal(result.forward.protocol_passed, true);
  assert.equal(result.forward.cost_passed, true);
  assert.equal(result.platform.passed, true);
});

test("early unblind and reused sessions fail closed", () => {
  const early = evaluationBundle();
  early.adjudication.judging.unblinded_at =
    "2026-07-29T02:33:30.000Z";
  assert.throws(
    () => validateBlindedAdjudication(early.adjudication, fixture),
    /時序/u,
  );

  const reusedPrivate = evaluationBundle();
  reusedPrivate.sessions.judge.session_nonce =
    reusedPrivate.sessions.label_a.session_nonce;
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: reusedPrivate.assignment,
        sessions: reusedPrivate.sessions,
        judgeOutput: reusedPrivate.judgeOutput,
        measurement: reusedPrivate.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /session identity/u,
  );

  const reused = evaluationBundle();
  reused.adjudication.sessions.judge.session_sha256 =
    reused.adjudication.sessions.label_a.session_sha256;
  assert.throws(
    () => validateBlindedAdjudication(reused.adjudication, fixture),
    /隔離/u,
  );

  const mismatchedJudgeStart = evaluationBundle();
  mismatchedJudgeStart.adjudication.sessions.judge.started_at =
    "2026-07-29T02:33:19.000Z";
  assert.throws(
    () =>
      validateBlindedAdjudication(
        mismatchedJudgeStart.adjudication,
        fixture,
      ),
    /時序/u,
  );
});

test("tampered measurements and aggregates do not inherit a passing verdict", () => {
  const measurementTamper = evaluationBundle();
  measurementTamper.measurement.labels.a.artifact_bytes += 1;
  assert.throws(
    () =>
      verifyBlindedMeasurementSources(
        measurementTamper.measurement,
        {
          fixture,
          labelA: measurementTamper.labelA,
          labelB: measurementTamper.labelB,
        },
      ),
    /未由目前本機 sources 重算/u,
  );

  const aggregateTamper = evaluationBundle();
  aggregateTamper.aggregate.forward_evaluation
    .candidate_passed_behaviors = 7;
  const result = validateForwardEvaluationAggregate(
    aggregateTamper.aggregate,
    {
      currentSkillFingerprint: "f".repeat(64),
      fixture,
      adjudication: aggregateTamper.adjudication,
      measurement: aggregateTamper.measurement,
    },
  );
  assert.equal(result.forward.passed, false);
});

test("insufficient evidence blocks the derived gate and legacy summaries stay historical", () => {
  const bundle = evaluationBundle();
  bundle.adjudication.behaviors[0].label_a = {
    verdict: "insufficient_evidence",
    rationale_summary: "The synthetic Judge could not locate enough evidence.",
    evidence_sha256: sha256("insufficient-evidence"),
  };
  const aggregate = deriveBlindedForwardAggregate({
    adjudication: bundle.adjudication,
    measurement: bundle.measurement,
    fixture,
    currentSkillFingerprint: "f".repeat(64),
    evaluatedAt: "2026-07-29T02:34:30.000Z",
    platformValidation: passingPlatformValidation,
    limits: ["Insufficient evidence is a release blocker."],
  });
  assert.equal(aggregate.forward_evaluation.passed, false);
  const result = validateForwardEvaluationAggregate(aggregate, {
    currentSkillFingerprint: "f".repeat(64),
    fixture,
    adjudication: bundle.adjudication,
    measurement: bundle.measurement,
  });
  assert.equal(result.forward.passed, false);
  assert.deepEqual(inspectBlindedForwardAggregate(legacyAggregate), {
    schema_version: 2,
    historical: true,
    publishable: false,
    reason: "legacy_boolean_summary",
  });
});
