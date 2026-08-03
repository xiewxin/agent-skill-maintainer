import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildApproval,
  canonicalJson,
  fingerprint,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  buildBlindedMeasurement,
  buildForwardEvaluationBinding,
  buildGeneratorEvaluationInputView,
  buildJudgeEvaluationInputBundle,
  buildJudgeEvaluationInputView,
  buildOpaqueJudgeLabelOutput,
  capturePlatformValidationEvidence,
  evaluationInputFingerprint,
  observeRuntimeCliSmoke,
} from "../skills/agent-skill-maintainer/scripts/lib/evaluation.mjs";
import {
  buildCandidateSnapshot,
  buildRepositorySnapshot,
  countTreeFiles,
  createIsolatedCandidate,
  fingerprintTree,
  inspectCandidateCommitTree,
  readCandidateCommitRegularFile,
  runGit as runSafeGit,
  validateCommit,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  buildGithubCapabilityProof,
} from "../skills/agent-skill-maintainer/scripts/lib/github.mjs";

const BLINDED_FORWARD_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../evals/cases/evaluation-binding-heldout.json", import.meta.url),
    "utf8",
  ),
);
const NEUTRAL_CONTROLLER_PATH = fileURLToPath(
  new URL(
    "../scripts/neutral-evaluation-controller.mjs",
    import.meta.url,
  ),
);
const BLINDED_FORWARD_FIXTURE_BYTES = readFileSync(
  new URL("../evals/cases/evaluation-binding-heldout.json", import.meta.url),
);
const BLINDED_FORWARD_FIXTURE_SHA256 = createHash("sha256")
  .update(BLINDED_FORWARD_FIXTURE_BYTES)
  .digest("hex");
