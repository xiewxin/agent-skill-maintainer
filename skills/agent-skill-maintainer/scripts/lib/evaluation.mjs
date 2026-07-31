/**
 * Traceable blinded adjudication, local measurement and aggregate derivation.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  buildValidationResult,
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  redactText,
  resolveCandidatePath,
  validateCandidateSnapshotContract,
  validateDocument,
} from "./core.mjs";
import {
  countTreeFiles,
  fingerprintTree,
  readCandidateRegularFile,
} from "./git.mjs";

const LABELS = Object.freeze(["a", "b"]);
const VERDICTS = new Set(["pass", "fail", "insufficient_evidence"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLATFORM_CASES = Object.freeze(["positive", "negative"]);
const PLATFORM_CHALLENGE_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_ROUTE_ENVIRONMENT_POLICY_ID =
  "formal-default-route-v1";
const CURRENT_ENVIRONMENT_POLICY_ID =
  "formal-current-environment-v1";
const PLATFORM_SKILL_NAME = "agent-skill-maintainer";
const PLATFORM_INSTALL_PATHS = Object.freeze({
  codex: `.agents/skills/${PLATFORM_SKILL_NAME}`,
  "claude-code": `.claude/skills/${PLATFORM_SKILL_NAME}`,
});
const REQUIRED_PLATFORM_READ_PATHS = Object.freeze([
  "SKILL.md",
  "references/evaluation.md",
  "references/security-and-privacy.md",
]);
const TRANSCRIPT_TOOL_TYPES = Object.freeze([
  "command_execution",
  "todo_list",
]);
const FORBIDDEN_TRANSCRIPT_PATH_PARTS = Object.freeze([
  "/.agents/skills/",
  "/candidates/",
  "/private/",
  ".agents/skills/",
  "candidates/",
  "private/",
]);
const PLATFORM_EXECUTION_PROFILES = Object.freeze({
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
    installation_relative_path: PLATFORM_INSTALL_PATHS.codex,
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
      PLATFORM_INSTALL_PATHS["claude-code"],
    prompt_policy: "controller-owned-platform-case-v2",
    transcript_policy: "strict-read-only-claude-stream-v2",
  }),
});

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns the exact project-relative reads required by a positive case. */
function requiredPlatformReadPaths(platform) {
  const installationPath = PLATFORM_INSTALL_PATHS[platform];
  return REQUIRED_PLATFORM_READ_PATHS.map(
    (path) => `${installationPath}/${path}`,
  );
}

/** Validates the controller-signed required-read identity set. */
function requiredReadMap(requiredReads, platform) {
  const expectedPaths = requiredPlatformReadPaths(platform);
  if (
    !Array.isArray(requiredReads) ||
    requiredReads.length !== expectedPaths.length ||
    requiredReads.some(
      (item) =>
        !hasExactKeys(item, ["path", "sha256"]) ||
        !expectedPaths.includes(item.path) ||
        !SHA256_PATTERN.test(item.sha256 ?? ""),
    ) ||
    canonicalJson(
      requiredReads.map((item) => item.path).sort(),
    ) !== canonicalJson([...expectedPaths].sort())
  ) {
    throw new Error("platform required-read identity 不合法");
  }
  return new Map(
    requiredReads.map((item) => [item.path, item.sha256]),
  );
}

