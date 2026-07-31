#!/usr/bin/env node
/**
 * Independently validates raw held-out evidence and signs its result summary.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = realpathSync(fileURLToPath(import.meta.url));
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLATFORM_CASES = ["positive", "negative"];
const PLATFORM_CHALLENGE_LIFETIME_MS = 60 * 60 * 1000;
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
const COMMON_PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const PROVIDER_ENVIRONMENT_KEYS = Object.freeze({
  codex: Object.freeze([
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
  ]),
  "claude-code": Object.freeze([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_MODEL",
  ]),
});
const PROVIDER_SECRET_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
]);
const COMMON_FORBIDDEN_PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "all_proxy",
  "http_proxy",
  "https_proxy",
]);
const FORBIDDEN_PROVIDER_ENVIRONMENT_KEYS = Object.freeze({
  codex: Object.freeze([
    "AZURE_OPENAI_ENDPOINT",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ]),
  "claude-code": Object.freeze([
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
  ]),
});
const TRANSCRIPT_TOOL_TYPES = [
  "command_execution",
  "todo_list",
];
const FORBIDDEN_TRANSCRIPT_PATH_PARTS = [
  "/.agents/skills/",
  "/candidates/",
  "/private/",
  ".agents/skills/",
  "candidates/",
  "private/",
];
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

/** Returns recursively sorted JSON for stable cross-implementation hashes. */
function canonicalJson(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) {
      return item.map(canonicalize);
    }
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonicalize(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

/** Returns the SHA-256 of one UTF-8 string. */
function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns the canonical JSON SHA-256 of one value. */
function fingerprint(value) {
  return sha256Text(canonicalJson(value));
}

/** Orders path text by raw UTF-8 bytes. */
function compareUtf8(first, second) {
  return Buffer.compare(
    Buffer.from(first, "utf8"),
    Buffer.from(second, "utf8"),
  );
}

/** Returns one Git-compatible regular-file mode. */
function regularFileMode(metadata) {
  if (process.platform === "win32") {
    return "100644";
  }
  return (metadata.mode & 0o111) === 0 ? "100644" : "100755";
}

/** Inspects a complete regular-file tree without following links. */
function inspectRegularTree(path) {
  const root = realpathSync(resolve(path));
  if (!lstatSync(root).isDirectory()) {
    throw new Error("platform installed copy must be a directory");
  }
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== ".git")
      .sort((first, second) =>
        compareUtf8(first.name, second.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute)
        .split(sep)
        .join("/");
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `platform installed copy contains symlink: ${relativePath}`,
        );
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(
          `platform installed copy contains special entry: ${relativePath}`,
        );
      }
      files.push({
        mode: regularFileMode(metadata),
        path: relativePath,
        sha256: createHash("sha256")
          .update(readFileSync(absolute))
          .digest("hex"),
      });
    }
  };
  visit(root);
  files.sort((first, second) => compareUtf8(first.path, second.path));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.mode}\0${file.path}\0`, "utf8");
    digest.update(Buffer.from(file.sha256, "hex"));
  }
  return {
    tree_fingerprint: digest.digest("hex"),
    file_count: files.length,
  };
}

/** Copies one verified regular-file tree without links or special entries. */
function copyRegularTree(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const entries = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .sort((first, second) =>
      compareUtf8(first.name, second.name));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = lstatSync(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new Error("platform installed copy contains symlink");
    }
    if (metadata.isDirectory()) {
      copyRegularTree(sourcePath, destinationPath);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error("platform installed copy contains special entry");
    }
    copyFileSync(sourcePath, destinationPath);
    chmodSync(
      destinationPath,
      (metadata.mode & 0o111) === 0 ? 0o400 : 0o500,
    );
  }
  chmodSync(destination, 0o500);
}

/** Makes a private session tree removable after evidence capture. */
function makeTreeWritable(path) {
  const metadata = lstatSync(path);
  if (metadata.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      makeTreeWritable(join(path, entry.name));
    }
  } else if (metadata.isFile()) {
    chmodSync(path, 0o600);
  }
}

/** Removes one controller-created session project. */
function removeSessionProject(projectRoot) {
  try {
    makeTreeWritable(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

/** Creates one controller-owned standard project Skill installation. */
function createSessionProject(
  sourcePath,
  platform,
  expectedIdentity,
) {
  const requestedMetadata = lstatSync(sourcePath);
  const sourceRoot = realpathSync(sourcePath);
  if (
    requestedMetadata.isSymbolicLink() ||
    !lstatSync(sourceRoot).isDirectory()
  ) {
    throw new Error("platform installed copy root is invalid");
  }
  const sourceBefore = inspectRegularTree(sourceRoot);
  if (
    canonicalJson(sourceBefore) !== canonicalJson(expectedIdentity)
  ) {
    throw new Error("platform installed copy identity mismatch");
  }
  const projectRoot = realpathSync(
    mkdtempSync(
      join(tmpdir(), "agent-skill-maintainer-platform-"),
    ),
  );
  const installationRelativePath =
    PLATFORM_INSTALL_PATHS[platform];
  const installedSkillRoot = resolve(
    projectRoot,
    installationRelativePath,
  );
  try {
    copyRegularTree(sourceRoot, installedSkillRoot);
    const sourceAfter = inspectRegularTree(sourceRoot);
    const installedBefore = inspectRegularTree(installedSkillRoot);
    if (
      canonicalJson(sourceAfter) !== canonicalJson(sourceBefore) ||
      canonicalJson(installedBefore) !==
        canonicalJson(expectedIdentity)
    ) {
      throw new Error(
        "platform installed copy drifted while creating session project",
      );
    }
    chmodSync(projectRoot, 0o500);
    return {
      projectRoot,
      installedSkillRoot,
      installationRelativePath,
      sourceRoot,
      sourceBefore,
      installedBefore,
    };
  } catch (error) {
    removeSessionProject(projectRoot);
    throw error;
  }
}

/** Returns the three installed target paths required by a positive case. */
function requiredPlatformReadPaths(platform) {
  const installationPath = PLATFORM_INSTALL_PATHS[platform];
  return REQUIRED_PLATFORM_READ_PATHS.map(
    (path) => `${installationPath}/${path}`,
  );
}

/** Returns signed content identities for every required platform read. */
function platformRequiredReads(projectRoot, platform) {
  return requiredPlatformReadPaths(platform).map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(projectRoot, path)))
      .digest("hex"),
  }));
}

/** Returns one controller-owned prompt template without session identity. */
function platformPromptTemplate(platform, caseId) {
  if (!PLATFORM_CASES.includes(caseId)) {
    throw new Error("unsupported platform case prompt");
  }
  const requiredPaths = requiredPlatformReadPaths(platform);
  const caseInstructions = caseId === "positive"
    ? platform === "codex"
      ? [
          `Explicitly use the installed ${PLATFORM_SKILL_NAME} Skill.`,
          "Execute exactly these three read commands as separate tool calls and use no other tool:",
          ...requiredPaths.map(
            (path) => `/bin/zsh -lc "/bin/cat -- '${path}'"`,
          ),
          "Use the files to confirm stable FB/OPT IDs, explicit user decision boundaries, and read-only analysis.",
          "Set triggered_skill, target_and_reference_read, stable_ids, and decision_boundary to true.",
        ]
      : [
          `Explicitly use the installed ${PLATFORM_SKILL_NAME} Skill.`,
          "Use exactly three Read calls and no Glob or Grep calls.",
          ...requiredPaths.map((path) => `Read ${path}`),
          "Use the files to confirm stable FB/OPT IDs, explicit user decision boundaries, and read-only analysis.",
          "Set triggered_skill, target_and_reference_read, stable_ids, and decision_boundary to true.",
        ]
    : [
        "Answer the unrelated arithmetic question: what is 17 + 25?",
        `Do not use or read the ${PLATFORM_SKILL_NAME} Skill and do not call any read tool.`,
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

/** Rejects route-changing provider environment overrides. */
function rejectProviderEnvironmentOverrides(environment, platform) {
  const active = [
    ...COMMON_FORBIDDEN_PROVIDER_ENVIRONMENT_KEYS,
    ...FORBIDDEN_PROVIDER_ENVIRONMENT_KEYS[platform],
  ]
    .filter((key) => (environment[key] ?? "").length > 0);
  if (active.length > 0) {
    throw new Error(
      `formal provider environment contains routing overrides: ${active.join(", ")}`,
    );
  }
}

/** Builds one minimal provider environment without exposing secret values. */
function buildProviderEnvironment(executablePath, platform) {
  rejectProviderEnvironmentOverrides(process.env, platform);
  if (
    platform === "claude-code" &&
    (
      (process.env.ANTHROPIC_BASE_URL ?? "").length === 0 ||
      (process.env.ANTHROPIC_MODEL ?? "") !==
        PLATFORM_EXECUTION_PROFILES["claude-code"].model ||
      (
        (process.env.ANTHROPIC_API_KEY ?? "").length === 0 &&
        (process.env.ANTHROPIC_AUTH_TOKEN ?? "").length === 0
      )
    )
  ) {
    throw new Error(
      "formal current-environment Claude route requires a bound endpoint, k3 model, and credential",
    );
  }
  const environment = {};
  for (const key of [
    ...COMMON_PROVIDER_ENVIRONMENT_KEYS,
    ...PROVIDER_ENVIRONMENT_KEYS[platform],
  ]) {
    if ((process.env[key] ?? "").length > 0) {
      environment[key] = process.env[key];
    }
  }
  environment.PATH = [
    dirname(executablePath),
    dirname(process.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((path, index, paths) =>
      path.length > 0 && paths.indexOf(path) === index)
    .join(delimiter);
  return environment;
}

/** Commits one provider environment using a challenge-specific salt. */
function providerEnvironmentFingerprint(
  environment,
  challengeNonce,
  platform,
) {
  return fingerprint({
    policy_id:
      PLATFORM_EXECUTION_PROFILES[platform].environment_policy,
    values: Object.fromEntries(
      Object.entries(environment)
        .sort(([first], [second]) => compareUtf8(first, second))
        .map(([key, value]) => [
          key,
          PROVIDER_SECRET_ENVIRONMENT_KEYS.has(key)
            ? sha256Text(`${challengeNonce}\0${value}`)
            : value,
        ]),
    ),
  });
}

/** Returns the signed portion of one platform challenge attestation. */
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
    challenges: attestation.challenges,
  };
}

/** Verifies the neutral controller identity and locked fixture bytes. */
function verifyControllerRequest(request) {
  const sourceSha256 = createHash("sha256")
    .update(readFileSync(SOURCE_PATH))
    .digest("hex");
  if (
    request.fixture?.evaluator_authority?.controller_sha256 !==
      sourceSha256 ||
    !SHA256_PATTERN.test(request.fixtureSha256 ?? "") ||
    request.fixtureSha256 !== sha256Text(request.fixtureRaw)
  ) {
    throw new Error("controller or fixture identity mismatch");
  }
}

/** Signs one canonical payload with the evaluator private key. */
function signPayload(payload, privateKeyPath) {
  const privateKey = createPrivateKey(
    readFileSync(privateKeyPath, "utf8"),
  );
  return sign(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey,
  ).toString("base64");
}

/** Resolves one external regular private key outside candidate and run trees. */
function resolveExternalPrivateKey(requestPath, privateKeyPath) {
  if (!isAbsolute(privateKeyPath)) {
    throw new Error("evaluator private key path must be absolute");
  }
  const metadata = lstatSync(privateKeyPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "evaluator private key must be a private regular file",
    );
  }
  const keyPath = realpathSync(privateKeyPath);
  const candidateRoot = dirname(dirname(SOURCE_PATH));
  const request = realpathSync(requestPath);
  const runMarker =
    `${sep}.agent-skill-maintainer${sep}runs${sep}`;
  const runIndex = request.indexOf(runMarker);
  const forbiddenRoots = [candidateRoot];
  if (runIndex >= 0) {
    const runStart = runIndex + runMarker.length;
    const runEnd = request.indexOf(sep, runStart);
    if (runEnd > runStart) {
      forbiddenRoots.push(request.slice(0, runEnd));
    }
  }
  if (
    forbiddenRoots.some(
      (root) =>
        keyPath === root ||
        keyPath.startsWith(`${root}${sep}`),
    )
  ) {
    throw new Error(
      "evaluator private key must be external to candidate and run artifacts",
    );
  }
  return keyPath;
}

/** Issues a short-lived challenge before any platform session starts. */
function issuePlatformChallenge(request, privateKeyPath) {
  verifyControllerRequest(request);
  if (
    request.candidateSkillFingerprint !==
      request.fixture.runtime_bundle.candidate_tree_fingerprint ||
    Date.parse(request.unblindedAt) > Date.now()
  ) {
    throw new Error("platform challenge request identity mismatch");
  }
  const authority = request.fixture.evaluator_authority;
  const issuedAt = new Date().toISOString();
  const runtimes = new Map(
    request.fixture.aggregate_template
      .platform_requirements.platforms
      .map((platform) => [
        platform,
        observePlatformRuntime(platform),
      ]),
  );
  const payload = {
    schema_version: 1,
    authority_id: authority.authority_id,
    authority_version: authority.version,
    controller_sha256: authority.controller_sha256,
    candidate_skill_fingerprint:
      request.candidateSkillFingerprint,
    evaluation_input_sha256: fingerprint(request.fixture),
    issued_at: issuedAt,
    expires_at: new Date(
      Date.parse(issuedAt) + PLATFORM_CHALLENGE_LIFETIME_MS,
    ).toISOString(),
    challenges: [
      ...request.fixture.aggregate_template
        .platform_requirements.platforms,
    ]
      .sort()
      .flatMap((platform) =>
        PLATFORM_CASES.map((caseId) => {
          const challengeNonce = randomUUID();
          const runtime = runtimes.get(platform);
          return {
            platform,
            case: caseId,
            platform_version: runtime.version,
            executable_sha256: runtime.executable_sha256,
            execution_profile_sha256:
              runtime.execution_profile_sha256,
            environment_sha256:
              providerEnvironmentFingerprint(
                runtime.provider_environment,
                challengeNonce,
                platform,
              ),
            prompt_template_sha256: sha256Text(
              platformPromptTemplate(platform, caseId),
            ),
            installation_relative_path:
              PLATFORM_INSTALL_PATHS[platform],
            challenge_nonce: challengeNonce,
          };
        })),
  };
  return {
    ...payload,
    payload_sha256: fingerprint(payload),
    signature_base64: signPayload(payload, privateKeyPath),
  };
}

/** Verifies the signed platform challenge and returns case lookups. */
function verifyPlatformChallenge(request) {
  const attestation =
    request.platformValidationEvidence.challenge_attestation;
  const payload = platformChallengePayload(attestation);
  const authority = request.fixture.evaluator_authority;
  const issuedAt = Date.parse(attestation.issued_at);
  const expiresAt = Date.parse(attestation.expires_at);
  const ids = attestation.challenges.map(
    (item) => `${item.platform}:${item.case}`,
  );
  const challengeNonces = attestation.challenges.map(
    (item) => item.challenge_nonce,
  );
  const expectedIds = [
    ...request.fixture.aggregate_template
      .platform_requirements.platforms,
  ]
    .sort()
    .flatMap((platform) =>
      PLATFORM_CASES.map((caseId) => `${platform}:${caseId}`));
  if (
    attestation.authority_id !== authority.authority_id ||
    attestation.authority_version !== authority.version ||
    attestation.controller_sha256 !== authority.controller_sha256 ||
    attestation.candidate_skill_fingerprint !==
      request.candidateSkillFingerprint ||
    attestation.evaluation_input_sha256 !==
      fingerprint(request.fixture) ||
    issuedAt < Date.parse(request.unblindedAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > PLATFORM_CHALLENGE_LIFETIME_MS ||
    attestation.challenges.some(
      (item) =>
        canonicalJson(Object.keys(item).sort()) !==
          canonicalJson([
            "case",
            "challenge_nonce",
            "environment_sha256",
            "executable_sha256",
            "execution_profile_sha256",
            "installation_relative_path",
            "platform",
            "platform_version",
            "prompt_template_sha256",
          ]) ||
        typeof item.platform_version !== "string" ||
        item.platform_version.length === 0 ||
        !SHA256_PATTERN.test(item.executable_sha256 ?? "") ||
        !SHA256_PATTERN.test(
          item.execution_profile_sha256 ?? "",
        ) ||
        !SHA256_PATTERN.test(item.environment_sha256 ?? "") ||
        !SHA256_PATTERN.test(
          item.prompt_template_sha256 ?? "",
        ) ||
        item.execution_profile_sha256 !==
          fingerprint(PLATFORM_EXECUTION_PROFILES[item.platform]) ||
        item.prompt_template_sha256 !==
          sha256Text(
            platformPromptTemplate(item.platform, item.case),
          ) ||
        item.installation_relative_path !==
          PLATFORM_INSTALL_PATHS[item.platform],
    ) ||
    new Set(ids).size !== ids.length ||
    new Set(challengeNonces).size !== challengeNonces.length ||
    canonicalJson([...ids].sort()) !==
      canonicalJson([...expectedIds].sort()) ||
    attestation.payload_sha256 !== fingerprint(payload) ||
    !verify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      createPublicKey(authority.public_key_pem),
      Buffer.from(attestation.signature_base64, "base64"),
    )
  ) {
    throw new Error("platform challenge attestation mismatch");
  }
  return new Map(
    attestation.challenges.map((item) => [
      `${item.platform}:${item.case}`,
      item,
    ]),
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

/** Independently classifies one locked read-only transcript command. */
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

/** Independently enforces the fixture transcript policy. */
function validateTranscriptPolicy(
  tools,
  toolProfile,
  allowedRoot,
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
    tools.length > policy.max_tool_calls
  ) {
    throw new Error("locked transcript tool profile mismatch");
  }
  const root = resolve(allowedRoot);
  const families = [];
  for (const tool of tools) {
    if (!TRANSCRIPT_TOOL_TYPES.includes(tool.type)) {
      throw new Error("transcript tool type is not allowed");
    }
    if (tool.type === "todo_list") {
      if (tool.command !== null) {
        throw new Error("todo_list cannot carry a command");
      }
      continue;
    }
    const family = classifyTranscriptCommand(tool.command);
    if (!policy.allowed_command_families.includes(family)) {
      throw new Error("transcript command is outside read-only policy");
    }
    if (
      FORBIDDEN_TRANSCRIPT_PATH_PARTS.some(
        (part) => tool.command.includes(part),
      )
    ) {
      throw new Error("transcript reads a forbidden path");
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
      absolutePaths.some((path) => {
        const normalized = resolve(path);
        return normalized !== root &&
          !normalized.startsWith(`${root}${sep}`);
      })
    ) {
      throw new Error("transcript reads outside its workspace");
    }
    families.push(family);
  }
  if (
    families.filter(
      (family) => family === "eval_bind_smoke",
    ).length !== 1 ||
    families.filter(
      (family) => family === "runtime_observation",
    ).length !== 1
  ) {
    throw new Error("transcript required command count mismatch");
  }
}

/** Parses one complete Codex transcript without candidate-library code. */
function inspectTranscript(
  transcript,
  expectedOutput,
  { toolProfile, allowedRoot } = {},
) {
  const events = transcript
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const first = events[0];
  if (
    first?.type !== "thread.started" ||
    typeof first.thread_id !== "string" ||
    events.at(-1)?.type !== "turn.completed" ||
    events.filter((event) => event?.type === "thread.started").length !== 1 ||
    events.filter((event) => event?.type === "turn.started").length !== 1 ||
    events.filter((event) => event?.type === "turn.completed").length !== 1 ||
    events.some((event) => event?.type === "error")
  ) {
    throw new Error("transcript session boundary is incomplete");
  }
  const started = new Map();
  const completed = new Set();
  const messages = [];
  for (const event of events) {
    const item = event?.item;
    if (
      event?.type === "item.completed" &&
      item?.type === "agent_message"
    ) {
      messages.push(item.text);
    } else if (
      event?.type === "item.started" &&
      !["agent_message", "reasoning"].includes(item?.type)
    ) {
      if (
        typeof item?.id !== "string" ||
        started.has(item.id)
      ) {
        throw new Error("transcript tool start is invalid");
      }
      started.set(item.id, {
        id: item.id,
        type: item.type,
        command:
          typeof item.command === "string" ? item.command : null,
      });
    } else if (
      event?.type === "item.completed" &&
      !["agent_message", "reasoning"].includes(item?.type)
    ) {
      if (
        !started.has(item?.id) ||
        completed.has(item.id)
      ) {
        throw new Error("transcript tool completion is invalid");
      }
      completed.add(item.id);
    }
  }
  if (
    started.size !== completed.size ||
    messages.length === 0 ||
    messages.at(-1) !== expectedOutput
  ) {
    throw new Error("transcript output or tool sequence mismatch");
  }
  const tools = [...started.values()];
  if (toolProfile !== undefined) {
    validateTranscriptPolicy(tools, toolProfile, allowedRoot);
  }
  return {
    session_nonce: first.thread_id,
    transcript_sha256: sha256Text(transcript),
    tool_calls: started.size,
    tool_sequence_sha256: fingerprint(tools),
  };
}

/** Rejects any platform Codex tool that is not a confined read command. */
function validatePlatformCodexTools(
  tools,
  { allowedRoot, caseId, platform },
) {
  const root = resolve(allowedRoot);
  const expectedPaths = requiredPlatformReadPaths(platform);
  if (
    (caseId === "positive" && tools.length !== expectedPaths.length) ||
    (caseId === "negative" && tools.length !== 0)
  ) {
    throw new Error("platform Codex tool count mismatches case");
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
      throw new Error("platform Codex tool policy mismatch");
    }
    const inputPath = words[2];
    const normalized = resolve(root, inputPath);
    if (
      !expectedPaths.includes(inputPath) ||
      (
        normalized !== root &&
        !normalized.startsWith(`${root}${sep}`)
      ) ||
      realpathSync(normalized) !== normalized ||
      tool.aggregated_output !== readFileSync(normalized, "utf8")
    ) {
      throw new Error(
        "platform Codex required read did not match installed content",
      );
    }
    observedPaths.push(inputPath);
  }
  if (
    caseId === "positive" &&
    canonicalJson([...observedPaths].sort(compareUtf8)) !==
      canonicalJson([...expectedPaths].sort(compareUtf8))
  ) {
    throw new Error("platform Codex required read set mismatch");
  }
}

/** Parses Claude stream-json and enforces paired, confined read tools. */
function inspectClaudePlatformTranscript(
  transcript,
  expectedOutput,
  { allowedRoot, caseId },
) {
  const events = transcript
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const expected = JSON.parse(expectedOutput);
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
    canonicalJson([...(init?.tools ?? [])].sort()) !==
      canonicalJson([...permittedTools].sort()) ||
    result?.subtype !== "success" ||
    result?.is_error !== false ||
    canonicalJson(result?.structured_output) !==
      canonicalJson(expected)
  ) {
    throw new Error("platform Claude runtime or output mismatch");
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
          throw new Error("platform Claude tool start mismatch");
        }
        const record = {
          id: item.id,
          name: item.name,
          input: item.input ?? {},
        };
        started.set(item.id, record);
        sequence.push(record);
      } else if (
        event.type === "user" &&
        item?.type === "tool_result"
      ) {
        if (
          !started.has(item?.tool_use_id) ||
          completed.has(item.tool_use_id)
        ) {
          throw new Error("platform Claude tool result mismatch");
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
    throw new Error("platform Claude tool sequence is incomplete");
  }
  const structured = sequence.filter(
    (tool) => tool.name === "StructuredOutput",
  );
  const reads = sequence.filter(
    (tool) => tool.name !== "StructuredOutput",
  );
  const expectedPaths = requiredPlatformReadPaths(
    "claude-code",
  );
  if (
    structured.length !== 1 ||
    canonicalJson(structured[0].input) !== canonicalJson(expected) ||
    (caseId === "positive" &&
      reads.length !== expectedPaths.length) ||
    (caseId === "negative" && reads.length !== 0)
  ) {
    throw new Error("platform Claude tools mismatch case");
  }
  const observedPaths = [];
  for (const tool of reads) {
    const inputPath = tool.input.file_path;
    const completion = completed.get(tool.id);
    const normalized = typeof inputPath === "string"
      ? resolve(root, inputPath)
      : "";
    const relativePath = typeof normalized === "string"
      ? relative(root, normalized).split(sep).join("/")
      : "";
    if (
      tool.name !== "Read" ||
      typeof inputPath !== "string" ||
      !expectedPaths.includes(relativePath) ||
      completion?.is_error === true
    ) {
      throw new Error("platform Claude tool path mismatch");
    }
    if (
      (
        normalized !== root &&
        !normalized.startsWith(`${root}${sep}`)
      ) ||
      realpathSync(normalized) !== normalized ||
      completion?.tool_use_result?.file?.filePath !== normalized ||
      completion?.tool_use_result?.file?.content !==
        readFileSync(normalized, "utf8")
    ) {
      throw new Error(
        "platform Claude required read did not match installed content",
      );
    }
    observedPaths.push(relativePath);
  }
  if (
    caseId === "positive" &&
    canonicalJson([...observedPaths].sort(compareUtf8)) !==
      canonicalJson([...expectedPaths].sort(compareUtf8))
  ) {
    throw new Error("platform Claude required read set mismatch");
  }
  const structuredCompletion = completed.get(structured[0].id);
  if (structuredCompletion?.is_error === true) {
    throw new Error("platform Claude structured output failed");
  }
  return {
    session_nonce: result.session_id,
    transcript_sha256: sha256Text(transcript),
    tool_calls: sequence.length,
    tool_sequence_sha256: fingerprint(sequence),
  };
}

/** Parses only the declared provider transcript format. */
function inspectPlatformTranscript(
  expectedPlatform,
  transcript,
  expectedOutput,
  { allowedRoot, caseId },
) {
  if (expectedPlatform === "codex") {
    const inspected = inspectTranscript(transcript, expectedOutput);
    const events = transcript
      .trimEnd()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
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
    });
    return inspected;
  }
  if (expectedPlatform === "claude-code") {
    return inspectClaudePlatformTranscript(
      transcript,
      expectedOutput,
      { allowedRoot, caseId },
    );
  }
  throw new Error("unsupported platform transcript");
}

/** Returns the signed payload for post-execution platform completions. */
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
    sessions: attestation.sessions,
  };
}

/** Observes the exact provider binary, version, and controller-owned profile. */
function observePlatformRuntime(platform) {
  const executable = platform === "codex"
    ? "codex"
    : platform === "claude-code"
      ? "claude"
      : null;
  if (executable === null) {
    throw new Error("unsupported platform executable");
  }
  const executablePath = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => resolve(directory, executable))
    .find((path) => {
      try {
        return lstatSync(realpathSync(path)).isFile();
      } catch {
        return false;
      }
    });
  if (executablePath === undefined) {
    throw new Error(`cannot resolve ${platform} executable`);
  }
  const realExecutablePath = realpathSync(executablePath);
  const providerEnvironment =
    buildProviderEnvironment(realExecutablePath, platform);
  const result = spawnSync(realExecutablePath, ["--version"], {
    encoding: "utf8",
    env: providerEnvironment,
    shell: false,
    windowsHide: true,
  });
  const version = result.stdout.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(`cannot observe ${platform} version`);
  }
  const profile = PLATFORM_EXECUTION_PROFILES[platform];
  return {
    executable_path: realExecutablePath,
    executable_sha256: createHash("sha256")
      .update(readFileSync(realExecutablePath))
      .digest("hex"),
    version,
    execution_profile: profile,
    execution_profile_sha256: fingerprint(profile),
    provider_environment: providerEnvironment,
  };
}

/** Returns one fixed structured-output schema for a platform case. */
function platformOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
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
    ],
    properties: {
      schema_version: { type: "integer", const: 1 },
      case: { type: "string", enum: PLATFORM_CASES },
      evaluation_input_sha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      candidate_skill_fingerprint: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      platform: {
        type: "string",
        enum: ["codex", "claude-code"],
      },
      platform_version: { type: "string", minLength: 1 },
      challenge_nonce: { type: "string", minLength: 16 },
      started_at: { type: "string", format: "date-time" },
      installed_copy: {
        type: "object",
        additionalProperties: false,
        required: ["tree_fingerprint", "file_count"],
        properties: {
          tree_fingerprint: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          file_count: { type: "integer", minimum: 1 },
        },
      },
      result: {
        type: "object",
        additionalProperties: false,
        required: [
          "triggered_skill",
          "target_and_reference_read",
          "analysis_correct",
          "stable_ids",
          "decision_boundary",
          "files_modified",
          "evidence",
        ],
        properties: {
          triggered_skill: { type: "boolean" },
          target_and_reference_read: { type: "boolean" },
          analysis_correct: { type: "boolean" },
          stable_ids: { type: "boolean" },
          decision_boundary: { type: "boolean" },
          files_modified: { type: "boolean" },
          evidence: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

/** Extracts the final Codex agent message from one complete JSONL run. */
function codexFinalOutput(transcript) {
  const messages = transcript
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event?.type === "item.completed" &&
        event?.item?.type === "agent_message",
    )
    .map((event) => event.item.text);
  if (messages.length === 0) {
    throw new Error("controller-managed Codex output is missing");
  }
  return messages.at(-1);
}

/** Extracts the final Claude structured output from stream-json. */
function claudeFinalOutput(transcript) {
  const results = transcript
    .trimEnd()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .filter((event) => event?.type === "result");
  if (results.length !== 1) {
    throw new Error("controller-managed Claude output is missing");
  }
  return JSON.stringify(results[0].structured_output);
}

/** Returns the signed portion of one controller-managed platform session. */
function platformSessionPayload(receipt) {
  return {
    schema_version: receipt.schema_version,
    authority_id: receipt.authority_id,
    authority_version: receipt.authority_version,
    controller_sha256: receipt.controller_sha256,
    candidate_skill_fingerprint:
      receipt.candidate_skill_fingerprint,
    evaluation_input_sha256:
      receipt.evaluation_input_sha256,
    challenge_payload_sha256:
      receipt.challenge_payload_sha256,
    platform: receipt.platform,
    case: receipt.case,
    platform_version: receipt.platform_version,
    executable_sha256: receipt.executable_sha256,
    execution_profile_sha256:
      receipt.execution_profile_sha256,
    environment_sha256: receipt.environment_sha256,
    prompt_template_sha256:
      receipt.prompt_template_sha256,
    prompt_sha256: receipt.prompt_sha256,
    workspace_root: receipt.workspace_root,
    source_skill_root: receipt.source_skill_root,
    installed_skill_root: receipt.installed_skill_root,
    installation_relative_path:
      receipt.installation_relative_path,
    source_copy_before: receipt.source_copy_before,
    source_copy_after: receipt.source_copy_after,
    installed_copy_before: receipt.installed_copy_before,
    installed_copy_after: receipt.installed_copy_after,
    required_reads: receipt.required_reads,
    challenge_nonce: receipt.challenge_nonce,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    exit_status: receipt.exit_status,
    output_sha256: receipt.output_sha256,
    transcript_sha256: receipt.transcript_sha256,
    provider_session_nonce:
      receipt.provider_session_nonce,
    tool_calls: receipt.tool_calls,
    tool_sequence_sha256:
      receipt.tool_sequence_sha256,
  };
}

/** Runs one provider with fixed argv and signs the resulting transcript. */
function runPlatformSession(request, privateKeyPath) {
  verifyControllerRequest(request);
  const challenges = verifyPlatformChallenge(request);
  const id = `${request.platform}:${request.case}`;
  const challenge = challenges.get(id);
  const runtime = observePlatformRuntime(request.platform);
  const expectedIdentity = {
    tree_fingerprint:
      request.fixture.runtime_bundle.candidate_tree_fingerprint,
    file_count:
      request.fixture.runtime_bundle.candidate_file_count,
  };
  if (
    challenge === undefined ||
    !PLATFORM_CASES.includes(request.case) ||
    Object.hasOwn(request, "prompt") ||
    typeof request.installedCopyPath !== "string" ||
    request.installedCopyPath.trim().length === 0 ||
    challenge.platform_version !== runtime.version ||
    challenge.executable_sha256 !== runtime.executable_sha256 ||
    challenge.execution_profile_sha256 !==
      runtime.execution_profile_sha256 ||
    challenge.environment_sha256 !==
      providerEnvironmentFingerprint(
        runtime.provider_environment,
        challenge.challenge_nonce,
        request.platform,
      ) ||
    challenge.prompt_template_sha256 !==
      sha256Text(
        platformPromptTemplate(request.platform, request.case),
      ) ||
    challenge.installation_relative_path !==
      PLATFORM_INSTALL_PATHS[request.platform]
  ) {
    throw new Error("controller-managed platform request mismatch");
  }
  const now = Date.now();
  if (
    now < Date.parse(request.unblindedAt) ||
    now < Date.parse(
      request.platformValidationEvidence
        .challenge_attestation.issued_at,
    ) ||
    now >
      Date.parse(
        request.platformValidationEvidence
          .challenge_attestation.expires_at,
      )
  ) {
    throw new Error("controller-managed platform challenge expired");
  }
  const sessionProject = createSessionProject(
    request.installedCopyPath,
    request.platform,
    expectedIdentity,
  );
  let outputSchemaRoot = null;
  try {
    const startedAt = new Date().toISOString();
    const identity = {
      case: request.case,
      platform: request.platform,
      platform_version: runtime.version,
      challenge_nonce: challenge.challenge_nonce,
      started_at: startedAt,
      candidate_skill_fingerprint:
        request.candidateSkillFingerprint,
      evaluation_input_sha256: fingerprint(request.fixture),
      installed_copy: sessionProject.installedBefore,
    };
    const promptTemplate = platformPromptTemplate(
      request.platform,
      request.case,
    );
    const requiredReads = platformRequiredReads(
      sessionProject.projectRoot,
      request.platform,
    );
    const prompt = [
      promptTemplate,
      "",
      "The neutral controller fixed these identity fields:",
      JSON.stringify(identity),
      "Return exactly one JSON object matching the supplied schema.",
      "Copy every identity key and value directly to the top level without nesting, renaming, or changing it.",
    ].join("\n");
    outputSchemaRoot = request.platform === "codex"
      ? mkdtempSync(
          join(tmpdir(), "agent-skill-maintainer-platform-schema-"),
        )
      : null;
    const outputSchemaPath = outputSchemaRoot === null
      ? null
      : join(outputSchemaRoot, "platform-output.schema.json");
    if (outputSchemaPath !== null) {
      writeFileSync(
        outputSchemaPath,
        `${JSON.stringify(platformOutputSchema())}\n`,
        { mode: 0o400 },
      );
      chmodSync(outputSchemaRoot, 0o500);
    }
    const args = request.platform === "codex"
      ? [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--config",
          "approval_policy=\"never\"",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--model",
          PLATFORM_EXECUTION_PROFILES.codex.model,
          "--cd",
          sessionProject.projectRoot,
          "--output-schema",
          outputSchemaPath,
          "--json",
          prompt,
        ]
      : [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--model",
          PLATFORM_EXECUTION_PROFILES["claude-code"].model,
          "--effort",
          PLATFORM_EXECUTION_PROFILES["claude-code"].effort,
          "--permission-mode",
          "dontAsk",
          "--setting-sources",
          "project,local",
          "--strict-mcp-config",
          "--mcp-config",
          "{\"mcpServers\":{}}",
          "--tools",
          "Read,Grep,Glob",
          "--allowedTools",
          "Read,Grep,Glob",
          "--no-chrome",
          "--json-schema",
          JSON.stringify(platformOutputSchema()),
          prompt,
        ];
    const provider = spawnSync(runtime.executable_path, args, {
      cwd: sessionProject.projectRoot,
      encoding: "utf8",
      env: runtime.provider_environment,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    const completedAt = new Date().toISOString();
    const sourceAfter = inspectRegularTree(
      sessionProject.sourceRoot,
    );
    const installedAfter = inspectRegularTree(
      sessionProject.installedSkillRoot,
    );
    if (
      provider.status !== 0 ||
      Date.parse(completedAt) >
        Date.parse(
          request.platformValidationEvidence
            .challenge_attestation.expires_at,
        ) ||
      canonicalJson(sourceAfter) !==
        canonicalJson(sessionProject.sourceBefore) ||
      canonicalJson(installedAfter) !==
        canonicalJson(sessionProject.installedBefore)
    ) {
      throw new Error(
        `controller-managed ${id} failed or drifted: ${provider.stderr}`,
      );
    }
    const transcript = provider.stdout;
    const output = request.platform === "codex"
      ? codexFinalOutput(transcript)
      : claudeFinalOutput(transcript);
    const document = JSON.parse(output);
    const expected = request.case === "positive";
    const providerSession = inspectPlatformTranscript(
      request.platform,
      transcript,
      output,
      {
        allowedRoot: sessionProject.projectRoot,
        caseId: request.case,
      },
    );
    const mismatches = [
      ["schema_version", document?.schema_version === 1],
      ["case", document?.case === request.case],
      ["platform", document?.platform === request.platform],
      ["platform_version", document?.platform_version === runtime.version],
      ["challenge_nonce", document?.challenge_nonce === challenge.challenge_nonce],
      ["started_at", document?.started_at === startedAt],
      [
        "candidate_skill_fingerprint",
        document?.candidate_skill_fingerprint ===
          request.candidateSkillFingerprint,
      ],
      [
        "evaluation_input_sha256",
        document?.evaluation_input_sha256 === fingerprint(request.fixture),
      ],
      [
        "installed_copy",
        canonicalJson(document?.installed_copy) ===
          canonicalJson(sessionProject.installedBefore),
      ],
      ["triggered_skill", document?.result?.triggered_skill === expected],
      [
        "target_and_reference_read",
        document?.result?.target_and_reference_read === expected,
      ],
      ["analysis_correct", document?.result?.analysis_correct === true],
      ["stable_ids", document?.result?.stable_ids === expected],
      ["decision_boundary", document?.result?.decision_boundary === expected],
      ["files_modified", document?.result?.files_modified === false],
      [
        "evidence",
        Array.isArray(document?.result?.evidence) &&
          document.result.evidence.length > 0,
      ],
    ].filter(([, matches]) => !matches).map(([field]) => field);
    if (mismatches.length > 0) {
      throw new Error(
        `controller-managed ${id} output mismatch: ${mismatches.join(", ")}`,
      );
    }
    const authority = request.fixture.evaluator_authority;
    const payload = {
      schema_version: 1,
      authority_id: authority.authority_id,
      authority_version: authority.version,
      controller_sha256: authority.controller_sha256,
      candidate_skill_fingerprint:
        request.candidateSkillFingerprint,
      evaluation_input_sha256: fingerprint(request.fixture),
      challenge_payload_sha256:
        request.platformValidationEvidence
          .challenge_attestation.payload_sha256,
      platform: request.platform,
      case: request.case,
      platform_version: runtime.version,
      executable_sha256: runtime.executable_sha256,
      execution_profile_sha256:
        runtime.execution_profile_sha256,
      environment_sha256: challenge.environment_sha256,
      prompt_template_sha256:
        challenge.prompt_template_sha256,
      prompt_sha256: sha256Text(prompt),
      workspace_root: sessionProject.projectRoot,
      source_skill_root: sessionProject.sourceRoot,
      installed_skill_root:
        sessionProject.installedSkillRoot,
      installation_relative_path:
        sessionProject.installationRelativePath,
      source_copy_before: sessionProject.sourceBefore,
      source_copy_after: sourceAfter,
      installed_copy_before: sessionProject.installedBefore,
      installed_copy_after: installedAfter,
      required_reads: requiredReads,
      challenge_nonce: challenge.challenge_nonce,
      started_at: startedAt,
      completed_at: completedAt,
      exit_status: 0,
      output_sha256: sha256Text(output),
      transcript_sha256: sha256Text(transcript),
      provider_session_nonce: providerSession.session_nonce,
      tool_calls: providerSession.tool_calls,
      tool_sequence_sha256:
        providerSession.tool_sequence_sha256,
    };
    const receipt = {
      ...payload,
      output,
      transcript,
      payload_sha256: fingerprint(payload),
      signature_base64: signPayload(payload, privateKeyPath),
    };
    if (outputSchemaRoot !== null) {
      chmodSync(outputSchemaRoot, 0o700);
      rmSync(outputSchemaRoot, { recursive: true, force: true });
    }
    return receipt;
  } catch (error) {
    if (outputSchemaRoot !== null) {
      chmodSync(outputSchemaRoot, 0o700);
      rmSync(outputSchemaRoot, { recursive: true, force: true });
    }
    removeSessionProject(sessionProject.projectRoot);
    throw error;
  }
}

/** Signs completion only from four controller-signed session receipts. */
function attestPlatformCompletion(request, privateKeyPath) {
  verifyControllerRequest(request);
  const challenges = verifyPlatformChallenge(request);
  const requiredIds = [
    ...request.fixture.aggregate_template
      .platform_requirements.platforms,
  ]
    .flatMap((platform) =>
      PLATFORM_CASES.map((caseId) => `${platform}:${caseId}`))
    .sort();
  if (
    !Array.isArray(request.platformSessionReceipts) ||
    request.platformSessionReceipts.length !== requiredIds.length
  ) {
    throw new Error("platform session receipts are incomplete");
  }
  const authority = request.fixture.evaluator_authority;
  const sessions = request.platformSessionReceipts.map((receipt) => {
    const payload = platformSessionPayload(receipt);
    const id = `${receipt.platform}:${receipt.case}`;
    const challenge = challenges.get(id);
    if (
      !requiredIds.includes(id) ||
      receipt.payload_sha256 !== fingerprint(payload) ||
      !verify(
        null,
        Buffer.from(canonicalJson(payload), "utf8"),
        createPublicKey(authority.public_key_pem),
        Buffer.from(receipt.signature_base64 ?? "", "base64"),
      ) ||
      sha256Text(receipt.output ?? "") !== receipt.output_sha256 ||
      sha256Text(receipt.transcript ?? "") !==
        receipt.transcript_sha256 ||
      receipt.authority_id !== authority.authority_id ||
      receipt.controller_sha256 !== authority.controller_sha256 ||
      receipt.candidate_skill_fingerprint !==
        request.candidateSkillFingerprint ||
      receipt.evaluation_input_sha256 !==
        fingerprint(request.fixture) ||
      receipt.challenge_payload_sha256 !==
        request.platformValidationEvidence
          .challenge_attestation.payload_sha256 ||
      receipt.challenge_nonce !== challenge?.challenge_nonce ||
      receipt.platform_version !== challenge?.platform_version ||
      receipt.executable_sha256 !==
        challenge?.executable_sha256 ||
      receipt.execution_profile_sha256 !==
        challenge?.execution_profile_sha256 ||
      receipt.environment_sha256 !==
        challenge?.environment_sha256 ||
      receipt.prompt_template_sha256 !==
        challenge?.prompt_template_sha256 ||
      !SHA256_PATTERN.test(receipt.prompt_sha256 ?? "") ||
      receipt.installation_relative_path !==
        challenge?.installation_relative_path ||
      resolve(
        receipt.workspace_root,
        receipt.installation_relative_path,
      ) !== receipt.installed_skill_root ||
      realpathSync(receipt.workspace_root) !==
        receipt.workspace_root ||
      realpathSync(receipt.source_skill_root) !==
        receipt.source_skill_root ||
      realpathSync(receipt.installed_skill_root) !==
        receipt.installed_skill_root ||
      canonicalJson(receipt.source_copy_before) !==
        canonicalJson(receipt.source_copy_after) ||
      canonicalJson(receipt.installed_copy_before) !==
        canonicalJson(receipt.installed_copy_after) ||
      canonicalJson(receipt.source_copy_before) !==
        canonicalJson(receipt.installed_copy_before) ||
      canonicalJson(
        inspectRegularTree(receipt.source_skill_root),
      ) !== canonicalJson(receipt.source_copy_after) ||
      canonicalJson(
        inspectRegularTree(receipt.installed_skill_root),
      ) !== canonicalJson(receipt.installed_copy_after) ||
      canonicalJson(
        platformRequiredReads(
          receipt.workspace_root,
          receipt.platform,
        ),
      ) !== canonicalJson(receipt.required_reads) ||
      receipt.source_copy_before.tree_fingerprint !==
        request.candidateSkillFingerprint ||
      receipt.source_copy_before.file_count !==
        request.fixture.runtime_bundle.candidate_file_count ||
      receipt.exit_status !== 0 ||
      !Number.isFinite(Date.parse(receipt.started_at)) ||
      !Number.isFinite(Date.parse(receipt.completed_at)) ||
      Date.parse(receipt.started_at) <
        Date.parse(
          request.platformValidationEvidence
            .challenge_attestation.issued_at,
        ) ||
      Date.parse(receipt.started_at) <
        Date.parse(request.unblindedAt) ||
      Date.parse(receipt.completed_at) <
        Date.parse(receipt.started_at) ||
      Date.parse(receipt.completed_at) >
        Date.parse(
          request.platformValidationEvidence
            .challenge_attestation.expires_at,
        ) ||
      !Number.isInteger(receipt.tool_calls) ||
      receipt.tool_calls < 0 ||
      !SHA256_PATTERN.test(
        receipt.tool_sequence_sha256 ?? "",
      )
    ) {
      throw new Error(`${id} controller receipt mismatch`);
    }
    const inspected = inspectPlatformTranscript(
      receipt.platform,
      receipt.transcript,
      receipt.output,
      {
        allowedRoot: receipt.workspace_root,
        caseId: receipt.case,
      },
    );
    if (
      inspected.session_nonce !== receipt.provider_session_nonce ||
      inspected.tool_calls !== receipt.tool_calls ||
      inspected.tool_sequence_sha256 !==
        receipt.tool_sequence_sha256
    ) {
      throw new Error(`${id} controller receipt transcript mismatch`);
    }
    return {
      platform: receipt.platform,
      case: receipt.case,
      platform_version: receipt.platform_version,
      executable_sha256: receipt.executable_sha256,
      execution_profile_sha256:
        receipt.execution_profile_sha256,
      environment_sha256: receipt.environment_sha256,
      prompt_template_sha256:
        receipt.prompt_template_sha256,
      prompt_sha256: receipt.prompt_sha256,
      workspace_root: receipt.workspace_root,
      installation_relative_path:
        receipt.installation_relative_path,
      source_copy_before: receipt.source_copy_before,
      source_copy_after: receipt.source_copy_after,
      installed_copy_before: receipt.installed_copy_before,
      installed_copy_after: receipt.installed_copy_after,
      required_reads: receipt.required_reads,
      challenge_nonce: receipt.challenge_nonce,
      started_at: receipt.started_at,
      completed_at: receipt.completed_at,
      exit_status: receipt.exit_status,
      output_sha256: receipt.output_sha256,
      transcript_sha256: receipt.transcript_sha256,
      provider_session_nonce:
        receipt.provider_session_nonce,
      tool_calls: receipt.tool_calls,
      tool_sequence_sha256:
        receipt.tool_sequence_sha256,
    };
  }).sort(
    (first, second) =>
      `${first.platform}:${first.case}`.localeCompare(
        `${second.platform}:${second.case}`,
      ),
  );
  const ids = sessions.map(
    (session) => `${session.platform}:${session.case}`,
  );
  const attestedAt = new Date().toISOString();
  const challengeExpiresAt = Date.parse(
    request.platformValidationEvidence
      .challenge_attestation.expires_at,
  );
  const challengeNonces = request.platformValidationEvidence
    .challenge_attestation.challenges
    .map((challenge) => challenge.challenge_nonce);
  if (
    canonicalJson(ids) !== canonicalJson(requiredIds) ||
    Date.parse(attestedAt) > challengeExpiresAt ||
    sessions.some(
      (session) =>
        Date.parse(session.completed_at) > Date.parse(attestedAt),
    ) ||
    new Set(
      sessions.map((session) => session.provider_session_nonce),
    ).size !== sessions.length ||
    sessions.some(
      (session) =>
        challengeNonces.includes(session.provider_session_nonce),
    )
  ) {
    throw new Error("platform completion identities are not unique");
  }
  const completionPayload = {
    schema_version: 1,
    authority_id: authority.authority_id,
    authority_version: authority.version,
    controller_sha256: authority.controller_sha256,
    candidate_skill_fingerprint:
      request.candidateSkillFingerprint,
    evaluation_input_sha256: fingerprint(request.fixture),
    challenge_payload_sha256:
      request.platformValidationEvidence
        .challenge_attestation.payload_sha256,
    attested_at: attestedAt,
    sessions,
  };
  return {
    ...completionPayload,
    payload_sha256: fingerprint(completionPayload),
    signature_base64: signPayload(
      completionPayload,
      privateKeyPath,
    ),
  };
}

/** Verifies the signed completion attestation before headline derivation. */
function verifyPlatformCompletion(request, challenges) {
  const attestation =
    request.platformValidationEvidence.completion_attestation;
  const payload = platformCompletionPayload(attestation);
  const authority = request.fixture.evaluator_authority;
  const requiredIds = [
    ...request.fixture.aggregate_template
      .platform_requirements.platforms,
  ]
    .flatMap((platform) =>
      PLATFORM_CASES.map((caseId) => `${platform}:${caseId}`))
    .sort();
  const ids = attestation?.sessions?.map(
    (session) => `${session.platform}:${session.case}`,
  ) ?? [];
  const providerNonces = attestation?.sessions?.map(
    (session) => session.provider_session_nonce,
  ) ?? [];
  const challengeNonces = [
    ...request.platformValidationEvidence
      .challenge_attestation.challenges,
  ].map((challenge) => challenge.challenge_nonce);
  const attestedAt = Date.parse(attestation?.attested_at);
  if (
    attestation?.authority_id !== authority.authority_id ||
    attestation?.authority_version !== authority.version ||
    attestation?.controller_sha256 !== authority.controller_sha256 ||
    attestation?.candidate_skill_fingerprint !==
      request.candidateSkillFingerprint ||
    attestation?.evaluation_input_sha256 !==
      fingerprint(request.fixture) ||
    attestation?.challenge_payload_sha256 !==
      request.platformValidationEvidence
        .challenge_attestation.payload_sha256 ||
    canonicalJson([...ids].sort()) !== canonicalJson(requiredIds) ||
    new Set(ids).size !== ids.length ||
    new Set(providerNonces).size !== providerNonces.length ||
    providerNonces.some((nonce) => challengeNonces.includes(nonce)) ||
    !Number.isFinite(attestedAt) ||
    attestedAt >
      Date.parse(
        request.platformValidationEvidence
          .challenge_attestation.expires_at,
      ) ||
    attestation?.payload_sha256 !== fingerprint(payload) ||
    !verify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      createPublicKey(authority.public_key_pem),
      Buffer.from(attestation?.signature_base64 ?? "", "base64"),
    )
  ) {
    throw new Error("platform completion attestation mismatch");
  }
  const completions = new Map();
  for (const session of attestation.sessions) {
    const challenge = challenges.get(
      `${session.platform}:${session.case}`,
    );
    const startedAt = Date.parse(session.started_at);
    const completedAt = Date.parse(session.completed_at);
    if (
      session.challenge_nonce !== challenge?.challenge_nonce ||
      session.platform_version !== challenge?.platform_version ||
      session.executable_sha256 !==
        challenge?.executable_sha256 ||
      session.execution_profile_sha256 !==
        challenge?.execution_profile_sha256 ||
      session.environment_sha256 !==
        challenge?.environment_sha256 ||
      session.prompt_template_sha256 !==
        challenge?.prompt_template_sha256 ||
      !SHA256_PATTERN.test(session.prompt_sha256 ?? "") ||
      session.installation_relative_path !==
        challenge?.installation_relative_path ||
      resolve(
        session.workspace_root,
        session.installation_relative_path,
      ) !==
        resolve(
          session.workspace_root,
          PLATFORM_INSTALL_PATHS[session.platform],
        ) ||
      canonicalJson(session.source_copy_before) !==
        canonicalJson(session.source_copy_after) ||
      canonicalJson(session.installed_copy_before) !==
        canonicalJson(session.installed_copy_after) ||
      canonicalJson(session.source_copy_before) !==
        canonicalJson(session.installed_copy_before) ||
      session.source_copy_before?.tree_fingerprint !==
        request.candidateSkillFingerprint ||
      session.source_copy_before?.file_count !==
        request.fixture.runtime_bundle.candidate_file_count ||
      typeof session.workspace_root !== "string" ||
      session.workspace_root.length === 0 ||
      session.exit_status !== 0 ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      startedAt <
        Date.parse(
          request.platformValidationEvidence
            .challenge_attestation.issued_at,
        ) ||
      completedAt < startedAt ||
      completedAt >
        Date.parse(
          request.platformValidationEvidence
            .challenge_attestation.expires_at,
        ) ||
      completedAt > attestedAt ||
      !SHA256_PATTERN.test(session.output_sha256 ?? "") ||
      !SHA256_PATTERN.test(session.transcript_sha256 ?? "") ||
      !Number.isInteger(session.tool_calls) ||
      session.tool_calls < 0 ||
      !SHA256_PATTERN.test(
        session.tool_sequence_sha256 ?? "",
      )
    ) {
      throw new Error("platform completion session mismatch");
    }
    completions.set(
      `${session.platform}:${session.case}`,
      session,
    );
  }
  return completions;
}

/** Validates one intrinsic platform response against its transcript. */
function validatePlatformSession(
  platform,
  caseId,
  output,
  transcript,
  request,
  challenges,
  completions,
  nonces,
) {
  const document = JSON.parse(output);
  const positive = caseId === "positive";
  const copy = request.platformValidationEvidence.installed_copies
    .find((item) => item.platform === platform.id);
  const expected = {
    triggered_skill: positive,
    target_and_reference_read: positive,
    analysis_correct: true,
    stable_ids: positive,
    decision_boundary: positive,
    files_modified: false,
  };
  const challenge = challenges.get(`${platform.id}:${caseId}`);
  const completion = completions.get(`${platform.id}:${caseId}`);
  const session = inspectPlatformTranscript(
    platform.id,
    transcript,
    output,
    {
      allowedRoot: completion?.workspace_root,
      caseId,
    },
  );
  const startedAt = Date.parse(document?.started_at);
  const issuedAt = Date.parse(
    request.platformValidationEvidence
      .challenge_attestation.issued_at,
  );
  const providerNonceKey = caseId === "positive"
    ? "positive_provider_session_nonce"
    : "negative_provider_session_nonce";
  if (
    document?.case !== caseId ||
    document?.evaluation_input_sha256 !==
      fingerprint(request.fixture) ||
    document?.candidate_skill_fingerprint !==
      request.candidateSkillFingerprint ||
    document?.platform !== platform.id ||
    document?.platform_version !== platform.version ||
    document?.challenge_nonce !== challenge?.challenge_nonce ||
    startedAt < issuedAt ||
    startedAt < Date.parse(request.unblindedAt) ||
    document?.started_at !== completion?.started_at ||
    document?.platform_version !== completion?.platform_version ||
    sha256Text(output) !== completion?.output_sha256 ||
    sha256Text(transcript) !== completion?.transcript_sha256 ||
    session.session_nonce !== completion?.provider_session_nonce ||
    session.tool_calls !== completion?.tool_calls ||
    session.tool_sequence_sha256 !==
      completion?.tool_sequence_sha256 ||
    platform[providerNonceKey] !== session.session_nonce ||
    document?.installed_copy?.tree_fingerprint !==
      copy?.tree_fingerprint ||
    document?.installed_copy?.file_count !== copy?.file_count ||
    Object.entries(expected).some(
      ([key, value]) => document?.result?.[key] !== value,
    ) ||
    !Array.isArray(document?.result?.evidence) ||
    document.result.evidence.length === 0
  ) {
    throw new Error(`${platform.id} ${caseId} session mismatch`);
  }
  nonces.push(session.session_nonce);
}

/** Independently derives the public headline result from raw evidence. */
function deriveExpectedResult(request) {
  const labelA = inspectTranscript(
    request.labelA.events,
    request.labelA.output,
    {
      toolProfile: request.fixture.tool_profile,
      allowedRoot: dirname(dirname(
        request.sessions.label_a.runtime_path,
      )),
    },
  );
  const labelB = inspectTranscript(
    request.labelB.events,
    request.labelB.output,
    {
      toolProfile: request.fixture.tool_profile,
      allowedRoot: dirname(dirname(
        request.sessions.label_b.runtime_path,
      )),
    },
  );
  const judgeRaw = request.sessions.judge.raw_output;
  const judgeSession = inspectTranscript(
    request.sessions.judge.transcript,
    judgeRaw,
  );
  if (
    judgeSession.tool_calls !== 0 ||
    canonicalJson(JSON.parse(judgeRaw)) !==
      canonicalJson(request.judgeOutput) ||
    request.sessions.label_a.session_nonce !==
      labelA.session_nonce ||
    request.sessions.label_a.transcript_sha256 !==
      labelA.transcript_sha256 ||
    request.sessions.label_a.tool_calls !== labelA.tool_calls ||
    request.sessions.label_a.tool_sequence_sha256 !==
      labelA.tool_sequence_sha256 ||
    request.sessions.label_b.session_nonce !==
      labelB.session_nonce ||
    request.sessions.label_b.transcript_sha256 !==
      labelB.transcript_sha256 ||
    request.sessions.label_b.tool_calls !== labelB.tool_calls ||
    request.sessions.label_b.tool_sequence_sha256 !==
      labelB.tool_sequence_sha256 ||
    request.sessions.judge.session_nonce !==
      judgeSession.session_nonce ||
    request.sessions.judge.transcript_sha256 !==
      judgeSession.transcript_sha256 ||
    request.sessions.judge.tool_calls !== 0 ||
    request.sessions.judge.tool_sequence_sha256 !==
      judgeSession.tool_sequence_sha256 ||
    request.sessions.judge.input_bundle_sha256 !==
      fingerprint(request.sessions.judge.input_bundle)
  ) {
    throw new Error("generator or Judge transcript binding mismatch");
  }
  const judgeBundle = canonicalJson(
    request.sessions.judge.input_bundle,
  );
  for (const label of [request.labelA, request.labelB]) {
    const runtime = JSON.parse(label.output).runtime_bundle;
    if (
      judgeBundle.includes(runtime.tree_fingerprint) ||
      judgeBundle.includes(runtime.cli_smoke_sha256)
    ) {
      throw new Error("Judge input bundle leaks runtime identity");
    }
  }
  const seed = Buffer.from(
    request.assignment.seed_base64 ?? "",
    "base64",
  );
  const baselineLabel = seed[0] % 2 === 0 ? "a" : "b";
  const candidateLabel = baselineLabel === "a" ? "b" : "a";
  if (
    request.assignment.baseline_label !== baselineLabel ||
    request.assignment.candidate_label !== candidateLabel
  ) {
    throw new Error("assignment mismatch");
  }
  const verdicts = request.judgeOutput.behaviors.map((behavior) => ({
    baseline: behavior[`label_${baselineLabel}`].verdict,
    candidate: behavior[`label_${candidateLabel}`].verdict,
  }));
  const baselinePassed = verdicts.filter(
    (item) => item.baseline === "pass",
  ).length;
  const candidatePassed = verdicts.filter(
    (item) => item.candidate === "pass",
  ).length;
  const candidateRegressions = verdicts.filter(
    (item) =>
      item.baseline === "pass" && item.candidate !== "pass",
  ).length;
  const measured = {
    a: {
      artifact_bytes: Buffer.byteLength(
        request.labelA.output,
        "utf8",
      ),
      tool_calls: labelA.tool_calls,
      heading_count: [
        ...request.labelA.output.matchAll(/^#{1,6}\s+\S/gmu),
      ].length,
    },
    b: {
      artifact_bytes: Buffer.byteLength(
        request.labelB.output,
        "utf8",
      ),
      tool_calls: labelB.tool_calls,
      heading_count: [
        ...request.labelB.output.matchAll(/^#{1,6}\s+\S/gmu),
      ].length,
    },
  };
  const baselineCost = measured[baselineLabel];
  const candidateCost = measured[candidateLabel];
  const thresholds = request.fixture;
  const costPassed =
    candidateCost.artifact_bytes / baselineCost.artifact_bytes <=
      thresholds.cost_thresholds
        .candidate_artifact_bytes_max_ratio_to_baseline &&
    candidateCost.tool_calls <=
      thresholds.cost_thresholds.candidate_tool_calls_max &&
    candidateCost.heading_count <=
      thresholds.quality_thresholds.max_candidate_heading_count;
  const forwardPassed =
    verdicts.every((item) => item.candidate === "pass") &&
    candidateRegressions ===
      thresholds.quality_thresholds.candidate_regressions &&
    candidatePassed - baselinePassed >=
      thresholds.quality_thresholds
        .candidate_minimum_gain_over_baseline &&
    request.judgeOutput.quality.false_positive_optimizations ===
      thresholds.quality_thresholds.false_positive_optimizations;
  const challenges = verifyPlatformChallenge(request);
  const completions = verifyPlatformCompletion(
    request,
    challenges,
  );
  const nonces = [];
  for (const platform of request.platformValidationEvidence.platforms) {
    validatePlatformSession(
      platform,
      "positive",
      platform.positive_output,
      platform.positive_transcript,
      request,
      challenges,
      completions,
      nonces,
    );
    validatePlatformSession(
      platform,
      "negative",
      platform.negative_output,
      platform.negative_transcript,
      request,
      challenges,
      completions,
      nonces,
    );
  }
  const requiredPlatforms = [
    ...request.fixture.aggregate_template
      .platform_requirements.platforms,
  ].sort();
  const actualPlatforms = request.platformValidationEvidence.platforms
    .map((item) => item.id)
    .sort();
  const platformPassed =
    canonicalJson(requiredPlatforms) ===
      canonicalJson(actualPlatforms) &&
    new Set(nonces).size === nonces.length &&
    request.platformValidationEvidence.passed === true &&
    request.platformValidationEvidence
      .candidate_skill_fingerprint ===
        request.candidateSkillFingerprint &&
    request.platformValidationEvidence.validated_at ===
      request.platformValidationEvidence
        .completion_attestation.attested_at &&
    [...completions.values()].every(
      (session) =>
        Date.parse(session.completed_at) <=
          Date.parse(
            request.platformValidationEvidence
              .completion_attestation.attested_at,
          ),
    );
  return {
    baseline_passed_behaviors: baselinePassed,
    candidate_passed_behaviors: candidatePassed,
    candidate_regressions: candidateRegressions,
    false_positive_optimizations:
      request.judgeOutput.quality.false_positive_optimizations,
    baseline_tool_calls: baselineCost.tool_calls,
    candidate_tool_calls: candidateCost.tool_calls,
    forward_passed: forwardPassed,
    cost_passed: costPassed,
    platform_passed: platformPassed,
  };
}

/** Builds the exact authority payload used by the candidate verifier. */
function buildPayload(request, expectedResult) {
  const authority = request.fixture.evaluator_authority;
  return {
    schema_version: 1,
    authority_id: authority.authority_id,
    authority_version: authority.version,
    controller_sha256: authority.controller_sha256,
    candidate_skill_fingerprint:
      request.candidateSkillFingerprint,
    fixture_sha256: request.fixtureSha256,
    evaluation_input_sha256: fingerprint(request.fixture),
    source_commitments: {
      assignment_sha256: fingerprint(request.assignment),
      sessions_sha256: fingerprint(request.sessions),
      label_a_output_sha256: sha256Text(request.labelA.output),
      label_a_transcript_sha256: sha256Text(request.labelA.events),
      label_b_output_sha256: sha256Text(request.labelB.output),
      label_b_transcript_sha256: sha256Text(request.labelB.events),
      judge_output_sha256: fingerprint(request.judgeOutput),
      judge_transcript_sha256: sha256Text(
        request.sessions.judge.transcript,
      ),
      measured_at_sha256: sha256Text(request.measuredAt),
      unblinded_at_sha256: sha256Text(request.unblindedAt),
      platform_source_sha256: fingerprint(
        request.platformValidationEvidence,
      ),
    },
    expected_result: expectedResult,
  };
}

/** Runs the neutral controller and writes one signed attestation to stdout. */
function main() {
  const args = process.argv.slice(2);
  const command = [
    "attest-platform-completion",
    "issue-platform-challenge",
    "run-platform-session",
  ].includes(args[0])
    ? args.shift()
    : "attest";
  const [requestPath, privateKeyPath] = args;
  if (!requestPath || !privateKeyPath) {
    throw new Error(
      "usage: neutral-evaluation-controller [issue-platform-challenge|run-platform-session|attest-platform-completion] <request.json> <private-key.pem>",
    );
  }
  const externalPrivateKeyPath = resolveExternalPrivateKey(
    requestPath,
    privateKeyPath,
  );
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  if (command === "issue-platform-challenge") {
    process.stdout.write(
      `${JSON.stringify(
        issuePlatformChallenge(request, externalPrivateKeyPath),
      )}\n`,
    );
    return;
  }
  if (command === "attest-platform-completion") {
    process.stdout.write(
      `${JSON.stringify(
        attestPlatformCompletion(request, externalPrivateKeyPath),
      )}\n`,
    );
    return;
  }
  if (command === "run-platform-session") {
    process.stdout.write(
      `${JSON.stringify(
        runPlatformSession(request, externalPrivateKeyPath),
      )}\n`,
    );
    return;
  }
  verifyControllerRequest(request);
  const expectedResult = deriveExpectedResult(request);
  const payload = buildPayload(request, expectedResult);
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    authority_id: payload.authority_id,
    authority_version: payload.authority_version,
    controller_sha256: payload.controller_sha256,
    payload_sha256: fingerprint(payload),
    signature_base64: signPayload(payload, externalPrivateKeyPath),
  })}\n`);
}

main();