const BLINDED_ADJUDICATION = JSON.parse(
  readFileSync(
    new URL(
      "../evals/evidence/blinded-adjudication-v1.0.0.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const BLINDED_MEASUREMENT = JSON.parse(
  readFileSync(
    new URL(
      "../evals/evidence/blinded-measurement-v1.0.0.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const RETAINED_RUNTIME_ROOTS = [];
const DEFAULT_ROUTE_ENVIRONMENT_POLICY_ID =
  "formal-default-route-v1";
const CURRENT_ENVIRONMENT_POLICY_ID =
  "formal-current-environment-v1";
export const FORWARD_EVALUATION_BASELINE_COMMIT =
  "9a0e001d92abe86d0d8c4f34d66170bd78ca8059";
export const FORWARD_EVALUATION_PROCESS_ARTIFACT_PREFIXES =
  Object.freeze([
    "docs/plans/",
    "docs/specs/",
    "docs/superpowers/",
  ]);
export const TEST_PLATFORM_INSTALL_PATHS = Object.freeze({
  codex: ".agents/skills/agent-skill-maintainer",
  "claude-code": ".claude/skills/agent-skill-maintainer",
});
export const TEST_REQUIRED_PLATFORM_READ_PATHS = Object.freeze([
  "SKILL.md",
  "references/evaluation.md",
  "references/security-and-privacy.md",
]);
process.once("exit", () => {
  for (const root of RETAINED_RUNTIME_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});
const TEST_EVALUATOR_PRIVATE_KEY = createPrivateKey({
  key: {
    crv: "Ed25519",
    d: "KVELcgg7G1MaeqZU2n789pCQ2IlaLY5f5d_tKJiAXG0",
    x: "riNY5IfkP-6ktFE_5229T78DDDfABFBwuyxHSzh2HwI",
    kty: "OKP",
  },
  format: "jwk",
});
export const TEST_PLATFORM_EXECUTION_PROFILES = Object.freeze({
  codex: Object.freeze({
    controller_managed: true,
    command: "codex exec",
    model: "gpt-5.4",
    sandbox: "read-only",
    approval_policy: "never",
    ignore_user_config: true,
    ignore_rules: true,
    ephemeral: true,
    environment_policy: DEFAULT_ROUTE_ENVIRONMENT_POLICY_ID,
    routing_policy: "default-only",
    installation_relative_path: TEST_PLATFORM_INSTALL_PATHS.codex,
    prompt_policy: "controller-owned-platform-case-v2",
    transcript_policy: "strict-read-only-codex-v2",
  }),
  "claude-code": Object.freeze({
    controller_managed: true,
    command: "claude --print",
    model: "k3",
    effort: "high",
    permission_mode: "dontAsk",
    setting_sources: Object.freeze(["project", "local"]),
    strict_mcp_config: true,
    tools: Object.freeze(["Glob", "Grep", "Read"]),
    environment_policy: CURRENT_ENVIRONMENT_POLICY_ID,
    routing_policy: "current-environment-bound",
    portability_policy: "default-only-nonblocking",
    installation_relative_path:
      TEST_PLATFORM_INSTALL_PATHS["claude-code"],
    prompt_policy: "controller-owned-platform-case-v2",
    transcript_policy: "strict-read-only-claude-stream-v2",
  }),
});

/** Mirrors the locked controller-owned prompt template for schema fixtures. */
export function testPlatformPromptTemplate(platform, caseId) {
  const requiredPaths = TEST_REQUIRED_PLATFORM_READ_PATHS.map(
    (path) => `${TEST_PLATFORM_INSTALL_PATHS[platform]}/${path}`,
  );
  const caseInstructions = caseId === "positive"
    ? platform === "codex"
      ? [
          "Explicitly use the installed agent-skill-maintainer Skill.",
          "Execute exactly these three read commands as separate tool calls and use no other tool:",
          ...requiredPaths.map(
            (path) => `/bin/zsh -lc "/bin/cat -- '${path}'"`,
          ),
          "Use the files to confirm stable FB/OPT IDs, explicit user decision boundaries, and read-only analysis.",
          "Set triggered_skill, target_and_reference_read, stable_ids, and decision_boundary to true.",
        ]
      : [
          "Explicitly use the installed agent-skill-maintainer Skill.",
          "Use exactly three Read calls and no Glob or Grep calls.",
          ...requiredPaths.map((path) => `Read ${path}`),
          "Use the files to confirm stable FB/OPT IDs, explicit user decision boundaries, and read-only analysis.",
          "Set triggered_skill, target_and_reference_read, stable_ids, and decision_boundary to true.",
        ]
    : [
        "Answer the unrelated arithmetic question: what is 17 + 25?",
        "Do not use or read the agent-skill-maintainer Skill and do not call any read tool.",
        "Set triggered_skill, target_and_reference_read, stable_ids, and decision_boundary to false.",
      ];
  return [
    ...caseInstructions,
    "Set analysis_correct to true and files_modified to false.",
    "Return raw JSON without Markdown.",
    "Copy every key and value from the controller identity JSON directly to the top level, including installed_copy; do not nest or rename any identity field.",
    "Besides those identity fields, the top-level object must contain only schema_version and one nested result object.",
    "The result object must contain exactly the required booleans and a non-empty evidence array.",
    "The neutral controller will append the immutable session identity.",
  ].join("\n");
}

/** Returns one complete synthetic Codex JSONL transcript. */
export function codexTranscript(
  sessionNonce,
  output,
  toolCalls = [],
) {
  const events = [
    {
      type: "thread.started",
      thread_id: sessionNonce,
    },
    { type: "turn.started" },
  ];
  toolCalls.forEach((tool, index) => {
    const item = {
      id: `tool_${index}`,
      type: tool.type ?? "command_execution",
      command: tool.command ?? `read-${index}`,
    };
    events.push(
      { type: "item.started", item },
      {
        type: "item.completed",
        item: {
          ...item,
          aggregated_output: tool.aggregated_output ?? "",
          exit_code: 0,
          status: "completed",
        },
      },
    );
  });
  events.push(
    {
      type: "item.completed",
      item: {
        id: "final",
        type: "agent_message",
        text: output,
      },
    },
    { type: "turn.completed" },
  );
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** Returns one complete synthetic Claude stream-json transcript. */
export function claudeTranscript(
  sessionNonce,
  output,
  workspaceRoot,
  { readPaths = [] } = {},
) {
  const document = JSON.parse(output);
  const events = [
    {
      type: "system",
      subtype: "init",
      cwd: workspaceRoot,
      session_id: sessionNonce,
      tools: ["Glob", "Grep", "Read", "StructuredOutput"],
      permissionMode: "dontAsk",
    },
  ];
  readPaths.forEach((relativePath, index) => {
    const absolutePath = join(workspaceRoot, relativePath);
    events.push(
      {
        type: "assistant",
        session_id: sessionNonce,
        message: {
          content: [{
            type: "tool_use",
            name: "Read",
            id: `claude-read-${index}`,
            input: {
              file_path: absolutePath,
            },
          }],
        },
      },
      {
        type: "user",
        session_id: sessionNonce,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: `claude-read-${index}`,
            content: readFileSync(absolutePath, "utf8"),
          }],
        },
        tool_use_result: {
          file: {
            filePath: absolutePath,
            content: readFileSync(absolutePath, "utf8"),
          },
        },
      },
    );
  });
  events.push(
    {
      type: "assistant",
      session_id: sessionNonce,
      message: {
        content: [{
          type: "tool_use",
          name: "StructuredOutput",
          id: "claude-structured",
          input: document,
        }],
      },
    },
    {
      type: "user",
      session_id: sessionNonce,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "claude-structured",
          content: "accepted",
        }],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionNonce,
      modelUsage: {
        k3: {
          canonicalModel: "k3",
          provider: "firstParty",
        },
      },
      structured_output: document,
    },
  );
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** Returns the two mandatory read-only evaluation transcript commands. */
export function evaluationTranscriptTools() {
  return [
    {
      command:
        "/bin/zsh -lc \"node 'scripts/maintainer.mjs' eval-bind\"",
    },
    {
      command:
        "/bin/zsh -lc \"node --input-type=module -e \\\"import { createHash } from 'node:crypto'; import { fingerprintTree, countTreeFiles } from './scripts/lib/git.mjs'; console.log(createHash('sha256').update(JSON.stringify({tree_fingerprint:fingerprintTree('.'),file_count:countTreeFiles('.')})).digest('hex'));\\\"\"",
    },
  ];
}

/** Returns one deterministic read-only GitHub capability proof. */
export function githubCapability({
  account = "example-user",
  repository = "example/skill",
  relationship = "managed",
  defaultBranch = "main",
  immutableReleases = false,
} = {}) {
  return buildGithubCapabilityProof({
    account,
    repository,
    permission: relationship === "managed" ? "ADMIN" : "READ",
    defaultBranch,
    immutableReleases,
    inspectedAt: "2026-07-28T08:00:00.000Z",
  });
}

/** Runs Git in a test repository and returns trimmed stdout. */
export function runGit(repository, ...arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

/** Initializes a deterministic local Git repository. */
export function initializeRepository(repository) {
  mkdirSync(repository, { recursive: true });
  runGit(repository, "init", "-b", "main");
  runGit(repository, "config", "user.name", "Test User");
  runGit(repository, "config", "user.email", "test@example.invalid");
  writeFileSync(
    join(repository, "SKILL.md"),
    "---\nname: example-skill\n---\nbase\n",
    "utf8",
  );
  runGit(repository, "add", "SKILL.md");
  runGit(repository, "commit", "-m", "base");
}

/** Creates installed, source, and candidate roots for one isolated test. */
export function createIsolationFixture({
  prefix = "maintainer-git-",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const installed = join(root, "installed", "example-skill");
  const source = join(root, "source");
  const candidates = join(root, "candidates");
  mkdirSync(installed, { recursive: true });
  mkdirSync(candidates);
  writeFileSync(
    join(installed, "SKILL.md"),
    "---\nname: example-skill\n---\ninstalled\n",
    "utf8",
  );
  initializeRepository(source);
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: example-skill\n---\nsource\n",
    "utf8",
  );
  runGit(source, "add", "SKILL.md");
  runGit(source, "commit", "-m", "source");
  return { root, installed, source, candidates };
}

/** Returns one complete accepted optimization fixture. */
export function optimizationFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "OPT-001",
    feedback_ids: ["FB-001"],
    intent_evidence: "既有能力合同。",
    problem_evidence: "固定輸入可重現。",
    owner: "example-skill",
    scope: "既有能力範圍。",
    closure: "補上缺失閉環。",
    minimum_change: "只修改必要規則。",
    regression_case: "固定輸入不得再次失敗。",
    generalized_value: "避免同類錯誤。",
    confidence: "high",
    decision_status: "accepted",
    decision_reason: "問題可重現且符合能力初衷。",
    ...overrides,
  };
}

/** Returns one complete redacted evidence fixture. */
export function evidenceFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "EV-001",
    source_type: "current-run",
    source_ref: "sha256:example-evidence",
    skill_version: "0.1.0",
    redacted_summary: "使用者修正了錯誤的步驟選擇。",
    confidence: "high",
    ...overrides,
  };
}