/** Removes one provider-added zsh wrapper without executing shell syntax. */
function unwrapTranscriptShellCommand(command) {
  if (typeof command !== "string") {
    return command;
  }
  const prefix = ["/bin/zsh -c ", "/bin/zsh -lc "]
    .find((candidate) => command.startsWith(candidate));
  if (prefix === undefined) {
    return command;
  }
  const payload = command.slice(prefix.length);
  const quote = payload[0];
  if (
    !["\"", "'"].includes(quote) ||
    payload.at(-1) !== quote
  ) {
    return command;
  }
  let inner = payload.slice(1, -1);
  if (quote === "\"") {
    inner = inner.replace(/\\(["\\$`])/gu, "$1");
  } else {
    inner = inner.replace(/'"'"'/gu, "'");
  }
  return inner.startsWith("/bin/zsh -lc ")
    ? inner
    : command;
}

/** Parses one non-expanding shell wrapper into a single argv vector. */
function parseTranscriptCommandWords(command) {
  command = unwrapTranscriptShellCommand(command);
  const prefix = "/bin/zsh -lc ";
  if (
    typeof command !== "string" ||
    !command.startsWith(prefix)
  ) {
    return null;
  }
  const wrapped = command.slice(prefix.length);
  const wrapperQuote = wrapped[0];
  if (
    !["\"", "'"].includes(wrapperQuote) ||
    wrapped.at(-1) !== wrapperQuote
  ) {
    return null;
  }
  let payload = wrapped.slice(1, -1);
  if (wrapperQuote === "\"") {
    if (/\\[$`]/u.test(payload)) {
      return null;
    }
    payload = payload.replace(/\\(["\\])/gu, "$1");
  } else {
    payload = payload.replace(/'"'"'/gu, "'");
  }
  const words = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index];
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") {
        quote = null;
      } else if (character === "\\") {
        const escaped = payload[index + 1];
        if (!["\"", "\\"].includes(escaped)) {
          return null;
        }
        current += escaped;
        index += 1;
      } else if (["$", "`"].includes(character)) {
        return null;
      } else {
        current += character;
      }
      continue;
    }
    if (["'", "\""].includes(character)) {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    if (
      [";", "&", "|", "<", ">", "$", "`", "(", ")", "\n", "\r"]
        .includes(character) ||
      character === "\\"
    ) {
      return null;
    }
    current += character;
  }
  if (quote !== null) {
    return null;
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words.length === 0 ? null : words;
}

/** Recognizes only the fixed read-only runtime observation program. */
function isRuntimeObservation(words) {
  if (
    canonicalJson(words.slice(0, 3)) !==
      canonicalJson([
        "node",
        "--input-type=module",
        "-e",
      ]) ||
    words.length !== 4
  ) {
    return false;
  }
  const compactRuntimeObservation =
    "import { createHash } from 'node:crypto'; import { fingerprintTree, countTreeFiles } from './scripts/lib/git.mjs'; console.log(createHash('sha256').update(JSON.stringify({tree_fingerprint:fingerprintTree('.'),file_count:countTreeFiles('.')})).digest('hex'));";
  if (words[3] === compactRuntimeObservation) {
    return true;
  }
  return /^import \{ createHash \} from 'node:crypto'; import \{ readFileSync \} from 'node:fs'; import \{ fingerprintTree, countTreeFiles \} from '\.\/scripts\/lib\/git\.mjs'; const contract=JSON\.parse\(readFileSync\('\/[^']+\/review-input\/label-[ab]-contract\.json','utf8'\)\); const paths=contract\.view\.target_files\.paths; const sha=\(path\)=>createHash\('sha256'\)\.update\(readFileSync\(path\)\)\.digest\('hex'\); console\.log\(JSON\.stringify\(\{tree_fingerprint:fingerprintTree\('\.'\),file_count:countTreeFiles\('\.'\),target_hashes:Object\.fromEntries\(paths\.map\(\(path\)=>\[path,sha\(path\)\]\)\)\}\)\);$/u
    .test(words[3]);
}

/** Classifies one shell command under the locked read-only transcript policy. */
function classifyTranscriptCommand(command) {
  const words = parseTranscriptCommandWords(command);
  if (words === null) {
    return null;
  }
  if (
    canonicalJson(words) ===
      canonicalJson([
        "node",
        "scripts/maintainer.mjs",
        "eval-bind",
      ])
  ) {
    return "eval_bind_smoke";
  }
  if (isRuntimeObservation(words)) {
    return "runtime_observation";
  }
  if (canonicalJson(words) === canonicalJson(["pwd"])) {
    return "read";
  }
  if (
    words[0] === "sed" &&
    words[1] === "-n" &&
    /^\d+(?:,\d+)?p$/u.test(words[2] ?? "") &&
    words.length === 4
  ) {
    return "read";
  }
  if (
    words[0] === "find" &&
    canonicalJson(words) ===
      canonicalJson(["find", ".", "-type", "f"])
  ) {
    return "read";
  }
  if (
    words[0] === "rg" &&
    words.length >= 2 &&
    words.slice(1).every(
      (word) =>
        !word.startsWith("--pre") &&
        word !== "--engine=pcre2",
    )
  ) {
    return "read";
  }
  return null;
}

/** Rejects tools, commands, and paths outside the locked transcript policy. */
function validateTranscriptToolProfile(
  toolSequence,
  toolProfile,
  { allowedRoot } = {},
) {
  const policy = toolProfile?.transcript_policy;
  if (
    toolProfile?.mode !== "read-only" ||
    toolProfile?.network_access !== false ||
    toolProfile?.filesystem_writes !== false ||
    toolProfile?.remote_writes !== false ||
    canonicalJson(policy?.allowed_item_types) !==
      canonicalJson(TRANSCRIPT_TOOL_TYPES) ||
    canonicalJson(policy?.allowed_command_families) !==
      canonicalJson([
        "eval_bind_smoke",
        "read",
        "runtime_observation",
      ]) ||
    policy?.required_eval_bind_smoke_count !== 1 ||
    policy?.required_runtime_observation_count !== 1 ||
    !Number.isInteger(policy?.max_tool_calls) ||
    policy.max_tool_calls <= 0 ||
    toolSequence.length > policy.max_tool_calls
  ) {
    throw new Error("locked transcript tool profile 不合法");
  }
  const normalizedRoot = allowedRoot === undefined
    ? null
    : resolve(allowedRoot);
  const commandFamilies = [];
  for (const tool of toolSequence) {
    if (!TRANSCRIPT_TOOL_TYPES.includes(tool.type)) {
      throw new Error(`transcript tool type 不允許：${tool.type}`);
    }
    if (tool.type === "todo_list") {
      if (tool.command !== null) {
        throw new Error("todo_list 不可攜帶 command");
      }
      continue;
    }
    const family = classifyTranscriptCommand(tool.command);
    if (!policy.allowed_command_families.includes(family)) {
      throw new Error("transcript command 超出唯讀 allowlist");
    }
    for (const part of FORBIDDEN_TRANSCRIPT_PATH_PARTS) {
      if (tool.command.includes(part)) {
        throw new Error("transcript command 讀取禁止路徑");
      }
    }
    const commandWords =
      parseTranscriptCommandWords(tool.command) ?? [];
    const absolutePaths = [
      ...(tool.command.match(
        /\/(?:Users|home|tmp|var|opt|root|workspace|etc)\/[A-Za-z0-9._~@%+=:,/\\-]+/gu,
      ) ?? []),
      ...commandWords.filter((word) => word.startsWith("/")),
    ];
    if (
      commandWords.some(
        (word) =>
          word === ".." ||
          word.startsWith("../") ||
          word.includes("/../"),
      ) ||
      normalizedRoot !== null &&
      absolutePaths.some((path) => {
        const normalized = resolve(path);
        return normalized !== normalizedRoot &&
          !normalized.startsWith(`${normalizedRoot}${sep}`);
      })
    ) {
      throw new Error("transcript command 讀取 workspace 外路徑");
    }
    commandFamilies.push(family);
  }
  if (
    commandFamilies.filter(
      (family) => family === "eval_bind_smoke",
    ).length !== policy.required_eval_bind_smoke_count ||
    commandFamilies.filter(
      (family) => family === "runtime_observation",
    ).length !== policy.required_runtime_observation_count
  ) {
    throw new Error("transcript 缺少或重複必要唯讀 command");
  }
}

/** Parses one complete Codex JSONL transcript and derives its tool sequence. */
export function inspectCodexTranscript(
  transcript,
  expectedOutput,
  {
    requireNoTools = false,
    toolProfile,
    allowedRoot,
  } = {},
) {
  if (
    typeof transcript !== "string" ||
    transcript.trim().length === 0 ||
    typeof expectedOutput !== "string" ||
    expectedOutput.length === 0
  ) {
    throw new Error("Codex transcript 與 output 必須是非空字串");
  }
  let events;
  try {
    events = transcript
      .trimEnd()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error("Codex transcript 不是完整 JSONL", {
      cause: error,
    });
  }
  const first = events[0];
  const last = events.at(-1);
  const threadEvents = events.filter(
    (event) => event?.type === "thread.started",
  );
  const turnStarts = events.filter(
    (event) => event?.type === "turn.started",
  );
  const turnCompletes = events.filter(
    (event) => event?.type === "turn.completed",
  );
  if (
    first?.type !== "thread.started" ||
    last?.type !== "turn.completed" ||
    threadEvents.length !== 1 ||
    turnStarts.length !== 1 ||
    turnCompletes.length !== 1 ||
    typeof first.thread_id !== "string" ||
    first.thread_id.trim().length === 0 ||
    events.some((event) => event?.type === "error")
  ) {
    throw new Error("Codex transcript 缺少完整 session 邊界");
  }
  const startedTools = new Map();
  const completedTools = new Set();
  const finalMessages = [];
  for (const event of events) {
    const item = event?.item;
    if (
      event?.type === "item.completed" &&
      item?.type === "agent_message"
    ) {
      if (typeof item.text !== "string") {
        throw new Error("Codex transcript agent message 不完整");
      }
      finalMessages.push(item.text);
      continue;
    }
    if (
      event?.type === "item.started" &&
      !["agent_message", "reasoning"].includes(item?.type)
    ) {
      if (
        typeof item?.id !== "string" ||
        item.id.length === 0 ||
        typeof item?.type !== "string" ||
        item.type.length === 0 ||
        startedTools.has(item.id)
      ) {
        throw new Error("Codex transcript tool start 不完整或重複");
      }
      startedTools.set(item.id, {
        id: item.id,
        type: item.type,
        command:
          typeof item.command === "string" ? item.command : null,
      });
      continue;
    }
    if (
      event?.type === "item.completed" &&
      !["agent_message", "reasoning"].includes(item?.type)
    ) {
      if (
        typeof item?.id !== "string" ||
        !startedTools.has(item.id) ||
        completedTools.has(item.id)
      ) {
        throw new Error("Codex transcript tool completion 未配對");
      }
      completedTools.add(item.id);
    }
  }
  if (
    startedTools.size !== completedTools.size ||
    finalMessages.length === 0 ||
    finalMessages.at(-1) !== expectedOutput ||
    (requireNoTools && startedTools.size !== 0)
  ) {
    throw new Error("Codex transcript 與實際 output／tool sequence 不一致");
  }
  const toolSequence = [...startedTools.values()];
  if (toolProfile !== undefined) {
    validateTranscriptToolProfile(
      toolSequence,
      toolProfile,
      { allowedRoot },
    );
  }
  return {
    session_nonce: first.thread_id,
    transcript_sha256: sha256Text(transcript),
    tool_calls: toolSequence.length,
    tool_sequence_sha256: fingerprint(toolSequence),
  };
}

/** Rejects any platform Codex tool that is not a confined read command. */
function validatePlatformCodexTools(
  tools,
  { allowedRoot, caseId, platform, requiredReads },
) {
  const root = resolve(allowedRoot);
  const expectedPaths = requiredPlatformReadPaths(platform);
  const readHashes = requiredReadMap(requiredReads, platform);
  if (
    (caseId === "positive" && tools.length !== expectedPaths.length) ||
    (caseId === "negative" && tools.length !== 0)
  ) {
    throw new Error("Codex platform transcript 讀取數量不符合 case");
  }
  const observedPaths = [];
  for (const tool of tools) {
    const words = parseTranscriptCommandWords(tool.command) ?? [];
    if (
      tool.type !== "command_execution" ||
      canonicalJson(words.slice(0, 2)) !==
        canonicalJson(["/bin/cat", "--"]) ||
      words.length !== 3 ||
      tool.status !== "completed" ||
      tool.exit_code !== 0
    ) {
      throw new Error("Codex platform transcript 超出唯讀工具策略");
    }
    const inputPath = words[2];
    const normalized = resolve(root, inputPath);
    if (
      !expectedPaths.includes(inputPath) ||
      (
        normalized !== root &&
        !normalized.startsWith(`${root}${sep}`)
      ) ||
      sha256Text(tool.aggregated_output ?? "") !==
        readHashes.get(inputPath)
    ) {
      throw new Error("Codex platform transcript 未精確讀取安裝內容");
    }
    observedPaths.push(inputPath);
  }
  if (
    caseId === "positive" &&
    canonicalJson([...observedPaths].sort()) !==
      canonicalJson([...expectedPaths].sort())
  ) {
    throw new Error(
      `Codex platform transcript 必要讀取集合不一致：${canonicalJson({
        observed: observedPaths,
        expected: expectedPaths,
      })}`,
    );
  }
}

/** Parses Claude stream-json and enforces paired, confined read tools. */
function inspectClaudeTranscript(
  transcript,
  expectedOutput,
  { allowedRoot, caseId, requiredReads },
) {
  let events;
  let expected;
  try {
    events = transcript
      .trimEnd()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    expected = JSON.parse(expectedOutput);
  } catch (error) {
    throw new Error("Claude platform transcript 不是完整 stream-json", {
      cause: error,
    });
  }
  const initEvents = events.filter(
    (event) =>
      event?.type === "system" &&
      event?.subtype === "init",
  );
  const resultEvents = events.filter(
    (event) => event?.type === "result",
  );
  const init = initEvents[0];
  const result = resultEvents[0];
  const modelUsage = Object.entries(result?.modelUsage ?? {});
  const expectedModel =
    PLATFORM_EXECUTION_PROFILES["claude-code"].model;
  const root = resolve(allowedRoot);
  const permittedTools = [
    "Glob",
    "Grep",
    "Read",
    "StructuredOutput",
  ];
  if (
    initEvents.length !== 1 ||
    resultEvents.length !== 1 ||
    result !== events.at(-1) ||
    init?.session_id !== result?.session_id ||
    resolve(init?.cwd ?? "") !== root ||
    init?.permissionMode !== "dontAsk" ||
    modelUsage.length !== 1 ||
    modelUsage[0][0] !== expectedModel ||
    modelUsage[0][1]?.canonicalModel !== expectedModel ||
    result?.subtype !== "success" ||
    result?.is_error !== false ||
    canonicalJson(result?.structured_output) !==
      canonicalJson(expected) ||
    !Array.isArray(init?.tools) ||
    canonicalJson([...init.tools].sort()) !==
      canonicalJson([...permittedTools].sort())
  ) {
    throw new Error("Claude platform transcript runtime／output 不一致");
  }
  const started = new Map();
  const completed = new Map();
  const sequence = [];
  for (const event of events) {
    for (const item of event?.message?.content ?? []) {
      if (event.type === "assistant" && item?.type === "tool_use") {
        if (
          typeof item.id !== "string" ||
          started.has(item.id) ||
          !permittedTools.includes(item.name)
        ) {
          throw new Error("Claude platform tool start 不合法");
        }
        const record = {
          id: item.id,
          name: item.name,
          input: clone(item.input ?? {}),
        };
        started.set(item.id, record);
        sequence.push(record);
      } else if (
        event.type === "user" &&
        item?.type === "tool_result"
      ) {
        if (
          typeof item.tool_use_id !== "string" ||
          !started.has(item.tool_use_id) ||
          completed.has(item.tool_use_id)
        ) {
          throw new Error("Claude platform tool result 未配對");
        }
        completed.set(item.tool_use_id, {
          is_error: item.is_error === true,
          content: item.content,
          tool_use_result: event.tool_use_result,
        });
      }
    }
  }
  if (started.size !== completed.size) {
    throw new Error("Claude platform tool sequence 不完整");
  }
  const structured = sequence.filter(
    (tool) => tool.name === "StructuredOutput",
  );
  const reads = sequence.filter(
    (tool) => tool.name !== "StructuredOutput",
  );
  const expectedPaths = requiredPlatformReadPaths("claude-code");
  const readHashes = requiredReadMap(
    requiredReads,
    "claude-code",
  );
  if (
    structured.length !== 1 ||
    canonicalJson(structured[0].input) !== canonicalJson(expected) ||
    (caseId === "positive" &&
      reads.length !== expectedPaths.length) ||
    (caseId === "negative" && reads.length !== 0)
  ) {
    throw new Error("Claude platform tool sequence 不符合 case");
  }
  const observedPaths = [];
  for (const tool of reads) {
    const inputPath = tool.input.file_path;
    const completion = completed.get(tool.id);
    if (
      tool.name !== "Read" ||
      typeof inputPath !== "string" ||
      completion?.is_error === true
    ) {
      throw new Error("Claude platform tool path 不合法");
    }
    const normalized = resolve(root, inputPath);
    const relativePath = relative(root, normalized)
      .split(sep)
      .join("/");
    if (
      !expectedPaths.includes(relativePath) ||
      (
        normalized !== root &&
        !normalized.startsWith(`${root}${sep}`)
      ) ||
      completion?.tool_use_result?.file?.filePath !== normalized ||
      sha256Text(
        completion?.tool_use_result?.file?.content ?? "",
      ) !== readHashes.get(relativePath)
    ) {
      throw new Error("Claude platform tool 未精確讀取安裝內容");
    }
    observedPaths.push(relativePath);
  }
  if (
    caseId === "positive" &&
    canonicalJson([...observedPaths].sort()) !==
      canonicalJson([...expectedPaths].sort())
  ) {
    throw new Error("Claude platform 必要讀取集合不一致");
  }
  if (completed.get(structured[0].id)?.is_error === true) {
    throw new Error("Claude platform structured output 失敗");
  }
  return {
    session_nonce: result.session_id,
    transcript_sha256: sha256Text(transcript),
    tool_calls: sequence.length,
    tool_sequence_sha256: fingerprint(sequence),
  };
}

/** Parses only the declared provider transcript and binds its final response. */
function inspectPlatformTranscript(
  expectedPlatform,
  transcript,
  expectedOutput,
  { allowedRoot, caseId, requiredReads },
) {
  if (expectedPlatform === "codex") {
    const inspected = inspectCodexTranscript(
      transcript,
      expectedOutput,
    );
    let events;
    try {
      events = transcript
        .trimEnd()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
    } catch {
      events = [];
    }
    const completed = new Map(
      events
        .filter(
          (event) =>
            event?.type === "item.completed" &&
            !["agent_message", "reasoning"].includes(
              event?.item?.type,
            ),
        )
        .map((event) => [event.item.id, event.item]),
    );
    const tools = events
      .filter(
        (event) =>
          event?.type === "item.started" &&
          !["agent_message", "reasoning"].includes(
            event?.item?.type,
          ),
      )
      .map((event) => {
        const completion = completed.get(event.item.id);
        return {
          id: event.item.id,
          type: event.item.type,
          command:
            typeof event.item.command === "string"
              ? event.item.command
              : null,
          status: completion?.status,
          exit_code: completion?.exit_code,
          aggregated_output: completion?.aggregated_output,
        };
      });
    validatePlatformCodexTools(tools, {
      allowedRoot,
      caseId,
      platform: "codex",
      requiredReads,
    });
    return inspected;
  }
  if (expectedPlatform === "claude-code") {
    return inspectClaudeTranscript(
      transcript,
      expectedOutput,
      { allowedRoot, caseId, requiredReads },
    );
  }
  throw new Error(`不支援的 platform transcript：${expectedPlatform}`);
}

function parseTime(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} 時間不合法`);
  }
  return timestamp;
}

/** Returns the signed payload committed by one platform challenge attestation. */
function platformChallengePayload(attestation) {
  return {
    schema_version: attestation.schema_version,
    authority_id: attestation.authority_id,
    authority_version: attestation.authority_version,
    controller_sha256: attestation.controller_sha256,
    candidate_skill_fingerprint:
      attestation.candidate_skill_fingerprint,
    evaluation_input_sha256:
      attestation.evaluation_input_sha256,
    issued_at: attestation.issued_at,
    expires_at: attestation.expires_at,
    challenges: clone(attestation.challenges),
  };
}

/** Verifies a short-lived neutral-controller platform challenge. */
function verifyPlatformChallengeAttestation(
  attestation,
  {
    fixture,
    candidateSkillFingerprint,
    minimumIssuedAt,
  },
) {
  const authority = fixture.evaluator_authority;
  const keys = [
    "schema_version",
    "authority_id",
    "authority_version",
    "controller_sha256",
    "candidate_skill_fingerprint",
    "evaluation_input_sha256",
    "issued_at",
    "expires_at",
    "challenges",
    "payload_sha256",
    "signature_base64",
  ];
  if (
    !hasExactKeys(attestation, keys) ||
    attestation.schema_version !== 1 ||
    attestation.authority_id !== authority.authority_id ||
    attestation.authority_version !== authority.version ||
    attestation.controller_sha256 !== authority.controller_sha256 ||
    attestation.candidate_skill_fingerprint !==
      candidateSkillFingerprint ||
    attestation.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    !Array.isArray(attestation.challenges)
  ) {
    throw new Error("platform challenge authority 或 identity 不一致");
  }
  const issuedAt = parseTime(
    attestation.issued_at,
    "platform challenge issued_at",
  );
  const expiresAt = parseTime(
    attestation.expires_at,
    "platform challenge expires_at",
  );
  if (
    issuedAt <
      parseTime(minimumIssuedAt, "platform challenge minimum time") ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > PLATFORM_CHALLENGE_MAX_LIFETIME_MS
  ) {
    throw new Error("platform challenge 時效不合法");
  }
  const expectedIds = fixture.aggregate_template
    .platform_requirements.platforms
    .flatMap((platform) =>
      PLATFORM_CASES.map((caseId) => `${platform}:${caseId}`))
    .sort();
  const actualIds = [];
  const challengeNonces = [];
  for (const challenge of attestation.challenges) {
    if (
      !hasExactKeys(
        challenge,
        [
          "platform",
          "case",
          "platform_version",
          "executable_sha256",
          "execution_profile_sha256",
          "environment_sha256",
          "prompt_template_sha256",
          "installation_relative_path",
          "challenge_nonce",
        ],
      ) ||
      !expectedIds.includes(
        `${challenge.platform}:${challenge.case}`,
      ) ||
      typeof challenge.platform_version !== "string" ||
      challenge.platform_version.length === 0 ||
      !SHA256_PATTERN.test(
        challenge.executable_sha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(
        challenge.execution_profile_sha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(
        challenge.environment_sha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(
        challenge.prompt_template_sha256 ?? "",
      ) ||
      challenge.execution_profile_sha256 !==
        fingerprint(
          PLATFORM_EXECUTION_PROFILES[challenge.platform],
        ) ||
      challenge.installation_relative_path !==
        PLATFORM_INSTALL_PATHS[challenge.platform] ||
      typeof challenge.challenge_nonce !== "string" ||
      challenge.challenge_nonce.trim().length < 16
    ) {
      throw new Error("platform challenge case 不合法");
    }
    actualIds.push(`${challenge.platform}:${challenge.case}`);
    challengeNonces.push(challenge.challenge_nonce);
  }
  if (
    new Set(actualIds).size !== actualIds.length ||
    new Set(challengeNonces).size !== challengeNonces.length ||
    canonicalJson(actualIds.sort()) !== canonicalJson(expectedIds)
  ) {
    throw new Error("platform challenge cases 不完整或重複");
  }
  const payload = platformChallengePayload(attestation);
  if (
    attestation.payload_sha256 !== fingerprint(payload) ||
    typeof attestation.signature_base64 !== "string" ||
    !verifySignature(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      createPublicKey(authority.public_key_pem),
      Buffer.from(attestation.signature_base64, "base64"),
    )
  ) {
    throw new Error("platform challenge 簽章不合法");
  }
  return clone(attestation);
}

/** Returns the signed payload committed by platform completion evidence. */
function platformCompletionPayload(attestation) {
  return {
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
    sessions: clone(attestation.sessions),
  };
}

/** Returns whether one value is an exact regular-tree identity. */
function isTreeIdentity(value) {
  return (
    hasExactKeys(value, ["tree_fingerprint", "file_count"]) &&
    SHA256_PATTERN.test(value.tree_fingerprint ?? "") &&
    Number.isInteger(value.file_count) &&
    value.file_count > 0
  );
}

/** Verifies signed post-execution completion evidence for every platform case. */
function verifyPlatformCompletionAttestation(
  attestation,
  {
    fixture,
    candidateSkillFingerprint,
    challengeAttestation,
    minimumCompletedAt,
  },
) {
  const authority = fixture.evaluator_authority;
  if (
    !hasExactKeys(attestation, [
      "schema_version",
      "authority_id",
      "authority_version",
      "controller_sha256",
      "candidate_skill_fingerprint",
      "evaluation_input_sha256",
      "challenge_payload_sha256",
      "attested_at",
      "sessions",
      "payload_sha256",
      "signature_base64",
    ]) ||
    attestation.schema_version !== 1 ||
    attestation.authority_id !== authority.authority_id ||
    attestation.authority_version !== authority.version ||
    attestation.controller_sha256 !== authority.controller_sha256 ||
    attestation.candidate_skill_fingerprint !==
      candidateSkillFingerprint ||
    attestation.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    attestation.challenge_payload_sha256 !==
      challengeAttestation.payload_sha256 ||
    !Array.isArray(attestation.sessions)
  ) {
    throw new Error("platform completion authority 或 identity 不一致");
  }
  const expectedIds = fixture.aggregate_template
    .platform_requirements.platforms
    .flatMap((platform) =>
      PLATFORM_CASES.map((caseId) => `${platform}:${caseId}`))
    .sort();
  const actualIds = [];
  const providerNonces = [];
  const challengeNonces = challengeAttestation.challenges.map(
    (challenge) => challenge.challenge_nonce,
  );
  const attestedAt = parseTime(
    attestation.attested_at,
    "platform completion attested_at",
  );
  if (
    attestedAt <
      parseTime(minimumCompletedAt, "platform minimum completion") ||
    attestedAt >
      parseTime(
        challengeAttestation.expires_at,
        "platform challenge expires_at",
      )
  ) {
    throw new Error("platform completion attested_at 不合法");
  }
  for (const session of attestation.sessions) {
    if (
      !hasExactKeys(session, [
        "platform",
        "case",
        "platform_version",
        "executable_sha256",
        "execution_profile_sha256",
        "environment_sha256",
        "prompt_template_sha256",
        "prompt_sha256",
        "workspace_root",
        "installation_relative_path",
        "source_copy_before",
        "source_copy_after",
        "installed_copy_before",
        "installed_copy_after",
        "required_reads",
        "challenge_nonce",
        "started_at",
        "completed_at",
        "exit_status",
        "output_sha256",
        "transcript_sha256",
        "provider_session_nonce",
        "tool_calls",
        "tool_sequence_sha256",
      ]) ||
      !expectedIds.includes(`${session.platform}:${session.case}`) ||
      typeof session.platform_version !== "string" ||
      session.platform_version.length === 0 ||
      !SHA256_PATTERN.test(session.executable_sha256 ?? "") ||
      !SHA256_PATTERN.test(
        session.execution_profile_sha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(session.environment_sha256 ?? "") ||
      !SHA256_PATTERN.test(
        session.prompt_template_sha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(session.prompt_sha256 ?? "") ||
      typeof session.workspace_root !== "string" ||
      session.workspace_root.length === 0 ||
      resolve(session.workspace_root) !== session.workspace_root ||
      session.installation_relative_path !==
        PLATFORM_INSTALL_PATHS[session.platform] ||
      !isTreeIdentity(session.source_copy_before) ||
      !isTreeIdentity(session.source_copy_after) ||
      !isTreeIdentity(session.installed_copy_before) ||
      !isTreeIdentity(session.installed_copy_after) ||
      (() => {
        try {
          requiredReadMap(session.required_reads, session.platform);
          return false;
        } catch {
          return true;
        }
      })() ||
      session.exit_status !== 0 ||
      !SHA256_PATTERN.test(session.output_sha256 ?? "") ||
      !SHA256_PATTERN.test(session.transcript_sha256 ?? "") ||
      typeof session.provider_session_nonce !== "string" ||
      session.provider_session_nonce.length === 0 ||
      !Number.isInteger(session.tool_calls) ||
      session.tool_calls < 0 ||
      !SHA256_PATTERN.test(
        session.tool_sequence_sha256 ?? "",
      )
    ) {
      throw new Error("platform completion session 不合法");
    }
    const challenge = challengeAttestation.challenges.find(
      (item) =>
        item.platform === session.platform &&
        item.case === session.case,
    );
    const startedAt = parseTime(
      session.started_at,
      "platform completion started_at",
    );
    const completedAt = parseTime(
      session.completed_at,
      "platform completion completed_at",
    );
    if (
      session.challenge_nonce !== challenge?.challenge_nonce ||
      session.platform_version !==
        challenge?.platform_version ||
      session.executable_sha256 !==
        challenge?.executable_sha256 ||
      session.execution_profile_sha256 !==
        challenge?.execution_profile_sha256 ||
      session.environment_sha256 !==
        challenge?.environment_sha256 ||
      session.prompt_template_sha256 !==
        challenge?.prompt_template_sha256 ||
      session.installation_relative_path !==
        challenge?.installation_relative_path ||
      canonicalJson(session.source_copy_before) !==
        canonicalJson(session.source_copy_after) ||
      canonicalJson(session.installed_copy_before) !==
        canonicalJson(session.installed_copy_after) ||
      canonicalJson(session.source_copy_before) !==
        canonicalJson(session.installed_copy_before) ||
      session.source_copy_before.tree_fingerprint !==
        candidateSkillFingerprint ||
      session.source_copy_before.file_count !==
        fixture.runtime_bundle.candidate_file_count ||
      startedAt <
        parseTime(
          challengeAttestation.issued_at,
          "platform challenge issued_at",
        ) ||
      completedAt < startedAt ||
      completedAt <
        parseTime(minimumCompletedAt, "platform minimum completion") ||
      completedAt >
        parseTime(
          challengeAttestation.expires_at,
          "platform challenge expires_at",
        ) ||
      completedAt > attestedAt
    ) {
      throw new Error("platform completion 時序或 challenge 不一致");
    }
    actualIds.push(`${session.platform}:${session.case}`);
    providerNonces.push(session.provider_session_nonce);
  }
  if (
    new Set(actualIds).size !== actualIds.length ||
    canonicalJson(actualIds.sort()) !== canonicalJson(expectedIds)
  ) {
    throw new Error("platform completion sessions 不完整或重複");
  }
  if (new Set(providerNonces).size !== providerNonces.length) {
    throw new Error("platform completion session nonce 必須唯一");
  }
  if (
    providerNonces.some((nonce) =>
      challengeNonces.includes(nonce))
  ) {
    throw new Error(
      "platform challenge 與 provider session nonce 必須隔離",
    );
  }
  const payload = platformCompletionPayload(attestation);
  if (
    attestation.payload_sha256 !== fingerprint(payload) ||
    typeof attestation.signature_base64 !== "string" ||
    !verifySignature(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      createPublicKey(authority.public_key_pem),
      Buffer.from(attestation.signature_base64, "base64"),
    )
  ) {
    throw new Error("platform completion 簽章不合法");
  }
  return clone(attestation);
}

/** Returns whether one object contains exactly the allowed keys. */
function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...keys].sort())
  );
}

function expectedBehaviorIds(fixture) {
  return [...(fixture?.required_behaviors ?? [])].sort();
}

/** Returns the locked clause IDs for one evaluated behavior. */
function behaviorClauseIds(fixture, behaviorId) {
  return [...(fixture?.behavior_contracts?.[behaviorId] ?? [])].sort();
}

/** Commits every locked input that A/B generators and the Judge receive. */
export function evaluationInputFingerprint(fixture) {
  return fingerprint(fixture);
}

/** Returns the label-neutral evaluation specification shared by all sessions. */
function blindedEvaluationSpecification(fixture) {
  return {
    schema_version: 1,
    fixture: fixture.id,
    prompt: fixture.prompt,
    required_behaviors: clone(fixture.required_behaviors),
    behavior_contracts: clone(fixture.behavior_contracts),
    locked_rubric: clone(fixture.locked_rubric),
    tool_profile: clone(fixture.tool_profile),
  };
}

/** Returns the exact generator JSON response contract. */
function generatorResponseContract() {
  return {
    format: "json",
    required_top_level: [
      "evaluation_input_sha256",
      "input_view_sha256",
      "runtime_bundle",
      "behaviors",
      "quality",
    ],
    required_runtime_bundle: [
      "tree_fingerprint",
      "file_count",
      "cli_smoke_sha256",
    ],
    required_behavior: [
      "id",
      "verdict",
      "rationale_summary",
      "evidence_summary",
      "clause_evidence",
    ],
    verdicts: [...VERDICTS].sort(),
    required_quality: [
      "false_positive_optimizations",
      "rationale_summary",
      "evidence_summary",
    ],
  };
}

/** Returns the exact Judge JSON response contract. */
function judgeResponseContract() {
  return {
    format: "json",
    required_top_level: [
      "evaluation_input_sha256",
      "input_view_sha256",
      "behaviors",
      "quality",
    ],
    required_behavior: [
      "id",
      "label_a",
      "label_b",
    ],
    required_label_verdict: [
      "verdict",
      "rationale_summary",
      "evidence_summary",
      "clause_evidence",
    ],
    verdicts: [...VERDICTS].sort(),
    required_quality: [
      "false_positive_optimizations",
      "rationale_summary",
      "evidence_summary",
    ],
  };
}

/** Resolves one opaque label to its private assignment variant. */
function assignmentVariant(assignment, label) {
  if (
    !LABELS.includes(label) ||
    assignment?.baseline_label === assignment?.candidate_label ||
    canonicalJson(
      [assignment?.baseline_label, assignment?.candidate_label].sort(),
    ) !== canonicalJson(LABELS)
  ) {
    throw new Error("A/B assignment label 不合法");
  }
  return label === assignment.baseline_label
    ? "baseline"
    : "candidate";
}

/** Builds the exact label-neutral input view supplied to one generator. */
export function buildGeneratorEvaluationInputView(
  fixture,
  assignment,
  label,
  observedRuntimeBundle,
) {
  const variant = assignmentVariant(assignment, label);
  const runtime = fixture.runtime_bundle;
  const supplemental =
    fixture.usage_evidence?.supplemental_repository_targets ?? {};
  if (
    !hasExactKeys(
      observedRuntimeBundle,
      [
        "tree_fingerprint",
        "file_count",
        "cli_smoke_sha256",
      ],
    ) ||
    observedRuntimeBundle.tree_fingerprint !==
      runtime[`${variant}_tree_fingerprint`] ||
    observedRuntimeBundle.file_count !==
      runtime[`${variant}_file_count`] ||
    !SHA256_PATTERN.test(
      observedRuntimeBundle.cli_smoke_sha256 ?? "",
    )
  ) {
    throw new Error(`label_${label} observed runtime bundle 不一致`);
  }
  return {
    schema_version: 1,
    role: `label_${label}`,
    label,
    specification: blindedEvaluationSpecification(fixture),
    response_contract: generatorResponseContract(),
    target_files: {
      paths: clone(fixture.target_files.paths),
      sha256: clone(
        fixture.target_files[`${variant}_sha256`],
      ),
    },
    runtime_bundle: {
      mode: runtime.mode,
      skill_root: runtime.skill_root,
      tree_fingerprint:
        observedRuntimeBundle.tree_fingerprint,
      file_count: observedRuntimeBundle.file_count,
      read_only_cli_smoke: runtime.read_only_cli_smoke,
      cli_smoke_sha256:
        observedRuntimeBundle.cli_smoke_sha256,
    },
    supplemental_repository_targets: Object.fromEntries(
      Object.entries(supplemental).map(([id, target]) => [
        id,
        {
          relative_path: target.relative_path,
          sha256: target[`${variant}_sha256`],
        },
      ]),
    ),
  };
}

/** Removes direct runtime identity from one generator result before judging. */
export function buildOpaqueJudgeLabelOutput(output) {
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    throw new Error("Judge label output 不是有效 JSON", {
      cause: error,
    });
  }
  if (
    !hasExactKeys(
      document,
      [
        "evaluation_input_sha256",
        "input_view_sha256",
        "runtime_bundle",
        "behaviors",
        "quality",
      ],
    ) ||
    !hasExactKeys(
      document.runtime_bundle,
      [
        "tree_fingerprint",
        "file_count",
        "cli_smoke_sha256",
      ],
    )
  ) {
    throw new Error("Judge label output 缺少完整 runtime commitment");
  }
  const opaque = {
    evaluation_input_sha256: document.evaluation_input_sha256,
    input_view_sha256: document.input_view_sha256,
    runtime_bundle_sha256: fingerprint(document.runtime_bundle),
    behaviors: clone(document.behaviors),
    quality: clone(document.quality),
  };
  const serialized = canonicalJson(opaque);
  for (const value of [
    document.runtime_bundle.tree_fingerprint,
    document.runtime_bundle.cli_smoke_sha256,
  ]) {
    if (serialized.includes(value)) {
      throw new Error("Judge label output 洩漏直接 runtime identity");
    }
  }
  return opaque;
}

/** Builds the exact label-neutral Judge view after both outputs exist. */
export function buildJudgeEvaluationInputView(
  fixture,
  {
    labelInputViewSha256,
    opaqueLabelOutputSha256,
    runtimeBundles,
  },
) {
  if (
    LABELS.some(
      (label) =>
        !SHA256_PATTERN.test(
          labelInputViewSha256?.[label] ?? "",
        ),
    )
  ) {
    throw new Error("Judge label input-view commitment 不完整");
  }
  return {
    schema_version: 1,
    role: "judge",
    specification: blindedEvaluationSpecification(fixture),
    response_contract: judgeResponseContract(),
    labels: Object.fromEntries(
      LABELS.map((label) => [
        label,
        {
          input_view_sha256:
            labelInputViewSha256[label],
          opaque_output_sha256:
            opaqueLabelOutputSha256[label],
          runtime_bundle_sha256:
            fingerprint(runtimeBundles[label]),
        },
      ]),
    ),
  };
}

/** Builds the exact identity-neutral input bundle supplied to the Judge. */
export function buildJudgeEvaluationInputBundle(
  judgeInputView,
  labelOutputs,
) {
  const bundle = {
    contract: clone(judgeInputView),
    labels: {
      a: buildOpaqueJudgeLabelOutput(labelOutputs.a),
      b: buildOpaqueJudgeLabelOutput(labelOutputs.b),
    },
  };
  const serialized = canonicalJson(bundle);
  for (const output of Object.values(labelOutputs)) {
    const runtime = JSON.parse(output).runtime_bundle;
    if (
      serialized.includes(runtime.tree_fingerprint) ||
      serialized.includes(runtime.cli_smoke_sha256)
    ) {
      throw new Error("Judge input bundle 洩漏直接 runtime identity");
    }
  }
  return bundle;
}

/** Validates locked fixture identity, content hashes and release thresholds. */
function validateLockedEvaluationFixture(
  fixture,
  candidateSkillFingerprint,
) {
  const targetFiles = fixture?.target_files;
  const paths = targetFiles?.paths;
  const baselineHashes = targetFiles?.baseline_sha256;
  const candidateHashes = targetFiles?.candidate_sha256;
  const behaviorIds = expectedBehaviorIds(fixture);
  const rubricIds = isObject(fixture?.locked_rubric)
    ? Object.keys(fixture.locked_rubric).sort()
    : [];
  const contractIds = isObject(fixture?.behavior_contracts)
    ? Object.keys(fixture.behavior_contracts).sort()
    : [];
  const aggregateTemplate = fixture?.aggregate_template;
  const runtimeBundle = fixture?.runtime_bundle;
  const validHashMap = (value) =>
    isObject(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...paths].sort()) &&
    Object.values(value).every((hash) => SHA256_PATTERN.test(hash));
  if (
    fixture?.schema_version !== 1 ||
    typeof fixture?.id !== "string" ||
    fixture.id.length === 0 ||
    !Number.isFinite(Date.parse(fixture?.locked_at)) ||
    typeof fixture?.prompt !== "string" ||
    fixture.prompt.length === 0 ||
    fixture.prompt.includes(candidateSkillFingerprint) ||
    fixture.prompt.includes(
      runtimeBundle?.baseline_tree_fingerprint ?? "",
    ) ||
    !isObject(targetFiles) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("/") ||
        /^[A-Za-z]:/u.test(path) ||
        path.includes("\\") ||
        path.split("/").some(
          (part) => part.length === 0 || part === "." || part === "..",
        ),
    ) ||
    !validHashMap(baselineHashes) ||
    !validHashMap(candidateHashes) ||
    behaviorIds.length === 0 ||
    new Set(behaviorIds).size !== behaviorIds.length ||
    canonicalJson(behaviorIds) !== canonicalJson(rubricIds) ||
    canonicalJson(behaviorIds) !== canonicalJson(contractIds) ||
    contractIds.some((id) => {
      const clauses = behaviorClauseIds(fixture, id);
      return (
        clauses.length === 0 ||
        new Set(clauses).size !== clauses.length ||
        clauses.some(
          (clause) =>
            typeof clause !== "string" ||
            clause.trim().length === 0,
        )
      );
    }) ||
    fixture?.usage_evidence?.current_run
      ?.candidate_skill_fingerprint !== candidateSkillFingerprint ||
    runtimeBundle?.mode !== "complete-skill-tree" ||
    runtimeBundle?.skill_root !== "." ||
    !SHA256_PATTERN.test(
      runtimeBundle?.baseline_tree_fingerprint ?? "",
    ) ||
    runtimeBundle?.candidate_tree_fingerprint !==
      candidateSkillFingerprint ||
    !Number.isInteger(runtimeBundle?.baseline_file_count) ||
    runtimeBundle.baseline_file_count <= 0 ||
    !Number.isInteger(runtimeBundle?.candidate_file_count) ||
    runtimeBundle.candidate_file_count <= 0 ||
    runtimeBundle?.read_only_cli_smoke !== true ||
    fixture?.quality_thresholds?.candidate_regressions !== 0 ||
    fixture?.quality_thresholds?.false_positive_optimizations !== 0 ||
    fixture?.quality_thresholds?.candidate_minimum_gain_over_baseline < 0 ||
    (
      fixture?.quality_thresholds
        ?.candidate_minimum_gain_over_baseline > 0 &&
      runtimeBundle?.baseline_tree_fingerprint ===
        runtimeBundle?.candidate_tree_fingerprint
    ) ||
    fixture?.quality_thresholds?.max_candidate_heading_count < 0 ||
    fixture?.cost_thresholds
      ?.candidate_artifact_bytes_max_ratio_to_baseline <= 0 ||
    fixture?.cost_thresholds?.candidate_tool_calls_max < 0 ||
    !isObject(aggregateTemplate) ||
    !isObject(aggregateTemplate.platform_requirements) ||
    aggregateTemplate.platform_requirements.installer !== "skills" ||
    aggregateTemplate.platform_requirements.scope !==
      "isolated-project-copy" ||
    !Array.isArray(aggregateTemplate.platform_requirements.platforms) ||
    canonicalJson(
      [...aggregateTemplate.platform_requirements.platforms].sort(),
    ) !== canonicalJson(["claude-code", "codex"]) ||
    !Array.isArray(aggregateTemplate.limits) ||
    aggregateTemplate.limits.length === 0 ||
    aggregateTemplate.limits.some(
      (item) => typeof item !== "string" || item.length === 0,
    ) ||
    fixture?.tool_profile?.mode !== "read-only" ||
    fixture?.tool_profile?.network_access !== false ||
    fixture?.tool_profile?.filesystem_writes !== false ||
    fixture?.tool_profile?.remote_writes !== false ||
    canonicalJson(
      fixture?.tool_profile?.transcript_policy
        ?.allowed_item_types,
    ) !== canonicalJson(TRANSCRIPT_TOOL_TYPES) ||
    canonicalJson(
      fixture?.tool_profile?.transcript_policy
        ?.allowed_command_families,
    ) !== canonicalJson([
      "eval_bind_smoke",
      "read",
      "runtime_observation",
    ]) ||
    fixture?.tool_profile?.transcript_policy
      ?.required_eval_bind_smoke_count !== 1 ||
    fixture?.tool_profile?.transcript_policy
      ?.required_runtime_observation_count !== 1 ||
    fixture?.tool_profile?.transcript_policy?.max_tool_calls !==
      fixture?.cost_thresholds?.candidate_tool_calls_max ||
    !hasExactKeys(
      fixture?.evaluator_authority,
      [
        "authority_id",
        "version",
        "controller_sha256",
        "public_key_pem",
      ],
    ) ||
    typeof fixture.evaluator_authority.authority_id !== "string" ||
    fixture.evaluator_authority.authority_id.length === 0 ||
    typeof fixture.evaluator_authority.version !== "string" ||
    fixture.evaluator_authority.version.length === 0 ||
    !SHA256_PATTERN.test(
      fixture.evaluator_authority.controller_sha256 ?? "",
    ) ||
    typeof fixture.evaluator_authority.public_key_pem !== "string" ||
    !fixture.evaluator_authority.public_key_pem.includes(
      "BEGIN PUBLIC KEY",
    )
  ) {
    throw new Error("locked evaluation fixture 不完整或未綁定內容");
  }
  return clone(fixture);
}

/** Verifies locked candidate file hashes against the live candidate Skill. */
function validateCandidateTargetFiles(
  fixture,
  candidate,
  candidatePath,
) {
  if (
    typeof candidatePath !== "string" ||
    candidatePath.trim().length === 0
  ) {
    throw new Error("live candidate root path 不合法");
  }
  const candidateSkillPath = resolveCandidatePath(
    candidatePath,
    candidate.skill_path,
  );
  const before = fingerprintTree(candidateSkillPath);
  if (before !== candidate.candidate_skill_fingerprint) {
    throw new Error("live candidate Skill fingerprint 不一致");
  }
  if (
    countTreeFiles(candidateSkillPath) !==
    fixture.runtime_bundle.candidate_file_count
  ) {
    throw new Error("live candidate Skill file count 不一致");
  }
  for (const relativePath of fixture.target_files.paths) {
    if (
      sha256Text(
        readCandidateRegularFile(candidateSkillPath, relativePath),
      ) !==
        fixture.target_files.candidate_sha256[relativePath]
    ) {
      throw new Error(
        `live candidate target file hash 不一致：${relativePath}`,
      );
    }
  }
  if (
    fingerprintTree(candidateSkillPath) !== before ||
    before !== candidate.candidate_skill_fingerprint
  ) {
    throw new Error("live candidate Skill 讀取期間已漂移");
  }
}

/** Reads the snapshot-bound fixture from the live candidate root. */
function validateCandidateFixture(
  fixture,
  bindingFixtureSha256,
  candidate,
  candidatePath,
) {
  if (
    candidate.evaluation_fixture_path === undefined ||
    candidate.evaluation_fixture_sha256 === undefined
  ) {
    throw new Error("candidate snapshot 缺少 evaluation fixture 綁定");
  }
  if (
    bindingFixtureSha256 !== candidate.evaluation_fixture_sha256
  ) {
    throw new Error("binding fixture SHA-256 與 candidate snapshot 不一致");
  }
  const content = readCandidateRegularFile(
    candidatePath,
    candidate.evaluation_fixture_path,
  );
  const contentSha256 = createHash("sha256")
    .update(content)
    .digest("hex");
  if (contentSha256 !== candidate.evaluation_fixture_sha256) {
    throw new Error("live evaluation fixture SHA-256 不一致");
  }
  let liveFixture;
  try {
    liveFixture = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error("live evaluation fixture 不是有效 JSON", {
      cause: error,
    });
  }
  if (canonicalJson(liveFixture) !== canonicalJson(fixture)) {
    throw new Error("binding fixture 與 live candidate fixture 不一致");
  }
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

/** Rejects Judge summaries that would leak through public evidence. */
function requirePublicSummary(value, label) {
  if (redactText(value) !== value) {
    throw new Error(`${label} 尚未脫敏`);
  }
}

function validateJudgeOutput(
  judgeOutput,
  fixture,
  inputViewSha256,
) {
  if (!isObject(judgeOutput) || !Array.isArray(judgeOutput.behaviors)) {
    throw new Error("Judge output 格式不合法");
  }
  if (
    !hasExactKeys(
      judgeOutput,
      [
        "evaluation_input_sha256",
        "input_view_sha256",
        "behaviors",
        "quality",
      ],
    ) ||
    judgeOutput.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    judgeOutput.input_view_sha256 !== inputViewSha256
  ) {
    throw new Error("Judge output 未綁定 locked evaluation input");
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
      const clauseIds = Object.keys(
        verdict?.clause_evidence ?? {},
      ).sort();
      if (
        !hasExactKeys(
          verdict,
          [
            "verdict",
            "rationale_summary",
            "evidence_summary",
            "clause_evidence",
          ],
        ) ||
        !hasExactKeys(
          verdict.clause_evidence,
          behaviorClauseIds(fixture, behavior.id),
        ) ||
        !VERDICTS.has(verdict.verdict) ||
        typeof verdict.rationale_summary !== "string" ||
        verdict.rationale_summary.trim().length === 0 ||
        typeof verdict.evidence_summary !== "string" ||
        verdict.evidence_summary.trim().length === 0 ||
        canonicalJson(clauseIds) !==
          canonicalJson(behaviorClauseIds(fixture, behavior.id)) ||
        clauseIds.some(
          (id) =>
            typeof verdict.clause_evidence[id] !== "string" ||
            verdict.clause_evidence[id].trim().length === 0,
        )
      ) {
        throw new Error(`Judge output ${behavior.id}.label_${label} 不完整`);
      }
      requirePublicSummary(
        verdict.rationale_summary,
        `Judge output ${behavior.id}.label_${label}.rationale_summary`,
      );
    }
    if (
      !hasExactKeys(
        behavior,
        ["id", "label_a", "label_b"],
      )
    ) {
      throw new Error(`Judge output ${behavior.id} 欄位不完整`);
    }
  }
  if (
    !hasExactKeys(
      judgeOutput.quality,
      [
        "false_positive_optimizations",
        "rationale_summary",
        "evidence_summary",
      ],
    ) ||
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
  requirePublicSummary(
    judgeOutput.quality.rationale_summary,
    "Judge output quality.rationale_summary",
  );
}

/** Validates one generator output against its locked input and runtime bundle. */
function validateGeneratorOutput(
  output,
  fixture,
  runtimeBundle,
  label,
  inputViewSha256,
) {
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    throw new Error(`label_${label} output 不是有效 JSON`, {
      cause: error,
    });
  }
  const ids = document?.behaviors
    ?.map((behavior) => behavior?.id)
    .sort();
  if (
    !hasExactKeys(
      document,
      [
        "evaluation_input_sha256",
        "input_view_sha256",
        "runtime_bundle",
        "behaviors",
        "quality",
      ],
    ) ||
    document.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    document.input_view_sha256 !== inputViewSha256 ||
    !Array.isArray(document.behaviors) ||
    new Set(ids).size !== ids.length ||
    canonicalJson(ids) !== canonicalJson(expectedBehaviorIds(fixture)) ||
    !hasExactKeys(
      document.runtime_bundle,
      [
        "tree_fingerprint",
        "file_count",
        "cli_smoke_sha256",
      ],
    ) ||
    document.runtime_bundle?.tree_fingerprint !==
      runtimeBundle.tree_fingerprint ||
    document.runtime_bundle?.file_count !== runtimeBundle.file_count ||
    document.runtime_bundle?.cli_smoke_sha256 !==
      runtimeBundle.cli_smoke_sha256
  ) {
    throw new Error(
      `label_${label} output 未綁定 locked input 或完整 runtime bundle`,
    );
  }
  for (const behavior of document.behaviors) {
    const clauseIds = Object.keys(
      behavior.clause_evidence ?? {},
    ).sort();
    if (
      !hasExactKeys(
        behavior,
        [
          "id",
          "verdict",
          "rationale_summary",
          "evidence_summary",
          "clause_evidence",
        ],
      ) ||
      !hasExactKeys(
        behavior.clause_evidence,
        behaviorClauseIds(fixture, behavior.id),
      ) ||
      !VERDICTS.has(behavior.verdict) ||
      typeof behavior.rationale_summary !== "string" ||
      behavior.rationale_summary.trim().length === 0 ||
      typeof behavior.evidence_summary !== "string" ||
      behavior.evidence_summary.trim().length === 0 ||
      canonicalJson(clauseIds) !==
        canonicalJson(behaviorClauseIds(fixture, behavior.id)) ||
      clauseIds.some(
        (id) =>
          typeof behavior.clause_evidence[id] !== "string" ||
          behavior.clause_evidence[id].trim().length === 0,
      )
    ) {
      throw new Error(`label_${label} output ${behavior.id} 不完整`);
    }
  }
  if (
    !hasExactKeys(
      document.quality,
      [
        "false_positive_optimizations",
        "rationale_summary",
        "evidence_summary",
      ],
    ) ||
    !Number.isInteger(
      document.quality.false_positive_optimizations,
    ) ||
    document.quality.false_positive_optimizations < 0 ||
    typeof document.quality.rationale_summary !== "string" ||
    document.quality.rationale_summary.trim().length === 0 ||
    typeof document.quality.evidence_summary !== "string" ||
    document.quality.evidence_summary.trim().length === 0
  ) {
    throw new Error(`label_${label} output quality 不完整`);
  }
  return document;
}

/** Executes the exact read-only binding smoke against one runtime tree. */
export function observeRuntimeCliSmoke(runtimePath) {
  const root = realpathSync(resolve(runtimePath));
  const beforeFingerprint = fingerprintTree(root);
  const beforeFileCount = countTreeFiles(root);
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts", "maintainer.mjs"), "eval-bind"],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  const afterFingerprint = fingerprintTree(root);
  const afterFileCount = countTreeFiles(root);
  const smoke = {
    command: "node scripts/maintainer.mjs eval-bind",
    exit_code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    files_modified:
      beforeFingerprint !== afterFingerprint ||
      beforeFileCount !== afterFileCount,
  };
  if (
    result.error !== undefined ||
    smoke.files_modified ||
    !Number.isInteger(smoke.exit_code)
  ) {
    throw new Error("CLI smoke 未能完成唯讀執行");
  }
  return smoke;
}

/** Validates one private read-only runtime-bundle observation. */
function validateRuntimeBundleSession(
  session,
  fixture,
  expectedVariant,
  expectedOutputSha256,
  label,
) {
  const evaluationInputSha256 = evaluationInputFingerprint(fixture);
  const expectedFingerprint =
    fixture.runtime_bundle[
      `${expectedVariant}_tree_fingerprint`
    ];
  const expectedFileCount =
    fixture.runtime_bundle[`${expectedVariant}_file_count`];
  const smoke = session?.cli_smoke;
  if (
    typeof session?.runtime_path !== "string" ||
    session.runtime_path.trim().length === 0
  ) {
    throw new Error(
      `label_${label} session 未綁定完整唯讀 runtime bundle`,
    );
  }
  const observedSmoke = observeRuntimeCliSmoke(session?.runtime_path);
  let smokeResult;
  try {
    smokeResult = JSON.parse(observedSmoke.stderr.trim());
  } catch (error) {
    throw new Error(
      `label_${label} session 未綁定完整唯讀 runtime bundle`,
      {
      cause: error,
      },
    );
  }
  const expectedSmokeFailure =
    expectedVariant === "candidate"
      ? smokeResult?.error?.startsWith("缺少必要參數：--") === true
      : smokeResult?.error === "未知或缺少命令" ||
        smokeResult?.error?.startsWith("缺少必要參數：--") === true;
  if (
    session?.evaluation_input_sha256 !== evaluationInputSha256 ||
    session?.output_sha256 !== expectedOutputSha256 ||
    fingerprintTree(session.runtime_path) !== expectedFingerprint ||
    countTreeFiles(session.runtime_path) !== expectedFileCount ||
    canonicalJson(smoke) !== canonicalJson(observedSmoke) ||
    smoke?.command !== "node scripts/maintainer.mjs eval-bind" ||
    smoke?.exit_code !== 1 ||
    smoke?.stdout !== "" ||
    smoke?.files_modified !== false ||
    smokeResult?.command !== "eval-bind" ||
    smokeResult?.valid !== false ||
    expectedSmokeFailure !== true
  ) {
    throw new Error(
      `label_${label} session 未綁定完整唯讀 runtime bundle`,
    );
  }
  return {
    tree_fingerprint: expectedFingerprint,
    file_count: expectedFileCount,
    cli_smoke_sha256: fingerprint(observedSmoke),
  };
}

function generatorSession({
  role,
  modelId,
  session,
  outputSha256,
  toolProfileSha256,
  evaluationInputSha256,
  inputViewSha256,
  runtimeBundleSha256,
  measurement,
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
      evaluation_input_sha256: evaluationInputSha256,
      input_view_sha256: inputViewSha256,
      runtime_bundle_sha256: runtimeBundleSha256,
      transcript_sha256: measurement.events_sha256,
      tool_calls: measurement.tool_calls,
      tool_sequence_sha256: measurement.tool_sequence_sha256,
    }),
    tool_profile_sha256: toolProfileSha256,
    evaluation_input_sha256: evaluationInputSha256,
    input_view_sha256: inputViewSha256,
    runtime_bundle_sha256: runtimeBundleSha256,
    transcript_sha256: measurement.events_sha256,
    tool_calls: measurement.tool_calls,
    tool_sequence_sha256: measurement.tool_sequence_sha256,
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
  labelOutputs,
  labelTranscripts,
  judgeOutput,
  measurement,
  unblindedAt,
}) {
  validateDocument("blinded-measurement", measurement);
  const seed = Buffer.from(assignment.seed_base64 ?? "", "base64");
  const evaluationInputSha256 =
    evaluationInputFingerprint(fixture);
  const judgeOutputSha256 = fingerprint(judgeOutput);
  if (
    seed.length < 16 ||
    seed.toString("base64") !== assignment.seed_base64 ||
    rawSeedFingerprint(seed) !== assignment.seed_commitment_sha256 ||
    assignment.evaluation_input_sha256 !== evaluationInputSha256
  ) {
    throw new Error("A/B assignment seed 或 evaluation input commitment 不一致");
  }
  const expectedBaselineLabel = seed[0] % 2 === 0 ? "a" : "b";
  const expectedCandidateLabel =
    expectedBaselineLabel === "a" ? "b" : "a";
  if (
    assignment.baseline_label !== expectedBaselineLabel ||
    assignment.candidate_label !== expectedCandidateLabel
  ) {
    throw new Error("A/B assignment 映射不一致");
  }
  const runtimeBundles = Object.fromEntries(
    LABELS.map((label) => {
      const variant =
        label === expectedBaselineLabel ? "baseline" : "candidate";
      return [
        label,
        validateRuntimeBundleSession(
          sessions[`label_${label}`],
          fixture,
          variant,
          measurement.labels[label].output_sha256,
          label,
        ),
      ];
    }),
  );
  const generatorInputViews = Object.fromEntries(
    LABELS.map((label) => [
      label,
      buildGeneratorEvaluationInputView(
        fixture,
        assignment,
        label,
        runtimeBundles[label],
      ),
    ]),
  );
  const generatorInputViewSha256 = Object.fromEntries(
    LABELS.map((label) => [
      label,
      fingerprint(generatorInputViews[label]),
    ]),
  );
  for (const label of LABELS) {
    const output = labelOutputs?.[label];
    const transcript = inspectCodexTranscript(
      labelTranscripts?.[label] ??
        sessions[`label_${label}`]?.transcript,
      output,
      {
        toolProfile: fixture.tool_profile,
        allowedRoot: dirname(dirname(
          sessions[`label_${label}`].runtime_path,
        )),
      },
    );
    if (
      sessions[`label_${label}`]?.input_view_sha256 !==
        generatorInputViewSha256[label] ||
      sessions[`label_${label}`]?.session_nonce !==
        transcript.session_nonce ||
      sessions[`label_${label}`]?.transcript_sha256 !==
        transcript.transcript_sha256 ||
      sessions[`label_${label}`]?.tool_calls !==
        transcript.tool_calls ||
      sessions[`label_${label}`]?.tool_sequence_sha256 !==
        transcript.tool_sequence_sha256 ||
      measurement.labels[label].events_sha256 !==
        transcript.transcript_sha256 ||
      measurement.labels[label].session_nonce !==
        transcript.session_nonce ||
      measurement.labels[label].tool_calls !==
        transcript.tool_calls ||
      measurement.labels[label].tool_sequence_sha256 !==
        transcript.tool_sequence_sha256
    ) {
      throw new Error(
        `label_${label} session 未綁定 exact input view／transcript`,
      );
    }
    if (
      typeof output !== "string" ||
      sha256Text(output) !== measurement.labels[label].output_sha256
    ) {
      throw new Error(`label_${label} private output 與 measurement 不一致`);
    }
    validateGeneratorOutput(
      output,
      fixture,
      runtimeBundles[label],
      label,
      generatorInputViewSha256[label],
    );
  }
  const judgeInputView = buildJudgeEvaluationInputView(
    fixture,
    {
      labelInputViewSha256: generatorInputViewSha256,
      opaqueLabelOutputSha256: {
        a: fingerprint(
          buildOpaqueJudgeLabelOutput(labelOutputs.a),
        ),
        b: fingerprint(
          buildOpaqueJudgeLabelOutput(labelOutputs.b),
        ),
      },
      runtimeBundles,
    },
  );
  const judgeInputViewSha256 = fingerprint(judgeInputView);
  const judgeInputBundle = buildJudgeEvaluationInputBundle(
    judgeInputView,
    labelOutputs,
  );
  const judgeInputBundleSha256 = fingerprint(judgeInputBundle);
  const judgeRawOutput = sessions.judge?.raw_output;
  let parsedJudgeOutput;
  try {
    parsedJudgeOutput = JSON.parse(judgeRawOutput);
  } catch (error) {
    throw new Error("Judge raw output 不是有效 JSON", {
      cause: error,
    });
  }
  if (canonicalJson(parsedJudgeOutput) !== canonicalJson(judgeOutput)) {
    throw new Error("Judge raw output 與 parsed output 不一致");
  }
  const judgeTranscript = inspectCodexTranscript(
    sessions.judge?.transcript,
    judgeRawOutput,
    { requireNoTools: true },
  );
  validateJudgeOutput(
    judgeOutput,
    fixture,
    judgeInputViewSha256,
  );
  const sessionNonces = [
    sessions.label_a?.session_nonce,
    sessions.label_b?.session_nonce,
    sessions.judge?.session_nonce,
  ];
  if (
    assignment.model_id !== sessions.model_id ||
    measurement.fixture !== fixture.id ||
    sessions.judge?.evaluation_input_sha256 !==
      evaluationInputSha256 ||
    sessions.judge?.input_view_sha256 !==
      judgeInputViewSha256 ||
    sessions.judge?.input_bundle_sha256 !==
      judgeInputBundleSha256 ||
    canonicalJson(sessions.judge?.input_bundle) !==
      canonicalJson(judgeInputBundle) ||
    sessions.judge?.output_sha256 !== judgeOutputSha256 ||
    sessions.judge?.session_nonce !== judgeTranscript.session_nonce ||
    sessions.judge?.transcript_sha256 !==
      judgeTranscript.transcript_sha256 ||
    sessions.judge?.tool_calls !== 0 ||
    sessions.judge?.tool_sequence_sha256 !==
      judgeTranscript.tool_sequence_sha256 ||
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
          clause_evidence: behavior.label_a.clause_evidence,
        }),
    },
    label_b: {
      verdict: behavior.label_b.verdict,
      rationale_summary: behavior.label_b.rationale_summary,
        evidence_sha256: fingerprint({
          id: behavior.id,
          label: "b",
          evidence_summary: behavior.label_b.evidence_summary,
          clause_evidence: behavior.label_b.clause_evidence,
        }),
    },
  }));
  const document = {
    schema_version: 1,
    evidence_kind: "blinded-adjudication",
    fixture: fixture.id,
    rubric_sha256: rubricFingerprint(fixture),
    assignment: {
      method: "randomized-a-b",
      committed_at: assignment.committed_at,
      seed_commitment_sha256: assignment.seed_commitment_sha256,
      evaluation_input_sha256: evaluationInputSha256,
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
        evaluationInputSha256,
        inputViewSha256: generatorInputViewSha256.a,
        runtimeBundleSha256: fingerprint(runtimeBundles.a),
        measurement: measurement.labels.a,
      }),
      label_b: generatorSession({
        role: "label_b",
        modelId: sessions.model_id,
        session: sessions.label_b,
        outputSha256: measurement.labels.b.output_sha256,
        toolProfileSha256,
        evaluationInputSha256,
        inputViewSha256: generatorInputViewSha256.b,
        runtimeBundleSha256: fingerprint(runtimeBundles.b),
        measurement: measurement.labels.b,
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
          evaluation_input_sha256: evaluationInputSha256,
          input_view_sha256: judgeInputViewSha256,
          input_bundle_sha256: judgeInputBundleSha256,
          transcript_sha256: judgeTranscript.transcript_sha256,
          tool_calls: judgeTranscript.tool_calls,
          tool_sequence_sha256: judgeTranscript.tool_sequence_sha256,
        }),
        evaluation_input_sha256: evaluationInputSha256,
        input_view_sha256: judgeInputViewSha256,
        input_bundle_sha256: judgeInputBundleSha256,
        transcript_sha256: judgeTranscript.transcript_sha256,
        tool_calls: judgeTranscript.tool_calls,
        tool_sequence_sha256: judgeTranscript.tool_sequence_sha256,
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
      labels_hidden_from_judge:
        judgeTranscript.tool_calls === 0 &&
        !canonicalJson([
          buildOpaqueJudgeLabelOutput(labelOutputs.a),
          buildOpaqueJudgeLabelOutput(labelOutputs.b),
        ]).includes(
          fixture.runtime_bundle.candidate_tree_fingerprint,
        ) &&
        !canonicalJson([
          buildOpaqueJudgeLabelOutput(labelOutputs.a),
          buildOpaqueJudgeLabelOutput(labelOutputs.b),
        ]).includes(
          fixture.runtime_bundle.baseline_tree_fingerprint,
        ),
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
    adjudication.assignment.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
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
    labelA.tool_profile_sha256 !== labelB.tool_profile_sha256 ||
    labelA.evaluation_input_sha256 !==
      adjudication.assignment.evaluation_input_sha256 ||
    labelB.evaluation_input_sha256 !==
      adjudication.assignment.evaluation_input_sha256 ||
    judge.evaluation_input_sha256 !==
      adjudication.assignment.evaluation_input_sha256 ||
    !SHA256_PATTERN.test(labelA.input_view_sha256 ?? "") ||
    !SHA256_PATTERN.test(labelB.input_view_sha256 ?? "") ||
    !SHA256_PATTERN.test(judge.input_view_sha256 ?? "")
  ) {
    throw new Error("A/B 與 Judge session 必須隔離且生成条件一致");
  }
  for (const [name, session] of [
    ["label_a", labelA],
    ["label_b", labelB],
  ]) {
    if (
      !SHA256_PATTERN.test(session.output_sha256 ?? "") ||
      !SHA256_PATTERN.test(session.transcript_sha256 ?? "") ||
      !SHA256_PATTERN.test(session.tool_sequence_sha256 ?? "") ||
      !Number.isInteger(session.tool_calls) ||
      session.tool_calls < 0 ||
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
    requirePublicSummary(
      behavior.label_a.rationale_summary,
      `${behavior.id}.label_a.rationale_summary`,
    );
    requirePublicSummary(
      behavior.label_b.rationale_summary,
      `${behavior.id}.label_b.rationale_summary`,
    );
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
  requirePublicSummary(
    adjudication.quality.rationale_summary,
    "adjudication quality.rationale_summary",
  );
  return clone(adjudication);
}

function measureLabel({ output, events }, toolProfile) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("measurement output 必須是非空字串");
  }
  const transcript = inspectCodexTranscript(events, output, {
    toolProfile,
  });
  return {
    output_sha256: sha256Text(output),
    events_sha256: transcript.transcript_sha256,
    artifact_bytes: Buffer.byteLength(output, "utf8"),
    tool_calls: transcript.tool_calls,
    session_nonce: transcript.session_nonce,
    tool_sequence_sha256: transcript.tool_sequence_sha256,
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
    evaluation_input_sha256: evaluationInputFingerprint(fixture),
    measured_at: measuredAt,
    labels: {
      a: measureLabel(labelA, fixture.tool_profile),
      b: measureLabel(labelB, fixture.tool_profile),
    },
    derivation: {
      builder: "agent-skill-maintainer/blinded-measurement-v1",
      encoding: "utf8",
      tool_event_type: "codex-jsonl-complete-session",
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
    measurement.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    measurement.evaluation_input_sha256 !==
      adjudication.assignment.evaluation_input_sha256 ||
    measurement.raw_inputs_published !== false ||
    measurement.synthetic_fixture !== true ||
    measurement.labels.a.output_sha256 !==
      adjudication.sessions.label_a.output_sha256 ||
    measurement.labels.b.output_sha256 !==
      adjudication.sessions.label_b.output_sha256 ||
    LABELS.some((label) => {
      const measured = measurement.labels[label];
      const session = adjudication.sessions[`label_${label}`];
      return (
        measured.events_sha256 !== session.transcript_sha256 ||
        measured.tool_calls !== session.tool_calls ||
        measured.tool_sequence_sha256 !==
          session.tool_sequence_sha256
      );
    })
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
      typeof item.session_nonce !== "string" ||
      item.session_nonce.length === 0 ||
      !SHA256_PATTERN.test(item.tool_sequence_sha256 ?? "") ||
      !Number.isInteger(item.heading_count) ||
      item.heading_count < 0
    ) {
      throw new Error(`measurement label_${label} 不合法`);
    }
  }
  const measuredAt = parseTime(
    measurement.measured_at,
    "measurement.measured_at",
  );
  const outputsCompleted = Math.max(
    parseTime(
      adjudication.sessions.label_a.completed_at,
      "label_a.completed_at",
    ),
    parseTime(
      adjudication.sessions.label_b.completed_at,
      "label_b.completed_at",
    ),
  );
  const judgeStarted = parseTime(
    adjudication.sessions.judge.started_at,
    "judge.started_at",
  );
  if (
    measuredAt < outputsCompleted ||
    measuredAt > judgeStarted
  ) {
    throw new Error(
      "blinded measurement 時間必須位於 A/B 完成與 Judge 開始之間",
    );
  }
  return clone(measurement);
}

function mappedLabel(document, label) {
  return label === "a" ? document.label_a : document.label_b;
}

/** Reads one private regular output file without following a symlink. */
function readPrivateOutput(path, label) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`${label} path 不合法`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} 必須是 regular file`);
  }
  return readFileSync(path, "utf8");
}

/** Verifies the live neutral-controller bytes against the locked fixture. */
function validateNeutralControllerSource(fixture, candidatePath) {
  const source = readCandidateRegularFile(
    candidatePath,
    "scripts/neutral-evaluation-controller.mjs",
  );
  const sourceSha256 = createHash("sha256")
    .update(source)
    .digest("hex");
  if (
    sourceSha256 !==
      fixture.evaluator_authority.controller_sha256
  ) {
    throw new Error("neutral evaluator controller source 已漂移");
  }
  return sourceSha256;
}

/** Validates one platform output's intrinsic candidate and session binding. */
function validatePlatformOutput(
  output,
  {
    caseId,
    platform,
    version,
    fixture,
    candidateSkillFingerprint,
    installedCopy,
    minimumStartedAt,
    challengeAttestation,
    completion,
  },
) {
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `platform ${platform} ${caseId} output 不是有效 JSON`,
      { cause: error },
    );
  }
  const result = document?.result;
  const startedAt = parseTime(
    document?.started_at,
    `platform ${platform} ${caseId}.started_at`,
  );
  const expectedResult = caseId === "positive"
    ? {
        triggered_skill: true,
        target_and_reference_read: true,
        analysis_correct: true,
        stable_ids: true,
        decision_boundary: true,
        files_modified: false,
      }
    : {
        triggered_skill: false,
        target_and_reference_read: false,
        analysis_correct: true,
        stable_ids: false,
        decision_boundary: false,
        files_modified: false,
      };
  const documentKeys = [
    "schema_version",
    "case",
    "evaluation_input_sha256",
    "candidate_skill_fingerprint",
    "platform",
    "platform_version",
    "challenge_nonce",
    "started_at",
    "installed_copy",
    "result",
  ];
  const resultKeys = [...Object.keys(expectedResult), "evidence"];
  const expectedChallenge = challengeAttestation.challenges.find(
    (challenge) =>
      challenge.platform === platform &&
      challenge.case === caseId,
  );
  if (
    !hasExactKeys(document, documentKeys) ||
    document?.schema_version !== 1 ||
    document?.case !== caseId ||
    document?.evaluation_input_sha256 !==
      evaluationInputFingerprint(fixture) ||
    document?.candidate_skill_fingerprint !==
      candidateSkillFingerprint ||
    document?.platform !== platform ||
    document?.platform_version !== version ||
    document?.platform_version !==
      expectedChallenge?.platform_version ||
    document?.challenge_nonce !==
      expectedChallenge?.challenge_nonce ||
    startedAt <
      parseTime(minimumStartedAt, "platform minimum start") ||
    startedAt <
      parseTime(
        challengeAttestation.issued_at,
        "platform challenge issued_at",
      ) ||
    document.started_at !== completion?.started_at ||
    document.platform_version !== completion?.platform_version ||
    document.challenge_nonce !== completion?.challenge_nonce ||
    !isObject(installedCopy) ||
    !hasExactKeys(
      document?.installed_copy,
      ["tree_fingerprint", "file_count"],
    ) ||
    document?.installed_copy?.tree_fingerprint !==
      installedCopy.tree_fingerprint ||
    document?.installed_copy?.file_count !==
      installedCopy.file_count ||
    canonicalJson(document.installed_copy) !==
      canonicalJson(completion?.installed_copy_before) ||
    !hasExactKeys(result, resultKeys) ||
    Object.entries(expectedResult).some(
      ([key, value]) => result[key] !== value,
    ) ||
    !Array.isArray(result.evidence) ||
    result.evidence.length === 0 ||
    result.evidence.some(
      (item) => typeof item !== "string" || item.length === 0,
    )
  ) {
    throw new Error(
      `platform ${platform} ${caseId} output session 綁定不一致`,
    );
  }
  return {
    document,
    challenge_nonce: document.challenge_nonce,
  };
}

/** Recomputes one publishable platform summary from its public fields. */
function recomputePlatformValidation(
  platformValidation,
  fixture,
  candidateSkillFingerprint,
  minimumValidatedAt,
) {
  const copy = clone(platformValidation);
  parseTime(copy.validated_at, "platform_validation.validated_at");
  const platforms = copy.platforms ?? [];
  const copies = copy.installed_copies ?? [];
  const requirements =
    fixture.aggregate_template.platform_requirements;
  const currentCopyIds = copies.every(
    (item) =>
      typeof item.case === "string" &&
      typeof item.installation_relative_path === "string",
  );
  const copyIdentityPassed = currentCopyIds
    ? canonicalJson(
        copies
          .map((item) => `${item.platform}:${item.case}`)
          .sort(),
      ) ===
        canonicalJson(
          requirements.platforms
            .flatMap((platform) =>
              PLATFORM_CASES.map(
                (caseId) => `${platform}:${caseId}`,
              ))
            .sort(),
        )
    : copies.every(
        (item) =>
          !Object.hasOwn(item, "case") &&
          !Object.hasOwn(item, "installation_relative_path"),
      ) &&
      canonicalJson(copies.map((item) => item.platform).sort()) ===
        canonicalJson([...requirements.platforms].sort());
  copy.passed =
    copy.candidate_skill_fingerprint === candidateSkillFingerprint &&
    parseTime(copy.validated_at, "platform_validation.validated_at") >=
      parseTime(minimumValidatedAt, "platform minimum time") &&
    copy.installer?.name === requirements.installer &&
    copy.installer?.scope === requirements.scope &&
    copyIdentityPassed &&
    copies.every(
      (item) =>
        (
          !currentCopyIds ||
          item.installation_relative_path ===
            PLATFORM_INSTALL_PATHS[item.platform]
        ) &&
        item.tree_fingerprint === candidateSkillFingerprint &&
        item.file_count === fixture.runtime_bundle.candidate_file_count,
    ) &&
    canonicalJson(platforms.map((platform) => platform.id).sort()) ===
      canonicalJson([...requirements.platforms].sort()) &&
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
        SHA256_PATTERN.test(platform.positive_output_sha256 ?? "") &&
        SHA256_PATTERN.test(platform.negative_output_sha256 ?? "") &&
        SHA256_PATTERN.test(
          platform.positive_transcript_sha256 ?? "",
        ) &&
        SHA256_PATTERN.test(
          platform.negative_transcript_sha256 ?? "",
        ) &&
        platform.passed === true,
    );
  return copy;
}

/** Derives one canonical platform case from raw outputs, transcripts, and signed completion. */
function derivePlatformCaseEvidence(
  platform,
  {
    fixture,
    candidateSkillFingerprint,
    installedCopyByCase,
    minimumStartedAt,
    challengeAttestation,
    completionById,
  },
) {
  if (
    sha256Text(platform.positive_output) !==
      platform.positive_output_sha256 ||
    sha256Text(platform.negative_output) !==
      platform.negative_output_sha256 ||
    sha256Text(platform.positive_transcript) !==
      platform.positive_transcript_sha256 ||
    sha256Text(platform.negative_transcript) !==
      platform.negative_transcript_sha256
  ) {
    throw new Error(
      `platform ${platform.id} output／transcript hash 不一致`,
    );
  }
  const positiveCompletion = completionById.get(
    `${platform.id}:positive`,
  );
  const negativeCompletion = completionById.get(
    `${platform.id}:negative`,
  );
  const positive = validatePlatformOutput(
    platform.positive_output,
    {
      caseId: "positive",
      platform: platform.id,
      version: platform.version,
      fixture,
      candidateSkillFingerprint,
      installedCopy: installedCopyByCase.get("positive"),
      minimumStartedAt,
      challengeAttestation,
      completion: positiveCompletion,
    },
  );
  const negative = validatePlatformOutput(
    platform.negative_output,
    {
      caseId: "negative",
      platform: platform.id,
      version: platform.version,
      fixture,
      candidateSkillFingerprint,
      installedCopy: installedCopyByCase.get("negative"),
      minimumStartedAt,
      challengeAttestation,
      completion: negativeCompletion,
    },
  );
  const positiveSession = inspectPlatformTranscript(
    platform.id,
    platform.positive_transcript,
    platform.positive_output,
    {
      allowedRoot: positiveCompletion?.workspace_root,
      caseId: "positive",
      requiredReads: positiveCompletion?.required_reads,
    },
  );
  const negativeSession = inspectPlatformTranscript(
    platform.id,
    platform.negative_transcript,
    platform.negative_output,
    {
      allowedRoot: negativeCompletion?.workspace_root,
      caseId: "negative",
      requiredReads: negativeCompletion?.required_reads,
    },
  );
  if (
    positiveCompletion?.output_sha256 !==
      platform.positive_output_sha256 ||
    positiveCompletion?.transcript_sha256 !==
      platform.positive_transcript_sha256 ||
    positiveCompletion?.provider_session_nonce !==
      positiveSession.session_nonce ||
    positiveCompletion?.tool_calls !==
      positiveSession.tool_calls ||
    positiveCompletion?.tool_sequence_sha256 !==
      positiveSession.tool_sequence_sha256 ||
    negativeCompletion?.output_sha256 !==
      platform.negative_output_sha256 ||
    negativeCompletion?.transcript_sha256 !==
      platform.negative_transcript_sha256 ||
    negativeCompletion?.provider_session_nonce !==
      negativeSession.session_nonce ||
    negativeCompletion?.tool_calls !==
      negativeSession.tool_calls ||
    negativeCompletion?.tool_sequence_sha256 !==
      negativeSession.tool_sequence_sha256
  ) {
    throw new Error(
      `platform ${platform.id} completion 未綁定 output／transcript`,
    );
  }
  for (const [field, actual] of [
    [
      "positive_provider_session_nonce",
      positiveSession.session_nonce,
    ],
    [
      "negative_provider_session_nonce",
      negativeSession.session_nonce,
    ],
  ]) {
    if (Object.hasOwn(platform, field) && platform[field] !== actual) {
      throw new Error(
        `platform ${platform.id} provider session nonce 不一致`,
      );
    }
  }
  return {
    platform: {
      id: platform.id,
      version: platform.version,
      explicit_trigger:
        positive.document.result.triggered_skill,
      target_and_reference_read:
        positive.document.result.target_and_reference_read,
      positive_analysis:
        positive.document.result.analysis_correct,
      negative_non_trigger:
        negative.document.result.triggered_skill === false &&
        negative.document.result.target_and_reference_read === false &&
        negative.document.result.analysis_correct === true,
      stable_ids: positive.document.result.stable_ids,
      decision_boundary:
        positive.document.result.decision_boundary,
      files_modified:
        positive.document.result.files_modified ||
        negative.document.result.files_modified,
      positive_provider_session_nonce:
        positiveSession.session_nonce,
      negative_provider_session_nonce:
        negativeSession.session_nonce,
      positive_output: platform.positive_output,
      positive_output_sha256:
        platform.positive_output_sha256,
      positive_transcript: platform.positive_transcript,
      positive_transcript_sha256:
        platform.positive_transcript_sha256,
      negative_output: platform.negative_output,
      negative_output_sha256:
        platform.negative_output_sha256,
      negative_transcript: platform.negative_transcript,
      negative_transcript_sha256:
        platform.negative_transcript_sha256,
      passed: true,
    },
    nonces: [
      positiveSession.session_nonce,
      negativeSession.session_nonce,
    ],
    completionTimes: [
      parseTime(
        positiveCompletion.completed_at,
        `${platform.id} positive.completed_at`,
      ),
      parseTime(
        negativeCompletion.completed_at,
        `${platform.id} negative.completed_at`,
      ),
    ],
  };
}

/** Captures live platform paths as a self-contained evidence document. */
export function capturePlatformValidationEvidence(
  source,
  {
    fixture,
    candidateSkillFingerprint,
    minimumValidatedAt,
  },
) {
  validateDocument("platform-validation", source);
  if (
    source.candidate_skill_fingerprint !==
      candidateSkillFingerprint
  ) {
    throw new Error("platform source candidate fingerprint 不一致");
  }
  const challengeAttestation =
    verifyPlatformChallengeAttestation(
      source.challenge_attestation,
      {
        fixture,
        candidateSkillFingerprint,
        minimumIssuedAt: minimumValidatedAt,
      },
    );
  const completionAttestation =
    verifyPlatformCompletionAttestation(
      source.completion_attestation,
      {
        fixture,
        candidateSkillFingerprint,
        challengeAttestation,
        minimumCompletedAt: minimumValidatedAt,
      },
    );
  const completionById = new Map(
    completionAttestation.sessions.map((session) => [
      `${session.platform}:${session.case}`,
      session,
    ]),
  );
  const copies = source.installed_copies.map((item) => {
    const metadata = lstatSync(item.path);
    const installedSkillRoot = realpathSync(item.path);
    const completion = completionById.get(
      `${item.platform}:${item.case}`,
    );
    const expectedInstalledRoot = completion === undefined
      ? null
      : resolve(
          completion.workspace_root,
          completion.installation_relative_path,
        );
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      fingerprintTree(item.path) !== item.tree_fingerprint ||
      countTreeFiles(item.path) !== item.file_count ||
      installedSkillRoot !== expectedInstalledRoot ||
      item.installation_relative_path !==
        completion?.installation_relative_path ||
      canonicalJson({
        tree_fingerprint: item.tree_fingerprint,
        file_count: item.file_count,
      }) !== canonicalJson(completion?.installed_copy_after) ||
      completion.required_reads.some(
        (read) =>
          sha256Text(
            readFileSync(
              resolve(completion.workspace_root, read.path),
              "utf8",
            ),
          ) !== read.sha256,
      )
    ) {
      throw new Error(
        `platform ${item.platform}:${item.case} installed copy 已漂移`,
      );
    }
    return {
      platform: item.platform,
      case: item.case,
      installation_relative_path:
        item.installation_relative_path,
      tree_fingerprint: item.tree_fingerprint,
      file_count: item.file_count,
    };
  });
  const copyById = new Map(
    copies.map(
      (copy) => [`${copy.platform}:${copy.case}`, copy],
    ),
  );
  const nonces = [];
  const platforms = source.platforms.map((platform) => {
    const derived = derivePlatformCaseEvidence({
      id: platform.id,
      version: platform.version,
      positive_output: readPrivateOutput(
        platform.positive_output_path,
        `${platform.id} positive output`,
      ),
      positive_output_sha256:
        platform.positive_output_sha256,
      positive_transcript: readPrivateOutput(
        platform.positive_transcript_path,
        `${platform.id} positive transcript`,
      ),
      positive_transcript_sha256:
        platform.positive_transcript_sha256,
      negative_output: readPrivateOutput(
        platform.negative_output_path,
        `${platform.id} negative output`,
      ),
      negative_output_sha256:
        platform.negative_output_sha256,
      negative_transcript: readPrivateOutput(
        platform.negative_transcript_path,
        `${platform.id} negative transcript`,
      ),
      negative_transcript_sha256:
        platform.negative_transcript_sha256,
    }, {
      fixture,
      candidateSkillFingerprint,
      installedCopyByCase: new Map(
        PLATFORM_CASES.map((caseId) => [
          caseId,
          copyById.get(`${platform.id}:${caseId}`),
        ]),
      ),
      minimumStartedAt: minimumValidatedAt,
      challengeAttestation,
      completionById,
    });
    nonces.push(...derived.nonces);
    return derived.platform;
  });
  if (
    nonces.length === 0 ||
    new Set(nonces).size !== nonces.length
  ) {
    throw new Error("platform validation session nonce 必須唯一");
  }
  const validatedAt = completionAttestation.attested_at;
  const evidence = {
    schema_version: 1,
    candidate_skill_fingerprint:
      source.candidate_skill_fingerprint,
    validated_at: validatedAt,
    installer: clone(source.installer),
    challenge_attestation: challengeAttestation,
    completion_attestation: completionAttestation,
    installed_copies: copies,
    platforms,
    environment_baseline_failures:
      clone(source.environment_baseline_failures),
    passed: true,
  };
  const recomputed = recomputePlatformValidation(
    evidence,
    fixture,
    candidateSkillFingerprint,
    minimumValidatedAt,
  );
  evidence.passed = recomputed.passed;
  validateDocument("platform-validation-evidence", evidence);
  return evidence;
}

