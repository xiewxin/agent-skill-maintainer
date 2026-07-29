/**
 * Traceable blinded adjudication, local measurement and aggregate derivation.
 */

import { createHash } from "node:crypto";
import {
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  validateDocument,
} from "./core.mjs";

const LABELS = Object.freeze(["a", "b"]);
const VERDICTS = new Set(["pass", "fail", "insufficient_evidence"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseTime(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} 時間不合法`);
  }
  return timestamp;
}

function expectedBehaviorIds(fixture) {
  return [...(fixture?.required_behaviors ?? [])].sort();
}

function rubricFingerprint(fixture) {
  return sha256Text(`${JSON.stringify(fixture.locked_rubric, null, 2)}\n`);
}

function validateVerdict(item, label) {
  if (
    !isObject(item) ||
    !VERDICTS.has(item.verdict) ||
    typeof item.rationale_summary !== "string" ||
    item.rationale_summary.trim().length === 0 ||
    !SHA256_PATTERN.test(item.evidence_sha256 ?? "")
  ) {
    throw new Error(`${label} verdict 證據不完整`);
  }
}

function validateJudgeOutput(judgeOutput, fixture) {
  if (!isObject(judgeOutput) || !Array.isArray(judgeOutput.behaviors)) {
    throw new Error("Judge output 格式不合法");
  }
  const ids = judgeOutput.behaviors.map((behavior) => behavior?.id).sort();
  if (
    new Set(ids).size !== ids.length ||
    canonicalJson(ids) !== canonicalJson(expectedBehaviorIds(fixture))
  ) {
    throw new Error("Judge output behavior 與 locked rubric 不一致");
  }
  for (const behavior of judgeOutput.behaviors) {
    for (const label of LABELS) {
      const verdict = behavior[`label_${label}`];
      if (
        !isObject(verdict) ||
        !VERDICTS.has(verdict.verdict) ||
        typeof verdict.rationale_summary !== "string" ||
        verdict.rationale_summary.trim().length === 0 ||
        typeof verdict.evidence_summary !== "string" ||
        verdict.evidence_summary.trim().length === 0
      ) {
        throw new Error(`Judge output ${behavior.id}.label_${label} 不完整`);
      }
    }
  }
  if (
    !isObject(judgeOutput.quality) ||
    !Number.isInteger(
      judgeOutput.quality.false_positive_optimizations,
    ) ||
    judgeOutput.quality.false_positive_optimizations < 0 ||
    typeof judgeOutput.quality.rationale_summary !== "string" ||
    judgeOutput.quality.rationale_summary.trim().length === 0 ||
    typeof judgeOutput.quality.evidence_summary !== "string" ||
    judgeOutput.quality.evidence_summary.trim().length === 0
  ) {
    throw new Error("Judge output quality 不完整");
  }
}

function generatorSession({
  role,
  modelId,
  session,
  outputSha256,
  toolProfileSha256,
}) {
  return {
    model_id: modelId,
    session_sha256: fingerprint({
      role,
      session_nonce: session.session_nonce,
      model_id: modelId,
      started_at: session.started_at,
      completed_at: session.completed_at,
      output_sha256: outputSha256,
      tool_profile_sha256: toolProfileSha256,
    }),
    tool_profile_sha256: toolProfileSha256,
    started_at: session.started_at,
    completed_at: session.completed_at,
    output_sha256: outputSha256,
  };
}

/** Builds public adjudication evidence from private assignment and Judge sources. */
export function buildBlindedAdjudication({
  fixture,
  assignment,
  sessions,
  judgeOutput,
  measurement,
  unblindedAt,
}) {
  validateDocument("blinded-measurement", measurement);
  validateJudgeOutput(judgeOutput, fixture);
  const seed = Buffer.from(assignment.seed_base64 ?? "", "base64");
  if (
    seed.length < 16 ||
    seed.toString("base64") !== assignment.seed_base64 ||
    rawSeedFingerprint(seed) !== assignment.seed_commitment_sha256
  ) {
    throw new Error("A/B assignment seed commitment 不一致");
  }
  const expectedBaselineLabel = seed[0] % 2 === 0 ? "a" : "b";
  const expectedCandidateLabel =
    expectedBaselineLabel === "a" ? "b" : "a";
  const sessionNonces = [
    sessions.label_a?.session_nonce,
    sessions.label_b?.session_nonce,
    sessions.judge?.session_nonce,
  ];
  if (
    assignment.baseline_label !== expectedBaselineLabel ||
    assignment.candidate_label !== expectedCandidateLabel ||
    assignment.model_id !== sessions.model_id ||
    measurement.fixture !== fixture.id ||
    sessionNonces.some(
      (nonce) => typeof nonce !== "string" || nonce.trim().length === 0,
    ) ||
    new Set(sessionNonces).size !== 3
  ) {
    throw new Error("A/B assignment 映射或 session identity 不一致");
  }
  const toolProfileSha256 = fingerprint(fixture.tool_profile);
  const behaviorEvidence = judgeOutput.behaviors.map((behavior) => ({
    id: behavior.id,
    label_a: {
      verdict: behavior.label_a.verdict,
      rationale_summary: behavior.label_a.rationale_summary,
      evidence_sha256: fingerprint({
        id: behavior.id,
        label: "a",
        evidence_summary: behavior.label_a.evidence_summary,
      }),
    },
    label_b: {
      verdict: behavior.label_b.verdict,
      rationale_summary: behavior.label_b.rationale_summary,
      evidence_sha256: fingerprint({
        id: behavior.id,
        label: "b",
        evidence_summary: behavior.label_b.evidence_summary,
      }),
    },
  }));
  const judgeOutputSha256 = fingerprint(judgeOutput);
  const document = {
    schema_version: 1,
    evidence_kind: "blinded-adjudication",
    fixture: fixture.id,
    rubric_sha256: rubricFingerprint(fixture),
    assignment: {
      method: "randomized-a-b",
      committed_at: assignment.committed_at,
      seed_commitment_sha256: assignment.seed_commitment_sha256,
      baseline_label: assignment.baseline_label,
      candidate_label: assignment.candidate_label,
    },
    sessions: {
      label_a: generatorSession({
        role: "label_a",
        modelId: sessions.model_id,
        session: sessions.label_a,
        outputSha256: measurement.labels.a.output_sha256,
        toolProfileSha256,
      }),
      label_b: generatorSession({
        role: "label_b",
        modelId: sessions.model_id,
        session: sessions.label_b,
        outputSha256: measurement.labels.b.output_sha256,
        toolProfileSha256,
      }),
      judge: {
        model_id: sessions.model_id,
        session_sha256: fingerprint({
          role: "judge",
          session_nonce: sessions.judge.session_nonce,
          model_id: sessions.model_id,
          started_at: sessions.judge.started_at,
          completed_at: sessions.judge.completed_at,
          output_sha256: judgeOutputSha256,
        }),
        started_at: sessions.judge.started_at,
        completed_at: sessions.judge.completed_at,
        output_sha256: judgeOutputSha256,
      },
    },
    judging: {
      started_at: sessions.judge.started_at,
      completed_at: sessions.judge.completed_at,
      unblinded_at: unblindedAt,
      expected_findings_hidden: true,
      labels_hidden_from_judge: true,
    },
    behaviors: behaviorEvidence,
    quality: {
      false_positive_optimizations:
        judgeOutput.quality.false_positive_optimizations,
      rationale_summary: judgeOutput.quality.rationale_summary,
      evidence_sha256: fingerprint({
        kind: "quality",
        evidence_summary: judgeOutput.quality.evidence_summary,
      }),
    },
    derivation: {
      builder: "agent-skill-maintainer/blinded-adjudication-v1",
      assignment_rule: "seed-first-byte-parity",
      evidence_hash_rule: "canonical-json-redacted-evidence-summary",
      session_hash_rule: "canonical-json-private-session-metadata",
    },
    raw_outputs_published: false,
    synthetic_fixture: true,
  };
  validateBlindedAdjudication(document, fixture);
  validateBlindedMeasurement(measurement, document, fixture);
  return document;
}

function rawSeedFingerprint(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

/** Validates adjudication identity, timing, blinding and per-behavior evidence. */
export function validateBlindedAdjudication(adjudication, fixture) {
  validateDocument("blinded-adjudication", adjudication);
  if (
    adjudication.fixture !== fixture.id ||
    adjudication.rubric_sha256 !== rubricFingerprint(fixture) ||
    adjudication.raw_outputs_published !== false ||
    adjudication.synthetic_fixture !== true ||
    adjudication.derivation.builder !==
      "agent-skill-maintainer/blinded-adjudication-v1" ||
    adjudication.derivation.assignment_rule !==
      "seed-first-byte-parity" ||
    adjudication.derivation.evidence_hash_rule !==
      "canonical-json-redacted-evidence-summary" ||
    adjudication.derivation.session_hash_rule !==
      "canonical-json-private-session-metadata"
  ) {
    throw new Error("blinded adjudication 與 locked fixture 不一致");
  }
  const assignment = adjudication.assignment;
  if (
    assignment.baseline_label === assignment.candidate_label ||
    JSON.stringify(
      [assignment.baseline_label, assignment.candidate_label].sort(),
    ) !== JSON.stringify(LABELS)
  ) {
    throw new Error("A/B assignment 必須是一對一隨機映射");
  }
  const labelA = adjudication.sessions.label_a;
  const labelB = adjudication.sessions.label_b;
  const judge = adjudication.sessions.judge;
  const sessionIds = [
    labelA.session_sha256,
    labelB.session_sha256,
    judge.session_sha256,
  ];
  if (
    new Set(sessionIds).size !== 3 ||
    !sessionIds.every((value) => SHA256_PATTERN.test(value ?? "")) ||
    labelA.model_id !== labelB.model_id ||
    labelA.tool_profile_sha256 !== labelB.tool_profile_sha256
  ) {
    throw new Error("A/B 與 Judge session 必須隔離且生成条件一致");
  }
  for (const [name, session] of [
    ["label_a", labelA],
    ["label_b", labelB],
  ]) {
    if (
      !SHA256_PATTERN.test(session.output_sha256 ?? "") ||
      parseTime(session.started_at, `${name}.started_at`) >
        parseTime(session.completed_at, `${name}.completed_at`)
    ) {
      throw new Error(`${name} session 證據不合法`);
    }
  }
  const lockedAt = parseTime(fixture.locked_at, "fixture.locked_at");
  const assignedAt = parseTime(
    assignment.committed_at,
    "assignment.committed_at",
  );
  const firstOutputStart = Math.min(
    parseTime(labelA.started_at, "label_a.started_at"),
    parseTime(labelB.started_at, "label_b.started_at"),
  );
  const outputsCompleted = Math.max(
    parseTime(labelA.completed_at, "label_a.completed_at"),
    parseTime(labelB.completed_at, "label_b.completed_at"),
  );
  const judgeStarted = parseTime(
    adjudication.judging.started_at,
    "judging.started_at",
  );
  const judgeCompleted = parseTime(
    adjudication.judging.completed_at,
    "judging.completed_at",
  );
  const unblinded = parseTime(
    adjudication.judging.unblinded_at,
    "judging.unblinded_at",
  );
  if (
    lockedAt > assignedAt ||
    assignedAt > firstOutputStart ||
    outputsCompleted > judgeStarted ||
    judgeStarted > judgeCompleted ||
    judgeCompleted > unblinded ||
    judge.started_at !== adjudication.judging.started_at ||
    judge.completed_at !== adjudication.judging.completed_at ||
    !SHA256_PATTERN.test(judge.output_sha256 ?? "") ||
    adjudication.judging.expected_findings_hidden !== true ||
    adjudication.judging.labels_hidden_from_judge !== true
  ) {
    throw new Error("blinded adjudication 時序或隱藏條件不成立");
  }
  const behaviors = adjudication.behaviors;
  const ids = behaviors.map((behavior) => behavior.id).sort();
  if (
    new Set(ids).size !== ids.length ||
    canonicalJson(ids) !== canonicalJson(expectedBehaviorIds(fixture))
  ) {
    throw new Error("adjudication behavior 與 locked rubric 不一致");
  }
  for (const behavior of behaviors) {
    validateVerdict(behavior.label_a, `${behavior.id}.label_a`);
    validateVerdict(behavior.label_b, `${behavior.id}.label_b`);
  }
  if (
    !Number.isInteger(
      adjudication.quality.false_positive_optimizations,
    ) ||
    adjudication.quality.false_positive_optimizations < 0 ||
    typeof adjudication.quality.rationale_summary !== "string" ||
    adjudication.quality.rationale_summary.trim().length === 0 ||
    !SHA256_PATTERN.test(adjudication.quality.evidence_sha256 ?? "")
  ) {
    throw new Error("adjudication quality 證據不完整");
  }
  return clone(adjudication);
}

function measureLabel({ output, events }) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("measurement output 必須是非空字串");
  }
  if (!Array.isArray(events)) {
    throw new Error("measurement events 必須是 array");
  }
  return {
    output_sha256: sha256Text(output),
    events_sha256: fingerprint(events),
    artifact_bytes: Buffer.byteLength(output, "utf8"),
    tool_calls: events.filter((event) => event?.type === "tool_call").length,
    heading_count: [...output.matchAll(/^#{1,6}\s+\S/gmu)].length,
  };
}

/** Recomputes objective cost measurements from local A/B outputs and events. */
export function buildBlindedMeasurement({
  fixture,
  labelA,
  labelB,
  measuredAt = new Date().toISOString(),
}) {
  const document = {
    schema_version: 1,
    evidence_kind: "blinded-measurement",
    fixture: fixture.id,
    measured_at: measuredAt,
    labels: {
      a: measureLabel(labelA),
      b: measureLabel(labelB),
    },
    derivation: {
      builder: "agent-skill-maintainer/blinded-measurement-v1",
      encoding: "utf8",
      tool_event_type: "tool_call",
      heading_rule: "markdown-atx",
    },
    raw_inputs_published: false,
    synthetic_fixture: true,
  };
  validateDocument("blinded-measurement", document);
  return document;
}

/** Recomputes and compares a measurement against the private local sources. */
export function verifyBlindedMeasurementSources(
  measurement,
  {
    fixture,
    labelA,
    labelB,
  },
) {
  const recomputed = buildBlindedMeasurement({
    fixture,
    labelA,
    labelB,
    measuredAt: measurement.measured_at,
  });
  if (canonicalJson(recomputed) !== canonicalJson(measurement)) {
    throw new Error("blinded measurement 未由目前本機 sources 重算");
  }
  return true;
}

/** Validates a measurement and binds it to the adjudicated output identities. */
export function validateBlindedMeasurement(
  measurement,
  adjudication,
  fixture,
) {
  validateDocument("blinded-measurement", measurement);
  if (
    measurement.fixture !== fixture.id ||
    measurement.raw_inputs_published !== false ||
    measurement.synthetic_fixture !== true ||
    measurement.labels.a.output_sha256 !==
      adjudication.sessions.label_a.output_sha256 ||
    measurement.labels.b.output_sha256 !==
      adjudication.sessions.label_b.output_sha256
  ) {
    throw new Error("blinded measurement 與 adjudication outputs 不一致");
  }
  for (const label of LABELS) {
    const item = measurement.labels[label];
    if (
      !SHA256_PATTERN.test(item.output_sha256 ?? "") ||
      !SHA256_PATTERN.test(item.events_sha256 ?? "") ||
      !Number.isInteger(item.artifact_bytes) ||
      item.artifact_bytes <= 0 ||
      !Number.isInteger(item.tool_calls) ||
      item.tool_calls < 0 ||
      !Number.isInteger(item.heading_count) ||
      item.heading_count < 0
    ) {
      throw new Error(`measurement label_${label} 不合法`);
    }
  }
  parseTime(measurement.measured_at, "measurement.measured_at");
  return clone(measurement);
}

function mappedLabel(document, label) {
  return label === "a" ? document.label_a : document.label_b;
}

function recomputePlatformValidation(platformValidation) {
  const copy = clone(platformValidation);
  const platforms = copy.platforms ?? [];
  copy.passed =
    copy.installer?.scope === "isolated-project-copy" &&
    canonicalJson(platforms.map((platform) => platform.id).sort()) ===
      canonicalJson(["claude-code", "codex"]) &&
    platforms.every(
      (platform) =>
        typeof platform.version === "string" &&
        platform.version.length > 0 &&
        platform.explicit_trigger === true &&
        platform.target_and_reference_read === true &&
        platform.positive_analysis === true &&
        platform.negative_non_trigger === true &&
        platform.stable_ids === true &&
        platform.decision_boundary === true &&
        platform.files_modified === false &&
        platform.passed === true,
    );
  return copy;
}

/** Derives the complete publishable aggregate from adjudication and measurement. */
export function deriveBlindedForwardAggregate({
  adjudication,
  measurement,
  fixture,
  currentSkillFingerprint,
  evaluatedAt,
  platformValidation,
  limits,
}) {
  const judged = validateBlindedAdjudication(adjudication, fixture);
  const measured = validateBlindedMeasurement(
    measurement,
    judged,
    fixture,
  );
  if (!SHA256_PATTERN.test(currentSkillFingerprint ?? "")) {
    throw new Error("candidate Skill fingerprint 不合法");
  }
  parseTime(evaluatedAt, "evaluated_at");
  if (
    !Array.isArray(limits) ||
    limits.length === 0 ||
    limits.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("aggregate limits 必須明確記錄");
  }
  const baselineLabel = judged.assignment.baseline_label;
  const candidateLabel = judged.assignment.candidate_label;
  const behaviorResults = judged.behaviors.map((behavior) => {
    const baseline = mappedLabel(behavior, baselineLabel);
    const candidate = mappedLabel(behavior, candidateLabel);
    return {
      id: behavior.id,
      baseline_verdict: baseline.verdict,
      candidate_verdict: candidate.verdict,
      baseline_evidence_sha256: baseline.evidence_sha256,
      candidate_evidence_sha256: candidate.evidence_sha256,
    };
  });
  const baselinePassed = behaviorResults.filter(
    (behavior) => behavior.baseline_verdict === "pass",
  ).length;
  const candidatePassed = behaviorResults.filter(
    (behavior) => behavior.candidate_verdict === "pass",
  ).length;
  const candidateRegressions = behaviorResults.filter(
    (behavior) =>
      behavior.baseline_verdict === "pass" &&
      behavior.candidate_verdict !== "pass",
  ).length;
  const baselineCost = measured.labels[baselineLabel];
  const candidateCost = measured.labels[candidateLabel];
  const byteRatio =
    candidateCost.artifact_bytes / baselineCost.artifact_bytes;
  const costPassed =
    byteRatio <=
      fixture.cost_thresholds
        .candidate_artifact_bytes_max_ratio_to_baseline &&
    candidateCost.tool_calls <=
      fixture.cost_thresholds.candidate_tool_calls_max &&
    candidateCost.heading_count <=
      fixture.quality_thresholds.max_candidate_heading_count;
  const forwardPassed =
    behaviorResults.every(
      (behavior) => behavior.candidate_verdict === "pass",
    ) &&
    candidateRegressions ===
      fixture.quality_thresholds.candidate_regressions &&
    candidatePassed - baselinePassed >=
      fixture.quality_thresholds.candidate_minimum_gain_over_baseline &&
    judged.quality.false_positive_optimizations ===
      fixture.quality_thresholds.false_positive_optimizations;
  const platforms = recomputePlatformValidation(platformValidation);
  const aggregate = {
    schema_version: 3,
    evidence_kind: "blinded-forward-aggregate",
    evaluated_at: evaluatedAt,
    fixture: fixture.id,
    candidate_skill_fingerprint: currentSkillFingerprint,
    raw_outputs_published: false,
    evidence_sources: {
      adjudication_sha256: fingerprint(judged),
      measurement_sha256: fingerprint(measured),
    },
    protocol: {
      fixture_status: "held-out",
      held_out_from_iteration: true,
      rubric_locked_before_outputs: true,
      randomized_assignment: true,
      independent_judge: true,
      verdicts_recorded_before_unblind: true,
      same_model_and_tools:
        judged.sessions.label_a.model_id ===
          judged.sessions.label_b.model_id &&
        judged.sessions.label_a.tool_profile_sha256 ===
          judged.sessions.label_b.tool_profile_sha256,
      model_id: judged.sessions.label_a.model_id,
      judge_model_id: judged.sessions.judge.model_id,
      locked_at: fixture.locked_at,
      assignment_committed_at: judged.assignment.committed_at,
      baseline_started_at:
        judged.sessions[
          baselineLabel === "a" ? "label_a" : "label_b"
        ].started_at,
      candidate_started_at:
        judged.sessions[
          candidateLabel === "a" ? "label_a" : "label_b"
        ].started_at,
      judging_completed_at: judged.judging.completed_at,
      unblinded_at: judged.judging.unblinded_at,
      prompt_sha256: sha256Text(fixture.prompt),
      artifacts_sha256: fingerprint({
        target_files: fixture.target_files,
        usage_evidence: fixture.usage_evidence,
      }),
      rubric_sha256: rubricFingerprint(fixture),
      tool_profile_sha256:
        judged.sessions.label_a.tool_profile_sha256,
      baseline_session_sha256:
        judged.sessions[
          baselineLabel === "a" ? "label_a" : "label_b"
        ].session_sha256,
      candidate_session_sha256:
        judged.sessions[
          candidateLabel === "a" ? "label_a" : "label_b"
        ].session_sha256,
      judge_session_sha256: judged.sessions.judge.session_sha256,
    },
    forward_evaluation: {
      expected_findings_hidden:
        judged.judging.expected_findings_hidden,
      required_behaviors: behaviorResults,
      baseline_passed_behaviors: baselinePassed,
      candidate_passed_behaviors: candidatePassed,
      candidate_regressions: candidateRegressions,
      false_positive_optimizations:
        judged.quality.false_positive_optimizations,
      passed: forwardPassed,
    },
    cost: {
      baseline_artifact_bytes: baselineCost.artifact_bytes,
      candidate_artifact_bytes: candidateCost.artifact_bytes,
      artifact_byte_ratio: byteRatio,
      baseline_tool_calls: baselineCost.tool_calls,
      candidate_tool_calls: candidateCost.tool_calls,
      candidate_heading_count: candidateCost.heading_count,
      passed: costPassed,
    },
    platform_validation: platforms,
    limits: clone(limits),
  };
  validateDocument("blinded-forward-aggregate", aggregate);
  return aggregate;
}

/** Identifies old aggregate records without treating them as a current gate. */
export function inspectBlindedForwardAggregate(document) {
  if (!isObject(document) || !Number.isInteger(document.schema_version)) {
    throw new Error("blinded aggregate 格式不合法");
  }
  if (document.schema_version === 2) {
    return {
      schema_version: 2,
      historical: true,
      publishable: false,
      reason: "legacy_boolean_summary",
    };
  }
  validateDocument("blinded-forward-aggregate", document);
  return {
    schema_version: document.schema_version,
    historical: false,
    publishable: true,
    reason: null,
  };
}