/** Returns one complete feedback fixture. */
export function feedbackFixture(overrides = {}) {
  return {
    schema_version: 1,
    id: "FB-001",
    target_skill: "example-skill",
    phenomenon: "代理選擇了不符合既有意圖的步驟。",
    expected_behavior: "應依目標 Skill 的既有邊界選擇步驟。",
    source_ids: ["EV-001"],
    skill_version: "0.1.0",
    reproduction: "已由固定輸入重現。",
    missing_evidence: [],
    classification: "skill-defect",
    confidence: "high",
    provisional_owner: "example-skill",
    ...overrides,
  };
}

/** Returns one isolated candidate snapshot fixture. */
export function candidateFixture(overrides = {}) {
  return {
    schema_version: 1,
    repository_snapshot: {
      schema_version: 1,
      base_ref: "main",
      merge_base: "abc123",
      head_commit: "abc123",
      diff_hash: "a".repeat(64),
      changed_files: [],
      process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
    },
    candidate_diff_hash: "b".repeat(64),
    skill_path: ".",
    skill_name: "example-skill",
    candidate_skill_fingerprint: "c".repeat(64),
    evaluation_fixture_path:
      "evals/cases/evaluation-binding-heldout.json",
    evaluation_fixture_sha256: BLINDED_FORWARD_FIXTURE_SHA256,
    changed_files: ["SKILL.md", "tests/regression.txt"],
    approved_opt_ids: ["OPT-001"],
    process_artifact_prefixes: ["docs/plans/", "docs/specs/"],
    file_opt_map: {
      "SKILL.md": ["OPT-001"],
      "tests/regression.txt": ["OPT-001"],
    },
    diff_mapping_complete: true,
    isolated: true,
    ...overrides,
  };
}

/** Builds the repository identity used by the locked forward fixture. */
export function forwardEvaluationRepositorySnapshot(repository) {
  return buildRepositorySnapshot(repository, {
    baseRef: FORWARD_EVALUATION_BASELINE_COMMIT,
    processArtifactPrefixes:
      FORWARD_EVALUATION_PROCESS_ARTIFACT_PREFIXES,
  });
}

/** Resolves one portable Git path beneath a materialization root. */
export function resolveMaterializedTestPath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\")
  ) {
    throw new Error("test baseline path is not portable");
  }
  const target = resolve(root, ...relativePath.split("/"));
  const containment = relative(resolve(root), target);
  if (
    containment === "" ||
    containment === ".." ||
    containment.startsWith(`..${sep}`) ||
    isAbsolute(containment)
  ) {
    throw new Error("test baseline path escapes materialization root");
  }
  return target;
}

/** Resolves a candidate Skill root beneath a materialization root. */
export function resolveMaterializedTestRoot(root, skillPath) {
  if (skillPath === ".") {
    return resolve(root);
  }
  return resolveMaterializedTestPath(root, skillPath);
}

/** Materializes one immutable baseline subtree without archive extraction. */
function materializeForwardEvaluationBaseline(
  repository,
  candidateSnapshot,
  destinationRoot,
) {
  const commit = validateCommit(
    candidateSnapshot.repository_snapshot.merge_base,
    "test baseline merge_base",
  );
  const objectType = runSafeGit(
    repository,
    ["cat-file", "-t", commit],
    {
      readOnly: true,
      label: "Git test baseline commit",
    },
  ).trim();
  if (objectType !== "commit") {
    throw new Error("test baseline merge_base must resolve to a commit");
  }
  const skillPath = candidateSnapshot.skill_path;
  const inspected = inspectCandidateCommitTree(
    repository,
    commit,
    skillPath,
  );
  const destination = resolveMaterializedTestRoot(
    destinationRoot,
    skillPath,
  );
  mkdirSync(destination, { recursive: true });
  for (const relativePath of Object.keys(inspected.file_sha256)) {
    const repositoryPath = skillPath === "."
      ? relativePath
      : `${skillPath}/${relativePath}`;
    const payload = readCandidateCommitRegularFile(
      repository,
      commit,
      repositoryPath,
    );
    const actualSha256 = createHash("sha256")
      .update(payload)
      .digest("hex");
    if (actualSha256 !== inspected.file_sha256[relativePath]) {
      throw new Error("test baseline blob changed during materialization");
    }
    const target = resolveMaterializedTestPath(
      destination,
      relativePath,
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, payload, { flag: "wx" });
    chmodSync(
      target,
      inspected.file_modes[relativePath] === "100755"
        ? 0o755
        : 0o644,
    );
  }
  if (fingerprintTree(destination) !== inspected.fingerprint) {
    throw new Error("test baseline changed during materialization");
  }
  return destination;
}