/** Rebuilds a public platform summary from self-contained evidence. */
function buildPlatformValidationSummaryFromEvidence({
  evidence,
  fixture,
  candidateSkillFingerprint,
  minimumValidatedAt,
}) {
  validateDocument("platform-validation-evidence", evidence);
  const challengeAttestation =
    verifyPlatformChallengeAttestation(
      evidence.challenge_attestation,
      {
        fixture,
        candidateSkillFingerprint,
        minimumIssuedAt: minimumValidatedAt,
      },
    );
  const completionAttestation =
    verifyPlatformCompletionAttestation(
      evidence.completion_attestation,
      {
        fixture,
        candidateSkillFingerprint,
        challengeAttestation,
        minimumCompletedAt: minimumValidatedAt,
      },
    );
  const completionById = new Map(
    completionAttestation.sessions.map((session) => [
      `${session.platform}:${session.case}`,
      session,
    ]),
  );
  const copyById = new Map(
    evidence.installed_copies.map(
      (copy) => [`${copy.platform}:${copy.case}`, copy],
    ),
  );
  const nonces = [];
  const completions = [];
  const rebuiltPlatforms = evidence.platforms.map((platform) => {
    const derived = derivePlatformCaseEvidence(platform, {
      fixture,
      candidateSkillFingerprint,
      installedCopyByCase: new Map(
        PLATFORM_CASES.map((caseId) => [
          caseId,
          copyById.get(`${platform.id}:${caseId}`),
        ]),
      ),
      minimumStartedAt: minimumValidatedAt,
      challengeAttestation,
      completionById,
    });
    const rebuilt = derived.platform;
    if (canonicalJson(rebuilt) !== canonicalJson(platform)) {
      throw new Error(
        `platform ${platform.id} summary 未由 output session 重建`,
      );
    }
    nonces.push(...derived.nonces);
    completions.push(...derived.completionTimes);
    return rebuilt;
  });
  if (
    new Set(nonces).size !== nonces.length ||
    evidence.validated_at !==
      completionAttestation.attested_at ||
    completions.some(
      (completedAt) =>
        completedAt >
          parseTime(
            completionAttestation.attested_at,
            "platform completion attested_at",
          ),
    )
  ) {
    throw new Error(
      "platform validated_at 或 session nonce 未由 outputs 重建",
    );
  }
  const summary = recomputePlatformValidation(
    {
      candidate_skill_fingerprint:
        evidence.candidate_skill_fingerprint,
      validated_at: evidence.validated_at,
      installer: clone(evidence.installer),
      installed_copies: clone(evidence.installed_copies),
      platforms: rebuiltPlatforms.map((platform) => {
        const copy = clone(platform);
        delete copy.positive_output;
        delete copy.negative_output;
        delete copy.positive_transcript;
        delete copy.negative_transcript;
        delete copy.positive_provider_session_nonce;
        delete copy.negative_provider_session_nonce;
        return copy;
      }),
      passed: evidence.passed,
    },
    fixture,
    candidateSkillFingerprint,
    minimumValidatedAt,
  );
  if (summary.passed !== evidence.passed) {
    throw new Error("platform validation passed 未由來源重算");
  }
  return {
    summary,
    source_sha256: fingerprint(evidence),
    evidence: clone(evidence),
  };
}

