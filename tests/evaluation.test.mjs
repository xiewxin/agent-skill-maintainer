import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBlindedAdjudication,
  buildBlindedMeasurement,
  buildGeneratorEvaluationInputView,
  buildJudgeEvaluationInputBundle,
  buildJudgeEvaluationInputView,
  buildOpaqueJudgeLabelOutput,
  deriveBlindedForwardAggregate,
  evaluationInputFingerprint,
  inspectBlindedForwardAggregate,
  observeRuntimeCliSmoke,
  validateBlindedAdjudication,
  validateBlindedMeasurement,
  validateForwardEvaluationAggregate,
  verifyBlindedMeasurementSources,
} from "../evals/run-evals.mjs";
import {
  countTreeFiles,
  fingerprintTree,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  canonicalJson,
  fingerprint,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  claudeTranscript,
  codexTranscript,
  evaluationTranscriptTools,
  TEST_PLATFORM_INSTALL_PATHS,
  TEST_PLATFORM_EXECUTION_PROFILES,
  TEST_REQUIRED_PLATFORM_READ_PATHS,
  testPlatformPromptTemplate,
} from "./fixtures.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const fixture = {
  ...JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        "evals",
        "cases",
        "evaluation-binding-heldout.json",
      ),
      "utf8",
    ),
  ),
  locked_at: "2026-07-29T02:30:00.000Z",
};
const skillRoot = resolve(ROOT, "skills", "agent-skill-maintainer");
const evaluatorKeys = generateKeyPairSync("ed25519");
const neutralControllerPath = resolve(
  ROOT,
  "scripts",
  "neutral-evaluation-controller.mjs",
);
fixture.evaluator_authority = {
  authority_id: "agent-skill-maintainer-neutral-evaluator",
  version: "1",
  controller_sha256: createHash("sha256")
    .update(readFileSync(neutralControllerPath))
    .digest("hex"),
  public_key_pem: evaluatorKeys.publicKey.export({
    type: "spki",
    format: "pem",
  }),
};
const testRuntimeRoot = mkdtempSync(
  join(tmpdir(), "maintainer-evaluation-runtime-"),
);
const baselineArchive = spawnSync(
  "git",
  [
    "-C",
    ROOT,
    "archive",
    "--format=tar",
    "HEAD",
    "skills/agent-skill-maintainer",
  ],
  { encoding: null },
);
if (baselineArchive.status !== 0) {
  throw new Error(baselineArchive.stderr.toString("utf8"));
}
const baselineExtract = spawnSync(
  "tar",
  ["-xf", "-", "-C", testRuntimeRoot],
  { input: baselineArchive.stdout, encoding: null },
);
if (baselineExtract.status !== 0) {
  throw new Error(baselineExtract.stderr.toString("utf8"));
}
const baselineSkillRoot = join(
  testRuntimeRoot,
  "skills",
  "agent-skill-maintainer",
);
const outputPaths = Object.fromEntries(
  ["codex-positive", "codex-negative", "claude-positive", "claude-negative"]
    .map((name) => {
      const path = join(testRuntimeRoot, `${name}.json`);
      return [name, path];
    }),
);
process.once("exit", () => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
});
const addedBehaviors = [
  "binds-evaluation-sessions-to-input-commitment",
  "binds-platform-validation-sessions",
  "binds-target-skill-name-and-path",
  "bounds-measurement-before-judging",
  "includes-mode-and-node-modules-in-tree-identity",
  "keeps-evaluation-input-views-label-neutral",
  "terminal-transition-cannot-cross-inflight-github-apply",
];
fixture.id = "agent-skill-maintainer-eval-binding-heldout-v34";
for (const id of addedBehaviors) {
  if (!fixture.required_behaviors.includes(id)) {
    fixture.required_behaviors.push(id);
    fixture.locked_rubric[id] = {
      pass: `${id} pass.`,
      fail: `${id} fail.`,
      insufficient_evidence: `${id} insufficient.`,
    };
    fixture.behavior_contracts[id] = [
      `${id}-clause`,
    ];
  }
}
fixture.required_behaviors.sort();
fixture.usage_evidence.current_run.candidate_skill_fingerprint =
  fingerprintTree(skillRoot);
fixture.runtime_bundle.candidate_tree_fingerprint =
  fingerprintTree(skillRoot);
fixture.runtime_bundle.candidate_file_count = countTreeFiles(skillRoot);
fixture.runtime_bundle.baseline_tree_fingerprint =
  fingerprintTree(baselineSkillRoot);
fixture.runtime_bundle.baseline_file_count =
  countTreeFiles(baselineSkillRoot);