/** Returns one aggregate binding tied to the exact candidate snapshot. */
export function forwardEvaluationBindingFixture(
  candidateSnapshot,
  candidatePath,
  { includePrivateSources = false } = {},
) {
  const sourceCandidatePath = candidatePath;
  let isolatedEvaluationRoot = null;
  let fixtureContent = readFileSync(
    join(candidatePath, candidateSnapshot.evaluation_fixture_path),
  );
  let fixture = JSON.parse(fixtureContent.toString("utf8"));
  const testPublicKeyPem =
    createPublicKey(TEST_EVALUATOR_PRIVATE_KEY).export({
      type: "spki",
      format: "pem",
    });
  {
    isolatedEvaluationRoot = mkdtempSync(
      join(tmpdir(), "maintainer-evaluation-candidate-"),
    );
    fixture = structuredClone(fixture);
    fixture.evaluator_authority.public_key_pem =
      testPublicKeyPem;
    fixtureContent = Buffer.from(
      `${JSON.stringify(fixture, null, 2)}\n`,
      "utf8",
    );
    candidateSnapshot = {
      ...candidateSnapshot,
      evaluation_fixture_sha256: createHash("sha256")
        .update(fixtureContent)
        .digest("hex"),
    };
    mkdirSync(
      join(
        isolatedEvaluationRoot,
        candidateSnapshot.skill_path,
        "..",
      ),
      { recursive: true },
    );
    cpSync(
      join(sourceCandidatePath, candidateSnapshot.skill_path),
      join(isolatedEvaluationRoot, candidateSnapshot.skill_path),
      { recursive: true },
    );
    mkdirSync(
      join(
        isolatedEvaluationRoot,
        candidateSnapshot.evaluation_fixture_path,
        "..",
      ),
      { recursive: true },
    );
    writeFileSync(
      join(
        isolatedEvaluationRoot,
        candidateSnapshot.evaluation_fixture_path,
      ),
      fixtureContent,
    );
    mkdirSync(join(isolatedEvaluationRoot, "scripts"), {
      recursive: true,
    });
    cpSync(
      join(
        sourceCandidatePath,
        "scripts",
        "neutral-evaluation-controller.mjs",
      ),
      join(
        isolatedEvaluationRoot,
        "scripts",
        "neutral-evaluation-controller.mjs",
      ),
    );
    candidatePath = isolatedEvaluationRoot;
  }
  const runtimePath = join(candidatePath, candidateSnapshot.skill_path);
  const lockedBaselineFingerprint =
    fixture.runtime_bundle.baseline_tree_fingerprint;
  const baselineRuntimeRoot = mkdtempSync(
    join(tmpdir(), "maintainer-baseline-runtime-"),
  );
  const baselineRuntimePath = materializeForwardEvaluationBaseline(
    sourceCandidatePath,
    candidateSnapshot,
    baselineRuntimeRoot,
  );
  if (
    fingerprintTree(baselineRuntimePath) !==
    lockedBaselineFingerprint
  ) {
    throw new Error(
      "test baseline merge_base does not match the locked fixture",
    );
  }
  const controllerPath = NEUTRAL_CONTROLLER_PATH;
  fixture.evaluator_authority.controller_sha256 =
    createHash("sha256")
      .update(readFileSync(controllerPath))
      .digest("hex");
  fixture.usage_evidence.current_run.candidate_skill_fingerprint =
    fingerprintTree(runtimePath);
  fixture.runtime_bundle.baseline_tree_fingerprint =
    fingerprintTree(baselineRuntimePath);
  fixture.runtime_bundle.baseline_file_count =
    countTreeFiles(baselineRuntimePath);
  fixture.runtime_bundle.candidate_tree_fingerprint =
    fingerprintTree(runtimePath);
  fixture.runtime_bundle.candidate_file_count =
    countTreeFiles(runtimePath);
  for (const relativePath of fixture.target_files.paths) {
    fixture.target_files.baseline_sha256[relativePath] =
      createHash("sha256")
        .update(readFileSync(join(baselineRuntimePath, relativePath)))
        .digest("hex");
    fixture.target_files.candidate_sha256[relativePath] =
      createHash("sha256")
        .update(readFileSync(join(runtimePath, relativePath)))
        .digest("hex");
  }
  fixtureContent = Buffer.from(
    `${JSON.stringify(fixture, null, 2)}\n`,
    "utf8",
  );
  candidateSnapshot = {
    ...candidateSnapshot,
    evaluation_fixture_sha256: createHash("sha256")
      .update(fixtureContent)
      .digest("hex"),
  };
  writeFileSync(
    join(
      candidatePath,
      candidateSnapshot.evaluation_fixture_path,
    ),
    fixtureContent,
  );
  const fixtureRaw = fixtureContent.toString("utf8");
  const evaluationInputSha256 = evaluationInputFingerprint(fixture);
  const candidateSmoke = observeRuntimeCliSmoke(runtimePath);
  const baselineSmoke = observeRuntimeCliSmoke(baselineRuntimePath);
  const runtimeBundles = {
    a: {
      tree_fingerprint: fingerprintTree(baselineRuntimePath),
      file_count: countTreeFiles(baselineRuntimePath),
      cli_smoke_sha256: fingerprint(baselineSmoke),
    },
    b: {
      tree_fingerprint: fingerprintTree(runtimePath),
      file_count: countTreeFiles(runtimePath),
      cli_smoke_sha256: fingerprint(candidateSmoke),
    },
  };
  const verdict = (id, label) => ({
    verdict:
      label === "b" || id === fixture.required_behaviors.at(-1)
        ? "pass"
        : "fail",
    rationale_summary: `${label} verdict for ${id}.`,
    evidence_summary: `${label} evidence for ${id}.`,
    clause_evidence: Object.fromEntries(
      fixture.behavior_contracts[id].map((clause) => [
        clause,
        `${label} evidence for ${id}.${clause}.`,
      ]),
    ),
  });
  const seed = Buffer.alloc(32);
  const assignment = {
    seed_base64: seed.toString("base64"),
    seed_commitment_sha256: createHash("sha256")
      .update(seed)
      .digest("hex"),
    evaluation_input_sha256:
      evaluationInputFingerprint(fixture),
    baseline_label: "a",
    candidate_label: "b",
    model_id: "same-test-model",
    committed_at: "2030-01-01T00:00:10.000Z",
  };
  const generatorInputViewSha256 = Object.fromEntries(
    ["a", "b"].map((label) => [
      label,
      fingerprint(
        buildGeneratorEvaluationInputView(
          fixture,
          assignment,
          label,
          runtimeBundles[label],
        ),
      ),
    ]),
  );
  const generatorOutput = (label) => JSON.stringify({
    evaluation_input_sha256: evaluationInputSha256,
    input_view_sha256: generatorInputViewSha256[label],
    runtime_bundle: runtimeBundles[label],
    behaviors: fixture.required_behaviors.map((id) => ({
      id,
      ...verdict(id, label),
    })),
    quality: {
      false_positive_optimizations: 0,
      rationale_summary: `${label} quality gate passed.`,
      evidence_summary: `${label} evidence matches the locked rubric.`,
    },
  });
  const labelA = {
    output: generatorOutput("a"),
    events: codexTranscript(
      "test-label-a",
      generatorOutput("a"),
      evaluationTranscriptTools(),
    ),
  };
  const labelB = {
    output: generatorOutput("b"),
    events: codexTranscript(
      "test-label-b",
      generatorOutput("b"),
      evaluationTranscriptTools(),
    ),
  };
  const measurement = buildBlindedMeasurement({
    fixture,
    labelA,
    labelB,
    measuredAt: "2030-01-01T00:08:30.000Z",
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
      runtimeBundles,
    }),
  );
  const judgeOutput = {
    evaluation_input_sha256: evaluationInputSha256,
    input_view_sha256: judgeInputViewSha256,
    behaviors: fixture.required_behaviors.map((id) => ({
      id,
      label_a: verdict(id, "a"),
      label_b: verdict(id, "b"),
    })),
    quality: {
      false_positive_optimizations: 0,
      rationale_summary: "Synthetic quality gate passed.",
      evidence_summary: "No synthetic false positive was recorded.",
    },
  };
  const judgeRawOutput = JSON.stringify(judgeOutput);
  const judgeInputView = buildJudgeEvaluationInputView(fixture, {
    labelInputViewSha256: generatorInputViewSha256,
    opaqueLabelOutputSha256: {
      a: fingerprint(buildOpaqueJudgeLabelOutput(labelA.output)),
      b: fingerprint(buildOpaqueJudgeLabelOutput(labelB.output)),
    },
    runtimeBundles,
  });
  const judgeInputBundle = buildJudgeEvaluationInputBundle(
    judgeInputView,
    {
      a: labelA.output,
      b: labelB.output,
    },
  );
  const sessions = {
    model_id: "same-test-model",
    label_a: {
      session_nonce: "test-label-a",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: generatorInputViewSha256.a,
      output_sha256: measurement.labels.a.output_sha256,
      transcript_sha256: measurement.labels.a.events_sha256,
      transcript: labelA.events,
      tool_calls: measurement.labels.a.tool_calls,
      tool_sequence_sha256:
        measurement.labels.a.tool_sequence_sha256,
      runtime_path: baselineRuntimePath,
      cli_smoke: baselineSmoke,
      started_at: "2030-01-01T00:01:00.000Z",
      completed_at: "2030-01-01T00:08:00.000Z",
    },
    label_b: {
      session_nonce: "test-label-b",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: generatorInputViewSha256.b,
      output_sha256: measurement.labels.b.output_sha256,
      transcript_sha256: measurement.labels.b.events_sha256,
      transcript: labelB.events,
      tool_calls: measurement.labels.b.tool_calls,
      tool_sequence_sha256:
        measurement.labels.b.tool_sequence_sha256,
      runtime_path: runtimePath,
      cli_smoke: candidateSmoke,
      started_at: "2030-01-01T00:01:00.000Z",
      completed_at: "2030-01-01T00:08:00.000Z",
    },
    judge: {
      session_nonce: "test-judge",
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: judgeInputViewSha256,
      input_bundle: judgeInputBundle,
      input_bundle_sha256: fingerprint(judgeInputBundle),
      output_sha256: fingerprint(judgeOutput),
      raw_output: judgeRawOutput,
      transcript: codexTranscript(
        "test-judge",
        judgeRawOutput,
      ),
      transcript_sha256: createHash("sha256")
        .update(codexTranscript("test-judge", judgeRawOutput))
        .digest("hex"),
      tool_calls: 0,
      tool_sequence_sha256: fingerprint([]),
      started_at: "2030-01-01T00:09:00.000Z",
      completed_at: "2030-01-01T00:10:00.000Z",
    },
  };
  const platformRoot = mkdtempSync(
    join(tmpdir(), "maintainer-platform-source-"),
  );
  const unblindedAt = "2030-01-01T00:10:20.000Z";
  const challengePayload = {
    schema_version: 1,
    authority_id:
      fixture.evaluator_authority.authority_id,
    authority_version:
      fixture.evaluator_authority.version,
    controller_sha256:
      fixture.evaluator_authority.controller_sha256,
    candidate_skill_fingerprint:
      candidateSnapshot.candidate_skill_fingerprint,
    evaluation_input_sha256: evaluationInputSha256,
    issued_at: unblindedAt,
    expires_at: "2030-01-01T01:10:20.000Z",
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
  const challengeAttestation = {
    ...challengePayload,
    payload_sha256: fingerprint(challengePayload),
    signature_base64: sign(
      null,
      Buffer.from(canonicalJson(challengePayload), "utf8"),
      TEST_EVALUATOR_PRIVATE_KEY,
    ).toString("base64"),
  };
  const outputPath = (platform, caseId, index) => {
    const path = join(
      platformRoot,
      `${platform}-${caseId}.json`,
    );
    const transcriptPath = join(
      platformRoot,
      `${platform}-${caseId}.jsonl`,
    );
    const positive = caseId === "positive";
    const requestedProjectRoot = join(
      platformRoot,
      `${platform}-${caseId}-project`,
    );
    const installationRelativePath =
      TEST_PLATFORM_INSTALL_PATHS[platform];
    const installedSkillRoot = join(
      requestedProjectRoot,
      installationRelativePath,
    );
    mkdirSync(join(installedSkillRoot, ".."), {
      recursive: true,
    });
    cpSync(runtimePath, installedSkillRoot, { recursive: true });
    const projectRoot = realpathSync(requestedProjectRoot);
    const installedIdentity = {
      tree_fingerprint: fingerprintTree(installedSkillRoot),
      file_count: countTreeFiles(installedSkillRoot),
    };
    const document = {
      schema_version: 1,
      case: caseId,
      evaluation_input_sha256: evaluationInputSha256,
      candidate_skill_fingerprint:
        candidateSnapshot.candidate_skill_fingerprint,
      platform,
      platform_version: "test-version",
      challenge_nonce:
        `${platform}-${caseId}-challenge`,
      started_at:
        `2030-01-01T00:10:${21 + index * 2}.000Z`,
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
        evidence: [`${platform} ${caseId} fixture`],
      },
    };
    const output = JSON.stringify(document);
    const providerSessionNonce =
      `${platform}-${caseId}-provider-session`;
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
    const transcript = platform === "codex"
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
    const toolSequence = platform === "codex"
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
                  file_path: join(
                    projectRoot,
                    readPath,
                  ),
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
        platform,
        case: caseId,
        platform_version: "test-version",
        executable_sha256: "e".repeat(64),
        execution_profile_sha256: fingerprint(
          TEST_PLATFORM_EXECUTION_PROFILES[platform],
        ),
        environment_sha256: "a".repeat(64),
        prompt_template_sha256:
          challengePayload.challenges.find(
            (challenge) =>
              challenge.platform === platform &&
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
        challenge_nonce:
          `${platform}-${caseId}-challenge`,
        started_at: document.started_at,
        completed_at:
          `2030-01-01T00:10:${22 + index * 2}.000Z`,
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
  const platformRows = ["codex", "claude-code"].map(
    (id, index) => {
      const positive = outputPath(id, "positive", index * 2);
      const negative = outputPath(id, "negative", index * 2 + 1);
      return { id, positive, negative };
    },
  );
  const completionPayload = {
    schema_version: 1,
    authority_id:
      fixture.evaluator_authority.authority_id,
    authority_version:
      fixture.evaluator_authority.version,
    controller_sha256:
      fixture.evaluator_authority.controller_sha256,
    candidate_skill_fingerprint:
      candidateSnapshot.candidate_skill_fingerprint,
    evaluation_input_sha256: evaluationInputSha256,
    challenge_payload_sha256:
      challengeAttestation.payload_sha256,
    attested_at: "2030-01-01T00:10:30.000Z",
    sessions: platformRows.flatMap(
      ({ positive, negative }) => [
        positive.completion,
        negative.completion,
      ],
    ),
  };
  const completionAttestation = {
    ...completionPayload,
    payload_sha256: fingerprint(completionPayload),
    signature_base64: sign(
      null,
      Buffer.from(canonicalJson(completionPayload), "utf8"),
      TEST_EVALUATOR_PRIVATE_KEY,
    ).toString("base64"),
  };
  const platformSource = {
    schema_version: 1,
    candidate_skill_fingerprint:
      candidateSnapshot.candidate_skill_fingerprint,
    challenge_attestation: challengeAttestation,
    completion_attestation: completionAttestation,
    installer: {
      name: "skills",
      version: "test-version",
      scope: "isolated-project-copy",
    },
    installed_copies: platformRows.flatMap(
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
    platforms: platformRows.map(({ id, positive, negative }) => {
      return {
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
      };
    }),
    environment_baseline_failures: [],
  };
  const platformValidationEvidence = capturePlatformValidationEvidence(
    platformSource,
    {
      fixture,
      candidateSkillFingerprint:
        candidateSnapshot.candidate_skill_fingerprint,
      minimumValidatedAt: unblindedAt,
    },
  );
  const privateKeyPath = join(platformRoot, "authority-private.pem");
  writeFileSync(
    privateKeyPath,
    TEST_EVALUATOR_PRIVATE_KEY.export({
      type: "pkcs8",
      format: "pem",
    }),
    { mode: 0o600 },
  );
  const authorityRequestPath = join(
    platformRoot,
    "authority-request.json",
  );
  writeFileSync(
    authorityRequestPath,
    JSON.stringify({
      candidateSkillFingerprint:
        candidateSnapshot.candidate_skill_fingerprint,
      fixtureSha256:
        candidateSnapshot.evaluation_fixture_sha256,
      fixtureRaw,
      fixture,
      assignment,
      sessions,
      labelA,
      labelB,
      judgeOutput,
      measuredAt: "2030-01-01T00:08:30.000Z",
      unblindedAt,
      platformValidationEvidence,
    }),
    "utf8",
  );
  const authorityRun = spawnSync(
    process.execPath,
    [controllerPath, authorityRequestPath, privateKeyPath],
    { encoding: "utf8" },
  );
  if (authorityRun.status !== 0) {
    throw new Error(
      `test neutral evaluator failed: ${authorityRun.stderr}`,
    );
  }
  const evaluatorAttestation = JSON.parse(authorityRun.stdout);
  let retainedPrivateSources = false;
  try {
    const binding = buildForwardEvaluationBinding(
      candidateSnapshot,
      {
        fixture,
        assignment,
        sessions,
        labelA,
        labelB,
        judgeOutput,
        measuredAt: "2030-01-01T00:08:30.000Z",
        unblindedAt,
        platformValidationSource: platformSource,
        candidatePath,
        evaluatorAttestation,
      },
    );
    if (!includePrivateSources) {
      return binding;
    }
    retainedPrivateSources = true;
    return {
      binding,
      sources: {
        candidatePath,
        candidateSnapshot,
        fixture,
        assignment,
        sessions,
        labelA,
        labelB,
        judgeOutput,
        measuredAt: "2030-01-01T00:08:30.000Z",
        unblindedAt,
        platformValidationSource: platformSource,
        platformValidationEvidence,
        evaluatorAttestation,
        fixtureRaw,
        authorityPrivateKeyPath: privateKeyPath,
        neutralControllerPath: controllerPath,
      },
      cleanup: () => {
        rmSync(platformRoot, { recursive: true, force: true });
        if (baselineRuntimeRoot !== null) {
          rmSync(baselineRuntimeRoot, {
            recursive: true,
            force: true,
          });
        }
        if (isolatedEvaluationRoot !== null) {
          rmSync(isolatedEvaluationRoot, {
            recursive: true,
            force: true,
          });
        }
      },
    };
  } finally {
    if (!retainedPrivateSources) {
      rmSync(platformRoot, { recursive: true, force: true });
    }
    if (!retainedPrivateSources && baselineRuntimeRoot !== null) {
      RETAINED_RUNTIME_ROOTS.push(baselineRuntimeRoot);
    }
    if (!retainedPrivateSources && isolatedEvaluationRoot !== null) {
      RETAINED_RUNTIME_ROOTS.push(isolatedEvaluationRoot);
    }
  }
}

/** Builds a verified binding and approval for the current source head. */
export function sourceApproval(
  source,
  installedFingerprint,
  relationship = "managed",
) {
  const snapshot = buildRepositorySnapshot(source, { baseRef: "main" });
  const optimization = optimizationFixture();
  const binding = {
    schema_version: 1,
    binding_id: "binding-001",
    skill: "example-skill",
    source_repository: "example/skill",
    installed_fingerprint: installedFingerprint,
    install_method: "manual",
    remote_verified: true,
    relationship,
    release_enabled: false,
  };
  const approval = buildApproval([optimization], {
    runId: "run-001",
    bindingId: binding.binding_id,
    relationship,
    repository: binding.source_repository,
    headCommit: snapshot.head_commit,
    diffHash: snapshot.diff_hash,
    processArtifactPrefixes: snapshot.process_artifact_prefixes,
  });
  return { snapshot, optimization, binding, relationship, approval };
}

/** Creates one clean committed candidate suitable for branch-push tests. */
export function createBranchPushFixture({
  prefix = "maintainer-push-",
  candidateName = "push-run",
  branchName = "maintain/push-run",
  relationship = "managed",
} = {}) {
  const fixture = createIsolationFixture({ prefix });
  mkdirSync(join(fixture.source, "skill", "scripts"), {
    recursive: true,
  });
  mkdirSync(join(fixture.source, "skill", "references"), {
    recursive: true,
  });
  writeFileSync(
    join(fixture.source, "skill", "SKILL.md"),
    "---\nname: example-skill\n---\nbaseline skill\n",
    "utf8",
  );
  writeFileSync(
    join(fixture.source, "skill", "scripts", "maintainer.mjs"),
    [
      "#!/usr/bin/env node",
      "process.stderr.write(",
      "  `${JSON.stringify({ command: process.argv[2] ?? null, error: \"未知或缺少命令\", valid: false })}\\n`,",
      ");",
      "process.exitCode = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(fixture.source, "skill", "references", "evaluation.md"),
    "# Evaluation\nBaseline evaluation reference.\n",
    "utf8",
  );
  writeFileSync(
    join(
      fixture.source,
      "skill",
      "references",
      "security-and-privacy.md",
    ),
    "# Security\nBaseline security reference.\n",
    "utf8",
  );
  runSafeGit(fixture.source, ["add", "skill"], {
    label: "Git branch fixture baseline",
  });
  runSafeGit(
    fixture.source,
    ["commit", "-m", "baseline skill"],
    { label: "Git branch fixture baseline" },
  );
  const baselineSkillFingerprint = fingerprintTree(
    join(fixture.source, "skill"),
  );
  const baselineSkillFileCount = countTreeFiles(
    join(fixture.source, "skill"),
  );
  const baselineSkillHash = createHash("sha256")
    .update(readFileSync(join(fixture.source, "skill", "SKILL.md")))
    .digest("hex");
  const installedFingerprint = fingerprintTree(fixture.installed);
  const {
    snapshot: repositorySnapshot,
    optimization,
    binding,
    approval: implementationApproval,
  } = sourceApproval(
    fixture.source,
    installedFingerprint,
    relationship,
  );
  const isolated = createIsolatedCandidate({
    installedPath: fixture.installed,
    expectedInstalledFingerprint: installedFingerprint,
    sourcePath: fixture.source,
    candidateRoot: fixture.candidates,
    candidateName,
    branchName,
    baseRef: "main",
    repository: binding.source_repository,
    runId: "run-001",
    binding,
    relationship,
    optimizations: [optimization],
    approval: implementationApproval,
  });
  runGit(isolated.candidate_path, "config", "user.name", "Test User");
  runGit(
    isolated.candidate_path,
    "config",
    "user.email",
    "test@example.invalid",
  );
  runGit(
    isolated.candidate_path,
    "config",
    "core.autocrlf",
    "false",
  );
  writeFileSync(
    join(isolated.candidate_path, "SKILL.md"),
    "---\nname: decoy-skill\n---\nsource\nbranch push\n",
    "utf8",
  );
  mkdirSync(join(isolated.candidate_path, "skill"), {
    recursive: true,
  });
  writeFileSync(
    join(isolated.candidate_path, "skill", "SKILL.md"),
    "---\nname: example-skill\n---\nbranch push skill\n",
    "utf8",
  );
  mkdirSync(
    join(isolated.candidate_path, "skill", "scripts"),
    { recursive: true },
  );
  mkdirSync(
    join(isolated.candidate_path, "skill", "references"),
    { recursive: true },
  );
  writeFileSync(
    join(
      isolated.candidate_path,
      "skill",
      "scripts",
      "maintainer.mjs",
    ),
    [
      "#!/usr/bin/env node",
      "process.stderr.write(",
      "  `${JSON.stringify({ command: process.argv[2] ?? null, error: \"缺少必要參數：--candidate-snapshot\", valid: false })}\\n`,",
      ");",
      "process.exitCode = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(
      isolated.candidate_path,
      "skill",
      "references",
      "evaluation.md",
    ),
    "# Evaluation\nSynthetic evaluation reference.\n",
    "utf8",
  );
  writeFileSync(
    join(
      isolated.candidate_path,
      "skill",
      "references",
      "security-and-privacy.md",
    ),
    "# Security\nSynthetic security reference.\n",
    "utf8",
  );
  const candidateSkillFingerprint = fingerprintTree(
    join(isolated.candidate_path, "skill"),
  );
  mkdirSync(join(isolated.candidate_path, "scripts"), {
    recursive: true,
  });
  writeFileSync(
    join(
      isolated.candidate_path,
      "scripts",
      "neutral-evaluation-controller.mjs",
    ),
    readFileSync(NEUTRAL_CONTROLLER_PATH),
  );
  const fixtureDocument = structuredClone(BLINDED_FORWARD_FIXTURE);
  fixtureDocument.evaluator_authority.controller_sha256 =
    createHash("sha256")
      .update(readFileSync(NEUTRAL_CONTROLLER_PATH))
      .digest("hex");
  fixtureDocument.evaluator_authority.public_key_pem =
    createPublicKey(TEST_EVALUATOR_PRIVATE_KEY).export({
      type: "spki",
      format: "pem",
    });
  fixtureDocument.usage_evidence.current_run.candidate_skill_fingerprint =
    candidateSkillFingerprint;
  fixtureDocument.runtime_bundle.candidate_tree_fingerprint =
    candidateSkillFingerprint;
  fixtureDocument.runtime_bundle.candidate_file_count = countTreeFiles(
    join(isolated.candidate_path, "skill"),
  );
  fixtureDocument.runtime_bundle.baseline_tree_fingerprint =
    baselineSkillFingerprint;
  fixtureDocument.runtime_bundle.baseline_file_count =
    baselineSkillFileCount;
  fixtureDocument.quality_thresholds
    .candidate_minimum_gain_over_baseline = 0;
  const skillHash = createHash("sha256")
    .update(readFileSync(
      join(isolated.candidate_path, "skill", "SKILL.md"),
    ))
    .digest("hex");
  fixtureDocument.target_files = {
    paths: ["SKILL.md"],
    baseline_sha256: { "SKILL.md": baselineSkillHash },
    candidate_sha256: { "SKILL.md": skillHash },
  };
  mkdirSync(join(isolated.candidate_path, "evals", "cases"), {
    recursive: true,
  });
  writeFileSync(
    join(
      isolated.candidate_path,
      "evals",
      "cases",
      "evaluation-binding-heldout.json",
    ),
    `${JSON.stringify(fixtureDocument, null, 2)}\n`,
    "utf8",
  );
  runGit(
    isolated.candidate_path,
    "add",
    "SKILL.md",
    "skill/SKILL.md",
    "skill/references/evaluation.md",
    "skill/references/security-and-privacy.md",
    "skill/scripts/maintainer.mjs",
    "scripts/neutral-evaluation-controller.mjs",
    "evals/cases/evaluation-binding-heldout.json",
  );
  runGit(isolated.candidate_path, "commit", "-m", "branch push");
  const candidateSnapshot = buildCandidateSnapshot({
    candidatePath: isolated.candidate_path,
    installedPath: fixture.installed,
    sourcePath: fixture.source,
    skillPath: "skill",
    targetSkill: "example-skill",
    targetSkillPath: "skill",
    evaluationFixturePath:
      "evals/cases/evaluation-binding-heldout.json",
    baseRef: "main",
    approvedOptIds: ["OPT-001"],
    fileOptMap: {
      "SKILL.md": ["OPT-001"],
      "skill/SKILL.md": ["OPT-001"],
      "skill/references/evaluation.md": ["OPT-001"],
      "skill/references/security-and-privacy.md": ["OPT-001"],
      "skill/scripts/maintainer.mjs": ["OPT-001"],
      "scripts/neutral-evaluation-controller.mjs": ["OPT-001"],
      "evals/cases/evaluation-binding-heldout.json": ["OPT-001"],
    },
  });
  return {
    ...fixture,
    candidate: isolated.candidate_path,
    branch: isolated.branch,
    binding,
    implementationApproval,
    repositorySnapshot,
    candidateSnapshot,
  };
}

/** Returns a deterministic GitHub CLI runner for branch-push tests. */
export function branchPushGithubRunner(
  state,
  {
    forkAvailable = true,
    forkParent = state.repository,
    forkPermission = "WRITE",
    onSetupGit = () => {},
  } = {},
) {
  return (arguments_, options = {}) => {
    if (arguments_[0] === "api" && arguments_[1] === "user") {
      return { status: 0, stdout: `${state.account}\n`, stderr: "" };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === state.repository
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: state.repository,
          viewerPermission:
            state.relationship === "managed" ? "ADMIN" : "READ",
          defaultBranchRef: { name: state.base_branch },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "repo" &&
      arguments_[1] === "view" &&
      arguments_[2] === state.action_target.head_repository
    ) {
      if (!forkAvailable) {
        return {
          status: 1,
          stdout: "",
          stderr: "repository not found",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          nameWithOwner: state.action_target.head_repository,
          viewerPermission: forkPermission,
          parent: { nameWithOwner: forkParent },
        }),
        stderr: "",
      };
    }
    if (
      arguments_[0] === "api" &&
      arguments_[1] ===
        `repos/${state.repository}/branches/${state.base_branch}`
    ) {
      return {
        status: 0,
        stdout: `${state.base_commit}\n`,
        stderr: "",
      };
    }
    if (arguments_[0] === "auth" && arguments_[1] === "setup-git") {
      onSetupGit(options.environment);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh call: ${arguments_.join(" ")}`);
  };
}

/** Rewrites verified HTTPS remotes to local bare remotes for integration tests. */
export function localRemoteGitRunner(
  remoteMap,
  { beforePush = () => {} } = {},
) {
  return (repository, arguments_, options) => {
    if (arguments_[0] === "push") {
      beforePush();
    }
    return runSafeGit(
      repository,
      arguments_.map((value) => remoteMap.get(value) ?? value),
      options,
    );
  };
}