/** Validates live private platform evidence and returns its public summary. */
export function buildPlatformValidationSummary({
  source,
  fixture,
  candidateSkillFingerprint,
  minimumValidatedAt,
}) {
  return buildPlatformValidationSummaryFromEvidence({
    evidence: capturePlatformValidationEvidence(source, {
      fixture,
      candidateSkillFingerprint,
      minimumValidatedAt,
    }),
    fixture,
    candidateSkillFingerprint,
    minimumValidatedAt,
  });
}

/** Derives one aggregate from already validated public source identities. */
function deriveAggregateFromValidatedSources({
  adjudication,
  measurement,
  fixture,
  currentSkillFingerprint,
  platformValidation,
  platformValidationSourceSha256,
  privateSourceManifestSha256,
}) {
  const judged = validateBlindedAdjudication(adjudication, fixture);
  const measured = validateBlindedMeasurement(
    measurement,
    judged,
    fixture,
  );
  if (
    !SHA256_PATTERN.test(currentSkillFingerprint ?? "") ||
    !SHA256_PATTERN.test(platformValidationSourceSha256 ?? "") ||
    !SHA256_PATTERN.test(privateSourceManifestSha256 ?? "")
  ) {
    throw new Error("candidate 或 platform source fingerprint 不合法");
  }
  const platforms = recomputePlatformValidation(
    platformValidation,
    fixture,
    currentSkillFingerprint,
    judged.judging.unblinded_at,
  );
  const evaluatedAt = platforms.validated_at;
  parseTime(evaluatedAt, "evaluated_at");
  const limits = fixture.aggregate_template.limits;
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
  const aggregate = {
    schema_version: 5,
    evidence_kind: "blinded-forward-aggregate",
    evaluated_at: evaluatedAt,
    fixture: fixture.id,
    candidate_skill_fingerprint: currentSkillFingerprint,
    raw_outputs_published: false,
    evidence_sources: {
      adjudication_sha256: fingerprint(judged),
      measurement_sha256: fingerprint(measured),
      platform_validation_sha256:
        platformValidationSourceSha256,
      private_source_manifest_sha256:
        privateSourceManifestSha256,
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
      evaluation_input_sha256:
        judged.assignment.evaluation_input_sha256,
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
        runtime_bundle: fixture.runtime_bundle,
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

/** Derives the complete publishable aggregate from adjudication and measurement. */
export function deriveBlindedForwardAggregate({
  adjudication,
  measurement,
  fixture,
  currentSkillFingerprint,
  platformValidationSource,
  privateSourceManifestSha256,
}) {
  const judged = validateBlindedAdjudication(adjudication, fixture);
  const platform = buildPlatformValidationSummary({
    source: platformValidationSource,
    fixture,
    candidateSkillFingerprint: currentSkillFingerprint,
    minimumValidatedAt: judged.judging.unblinded_at,
  });
  return deriveAggregateFromValidatedSources({
    adjudication: judged,
    measurement,
    fixture,
    currentSkillFingerprint,
    platformValidation: platform.summary,
    platformValidationSourceSha256: platform.source_sha256,
    privateSourceManifestSha256,
  });
}

/** Re-derives a public aggregate from its committed private source identity. */
export function rederiveBlindedForwardAggregate({
  aggregate,
  adjudication,
  measurement,
  fixture,
  currentSkillFingerprint,
}) {
  validateDocument("blinded-forward-aggregate", aggregate);
  return deriveAggregateFromValidatedSources({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint,
    platformValidation: aggregate.platform_validation,
    platformValidationSourceSha256:
      aggregate.evidence_sources.platform_validation_sha256,
    privateSourceManifestSha256:
      aggregate.evidence_sources.private_source_manifest_sha256,
  });
}

/** Builds the source-and-result payload a neutral evaluator must attest. */
export function buildEvaluationAuthorityPayload({
  candidateSkillFingerprint,
  fixtureSha256,
  fixture,
  assignment,
  sessions,
  labelA,
  labelB,
  judgeOutput,
  measuredAt,
  unblindedAt,
  platformValidationSource,
  aggregate,
}) {
  const authority = fixture.evaluator_authority;
  const forward = aggregate.forward_evaluation;
  return {
    schema_version: 1,
    authority_id: authority.authority_id,
    authority_version: authority.version,
    controller_sha256: authority.controller_sha256,
    candidate_skill_fingerprint: candidateSkillFingerprint,
    fixture_sha256: fixtureSha256,
    evaluation_input_sha256: evaluationInputFingerprint(fixture),
    source_commitments: {
      assignment_sha256: fingerprint(assignment),
      sessions_sha256: fingerprint(sessions),
      label_a_output_sha256: sha256Text(labelA.output),
      label_a_transcript_sha256: sha256Text(labelA.events),
      label_b_output_sha256: sha256Text(labelB.output),
      label_b_transcript_sha256: sha256Text(labelB.events),
      judge_output_sha256: fingerprint(judgeOutput),
      judge_transcript_sha256: sha256Text(
        sessions.judge.transcript,
      ),
      measured_at_sha256: sha256Text(measuredAt),
      unblinded_at_sha256: sha256Text(unblindedAt),
      platform_source_sha256: fingerprint(platformValidationSource),
    },
    expected_result: {
      baseline_passed_behaviors:
        forward.baseline_passed_behaviors,
      candidate_passed_behaviors:
        forward.candidate_passed_behaviors,
      candidate_regressions: forward.candidate_regressions,
      false_positive_optimizations:
        forward.false_positive_optimizations,
      baseline_tool_calls: aggregate.cost.baseline_tool_calls,
      candidate_tool_calls: aggregate.cost.candidate_tool_calls,
      forward_passed: forward.passed,
      cost_passed: aggregate.cost.passed,
      platform_passed: aggregate.platform_validation.passed,
    },
  };
}

/** Verifies one independently signed neutral-evaluator attestation. */
function verifyEvaluationAuthorityAttestation(
  attestation,
  payload,
  fixture,
) {
  const authority = fixture.evaluator_authority;
  if (
    !hasExactKeys(
      attestation,
      [
        "schema_version",
        "authority_id",
        "authority_version",
        "controller_sha256",
        "payload_sha256",
        "signature_base64",
      ],
    ) ||
    attestation.schema_version !== 1 ||
    attestation.authority_id !== authority.authority_id ||
    attestation.authority_version !== authority.version ||
    attestation.controller_sha256 !== authority.controller_sha256 ||
    attestation.payload_sha256 !== fingerprint(payload) ||
    typeof attestation.signature_base64 !== "string" ||
    attestation.signature_base64.length === 0
  ) {
    throw new Error("neutral evaluator attestation identity 不一致");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(authority.public_key_pem);
  } catch (error) {
    throw new Error("neutral evaluator public key 不合法", {
      cause: error,
    });
  }
  const signature = Buffer.from(
    attestation.signature_base64,
    "base64",
  );
  if (
    signature.length === 0 ||
    !verifySignature(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKey,
      signature,
    )
  ) {
    throw new Error("neutral evaluator attestation signature 不一致");
  }
  return clone(attestation);
}

/** Builds the exact private source manifest committed by one binding. */
function buildPrivateSourceManifest(
  privateSources,
  platformSummary,
  evaluatorAttestation,
) {
  return {
    builder:
      "agent-skill-maintainer/private-forward-binding-v1",
    assignment_sha256:
      fingerprint(privateSources.assignment),
    sessions_sha256: fingerprint(privateSources.sessions),
    label_a_output_sha256:
      sha256Text(privateSources.label_a_output),
    label_a_events_sha256:
      sha256Text(privateSources.label_a_events),
    label_b_output_sha256:
      sha256Text(privateSources.label_b_output),
    label_b_events_sha256:
      sha256Text(privateSources.label_b_events),
    judge_output_sha256:
      fingerprint(privateSources.judge_output),
    measured_at_sha256:
      sha256Text(privateSources.measured_at),
    unblinded_at_sha256:
      sha256Text(privateSources.unblinded_at),
    platform_validation_sha256:
      fingerprint(privateSources.platform_validation_evidence),
    platform_summary_sha256: fingerprint(platformSummary),
    evaluator_attestation_sha256:
      fingerprint(evaluatorAttestation),
  };
}

/** Derives canonical binding artifacts from already captured private sources. */
function deriveBindingArtifacts({
  candidate,
  fixture,
  privateSources,
  platform,
  evaluatorAttestation,
}) {
  const measurement = buildBlindedMeasurement({
    fixture,
    labelA: {
      output: privateSources.label_a_output,
      events: privateSources.label_a_events,
    },
    labelB: {
      output: privateSources.label_b_output,
      events: privateSources.label_b_events,
    },
    measuredAt: privateSources.measured_at,
  });
  const adjudication = buildBlindedAdjudication({
    fixture,
    assignment: privateSources.assignment,
    sessions: privateSources.sessions,
    labelOutputs: {
      a: privateSources.label_a_output,
      b: privateSources.label_b_output,
    },
    labelTranscripts: {
      a: privateSources.label_a_events,
      b: privateSources.label_b_events,
    },
    judgeOutput: privateSources.judge_output,
    measurement,
    unblindedAt: privateSources.unblinded_at,
  });
  const preliminaryManifest = buildPrivateSourceManifest(
    privateSources,
    platform.summary,
    {
      pending: true,
    },
  );
  const preliminaryAggregate = deriveAggregateFromValidatedSources({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint:
      candidate.candidate_skill_fingerprint,
    platformValidation: platform.summary,
    platformValidationSourceSha256:
      platform.source_sha256,
    privateSourceManifestSha256:
      fingerprint(preliminaryManifest),
  });
  const authorityPayload = buildEvaluationAuthorityPayload({
    candidateSkillFingerprint:
      candidate.candidate_skill_fingerprint,
    fixtureSha256: candidate.evaluation_fixture_sha256,
    fixture,
    assignment: privateSources.assignment,
    sessions: privateSources.sessions,
    labelA: {
      output: privateSources.label_a_output,
      events: privateSources.label_a_events,
    },
    labelB: {
      output: privateSources.label_b_output,
      events: privateSources.label_b_events,
    },
    judgeOutput: privateSources.judge_output,
    measuredAt: privateSources.measured_at,
    unblindedAt: privateSources.unblinded_at,
    platformValidationSource:
      privateSources.platform_validation_evidence,
    aggregate: preliminaryAggregate,
  });
  const verifiedAttestation =
    verifyEvaluationAuthorityAttestation(
      evaluatorAttestation,
      authorityPayload,
      fixture,
    );
  const sourceManifest = buildPrivateSourceManifest(
    privateSources,
    platform.summary,
    verifiedAttestation,
  );
  const aggregate = deriveAggregateFromValidatedSources({
    adjudication,
    measurement,
    fixture,
    currentSkillFingerprint:
      candidate.candidate_skill_fingerprint,
    platformValidation: platform.summary,
    platformValidationSourceSha256:
      platform.source_sha256,
    privateSourceManifestSha256:
      fingerprint(sourceManifest),
  });
  return {
    measurement,
    adjudication,
    verifiedAttestation,
    sourceManifest,
    aggregate,
  };
}

/** Rebuilds private sources and binds them to the final candidate Skill. */
export function buildForwardEvaluationBinding(
  candidateSnapshot,
  {
    fixture,
    assignment,
    sessions,
    labelA,
    labelB,
    judgeOutput,
    measuredAt,
    unblindedAt,
    platformValidationSource,
    candidatePath,
    evaluatorAttestation,
  },
) {
  const candidate = validateCandidateSnapshotContract(candidateSnapshot);
  if (
    candidate.candidate_skill_fingerprint === undefined ||
    candidate.evaluation_fixture_sha256 === undefined
  ) {
    throw new Error("candidate snapshot 缺少 Skill 或 fixture fingerprint");
  }
  const lockedFixture = validateLockedEvaluationFixture(
    fixture,
    candidate.candidate_skill_fingerprint,
  );
  validateCandidateFixture(
    lockedFixture,
    candidate.evaluation_fixture_sha256,
    candidate,
    candidatePath,
  );
  validateCandidateTargetFiles(
    lockedFixture,
    candidate,
    candidatePath,
  );
  validateNeutralControllerSource(lockedFixture, candidatePath);
  const privateSources = {
    assignment: clone(assignment),
    sessions: clone(sessions),
    label_a_output: labelA.output,
    label_a_events: clone(labelA.events),
    label_b_output: labelB.output,
    label_b_events: clone(labelB.events),
    judge_output: clone(judgeOutput),
    measured_at: measuredAt,
    unblinded_at: unblindedAt,
  };
  const platform = buildPlatformValidationSummary({
    source: platformValidationSource,
    fixture: lockedFixture,
    candidateSkillFingerprint:
      candidate.candidate_skill_fingerprint,
    minimumValidatedAt: privateSources.unblinded_at,
  });
  privateSources.platform_validation_evidence =
    clone(platform.evidence);
  const artifacts = deriveBindingArtifacts({
    candidate,
    fixture: lockedFixture,
    privateSources,
    platform,
    evaluatorAttestation,
  });
  const document = {
    schema_version: 2,
    evidence_kind: "blinded-forward-evaluation-binding",
    candidate_skill_fingerprint:
      candidate.candidate_skill_fingerprint,
    fixture_sha256: candidate.evaluation_fixture_sha256,
    aggregate_fingerprint: fingerprint(artifacts.aggregate),
    source_manifest: artifacts.sourceManifest,
    evaluator_attestation: artifacts.verifiedAttestation,
    private_sources: privateSources,
    fixture: lockedFixture,
    adjudication: clone(artifacts.adjudication),
    measurement: clone(artifacts.measurement),
    aggregate: clone(artifacts.aggregate),
  };
  return validateForwardEvaluationBinding(
    document,
    candidate,
    candidatePath,
  );
}

/** Re-derives the aggregate from locked sources before accepting its binding. */
export function validateForwardEvaluationBinding(
  binding,
  candidateSnapshot,
  candidatePath,
) {
  return validateForwardEvaluationBindingContract(
    binding,
    candidateSnapshot,
    candidatePath,
    true,
  );
}

/** Validates one binding with an optional live-candidate requirement. */
function validateForwardEvaluationBindingContract(
  binding,
  candidateSnapshot,
  candidatePath,
  requireLiveCandidate,
) {
  const candidate = validateCandidateSnapshotContract(candidateSnapshot);
  if (
    candidate.candidate_skill_fingerprint === undefined ||
    candidate.evaluation_fixture_sha256 === undefined
  ) {
    throw new Error("candidate snapshot 缺少 Skill 或 fixture fingerprint");
  }
  const document = clone(binding);
  validateDocument("forward-evaluation-binding", document);
  validateDocument("blinded-forward-aggregate", document.aggregate);
  if (
    document.candidate_skill_fingerprint !==
      candidate.candidate_skill_fingerprint ||
    document.aggregate.candidate_skill_fingerprint !==
      candidate.candidate_skill_fingerprint ||
    document.fixture_sha256 !== candidate.evaluation_fixture_sha256
  ) {
    throw new Error("前向評估與 candidate snapshot fingerprint 不一致");
  }
  const fixture = validateLockedEvaluationFixture(
    document.fixture,
    candidate.candidate_skill_fingerprint,
  );
  if (requireLiveCandidate) {
    validateCandidateFixture(
      fixture,
      document.fixture_sha256,
      candidate,
      candidatePath,
    );
    validateCandidateTargetFiles(
      fixture,
      candidate,
      candidatePath,
    );
    validateNeutralControllerSource(fixture, candidatePath);
  }
  const privateSources = document.private_sources;
  const platform = buildPlatformValidationSummaryFromEvidence({
    evidence: privateSources.platform_validation_evidence,
    fixture,
    candidateSkillFingerprint:
      candidate.candidate_skill_fingerprint,
    minimumValidatedAt: privateSources.unblinded_at,
  });
  const artifacts = deriveBindingArtifacts({
    candidate,
    fixture,
    privateSources,
    platform,
    evaluatorAttestation:
      document.evaluator_attestation,
  });
  if (
    canonicalJson(document.source_manifest) !==
      canonicalJson(artifacts.sourceManifest)
  ) {
    throw new Error("前向評估未綁定 private source manifest");
  }
  if (
    canonicalJson(document.adjudication) !==
      canonicalJson(artifacts.adjudication) ||
    canonicalJson(document.measurement) !==
      canonicalJson(artifacts.measurement) ||
    canonicalJson(document.aggregate) !==
      canonicalJson(artifacts.aggregate)
  ) {
    throw new Error("前向評估未由 private sources 精確重建");
  }
  if (
    document.aggregate_fingerprint !==
      fingerprint(artifacts.aggregate)
  ) {
    throw new Error("前向評估 aggregate fingerprint 已漂移");
  }
  if (
    artifacts.aggregate.forward_evaluation.passed !== true ||
    artifacts.aggregate.forward_evaluation.candidate_regressions !== 0 ||
    artifacts.aggregate.cost.passed !== true ||
    artifacts.aggregate.platform_validation.passed !== true
  ) {
    throw new Error("前向評估、成本或平台門檻尚未通過");
  }
  return document;
}

/** Rebuilds candidate validation and optionally checks current forward evidence. */
function validatePrReadyValidationContract(
  validationSummary,
  candidateSnapshot,
  requireForwardEvaluationBinding,
  candidatePath,
  requireLiveCandidate,
) {
  const candidate = validateCandidateSnapshotContract(candidateSnapshot);
  const summary = clone(validationSummary);
  validateDocument("validation", summary);
  if (
    summary.candidate_diff_hash !== candidate.candidate_diff_hash ||
    summary.passed !== true ||
    summary.blockers.length !== 0
  ) {
    throw new Error("候選驗證摘要與目前 Diff 不一致或尚未通過");
  }
  const checkIds = new Set(summary.checks.map((check) => check?.id));
  const rebuilt = buildValidationResult(candidate, {
    checks: summary.checks,
    requiredCheckIds: checkIds,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(summary)) {
    throw new Error("候選驗證摘要無法由目前 checks 重建");
  }
  const categories = new Set(summary.checks.map((check) => check.category));
  const missingCategories = [
    "safety",
    "regression",
    "forward",
    "quality",
    "documentation",
  ].filter((category) => !categories.has(category));
  if (missingCategories.length > 0) {
    throw new Error(
      `候選驗證缺少必要類別：${missingCategories.join(", ")}`,
    );
  }
  if (summary.checks.some((check) => check.status !== "passed")) {
    throw new Error("PR 前所有候選檢查都必須通過");
  }
  if (requireForwardEvaluationBinding) {
    const forwardChecks = summary.checks.filter(
      (check) => check.category === "forward",
    );
    if (forwardChecks.length !== 1) {
      throw new Error("PR 前必須包含且只能包含一項前向評估檢查");
    }
    validateForwardEvaluationBindingContract(
      forwardChecks[0].details,
      candidate,
      candidatePath,
      requireLiveCandidate,
    );
  }
  return summary;
}

/** Rebuilds a PR-ready result and requires current candidate-bound evidence. */
export function validatePrReadyValidation(
  validationSummary,
  candidateSnapshot,
  candidatePath,
) {
  return validatePrReadyValidationContract(
    validationSummary,
    candidateSnapshot,
    true,
    candidatePath,
    true,
  );
}

/** Rebuilds already-preflighted PR-ready evidence without live filesystem I/O. */
export function validateRecordedPrReadyValidation(
  validationSummary,
  candidateSnapshot,
) {
  return validatePrReadyValidationContract(
    validationSummary,
    candidateSnapshot,
    true,
    undefined,
    false,
  );
}

/** Rebuilds historical validation only for bounded terminal recovery. */
export function validateLegacyTerminalValidation(
  validationSummary,
  candidateSnapshot,
) {
  return validatePrReadyValidationContract(
    validationSummary,
    candidateSnapshot,
    false,
    undefined,
    false,
  );
}

/** Identifies old aggregate records without treating them as a current gate. */
export function inspectBlindedForwardAggregate(document) {
  if (!isObject(document) || !Number.isInteger(document.schema_version)) {
    throw new Error("blinded aggregate 格式不合法");
  }
  if ([2, 3, 4].includes(document.schema_version)) {
    return {
      schema_version: document.schema_version,
      historical: true,
      publishable: false,
      reason:
        document.schema_version === 2
          ? "legacy_boolean_summary"
          : "uncommitted_evaluation_inputs",
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