for (const path of fixture.target_files.paths) {
  fixture.target_files.candidate_sha256[path] = createHash("sha256")
    .update(readFileSync(resolve(skillRoot, path)))
    .digest("hex");
}
fixture.aggregate_template = {
  platform_requirements: {
    installer: "skills",
    scope: "isolated-project-copy",
    platforms: ["codex", "claude-code"],
  },
  limits: [
    "Synthetic fixtures verify the evidence contract, not semantic truth.",
    "Raw outputs remain local and are represented by SHA-256 identities.",
  ],
};
const platformChallengePayload = {
  schema_version: 1,
  authority_id: fixture.evaluator_authority.authority_id,
  authority_version: fixture.evaluator_authority.version,
  controller_sha256:
    fixture.evaluator_authority.controller_sha256,
  candidate_skill_fingerprint: fingerprintTree(skillRoot),
  evaluation_input_sha256:
    evaluationInputFingerprint(fixture),
  issued_at: "2026-07-29T02:34:10.000Z",
  expires_at: "2026-07-29T03:34:10.000Z",
  challenges: ["codex", "claude-code"].flatMap(
    (platform) =>
      ["positive", "negative"].map((caseId) => ({
        platform,
        case: caseId,
        platform_version: "test-version",
        executable_sha256: "e".repeat(64),
        execution_profile_sha256: fingerprint(
          TEST_PLATFORM_EXECUTION_PROFILES[platform],
        ),
        environment_sha256: "a".repeat(64),
        prompt_template_sha256: createHash("sha256")
          .update(testPlatformPromptTemplate(platform, caseId))
          .digest("hex"),
        installation_relative_path:
          TEST_PLATFORM_INSTALL_PATHS[platform],
        challenge_nonce:
          `${platform}-${caseId}-challenge`,
      })),
  ),
};
const platformChallengeAttestation = {
  ...platformChallengePayload,
  payload_sha256: fingerprint(platformChallengePayload),
  signature_base64: sign(
    null,
    Buffer.from(
      canonicalJson(platformChallengePayload),
      "utf8",
    ),
    evaluatorKeys.privateKey,
  ).toString("base64"),
};
const makePlatformOutput = (id, caseId, caseIndex) => {
  const positive = caseId === "positive";
  const path = outputPaths[
    `${id === "claude-code" ? "claude" : id}-${caseId}`
  ];
  const transcriptPath = `${path}.jsonl`;
  const providerSessionNonce =
    `${id}-${caseId}-provider-session`;
  const requestedProjectRoot = join(
    testRuntimeRoot,
    `${id}-${caseId}-project`,
  );
  const installationRelativePath =
    TEST_PLATFORM_INSTALL_PATHS[id];
  const installedSkillRoot = join(
    requestedProjectRoot,
    installationRelativePath,
  );
  mkdirSync(join(installedSkillRoot, ".."), {
    recursive: true,
  });
  cpSync(skillRoot, installedSkillRoot, { recursive: true });
  const projectRoot = realpathSync(requestedProjectRoot);
  const installedIdentity = {
    tree_fingerprint: fingerprintTree(installedSkillRoot),
    file_count: countTreeFiles(installedSkillRoot),
  };
  const document = {
    schema_version: 1,
    case: caseId,
    evaluation_input_sha256:
      evaluationInputFingerprint(fixture),
    candidate_skill_fingerprint:
      fingerprintTree(skillRoot),
    platform: id,
    platform_version: "test-version",
    challenge_nonce: `${id}-${caseId}-challenge`,
    started_at:
      `2026-07-29T02:34:${11 + caseIndex * 2}.000Z`,
    installed_copy: {
      ...installedIdentity,
    },
    result: {
      triggered_skill: positive,
      target_and_reference_read: positive,
      analysis_correct: true,
      stable_ids: positive,
      decision_boundary: positive,
      files_modified: false,
      evidence: [`${id} ${caseId} fixture`],
    },
  };
  const output = JSON.stringify(document);
  const requiredReadPaths = TEST_REQUIRED_PLATFORM_READ_PATHS.map(
    (readPath) => `${installationRelativePath}/${readPath}`,
  );
  const requiredReads = requiredReadPaths.map((readPath) => ({
    path: readPath,
    sha256: createHash("sha256")
      .update(readFileSync(join(projectRoot, readPath)))
      .digest("hex"),
  }));
  const codexTools = positive
    ? requiredReadPaths.map((readPath) => ({
        command:
          `/bin/zsh -lc "/bin/cat -- '${readPath}'"`,
        aggregated_output: readFileSync(
          join(projectRoot, readPath),
          "utf8",
        ),
      }))
    : [];
  const transcript = id === "codex"
    ? codexTranscript(
        providerSessionNonce,
        output,
        codexTools,
      )
    : claudeTranscript(
        providerSessionNonce,
        output,
        projectRoot,
        { readPaths: positive ? requiredReadPaths : [] },
      );
  const toolSequence = id === "codex"
    ? codexTools.map((tool, toolIndex) => ({
        id: `tool_${toolIndex}`,
        type: "command_execution",
        command: tool.command,
      }))
    : [
        ...(positive
          ? requiredReadPaths.map((readPath, readIndex) => ({
              id: `claude-read-${readIndex}`,
              name: "Read",
              input: {
                file_path: join(projectRoot, readPath),
              },
            }))
          : []),
        {
          id: "claude-structured",
          name: "StructuredOutput",
          input: document,
        },
      ];
  writeFileSync(path, output, "utf8");
  writeFileSync(transcriptPath, transcript, "utf8");
  return {
    path,
    transcriptPath,
    completion: {
      platform: id,
      case: caseId,
      platform_version: "test-version",
      executable_sha256: "e".repeat(64),
      execution_profile_sha256: fingerprint(
        TEST_PLATFORM_EXECUTION_PROFILES[id],
      ),
      environment_sha256: "a".repeat(64),
      prompt_template_sha256:
        platformChallengePayload.challenges.find(
          (challenge) =>
            challenge.platform === id &&
            challenge.case === caseId,
        ).prompt_template_sha256,
      prompt_sha256: "c".repeat(64),
      workspace_root: projectRoot,
      installation_relative_path: installationRelativePath,
      source_copy_before: installedIdentity,
      source_copy_after: installedIdentity,
      installed_copy_before: installedIdentity,
      installed_copy_after: installedIdentity,
      required_reads: requiredReads,
      challenge_nonce: `${id}-${caseId}-challenge`,
      started_at: document.started_at,
      completed_at:
        `2026-07-29T02:34:${12 + caseIndex * 2}.000Z`,
      exit_status: 0,
      output_sha256: createHash("sha256")
        .update(output)
        .digest("hex"),
      transcript_sha256: createHash("sha256")
        .update(transcript)
        .digest("hex"),
      provider_session_nonce: providerSessionNonce,
      tool_calls: toolSequence.length,
      tool_sequence_sha256: fingerprint(toolSequence),
    },
  };
};
const passingPlatformRows = ["codex", "claude-code"].map(
  (id, platformIndex) => ({
    id,
    positive: makePlatformOutput(
      id,
      "positive",
      platformIndex * 2,
    ),
    negative: makePlatformOutput(
      id,
      "negative",
      platformIndex * 2 + 1,
    ),
  }),
);
const platformCompletionPayload = {
  schema_version: 1,
  authority_id: fixture.evaluator_authority.authority_id,
  authority_version: fixture.evaluator_authority.version,
  controller_sha256:
    fixture.evaluator_authority.controller_sha256,
  candidate_skill_fingerprint: fingerprintTree(skillRoot),
  evaluation_input_sha256:
    evaluationInputFingerprint(fixture),
  challenge_payload_sha256:
    platformChallengeAttestation.payload_sha256,
  attested_at: "2026-07-29T02:34:20.000Z",
  sessions: passingPlatformRows.flatMap(
    ({ positive, negative }) => [
      positive.completion,
      negative.completion,
    ],
  ),
};
const platformCompletionAttestation = {
  ...platformCompletionPayload,
  payload_sha256: fingerprint(platformCompletionPayload),
  signature_base64: sign(
    null,
    Buffer.from(
      canonicalJson(platformCompletionPayload),
      "utf8",
    ),
    evaluatorKeys.privateKey,
  ).toString("base64"),
};
const passingPlatformValidationSource = {
  schema_version: 1,
  candidate_skill_fingerprint: fingerprintTree(skillRoot),
  challenge_attestation: platformChallengeAttestation,
  completion_attestation: platformCompletionAttestation,
  installer: {
    name: "skills",
    version: "test-version",
    scope: "isolated-project-copy",
  },
  installed_copies: passingPlatformRows.flatMap(
    ({ id, positive, negative }) =>
      [positive, negative].map(({ completion }) => ({
        platform: id,
        case: completion.case,
        path: join(
          completion.workspace_root,
          completion.installation_relative_path,
        ),
        installation_relative_path:
          completion.installation_relative_path,
        tree_fingerprint:
          completion.installed_copy_after.tree_fingerprint,
        file_count:
          completion.installed_copy_after.file_count,
      })),
  ),
  platforms: passingPlatformRows.map(
    ({ id, positive, negative }) => ({
      id,
      version: "test-version",
      positive_output_path: positive.path,
      positive_output_sha256: createHash("sha256")
        .update(readFileSync(positive.path))
        .digest("hex"),
      positive_transcript_path: positive.transcriptPath,
      positive_transcript_sha256: createHash("sha256")
        .update(readFileSync(positive.transcriptPath))
        .digest("hex"),
      negative_output_path: negative.path,
      negative_output_sha256: createHash("sha256")
        .update(readFileSync(negative.path))
        .digest("hex"),
      negative_transcript_path: negative.transcriptPath,
      negative_transcript_sha256: createHash("sha256")
        .update(readFileSync(negative.transcriptPath))
        .digest("hex"),
    }),
  ),
  environment_baseline_failures: [],
};

/** Re-signs one intentionally mutated synthetic completion attestation. */
function resignPlatformCompletion(source) {
  const attestation = source.completion_attestation;
  const payload = {
    schema_version: attestation.schema_version,
    authority_id: attestation.authority_id,
    authority_version: attestation.authority_version,
    controller_sha256: attestation.controller_sha256,
    candidate_skill_fingerprint:
      attestation.candidate_skill_fingerprint,
    evaluation_input_sha256:
      attestation.evaluation_input_sha256,
    challenge_payload_sha256:
      attestation.challenge_payload_sha256,
    attested_at: attestation.attested_at,
    sessions: attestation.sessions,
  };
  attestation.payload_sha256 = fingerprint(payload);
  attestation.signature_base64 = sign(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    evaluatorKeys.privateKey,
  ).toString("base64");
}
const legacyAggregate = { schema_version: 2 };

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evaluationBundle() {
  const baselineFailures = new Set([
    "binds-publication-to-head-commit-tree",
    "binds-evaluation-sessions-to-input-commitment",
    "binds-platform-validation-sessions",
    "binds-target-skill-name-and-path",
    "exposes-runtime-eval-bind-contract",
    "blocks-rederived-forged-target-hash",
    "requires-exact-source-rederivation",
    "revalidates-final-skill-before-push-transition",
    "keeps-binding-analysis-read-only",
    "includes-mode-and-node-modules-in-tree-identity",
    "keeps-evaluation-input-views-label-neutral",
    "bounds-measurement-before-judging",
    "requires-pr-ready-exact-binding",
    "scans-tracked-node-modules-for-disclosure",
    "terminal-transition-cannot-cross-inflight-github-apply",
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
      clause_evidence: Object.fromEntries(
        fixture.behavior_contracts[id].map((clause) => [
          clause,
          `${condition} evidence for ${id}.${clause}.`,
        ]),
      ),
    };
  };
  const evaluationInputSha256 = evaluationInputFingerprint(fixture);
  const candidateSmoke = observeRuntimeCliSmoke(skillRoot);
  const baselineSmoke = observeRuntimeCliSmoke(baselineSkillRoot);
  const runtimeBundles = {
    candidate: {
      tree_fingerprint: fingerprintTree(skillRoot),
      file_count: countTreeFiles(skillRoot),
      cli_smoke_sha256: fingerprint(candidateSmoke),
    },
    baseline: {
      tree_fingerprint: fingerprintTree(baselineSkillRoot),
      file_count: countTreeFiles(baselineSkillRoot),
      cli_smoke_sha256: fingerprint(baselineSmoke),
    },
  };
  const seed = Buffer.alloc(32);
  seed[0] = 1;
  const assignment = {
    seed_base64: seed.toString("base64"),
    seed_commitment_sha256:
      createHash("sha256").update(seed).digest("hex"),
    evaluation_input_sha256: evaluationInputFingerprint(fixture),
    baseline_label: "b",
    candidate_label: "a",
    model_id: "same-model",
    committed_at: "2026-07-29T02:31:12.000Z",
  };
  const generatorInputViewSha256 = {
    a: fingerprint(
      buildGeneratorEvaluationInputView(
        fixture,
        assignment,
        "a",
        runtimeBundles.candidate,
      ),
    ),
    b: fingerprint(
      buildGeneratorEvaluationInputView(
        fixture,
        assignment,
        "b",
        runtimeBundles.baseline,
      ),
    ),
  };
  const generatorOutput = (condition, label) => JSON.stringify({
    evaluation_input_sha256: evaluationInputSha256,
    input_view_sha256: generatorInputViewSha256[label],
    runtime_bundle: runtimeBundles[condition],
    behaviors: fixture.required_behaviors.map((id) => ({
      id,
      ...verdict(id, condition),
    })),
    quality: {
      false_positive_optimizations: 0,
      rationale_summary: `${condition} has no false positives.`,
      evidence_summary: `${condition} evidence matches the rubric.`,
    },
  });
  const labelA = {
    output: generatorOutput("candidate", "a"),
    events: codexTranscript(
      "candidate-session",
      generatorOutput("candidate", "a"),
      evaluationTranscriptTools(),
    ),
  };
  const labelB = {
    output: generatorOutput("baseline", "b"),
    events: codexTranscript(
      "baseline-session",
      generatorOutput("baseline", "b"),
      evaluationTranscriptTools(),
    ),
  };
  const measurement = buildBlindedMeasurement({
    fixture,
    labelA,
    labelB,
    measuredAt: "2026-07-29T02:33:15.000Z",
  });
  const judgeInputViewSha256 = fingerprint(
    buildJudgeEvaluationInputView(fixture, {
      labelInputViewSha256: generatorInputViewSha256,
      opaqueLabelOutputSha256: {
        a: fingerprint(
          buildOpaqueJudgeLabelOutput(labelA.output),
        ),
        b: fingerprint(
          buildOpaqueJudgeLabelOutput(labelB.output),
        ),
      },
      runtimeBundles: {
        a: runtimeBundles.candidate,
        b: runtimeBundles.baseline,
      },
    }),
  );
  const judgeOutput = {
    evaluation_input_sha256: evaluationInputSha256,
    input_view_sha256: judgeInputViewSha256,
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
  const judgeRawOutput = JSON.stringify(judgeOutput);
  const judgeInputView = buildJudgeEvaluationInputView(fixture, {
    labelInputViewSha256: generatorInputViewSha256,
    opaqueLabelOutputSha256: {
      a: fingerprint(buildOpaqueJudgeLabelOutput(labelA.output)),
      b: fingerprint(buildOpaqueJudgeLabelOutput(labelB.output)),
    },
    runtimeBundles: {
      a: runtimeBundles.candidate,
      b: runtimeBundles.baseline,
    },
  });
  const judgeInputBundle = buildJudgeEvaluationInputBundle(
    judgeInputView,
    {
      a: labelA.output,
      b: labelB.output,
    },
  );
  const judgeTranscript = codexTranscript(
    "judge-session",
    judgeRawOutput,
  );
  const sessions = {
    model_id: "same-model",
    label_a: {
      session_nonce: "candidate-session",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: generatorInputViewSha256.a,
      output_sha256: measurement.labels.a.output_sha256,
      transcript_sha256: measurement.labels.a.events_sha256,
      transcript: labelA.events,
      tool_calls: measurement.labels.a.tool_calls,
      tool_sequence_sha256:
        measurement.labels.a.tool_sequence_sha256,
      runtime_path: skillRoot,
      cli_smoke: candidateSmoke,
      started_at: "2026-07-29T02:32:00.000Z",
      completed_at: "2026-07-29T02:33:00.000Z",
    },
    label_b: {
      session_nonce: "baseline-session",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: generatorInputViewSha256.b,
      output_sha256: measurement.labels.b.output_sha256,
      transcript_sha256: measurement.labels.b.events_sha256,
      transcript: labelB.events,
      tool_calls: measurement.labels.b.tool_calls,
      tool_sequence_sha256:
        measurement.labels.b.tool_sequence_sha256,
      runtime_path: baselineSkillRoot,
      cli_smoke: baselineSmoke,
      started_at: "2026-07-29T02:32:10.000Z",
      completed_at: "2026-07-29T02:33:10.000Z",
    },
    judge: {
      session_nonce: "judge-session",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: judgeInputViewSha256,
      input_bundle: judgeInputBundle,
      input_bundle_sha256: fingerprint(judgeInputBundle),
      output_sha256: fingerprint(judgeOutput),
      raw_output: judgeRawOutput,
      transcript: judgeTranscript,
      transcript_sha256: createHash("sha256")
        .update(judgeTranscript)
        .digest("hex"),
      tool_calls: 0,
      tool_sequence_sha256: fingerprint([]),
      started_at: "2026-07-29T02:33:20.000Z",
      completed_at: "2026-07-29T02:34:00.000Z",
    },
  };
  const adjudication = buildBlindedAdjudication({
    fixture,
    assignment,
    sessions,
    labelOutputs: {
      a: labelA.output,
      b: labelB.output,
    },
    labelTranscripts: {
      a: labelA.events,
      b: labelB.events,
    },
    judgeOutput,
    measurement,
    unblindedAt: "2026-07-29T02:34:10.000Z",
  });
  const aggregate = deriveBlindedForwardAggregate({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint: fingerprintTree(skillRoot),
    platformValidationSource: passingPlatformValidationSource,
    privateSourceManifestSha256: "f".repeat(64),
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
    runtimeBundles,
  };
}

test("measurement is recomputed from private outputs and aggregate is derived", () => {
  const bundle = evaluationBundle();
  assert.equal(bundle.measurement.labels.a.tool_calls, 2);
  assert.equal(bundle.measurement.labels.a.heading_count, 0);
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
    4,
  );
  assert.equal(
    bundle.aggregate.forward_evaluation.candidate_passed_behaviors,
    19,
  );
  assert.equal(bundle.aggregate.forward_evaluation.candidate_regressions, 0);
  const result = validateForwardEvaluationAggregate(bundle.aggregate, {
    currentSkillFingerprint: fingerprintTree(skillRoot),
    fixture,
    adjudication: bundle.adjudication,
    measurement: bundle.measurement,
  });
  assert.equal(result.forward.passed, true);
  assert.equal(result.forward.protocol_passed, true);
  assert.equal(result.forward.cost_passed, true);
  assert.equal(result.platform.passed, true);
});

test("provider transcripts are authoritative for tool counts and cannot be trimmed", () => {
  const bundle = evaluationBundle();
  const transcriptLines = bundle.labelA.events
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const trimmed = transcriptLines.filter(
    (event) => event?.item?.id !== "tool_0",
  );
  bundle.labelA.events =
    `${trimmed.map((event) => JSON.stringify(event)).join("\n")}\n`;
  assert.throws(
    () =>
      buildBlindedMeasurement({
        fixture,
        labelA: bundle.labelA,
        labelB: bundle.labelB,
        measuredAt: bundle.measurement.measured_at,
      }),
    /缺少或重複必要唯讀 command/u,
  );
});

test("generator transcripts reject network, duplicate, private-path, and write tools", () => {
  const wrappedBundle = evaluationBundle();
  wrappedBundle.labelA.events = codexTranscript(
    wrappedBundle.sessions.label_a.session_nonce,
    wrappedBundle.labelA.output,
    evaluationTranscriptTools().map((tool) => ({
      command:
        `/bin/zsh -c ${JSON.stringify(tool.command)}`,
    })),
  );
  assert.equal(
    buildBlindedMeasurement({
      fixture,
      labelA: wrappedBundle.labelA,
      labelB: wrappedBundle.labelB,
      measuredAt: wrappedBundle.measurement.measured_at,
    }).labels.a.tool_calls,
    2,
  );
  const attacks = [
    {
      name: "paired web search",
      tools: [
        ...evaluationTranscriptTools(),
        {
          type: "web_search",
          command: "search remote evidence",
        },
      ],
      message: /tool type 不允許/u,
    },
    {
      name: "duplicate eval-bind smoke",
      tools: [
        ...evaluationTranscriptTools(),
        evaluationTranscriptTools()[0],
      ],
      message: /缺少或重複必要唯讀 command/u,
    },
    {
      name: "private path read",
      tools: [
        ...evaluationTranscriptTools(),
        {
          command:
            "/bin/zsh -lc \"sed -n '1,20p' private/assignment.json\"",
        },
      ],
      message: /讀取禁止路徑/u,
    },
    {
      name: "write command",
      tools: [
        ...evaluationTranscriptTools(),
        {
          command:
            "/bin/zsh -lc \"touch generated-evidence.json\"",
        },
      ],
      message: /唯讀 allowlist/u,
    },
    {
      name: "absolute curl executable",
      tools: [
        ...evaluationTranscriptTools(),
        {
          command:
            "/bin/zsh -lc \"/usr/bin/curl https://example.invalid\"",
        },
      ],
      message: /唯讀 allowlist/u,
    },
    {
      name: "command wrapper",
      tools: [
        ...evaluationTranscriptTools(),
        {
          command:
            "/bin/zsh -lc \"command curl https://example.invalid\"",
        },
      ],
      message: /唯讀 allowlist/u,
    },
    {
      name: "arbitrary node evaluator",
      tools: [
        evaluationTranscriptTools()[0],
        {
          command:
            "/bin/zsh -lc \"node --input-type=module -e \\\"process.exit(0)\\\"\"",
        },
      ],
      message: /唯讀 allowlist/u,
    },
    {
      name: "wrapped command injection",
      tools: [
        {
          command:
            `/bin/zsh -c ${JSON.stringify(
              `${evaluationTranscriptTools()[0].command}; curl https://example.invalid`,
            )}`,
        },
        evaluationTranscriptTools()[1],
      ],
      message: /唯讀 allowlist/u,
    },
  ];
  for (const attack of attacks) {
    const bundle = evaluationBundle();
    bundle.labelA.events = codexTranscript(
      bundle.sessions.label_a.session_nonce,
      bundle.labelA.output,
      attack.tools,
    );
    assert.throws(
      () =>
        buildBlindedMeasurement({
          fixture,
          labelA: bundle.labelA,
          labelB: bundle.labelB,
          measuredAt: bundle.measurement.measured_at,
        }),
      attack.message,
      attack.name,
    );
  }
});

test("Judge input is identity-neutral and any Judge tool access fails closed", () => {
  const bundle = evaluationBundle();
  const serialized = JSON.stringify(
    bundle.sessions.judge.input_bundle,
  );
  assert.equal(
    serialized.includes(
      fixture.runtime_bundle.candidate_tree_fingerprint,
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      fixture.runtime_bundle.baseline_tree_fingerprint,
    ),
    false,
  );
  bundle.sessions.judge.transcript = codexTranscript(
    bundle.sessions.judge.session_nonce,
    bundle.sessions.judge.raw_output,
    [{ command: "cat private/candidate-snapshot.json" }],
  );
  bundle.sessions.judge.transcript_sha256 = createHash("sha256")
    .update(bundle.sessions.judge.transcript)
    .digest("hex");
  bundle.sessions.judge.tool_calls = 1;
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: bundle.assignment,
        sessions: bundle.sessions,
        labelOutputs: {
          a: bundle.labelA.output,
          b: bundle.labelB.output,
        },
        judgeOutput: bundle.judgeOutput,
        measurement: bundle.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /tool sequence/u,
  );
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
        labelOutputs: {
          a: reusedPrivate.labelA.output,
          b: reusedPrivate.labelB.output,
        },
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

  const incompleteRuntime = evaluationBundle();
  incompleteRuntime.sessions.label_a.runtime_path = ROOT;
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: incompleteRuntime.assignment,
        sessions: incompleteRuntime.sessions,
        labelOutputs: {
          a: incompleteRuntime.labelA.output,
          b: incompleteRuntime.labelB.output,
        },
        judgeOutput: incompleteRuntime.judgeOutput,
        measurement: incompleteRuntime.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /完整唯讀 runtime bundle/u,
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
    .candidate_passed_behaviors = 6;
  const result = validateForwardEvaluationAggregate(
    aggregateTamper.aggregate,
    {
      currentSkillFingerprint: fingerprintTree(skillRoot),
      platformValidationSource: passingPlatformValidationSource,
      fixture,
      adjudication: aggregateTamper.adjudication,
      measurement: aggregateTamper.measurement,
    },
  );
  assert.equal(result.forward.passed, false);
});

test("sessions cannot be replayed after locked evaluation inputs change", () => {
  const bundle = evaluationBundle();
  const changedFixture = structuredClone(fixture);
  changedFixture.prompt = `${fixture.prompt}\nchanged candidate identity`;
  assert.throws(
    () =>
      deriveBlindedForwardAggregate({
        adjudication: bundle.adjudication,
        measurement: bundle.measurement,
        fixture: changedFixture,
        currentSkillFingerprint: fingerprintTree(skillRoot),
        platformValidationSource: passingPlatformValidationSource,
        privateSourceManifestSha256: "f".repeat(64),
      }),
    /evaluation input|locked fixture/u,
  );

  const changedInputSha256 =
    evaluationInputFingerprint(changedFixture);
  const reboundAssignment = structuredClone(bundle.assignment);
  reboundAssignment.evaluation_input_sha256 = changedInputSha256;
  const reboundJudge = structuredClone(bundle.judgeOutput);
  reboundJudge.evaluation_input_sha256 = changedInputSha256;
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture: changedFixture,
        assignment: reboundAssignment,
        sessions: bundle.sessions,
        labelOutputs: {
          a: bundle.labelA.output,
          b: bundle.labelB.output,
        },
        judgeOutput: reboundJudge,
        measurement: bundle.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /session|measurement|locked input/u,
  );

  const reboundSessions = structuredClone(bundle.sessions);
  reboundSessions.label_a.evaluation_input_sha256 =
    changedInputSha256;
  reboundSessions.label_b.evaluation_input_sha256 =
    changedInputSha256;
  reboundSessions.judge.evaluation_input_sha256 =
    changedInputSha256;
  const reboundMeasurement = buildBlindedMeasurement({
    fixture: changedFixture,
    labelA: bundle.labelA,
    labelB: bundle.labelB,
    measuredAt: bundle.measurement.measured_at,
  });
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture: changedFixture,
        assignment: reboundAssignment,
        sessions: reboundSessions,
        labelOutputs: {
          a: bundle.labelA.output,
          b: bundle.labelB.output,
        },
        judgeOutput: reboundJudge,
        measurement: reboundMeasurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /label_a (?:session|output) 未綁定/u,
  );
});

test("input views remain label-neutral and every output binds its exact view", () => {
  const bundle = evaluationBundle();
  const viewA = buildGeneratorEvaluationInputView(
    fixture,
    bundle.assignment,
    "a",
    bundle.runtimeBundles.candidate,
  );
  const viewB = buildGeneratorEvaluationInputView(
    fixture,
    bundle.assignment,
    "b",
    bundle.runtimeBundles.baseline,
  );
  const serializedViews = JSON.stringify([viewA, viewB]);
  for (const forbiddenKey of [
    "baseline_label",
    "candidate_label",
    "baseline_tree_fingerprint",
    "candidate_tree_fingerprint",
    "baseline_sha256",
    "candidate_sha256",
    "candidate_skill_fingerprint",
  ]) {
    assert.equal(serializedViews.includes(`"${forbiddenKey}"`), false);
  }
  const judgeView = buildJudgeEvaluationInputView(fixture, {
    labelInputViewSha256: {
      a: fingerprint(viewA),
      b: fingerprint(viewB),
    },
    opaqueLabelOutputSha256: {
      a: fingerprint(
        buildOpaqueJudgeLabelOutput(bundle.labelA.output),
      ),
      b: fingerprint(
        buildOpaqueJudgeLabelOutput(bundle.labelB.output),
      ),
    },
    runtimeBundles: {
      a: viewA.runtime_bundle,
      b: viewB.runtime_bundle,
    },
  });
  const serializedJudgeView = JSON.stringify(judgeView);
  assert.equal(serializedJudgeView.includes("candidate_label"), false);
  assert.equal(
    serializedJudgeView.includes(
      fixture.usage_evidence.current_run.candidate_skill_fingerprint,
    ),
    false,
  );
  assert.equal(
    serializedJudgeView.includes("runtime_bundle_sha256"),
    true,
  );

  const generatorMismatch = evaluationBundle();
  const generatorDocument = JSON.parse(generatorMismatch.labelA.output);
  generatorDocument.input_view_sha256 = "0".repeat(64);
  generatorMismatch.labelA.output = JSON.stringify(generatorDocument);
  generatorMismatch.labelA.events = codexTranscript(
    generatorMismatch.sessions.label_a.session_nonce,
    generatorMismatch.labelA.output,
    evaluationTranscriptTools(),
  );
  generatorMismatch.measurement = buildBlindedMeasurement({
    fixture,
    labelA: generatorMismatch.labelA,
    labelB: generatorMismatch.labelB,
    measuredAt: generatorMismatch.measurement.measured_at,
  });
  generatorMismatch.sessions.label_a.output_sha256 =
    generatorMismatch.measurement.labels.a.output_sha256;
  generatorMismatch.sessions.label_a.transcript =
    generatorMismatch.labelA.events;
  generatorMismatch.sessions.label_a.transcript_sha256 =
    generatorMismatch.measurement.labels.a.events_sha256;
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: generatorMismatch.assignment,
        sessions: generatorMismatch.sessions,
        labelOutputs: {
          a: generatorMismatch.labelA.output,
          b: generatorMismatch.labelB.output,
        },
        judgeOutput: generatorMismatch.judgeOutput,
        measurement: generatorMismatch.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /label_a output 未綁定 locked input/u,
  );

  const judgeMismatch = evaluationBundle();
  judgeMismatch.judgeOutput.input_view_sha256 = "0".repeat(64);
  judgeMismatch.sessions.judge.raw_output =
    JSON.stringify(judgeMismatch.judgeOutput);
  judgeMismatch.sessions.judge.transcript = codexTranscript(
    judgeMismatch.sessions.judge.session_nonce,
    judgeMismatch.sessions.judge.raw_output,
  );
  judgeMismatch.sessions.judge.transcript_sha256 =
    createHash("sha256")
      .update(judgeMismatch.sessions.judge.transcript)
      .digest("hex");
  judgeMismatch.sessions.judge.output_sha256 =
    fingerprint(judgeMismatch.judgeOutput);
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: judgeMismatch.assignment,
        sessions: judgeMismatch.sessions,
        labelOutputs: {
          a: judgeMismatch.labelA.output,
          b: judgeMismatch.labelB.output,
        },
        judgeOutput: judgeMismatch.judgeOutput,
        measurement: judgeMismatch.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /Judge output 未綁定 locked evaluation input/u,
  );
});

test("measurement is recorded after both generators and before Judge starts", () => {
  const bundle = evaluationBundle();
  const tooEarly = structuredClone(bundle.measurement);
  tooEarly.measured_at = "2026-07-29T02:33:09.999Z";
  assert.throws(
    () =>
      validateBlindedMeasurement(
        tooEarly,
        bundle.adjudication,
        fixture,
      ),
    /A\/B 完成與 Judge 開始之間/u,
  );

  const tooLate = structuredClone(bundle.measurement);
  tooLate.measured_at = "2026-07-29T02:33:20.001Z";
  assert.throws(
    () =>
      validateBlindedMeasurement(
        tooLate,
        bundle.adjudication,
        fixture,
      ),
    /A\/B 完成與 Judge 開始之間/u,
  );
});

test("private sessions cannot be replayed against different raw outputs", () => {
  const generatorReplay = evaluationBundle();
  generatorReplay.sessions.label_a.output_sha256 = "0".repeat(64);
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: generatorReplay.assignment,
        sessions: generatorReplay.sessions,
        labelOutputs: {
          a: generatorReplay.labelA.output,
          b: generatorReplay.labelB.output,
        },
        judgeOutput: generatorReplay.judgeOutput,
        measurement: generatorReplay.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /runtime bundle/u,
  );

  const judgeReplay = evaluationBundle();
  judgeReplay.sessions.judge.output_sha256 = "0".repeat(64);
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: judgeReplay.assignment,
        sessions: judgeReplay.sessions,
        labelOutputs: {
          a: judgeReplay.labelA.output,
          b: judgeReplay.labelB.output,
        },
        judgeOutput: judgeReplay.judgeOutput,
        measurement: judgeReplay.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /session identity/u,
  );
});

test("runtime smoke, platform output, and public Judge summaries are source-bound", () => {
  const forgedSmoke = evaluationBundle();
  forgedSmoke.sessions.label_a.cli_smoke.stderr =
    '{"command":"eval-bind","error":"缺少必要參數：--forged","valid":false}\n';
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: forgedSmoke.assignment,
        sessions: forgedSmoke.sessions,
        labelOutputs: {
          a: forgedSmoke.labelA.output,
          b: forgedSmoke.labelB.output,
        },
        judgeOutput: forgedSmoke.judgeOutput,
        measurement: forgedSmoke.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /runtime bundle/u,
  );

  const privateRationale = evaluationBundle();
  privateRationale.judgeOutput.behaviors[0]
    .label_a.rationale_summary =
      `Read ${["/Users", "example/private"].join("/")} token=secret user@example.com`;
  privateRationale.sessions.judge.raw_output =
    JSON.stringify(privateRationale.judgeOutput);
  privateRationale.sessions.judge.transcript = codexTranscript(
    privateRationale.sessions.judge.session_nonce,
    privateRationale.sessions.judge.raw_output,
  );
  privateRationale.sessions.judge.transcript_sha256 =
    createHash("sha256")
      .update(privateRationale.sessions.judge.transcript)
      .digest("hex");
  privateRationale.sessions.judge.output_sha256 =
    fingerprint(privateRationale.judgeOutput);
  assert.throws(
    () =>
      buildBlindedAdjudication({
        fixture,
        assignment: privateRationale.assignment,
        sessions: privateRationale.sessions,
        labelOutputs: {
          a: privateRationale.labelA.output,
          b: privateRationale.labelB.output,
        },
        judgeOutput: privateRationale.judgeOutput,
        measurement: privateRationale.measurement,
        unblindedAt: "2026-07-29T02:34:10.000Z",
      }),
    /尚未脫敏/u,
  );

  const platformReplay = evaluationBundle();
  const tamperedPlatform = structuredClone(
    passingPlatformValidationSource,
  );
  tamperedPlatform.platforms[0].positive_output_sha256 =
    "0".repeat(64);
  assert.throws(
    () =>
      deriveBlindedForwardAggregate({
        adjudication: platformReplay.adjudication,
        measurement: platformReplay.measurement,
        fixture,
        currentSkillFingerprint: fingerprintTree(skillRoot),
        platformValidationSource: tamperedPlatform,
        privateSourceManifestSha256: "f".repeat(64),
      }),
    /output(?:／transcript)? hash/u,
  );

  const deriveWithPlatformSource = (source) => {
    const current = evaluationBundle();
    return deriveBlindedForwardAggregate({
      adjudication: current.adjudication,
      measurement: current.measurement,
      fixture,
      currentSkillFingerprint: fingerprintTree(skillRoot),
      platformValidationSource: source,
      privateSourceManifestSha256: "f".repeat(64),
    });
  };
  const postSessionWrapper = structuredClone(
    passingPlatformValidationSource,
  );
  const wrappedPath =
    postSessionWrapper.platforms[0].positive_output_path;
  const wrapped = JSON.parse(readFileSync(wrappedPath, "utf8"));
  wrapped.result.evidence.push("added after session completion");
  const replacementPath = join(
    testRuntimeRoot,
    "codex-positive-post-session-wrapper.json",
  );
  writeFileSync(replacementPath, JSON.stringify(wrapped), "utf8");
  postSessionWrapper.platforms[0].positive_output_path =
    replacementPath;
  postSessionWrapper.platforms[0].positive_output_sha256 =
    createHash("sha256")
      .update(readFileSync(replacementPath))
      .digest("hex");
  assert.throws(
    () => deriveWithPlatformSource(postSessionWrapper),
    /transcript|實際 output/u,
  );
  const replacePlatformOutput = (
    source,
    platformIndex,
    caseId,
    mutate,
    suffix,
    providerSessionNonce =
      `${source.platforms[platformIndex].id}-${caseId}-${suffix}-provider-session`,
  ) => {
    const platform = source.platforms[platformIndex];
    const pathKey = `${caseId}_output_path`;
    const hashKey = `${caseId}_output_sha256`;
    const transcriptPathKey = `${caseId}_transcript_path`;
    const transcriptHashKey = `${caseId}_transcript_sha256`;
    const document = JSON.parse(readFileSync(platform[pathKey], "utf8"));
    mutate(document);
    const replacementPath = join(
      testRuntimeRoot,
      `${platform.id}-${caseId}-${suffix}.json`,
    );
    writeFileSync(
      replacementPath,
      `${JSON.stringify(document)}\n`,
      "utf8",
    );
    platform[pathKey] = replacementPath;
    platform[hashKey] = createHash("sha256")
      .update(readFileSync(replacementPath))
      .digest("hex");
    const transcriptPath = `${replacementPath}.jsonl`;
    const output = readFileSync(replacementPath, "utf8");
    const replacementTools =
      caseId === "positive"
        ? [{
            command:
              "/bin/zsh -lc \"sed -n '1,40p' 'SKILL.md'\"",
          }]
        : [];
    writeFileSync(
      transcriptPath,
      codexTranscript(
        providerSessionNonce,
        output,
        replacementTools,
      ),
      "utf8",
    );
    platform[transcriptPathKey] = transcriptPath;
    platform[transcriptHashKey] = createHash("sha256")
      .update(readFileSync(transcriptPath))
      .digest("hex");
    const completion =
      source.completion_attestation.sessions.find(
        (session) =>
          session.platform === platform.id &&
          session.case === caseId,
      );
    completion.started_at = document.started_at;
    completion.output_sha256 = platform[hashKey];
    completion.transcript_sha256 =
      platform[transcriptHashKey];
    completion.provider_session_nonce =
      providerSessionNonce;
    completion.tool_calls = replacementTools.length;
    completion.tool_sequence_sha256 = fingerprint(
      replacementTools.map((tool, index) => ({
        id: `tool_${index}`,
        type: "command_execution",
        command: tool.command,
      })),
    );
    const payload = {
      schema_version:
        source.completion_attestation.schema_version,
      authority_id:
        source.completion_attestation.authority_id,
      authority_version:
        source.completion_attestation.authority_version,
      controller_sha256:
        source.completion_attestation.controller_sha256,
      candidate_skill_fingerprint:
        source.completion_attestation
          .candidate_skill_fingerprint,
      evaluation_input_sha256:
        source.completion_attestation
          .evaluation_input_sha256,
      challenge_payload_sha256:
        source.completion_attestation
          .challenge_payload_sha256,
      attested_at:
        source.completion_attestation.attested_at,
      sessions:
        source.completion_attestation.sessions,
    };
    source.completion_attestation.payload_sha256 =
      fingerprint(payload);
    source.completion_attestation.signature_base64 = sign(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      evaluatorKeys.privateKey,
    ).toString("base64");
  };

  const reboundOuterSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    reboundOuterSource,
    0,
    "positive",
    (document) => {
      document.candidate_skill_fingerprint = "0".repeat(64);
    },
    "rebound-candidate",
  );
  assert.throws(
    () => deriveWithPlatformSource(reboundOuterSource),
    /output session 綁定不一致/u,
  );

  const duplicateNonceSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    duplicateNonceSource,
    0,
    "negative",
    () => {},
    "duplicate-nonce",
    "codex-positive-provider-session",
  );
  assert.throws(
    () => deriveWithPlatformSource(duplicateNonceSource),
    /session nonce 必須唯一/u,
  );

  const crossProviderSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    crossProviderSource,
    1,
    "positive",
    () => {},
    "codex-envelope-for-claude",
  );
  assert.throws(
    () => deriveWithPlatformSource(crossProviderSource),
    /Claude platform transcript runtime／output 不一致/u,
  );

  const wrongClaudeModelSource = structuredClone(
    passingPlatformValidationSource,
  );
  const claudePositive =
    wrongClaudeModelSource.platforms[1];
  const wrongModelTranscriptPath = join(
    testRuntimeRoot,
    "claude-positive-wrong-model.jsonl",
  );
  const wrongModelEvents = readFileSync(
    claudePositive.positive_transcript_path,
    "utf8",
  )
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  wrongModelEvents.at(-1).modelUsage = {
    sonnet: {
      canonicalModel: "sonnet",
      provider: "firstParty",
    },
  };
  writeFileSync(
    wrongModelTranscriptPath,
    `${wrongModelEvents
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
    "utf8",
  );
  claudePositive.positive_transcript_path =
    wrongModelTranscriptPath;
  claudePositive.positive_transcript_sha256 =
    createHash("sha256")
      .update(readFileSync(wrongModelTranscriptPath))
      .digest("hex");
  const wrongModelCompletion =
    wrongClaudeModelSource.completion_attestation.sessions
      .find(
        (session) =>
          session.platform === "claude-code" &&
          session.case === "positive",
      );
  wrongModelCompletion.transcript_sha256 =
    claudePositive.positive_transcript_sha256;
  resignPlatformCompletion(wrongClaudeModelSource);
  assert.throws(
    () => deriveWithPlatformSource(wrongClaudeModelSource),
    /Claude platform transcript runtime／output 不一致/u,
  );

  const mismatchedChallengeSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    mismatchedChallengeSource,
    0,
    "negative",
    (document) => {
      document.challenge_nonce =
        "codex-positive-challenge";
    },
    "mismatched-challenge",
  );
  assert.throws(
    () => deriveWithPlatformSource(mismatchedChallengeSource),
    /output session 綁定不一致/u,
  );

  const forgedChallengeSource = structuredClone(
    passingPlatformValidationSource,
  );
  forgedChallengeSource.challenge_attestation.signature_base64 =
    Buffer.alloc(64).toString("base64");
  assert.throws(
    () => deriveWithPlatformSource(forgedChallengeSource),
    /platform challenge 簽章不合法/u,
  );

  const expiredCompletionSource = structuredClone(
    passingPlatformValidationSource,
  );
  expiredCompletionSource.completion_attestation
    .sessions[0].completed_at =
      "2026-07-29T03:34:11.000Z";
  const expiredCompletionPayload = {
    schema_version:
      expiredCompletionSource.completion_attestation
        .schema_version,
    authority_id:
      expiredCompletionSource.completion_attestation.authority_id,
    authority_version:
      expiredCompletionSource.completion_attestation
        .authority_version,
    controller_sha256:
      expiredCompletionSource.completion_attestation
        .controller_sha256,
    candidate_skill_fingerprint:
      expiredCompletionSource.completion_attestation
        .candidate_skill_fingerprint,
    evaluation_input_sha256:
      expiredCompletionSource.completion_attestation
        .evaluation_input_sha256,
    challenge_payload_sha256:
      expiredCompletionSource.completion_attestation
        .challenge_payload_sha256,
    attested_at:
      expiredCompletionSource.completion_attestation
        .attested_at,
    sessions:
      expiredCompletionSource.completion_attestation.sessions,
  };
  expiredCompletionSource.completion_attestation.payload_sha256 =
    fingerprint(expiredCompletionPayload);
  expiredCompletionSource.completion_attestation
    .signature_base64 = sign(
      null,
      Buffer.from(
        canonicalJson(expiredCompletionPayload),
        "utf8",
      ),
      evaluatorKeys.privateKey,
    ).toString("base64");
  assert.throws(
    () => deriveWithPlatformSource(expiredCompletionSource),
    /platform completion 時序或 challenge 不一致/u,
  );

  const backfilledAttestationSource = structuredClone(
    passingPlatformValidationSource,
  );
  backfilledAttestationSource.completion_attestation.attested_at =
    "2026-07-29T03:34:11.000Z";
  resignPlatformCompletion(backfilledAttestationSource);
  assert.throws(
    () => deriveWithPlatformSource(backfilledAttestationSource),
    /attested_at 不合法/u,
  );

  const nonceNamespaceSource = structuredClone(
    passingPlatformValidationSource,
  );
  nonceNamespaceSource.completion_attestation
    .sessions[0].provider_session_nonce =
      nonceNamespaceSource.challenge_attestation
        .challenges[0].challenge_nonce;
  resignPlatformCompletion(nonceNamespaceSource);
  assert.throws(
    () => deriveWithPlatformSource(nonceNamespaceSource),
    /nonce 必須隔離/u,
  );

  const earlyPlatformSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    earlyPlatformSource,
    0,
    "positive",
    (document) => {
      document.started_at = "2026-07-29T02:34:09.000Z";
    },
    "early-session",
  );
  assert.throws(
    () => deriveWithPlatformSource(earlyPlatformSource),
    /platform completion 時序或 challenge 不一致/u,
  );

  const prefilledCompletionSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    prefilledCompletionSource,
    0,
    "positive",
    (document) => {
      document.completed_at =
        "2026-07-29T02:34:12.000Z";
    },
    "prefilled-completion",
  );
  assert.throws(
    () => deriveWithPlatformSource(prefilledCompletionSource),
    /output session 綁定不一致/u,
  );

  const extraFieldSource = structuredClone(
    passingPlatformValidationSource,
  );
  replacePlatformOutput(
    extraFieldSource,
    0,
    "positive",
    (document) => {
      document.claimed_passed = true;
    },
    "extra-field",
  );
  assert.throws(
    () => deriveWithPlatformSource(extraFieldSource),
    /output session 綁定不一致/u,
  );
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
    currentSkillFingerprint: fingerprintTree(skillRoot),
    platformValidationSource: passingPlatformValidationSource,
    privateSourceManifestSha256: "f".repeat(64),
  });
  assert.equal(aggregate.forward_evaluation.passed, false);
  const result = validateForwardEvaluationAggregate(aggregate, {
    currentSkillFingerprint: fingerprintTree(skillRoot),
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
