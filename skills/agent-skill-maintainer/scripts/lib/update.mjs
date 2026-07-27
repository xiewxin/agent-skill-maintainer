/**
 * Deterministic local Skill update contracts for supported npx-skills installs.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import {
  ApprovalDriftError,
  canonicalJson,
  clone,
  fingerprint,
  isObject,
  redactText,
  resolveCandidatePath,
  validateDocument,
} from "./core.mjs";
import { fingerprintTree } from "./git.mjs";

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const TREE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SEMVER_PATTERN =
  /^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TREE_ENTRIES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_AGENTS = new Set(["codex", "claude-code"]);
const FORBIDDEN_CANONICAL_PARTS = new Set([".git", "node_modules"]);
const WINDOWS_RESERVED_COMPONENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** Returns whether a value is one canonical UTC ISO timestamp. */
function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value;
}

/** Runs GitHub CLI without a shell or interactive prompts. */
function defaultRunner(arguments_, { environment = {} } = {}) {
  return spawnSync("gh", arguments_, {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...environment,
    },
    shell: false,
    windowsHide: true,
  });
}

/** Returns trimmed GitHub CLI output or a redacted failure. */
function runGithub(runner, arguments_) {
  const result = runner(arguments_);
  if (
    !isObject(result) ||
    !Number.isInteger(result.status) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error("GitHub runner 回傳格式不合法");
  }
  if (result.status !== 0) {
    const summary = redactText(
      result.stderr.trim().split(/\r?\n/u)[0] || "unknown error",
    );
    throw new Error(`GitHub CLI 執行失敗：${summary}`);
  }
  return result.stdout.trim();
}

/** Parses one GitHub JSON response. */
function parseGithubJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON`, { cause: error });
  }
}

/** Returns a stable relative path contract without persisting a home path. */
export function canonicalInstallPathFingerprint(skill) {
  if (typeof skill !== "string" || !COMPONENT_PATTERN.test(skill)) {
    throw new Error("Skill 名稱格式不合法");
  }
  return fingerprint({
    scope: "global",
    relative_path: `.agents/skills/${skill}`,
  });
}

/** Normalizes one GitHub source URL to its owner/repository identity. */
function repositoryFromSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== "string") {
    throw new Error("installation source_url 不合法");
  }
  const match = sourceUrl.match(
    /^https:\/\/github\.com\/(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u,
  );
  if (match?.groups?.repository === undefined) {
    throw new Error("第一版只支援公開 GitHub HTTPS source_url");
  }
  return match.groups.repository;
}

/** Returns a safe repository-relative Skill folder. */
function skillFolderFromPath(skillPath) {
  if (
    typeof skillPath !== "string" ||
    skillPath.length === 0 ||
    isAbsolute(skillPath) ||
    skillPath.includes("\\")
  ) {
    throw new Error("installation skill_path 格式不合法");
  }
  const segments = skillPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === "..",
    ) ||
    segments.at(-1) !== "SKILL.md"
  ) {
    throw new Error("installation skill_path 必須安全地指向 SKILL.md");
  }
  return segments.slice(0, -1).join("/");
}

/** Rejects repository paths that are ambiguous across supported platforms. */
function validatePortableRelativePath(relativePath) {
  const components = relativePath.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.endsWith(" ") ||
        component.endsWith(".") ||
        /[<>:"|?*\u0000-\u001f]/u.test(component) ||
        WINDOWS_RESERVED_COMPONENT.test(component),
    )
  ) {
    throw new Error("發布 Skill 子樹含跨平台不安全路徑");
  }
}

/** Validates the update-specific portion of a repository binding. */
export function validateLocalUpdateBinding(binding) {
  validateDocument("binding", binding);
  if (
    binding.install_method !== "npx-skills" ||
    !isObject(binding.installation) ||
    !FINGERPRINT_PATTERN.test(binding.installed_fingerprint) ||
    binding.remote_verified !== true ||
    binding.release_enabled !== true ||
    !["managed", "contribute"].includes(binding.relationship)
  ) {
    throw new Error("本機更新需要完整的 npx-skills installation binding");
  }
  const installation = binding.installation;
  if (installation.scope !== "global") {
    throw new Error("第一版本機更新只支援全局安裝");
  }
  if (installation.mode !== "symlink") {
    throw new Error("第一版本機更新只支援規範目錄與符號連結模式");
  }
  if (
    installation.source_type !== "github" ||
    repositoryFromSourceUrl(installation.source_url).toLowerCase() !==
      binding.source_repository.toLowerCase()
  ) {
    throw new Error("installation source 與 binding repository 不一致");
  }
  skillFolderFromPath(installation.skill_path);
  if (installation.lock_schema_version !== 3) {
    throw new Error("不支援的 skills 全局 Lock Schema");
  }
  if (
    installation.canonical_path_fingerprint !==
      canonicalInstallPathFingerprint(binding.skill)
  ) {
    throw new Error("installation 規範路徑 fingerprint 不一致");
  }
  if (
    !Array.isArray(installation.agents) ||
    installation.agents.length === 0
  ) {
    throw new Error("installation agents 不可為空");
  }
  const agents = [...new Set(installation.agents)].sort();
  if (
    agents.length !== installation.agents.length ||
    agents.some((agent) => !SUPPORTED_AGENTS.has(agent))
  ) {
    throw new Error("installation agents 含重複或尚未支援的 Agent");
  }
  return {
    ...clone(binding),
    installation: {
      ...clone(installation),
      agents,
    },
  };
}

/** Rejects links and special files inside the canonical installed Skill. */
function validateCanonicalTree(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (FORBIDDEN_CANONICAL_PARTS.has(entry.name)) {
        throw new Error("規範 Skill 目錄含 fingerprint 排除目錄");
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("規範 Skill 目錄不可包含 symbolic link");
      }
      if (metadata.isDirectory()) {
        visit(path);
      } else if (!metadata.isFile()) {
        throw new Error("規範 Skill 目錄含不支援的檔案類型");
      }
    }
  };
  visit(root);
}

/** Reads and validates the Skill name from frontmatter. */
function validateSkillManifest(installedPath, expectedSkill) {
  const path = join(installedPath, "SKILL.md");
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error("Skill 目錄缺少 SKILL.md");
  }
  const content = readFileSync(path, "utf8");
  const frontmatter = content.match(/^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const name = frontmatter?.groups?.body
    ?.split(/\r?\n/u)
    .map((line) => line.match(/^name:\s*['"]?(?<name>[^'"]+?)['"]?\s*$/u))
    .find((match) => match?.groups?.name !== undefined)
    ?.groups?.name;
  if (name !== expectedSkill) {
    throw new Error("SKILL.md name 與 binding 不一致");
  }
}

/** Reads the supported global skills Lock without recovering malformed data. */
function readGlobalLock(
  homeDirectory,
  stateDirectory = process.env.XDG_STATE_HOME,
) {
  if (
    stateDirectory !== undefined &&
    (
      typeof stateDirectory !== "string" ||
      stateDirectory.length === 0 ||
      !isAbsolute(stateDirectory)
    )
  ) {
    throw new Error("XDG_STATE_HOME 必須是絕對路徑");
  }
  const path = stateDirectory === undefined
    ? resolve(homeDirectory, ".agents", ".skill-lock.json")
    : resolve(stateDirectory, "skills", ".skill-lock.json");
  let raw;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Lock 必須是一般檔案");
    }
    raw = readFileSync(path);
  } catch (error) {
    throw new Error("無法讀取 skills 全局 Lock", { cause: error });
  }
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("skills 全局 Lock 不是合法 JSON", { cause: error });
  }
  if (
    !isObject(document) ||
    document.version !== 3 ||
    !isObject(document.skills)
  ) {
    throw new Error("不支援的 skills 全局 Lock Schema");
  }
  return {
    path,
    raw,
    mode: statSync(path).mode & 0o777,
    document,
  };
}

/** Validates the bound entry in the global skills Lock. */
function validateLockEntry(
  lock,
  binding,
  expectedTreeSha,
  expectedRef,
) {
  const entry = lock.document.skills[binding.skill];
  if (!isObject(entry)) {
    throw new Error("skills 全局 Lock 缺少目前 Skill");
  }
  const installation = binding.installation;
  if (
    typeof entry.source !== "string" ||
    entry.source.toLowerCase() !==
      binding.source_repository.toLowerCase() ||
    entry.sourceType !== "github" ||
    repositoryFromSourceUrl(entry.sourceUrl).toLowerCase() !==
      binding.source_repository.toLowerCase() ||
    entry.skillPath !== installation.skill_path ||
    !isIsoTimestamp(entry.installedAt) ||
    !isIsoTimestamp(entry.updatedAt) ||
    (
      entry.ref !== undefined &&
      (
        typeof entry.ref !== "string" ||
        entry.ref.length === 0 ||
        entry.ref.startsWith("-")
      )
    ) ||
    !TREE_SHA_PATTERN.test(entry.skillFolderHash)
  ) {
    throw new Error("skills 全局 Lock entry 與 binding 不一致");
  }
  if (
    expectedTreeSha !== undefined &&
    entry.skillFolderHash !== expectedTreeSha
  ) {
    throw new Error("skills 全局 Lock tree SHA 與預期內容不一致");
  }
  if (
    expectedRef !== undefined &&
    entry.ref !== expectedRef
  ) {
    throw new Error("skills 全局 Lock ref 與預期 Release 不一致");
  }
  return clone(entry);
}

/** Resolves and validates all supported Agent consumers. */
function inspectAgentLinks(
  homeDirectory,
  binding,
  canonicalPath,
  claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR,
) {
  const observations = [];
  for (const agent of binding.installation.agents) {
    if (agent === "codex") {
      observations.push({
        agent,
        kind: "canonical",
        target: "canonical",
      });
      continue;
    }
    if (
      claudeConfigDirectory !== undefined &&
      (
        typeof claudeConfigDirectory !== "string" ||
        claudeConfigDirectory.length === 0 ||
        !isAbsolute(claudeConfigDirectory)
      )
    ) {
      throw new Error("CLAUDE_CONFIG_DIR 必須是絕對路徑");
    }
    const claudeHome = claudeConfigDirectory === undefined
      ? resolve(homeDirectory, ".claude")
      : resolve(claudeConfigDirectory);
    const agentPath = resolve(claudeHome, "skills", binding.skill);
    let metadata;
    try {
      metadata = lstatSync(agentPath);
    } catch (error) {
      throw new Error(`Agent Skill 連結不存在：${agent}`, { cause: error });
    }
    if (!metadata.isSymbolicLink()) {
      throw new Error(`Agent Skill 不是 symbolic link：${agent}`);
    }
    if (realpathSync(agentPath) !== canonicalPath) {
      throw new Error(`Agent Skill 連結目的地不一致：${agent}`);
    }
    observations.push({
      agent,
      kind: "symlink",
      target: "canonical",
    });
  }
  return {
    observations,
    hash: fingerprint(observations),
  };
}

/** Inspects one supported installation without writing to it. */
export function inspectLocalInstallation(
  binding,
  installedPath,
  {
    homeDirectory = homedir(),
    expectedFingerprint,
    expectedTreeSha,
    expectedRef,
    enforceBindingFingerprint = true,
    stateDirectory,
    claudeConfigDirectory,
  } = {},
) {
  const normalizedBinding = validateLocalUpdateBinding(binding);
  let expectedPath;
  try {
    expectedPath = realpathSync(resolve(
      homeDirectory,
      ".agents",
      "skills",
      normalizedBinding.skill,
    ));
  } catch (error) {
    throw new Error("目前 HOME 缺少規範 Skill 目錄", {
      cause: error,
    });
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync(resolve(installedPath));
  } catch (error) {
    throw new Error("無法解析已安裝 Skill 規範路徑", { cause: error });
  }
  if (
    canonicalPath !== expectedPath ||
    !statSync(canonicalPath).isDirectory() ||
    lstatSync(resolve(installedPath)).isSymbolicLink()
  ) {
    throw new Error("已安裝 Skill 不是目前 HOME 下的規範目錄");
  }
  validateCanonicalTree(canonicalPath);
  validateSkillManifest(canonicalPath, normalizedBinding.skill);
  const installedFingerprint = fingerprintTree(canonicalPath);
  const fingerprintToMatch =
    expectedFingerprint ??
    (
      enforceBindingFingerprint
        ? normalizedBinding.installed_fingerprint
        : undefined
    );
  if (
    typeof fingerprintToMatch === "string" &&
    installedFingerprint !== fingerprintToMatch
  ) {
    throw new ApprovalDriftError("已安裝 Skill fingerprint 已漂移");
  }
  const lock = readGlobalLock(homeDirectory, stateDirectory);
  const lockEntry = validateLockEntry(
    lock,
    normalizedBinding,
    expectedTreeSha,
    expectedRef,
  );
  const links = inspectAgentLinks(
    homeDirectory,
    normalizedBinding,
    canonicalPath,
    claudeConfigDirectory,
  );
  return {
    binding: normalizedBinding,
    canonical_path: canonicalPath,
    canonical_path_fingerprint:
      normalizedBinding.installation.canonical_path_fingerprint,
    installed_fingerprint: installedFingerprint,
    lock,
    lock_entry: lockEntry,
    lock_entry_hash: fingerprint(lockEntry),
    agent_links: links.observations,
    agent_links_hash: links.hash,
  };
}

/** Verifies that an official Release tag still points to its proof commit. */
function verifyPublicationProofLive(proof, runner) {
  validateDocument("publication-proof", proof);
  if (
    proof.official !== true ||
    !REPOSITORY_PATTERN.test(proof.repository) ||
    !COMMIT_PATTERN.test(proof.commit) ||
    !SEMVER_PATTERN.test(proof.tag) ||
    proof.version !== proof.tag ||
    proof.release_url !==
      `https://github.com/${proof.repository}/releases/tag/${proof.tag}`
  ) {
    throw new ApprovalDriftError("官方發布證明不完整");
  }
  const release = parseGithubJson(
    runGithub(runner, [
      "release",
      "view",
      proof.tag,
      "--repo",
      proof.repository,
      "--json",
      "tagName,url,isDraft",
    ]),
    "GitHub Release",
  );
  const tagCommit = runGithub(runner, [
    "api",
    `repos/${proof.repository}/commits/${encodeURIComponent(proof.tag)}`,
    "--jq",
    ".sha",
  ]);
  if (
    release.tagName !== proof.tag ||
    release.url !== proof.release_url ||
    release.isDraft !== false ||
    tagCommit !== proof.commit
  ) {
    throw new ApprovalDriftError("GitHub Release 或 Tag 已漂移");
  }
  return clone(proof);
}

/** Reads and validates the exact remote Skill tree at a published commit. */
function readPublishedSkillTree(repository, commit, skillPath, runner) {
  if (
    !REPOSITORY_PATTERN.test(repository) ||
    !COMMIT_PATTERN.test(commit)
  ) {
    throw new Error("發布 repository 或 commit 格式不合法");
  }
  const folder = skillFolderFromPath(skillPath);
  const tree = parseGithubJson(
    runGithub(runner, [
      "api",
      `repos/${repository}/git/trees/${commit}?recursive=1`,
    ]),
    "GitHub published tree",
  );
  if (
    tree.truncated === true ||
    !TREE_SHA_PATTERN.test(tree.sha) ||
    !Array.isArray(tree.tree)
  ) {
    throw new Error("GitHub published tree 不完整");
  }
  const folderEntry = folder.length === 0
    ? { sha: tree.sha, type: "tree" }
    : tree.tree.find(
      (entry) => entry?.path === folder && entry?.type === "tree",
    );
  if (!isObject(folderEntry) || !TREE_SHA_PATTERN.test(folderEntry.sha)) {
    throw new Error("發布 Commit 缺少綁定的 Skill 子樹");
  }
  const prefix = folder.length === 0 ? "" : `${folder}/`;
  const relevant = tree.tree.filter(
    (entry) =>
      isObject(entry) &&
      typeof entry.path === "string" &&
      entry.path.startsWith(prefix) &&
      entry.path !== folder,
  );
  if (relevant.length === 0 || relevant.length > MAX_TREE_ENTRIES) {
    throw new Error("發布 Skill 子樹為空或超出安全上限");
  }
  const files = [];
  const portablePaths = new Set();
  for (const entry of relevant) {
    const relativePath = entry.path.slice(prefix.length);
    if (
      relativePath.length === 0 ||
      isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.split("/").some(
        (part) => part.length === 0 || part === "." || part === "..",
      )
    ) {
      throw new Error("發布 Skill 子樹含不安全路徑");
    }
    validatePortableRelativePath(relativePath);
    const portablePath = relativePath.normalize("NFC").toLowerCase();
    if (portablePaths.has(portablePath)) {
      throw new Error("發布 Skill 子樹含跨平台路徑衝突");
    }
    portablePaths.add(portablePath);
    if (entry.type === "tree" && entry.mode === "040000") {
      continue;
    }
    if (entry.mode === "120000") {
      throw new Error("發布 Skill 子樹含 symbolic link");
    }
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new Error("發布 Skill 子樹含 submodule");
    }
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !TREE_SHA_PATTERN.test(entry.sha)
    ) {
      throw new Error("發布 Skill 子樹含不支援的 entry");
    }
    files.push({
      relative_path: relativePath,
      mode: entry.mode,
      sha: entry.sha,
    });
  }
  if (!files.some((entry) => entry.relative_path === "SKILL.md")) {
    throw new Error("發布 Skill 子樹缺少 SKILL.md");
  }
  files.sort((first, second) =>
    first.relative_path.localeCompare(second.relative_path));
  return {
    tree_sha: folderEntry.sha,
    files,
  };
}

/** Fetches one verified Git blob without executing repository content. */
function readPublishedBlob(repository, file, runner) {
  const blob = parseGithubJson(
    runGithub(runner, [
      "api",
      `repos/${repository}/git/blobs/${file.sha}`,
    ]),
    "GitHub published blob",
  );
  if (
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  ) {
    throw new Error("GitHub published blob 編碼不支援");
  }
  const payload = Buffer.from(blob.content.replace(/\s/gu, ""), "base64");
  if (payload.length > MAX_FILE_BYTES) {
    throw new Error("發布 Skill 單一檔案超出安全上限");
  }
  const header = Buffer.from(`blob ${payload.length}\0`, "utf8");
  const objectId = createHash("sha1")
    .update(header)
    .update(payload)
    .digest("hex");
  if (objectId !== file.sha) {
    throw new Error("發布 Skill blob fingerprint 不一致");
  }
  return payload;
}

/** Loads all published Skill payloads within bounded memory. */
function readPublishedFiles(repository, tree, runner) {
  let total = 0;
  const files = tree.files.map((file) => {
    const payload = readPublishedBlob(repository, file, runner);
    total += payload.length;
    if (total > MAX_TREE_BYTES) {
      throw new Error("發布 Skill 子樹超出安全上限");
    }
    return { ...file, payload };
  });
  return files;
}

/** Computes the same content fingerprint as fingerprintTree from memory. */
function fingerprintPublishedFiles(files) {
  const root = new Map();
  for (const file of files) {
    const parts = file.relative_path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) {
        directory.set(part, { kind: "directory", children: new Map() });
      }
      const entry = directory.get(part);
      if (entry.kind !== "directory") {
        throw new Error("發布 Skill 路徑檔案與目錄衝突");
      }
      directory = entry.children;
    }
    const name = parts.at(-1);
    if (directory.has(name)) {
      throw new Error("發布 Skill 路徑重複");
    }
    directory.set(name, { kind: "file", file });
  }
  const digest = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const names = [...directory.keys()].sort((first, second) =>
      first.localeCompare(second));
    for (const name of names) {
      const entry = directory.get(name);
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      if (entry.kind === "directory") {
        visit(entry.children, path);
      } else {
        digest.update(`file\0${path}\0`, "utf8");
        digest.update(
          createHash("sha256").update(entry.file.payload).digest(),
        );
      }
    }
  };
  visit(root);
  return digest.digest("hex");
}

/** Writes a validated published Skill tree to a fresh staging directory. */
function materializePublishedFiles(stage, files) {
  for (const file of files) {
    const target = resolveCandidatePath(stage, file.relative_path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.payload, { flag: "wx" });
    chmodSync(target, file.mode === "100755" ? 0o755 : 0o644);
  }
}

/** Validates the compact caller state used to build one update preview. */
function normalizePreviewInput(state) {
  if (!isObject(state)) {
    throw new Error("Local update state 必須是 object");
  }
  const fields = new Set([
    "run_id",
    "binding_id",
    "skill",
    "repository",
    "relationship",
    "from_version",
    "publication_proof",
    "provider_contract_hash",
  ]);
  const unknown = Object.keys(state)
    .filter((name) => !fields.has(name))
    .sort();
  const required = [...fields].filter(
    (name) => !Object.hasOwn(state, name),
  );
  if (unknown.length > 0) {
    throw new Error(`Local update state 含未知欄位：${unknown.join(", ")}`);
  }
  if (required.length > 0) {
    throw new Error(`Local update state 缺少欄位：${required.join(", ")}`);
  }
  if (
    typeof state.run_id !== "string" ||
    !COMPONENT_PATTERN.test(state.run_id) ||
    typeof state.binding_id !== "string" ||
    !COMPONENT_PATTERN.test(state.binding_id) ||
    typeof state.skill !== "string" ||
    !COMPONENT_PATTERN.test(state.skill) ||
    typeof state.repository !== "string" ||
    !REPOSITORY_PATTERN.test(state.repository) ||
    !["managed", "contribute"].includes(state.relationship) ||
    (
      state.from_version !== null &&
      (
        typeof state.from_version !== "string" ||
        state.from_version.length === 0
      )
    ) ||
    typeof state.provider_contract_hash !== "string" ||
    !FINGERPRINT_PATTERN.test(state.provider_contract_hash)
  ) {
    throw new Error("Local update state 欄位格式不合法");
  }
  validateDocument("publication-proof", state.publication_proof);
  return clone(state);
}

/** Builds a read-only update preview bound to local and published state. */
export function buildLocalUpdatePreview(
  state,
  binding,
  installedPath,
  {
    homeDirectory = homedir(),
    runner = defaultRunner,
    stateDirectory,
    claudeConfigDirectory,
  } = {},
) {
  const input = normalizePreviewInput(state);
  const local = inspectLocalInstallation(binding, installedPath, {
    homeDirectory,
    stateDirectory,
    claudeConfigDirectory,
  });
  if (
    local.binding.binding_id !== input.binding_id ||
    local.binding.skill !== input.skill ||
    local.binding.source_repository.toLowerCase() !==
      input.repository.toLowerCase() ||
    local.binding.relationship !== input.relationship ||
    local.binding.remote_verified !== true
  ) {
    throw new ApprovalDriftError("Local update binding 與目標不一致");
  }
  const publication = verifyPublicationProofLive(
    input.publication_proof,
    runner,
  );
  if (
    publication.repository.toLowerCase() !==
      input.repository.toLowerCase()
  ) {
    throw new ApprovalDriftError("Local update 發布倉庫不一致");
  }
  const publishedTree = readPublishedSkillTree(
    input.repository,
    publication.commit,
    local.binding.installation.skill_path,
    runner,
  );
  const preview = {
    schema_version: 1,
    action: "local_update",
    state: {
      run_id: input.run_id,
      binding_id: input.binding_id,
      skill: input.skill,
      repository: input.repository,
      relationship: input.relationship,
      from_version: input.from_version,
      to_version: publication.version,
      release_tag: publication.tag,
      source_commit: publication.commit,
      install_method: local.binding.install_method,
      scope: local.binding.installation.scope,
      mode: local.binding.installation.mode,
      source_url: local.binding.installation.source_url,
      skill_path: local.binding.installation.skill_path,
      agents: local.binding.installation.agents,
      lock_schema_version:
        local.binding.installation.lock_schema_version,
      canonical_path_fingerprint:
        local.canonical_path_fingerprint,
      current_fingerprint: local.installed_fingerprint,
      target_tree_sha: publishedTree.tree_sha,
      current_ref: local.lock_entry.ref ?? null,
      target_ref: publication.tag,
      lock_entry_hash: local.lock_entry_hash,
      agent_links_hash: local.agent_links_hash,
      provider_contract_hash: input.provider_contract_hash,
    },
  };
  preview.fingerprint = fingerprint(preview);
  validateDocument("local-update-preview", preview);
  return preview;
}

/** Builds one expiring confirmation for an exact update preview. */
export function buildLocalUpdateApproval(
  preview,
  { confirmedAt, expiresAt },
) {
  validateDocument("local-update-preview", preview);
  const confirmed = Date.parse(confirmedAt);
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(confirmed) ||
    !Number.isFinite(expires) ||
    expires <= confirmed ||
    expires - confirmed > MAX_APPROVAL_TTL_MS
  ) {
    throw new Error("Local update 確認時間範圍不合法");
  }
  const state = preview.state;
  const approval = {
    schema_version: 1,
    action: "local_update",
    preview_fingerprint: preview.fingerprint,
    run_id: state.run_id,
    binding_id: state.binding_id,
    skill: state.skill,
    repository: state.repository,
    from_version: state.from_version,
    to_version: state.to_version,
    release_tag: state.release_tag,
    source_commit: state.source_commit,
    current_fingerprint: state.current_fingerprint,
    target_tree_sha: state.target_tree_sha,
    current_ref: state.current_ref,
    target_ref: state.target_ref,
    canonical_path_fingerprint: state.canonical_path_fingerprint,
    install_method: state.install_method,
    scope: state.scope,
    mode: state.mode,
    confirmed_at: new Date(confirmed).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
  approval.fingerprint = fingerprint(approval);
  validateDocument("local-update-approval", approval);
  return approval;
}

/** Verifies one approval against the exact preview and current time. */
export function verifyLocalUpdateApproval(
  approval,
  preview,
  {
    now = new Date(),
    requireFresh = true,
  } = {},
) {
  validateDocument("local-update-preview", preview);
  validateDocument("local-update-approval", approval);
  const unsignedPreview = clone(preview);
  delete unsignedPreview.fingerprint;
  if (fingerprint(unsignedPreview) !== preview.fingerprint) {
    throw new ApprovalDriftError("Local update preview fingerprint 不一致");
  }
  const unsignedApproval = clone(approval);
  delete unsignedApproval.fingerprint;
  if (fingerprint(unsignedApproval) !== approval.fingerprint) {
    throw new ApprovalDriftError("Local update approval fingerprint 不一致");
  }
  const expected = buildLocalUpdateApproval(preview, {
    confirmedAt: approval.confirmed_at,
    expiresAt: approval.expires_at,
  });
  if (canonicalJson(expected) !== canonicalJson(approval)) {
    throw new ApprovalDriftError("Local update approval 與預覽不一致");
  }
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  const confirmed = Date.parse(approval.confirmed_at);
  const expires = Date.parse(approval.expires_at);
  if (!Number.isFinite(current)) {
    throw new Error("Local update 驗證時間不合法");
  }
  if (confirmed - current > MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new ApprovalDriftError("Local update 確認時間位於未來");
  }
  if (requireFresh && current > expires) {
    throw new ApprovalDriftError("Local update 確認已過期");
  }
  return true;
}

/** Rebuilds the global Lock with only the bound entry changed. */
function buildUpdatedLock(local, preview, now) {
  const next = clone(local.lock.document);
  const previous = local.lock_entry;
  next.skills[preview.state.skill] = {
    ...clone(previous),
    ref: preview.state.target_ref,
    skillFolderHash: preview.state.target_tree_sha,
    updatedAt: now.toISOString(),
  };
  return next;
}

/** Atomically writes a same-directory file while preserving its mode. */
function atomicWriteBuffer(path, payload, mode) {
  const temporary = resolve(
    dirname(path),
    `.local-update-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      rmSync(temporary, { force: true });
    }
  }
}

/** Builds a redacted reconciliation record. */
function buildReconciliation(
  preview,
  approval,
  status,
  localState,
  now,
) {
  const reconciliation = {
    schema_version: 1,
    action: "local_update",
    approval_fingerprint: approval.fingerprint,
    preview_fingerprint: preview.fingerprint,
    observed_at: now.toISOString(),
    status,
    local_state_hash: fingerprint(localState),
  };
  validateDocument("local-update-reconciliation", reconciliation);
  return reconciliation;
}

/** Builds a verified proof for the exact installed publication. */
function buildUpdateProof(
  preview,
  installedFingerprint,
  lockEntryHash,
  agentLinksHash,
  operation,
  now,
) {
  const proof = {
    schema_version: 2,
    run_id: preview.state.run_id,
    binding_id: preview.state.binding_id,
    skill: preview.state.skill,
    repository: preview.state.repository,
    from_version: preview.state.from_version,
    to_version: preview.state.to_version,
    release_tag: preview.state.release_tag,
    source_commit: preview.state.source_commit,
    install_method: preview.state.install_method,
    scope: preview.state.scope,
    mode: preview.state.mode,
    canonical_path_fingerprint:
      preview.state.canonical_path_fingerprint,
    previous_fingerprint: preview.state.current_fingerprint,
    installed_fingerprint: installedFingerprint,
    lock_entry_hash: lockEntryHash,
    agent_links_hash: agentLinksHash,
    operation,
    activation: "future_tasks_only",
    verified_at: now.toISOString(),
    verified: true,
  };
  validateDocument("update-proof", proof);
  return proof;
}

/** Rebuilds the exact official publication proof bound by a preview. */
function publicationProofFromPreview(preview) {
  return {
    schema_version: 1,
    repository: preview.state.repository,
    version: preview.state.to_version,
    tag: preview.state.release_tag,
    commit: preview.state.source_commit,
    release_url:
      `https://github.com/${preview.state.repository}/releases/tag/` +
      preview.state.release_tag,
    official: true,
  };
}

/** Revalidates preview-bound local and remote state immediately before apply. */
function preflightApply(
  preview,
  binding,
  installedPath,
  {
    homeDirectory,
    runner,
    stateDirectory,
    claudeConfigDirectory,
  },
) {
  validateDocument("local-update-preview", preview);
  verifyPublicationProofLive(
    publicationProofFromPreview(preview),
    runner,
  );
  const local = inspectLocalInstallation(binding, installedPath, {
    homeDirectory,
    expectedFingerprint: preview.state.current_fingerprint,
    stateDirectory,
    claudeConfigDirectory,
  });
  const tree = readPublishedSkillTree(
    preview.state.repository,
    preview.state.source_commit,
    preview.state.skill_path,
    runner,
  );
  if (
    local.binding.binding_id !== preview.state.binding_id ||
    local.binding.skill !== preview.state.skill ||
    local.binding.source_repository.toLowerCase() !==
      preview.state.repository.toLowerCase() ||
    local.lock_entry_hash !== preview.state.lock_entry_hash ||
    local.agent_links_hash !== preview.state.agent_links_hash ||
    tree.tree_sha !== preview.state.target_tree_sha
  ) {
    throw new ApprovalDriftError("Local update 套用前狀態已漂移");
  }
  return { local, tree };
}

/** Performs the mutation-free pre-reservation apply check. */
export function validateLocalUpdatePreflight(
  preview,
  approval,
  {
    binding,
    installedPath,
    homeDirectory = homedir(),
    runner = defaultRunner,
    now = new Date(),
    stateDirectory,
    claudeConfigDirectory,
  },
) {
  verifyLocalUpdateApproval(approval, preview, { now });
  preflightApply(
    preview,
    binding,
    installedPath,
    {
      homeDirectory,
      runner,
      stateDirectory,
      claudeConfigDirectory,
    },
  );
  return {
    valid: true,
    preview_fingerprint: preview.fingerprint,
    approval_fingerprint: approval.fingerprint,
  };
}

/** Applies one approved exact publication with atomic rollback. */
export function applyLocalUpdate(
  preview,
  approval,
  {
    binding,
    installedPath,
    homeDirectory = homedir(),
    runner = defaultRunner,
    now = new Date(),
    faultInjector = () => {},
    stateDirectory,
    claudeConfigDirectory,
  },
) {
  verifyLocalUpdateApproval(approval, preview, { now });
  let preflight;
  try {
    preflight = preflightApply(
      preview,
      binding,
      installedPath,
      {
        homeDirectory,
        runner,
        stateDirectory,
        claudeConfigDirectory,
      },
    );
  } catch (error) {
    return {
      status: "not_applied",
      reason: redactText(error.message),
      reconciliation: buildReconciliation(
        preview,
        approval,
        "not_applied",
        { stage: "preflight", error: redactText(error.message) },
        now,
      ),
    };
  }

  let files;
  try {
    faultInjector("before_source");
    files = readPublishedFiles(
      preview.state.repository,
      preflight.tree,
      runner,
    );
  } catch (error) {
    return {
      status: "not_applied",
      reason: redactText(error.message),
      reconciliation: buildReconciliation(
        preview,
        approval,
        "not_applied",
        { stage: "source", error: redactText(error.message) },
        now,
      ),
    };
  }

  const targetFingerprint = fingerprintPublishedFiles(files);
  if (
    targetFingerprint === preflight.local.installed_fingerprint &&
    preflight.local.lock_entry.skillFolderHash ===
      preview.state.target_tree_sha &&
    preflight.local.lock_entry.ref === preview.state.target_ref
  ) {
    return {
      status: "applied",
      proof: buildUpdateProof(
        preview,
        targetFingerprint,
        preflight.local.lock_entry_hash,
        preflight.local.agent_links_hash,
        "already_applied",
        now,
      ),
    };
  }

  const canonicalPath = preflight.local.canonical_path;
  const parent = dirname(canonicalPath);
  const stage = mkdtempSync(
    join(parent, `.${preview.state.skill}-update-`),
  );
  const nonce = randomBytes(8).toString("hex");
  const backup = join(
    parent,
    `.${preview.state.skill}-backup-${nonce}`,
  );
  const failed = join(
    parent,
    `.${preview.state.skill}-failed-${nonce}`,
  );
  let mutationStarted = false;
  let lockChanged = false;
  try {
    materializePublishedFiles(stage, files);
    validateCanonicalTree(stage);
    validateSkillManifest(stage, preview.state.skill);
    if (fingerprintTree(stage) !== targetFingerprint) {
      throw new Error("暫存 Skill fingerprint 不一致");
    }
    faultInjector("after_staging");

    renameSync(canonicalPath, backup);
    mutationStarted = true;
    faultInjector("after_backup");
    renameSync(stage, canonicalPath);
    faultInjector("after_switch");
    const nextLock = buildUpdatedLock(preflight.local, preview, now);
    atomicWriteBuffer(
      preflight.local.lock.path,
      Buffer.from(`${JSON.stringify(nextLock, null, 2)}\n`, "utf8"),
      preflight.local.lock.mode,
    );
    lockChanged = true;
    faultInjector("after_lock_write");
    faultInjector("before_postcondition");

    const verified = inspectLocalInstallation(binding, installedPath, {
      homeDirectory,
      expectedFingerprint: targetFingerprint,
      expectedTreeSha: preview.state.target_tree_sha,
      expectedRef: preview.state.target_ref,
      stateDirectory,
      claudeConfigDirectory,
    });
    verifyPublicationProofLive(
      publicationProofFromPreview(preview),
      runner,
    );
    const proof = buildUpdateProof(
      preview,
      verified.installed_fingerprint,
      verified.lock_entry_hash,
      verified.agent_links_hash,
      "update",
      now,
    );
    faultInjector("before_cleanup");
    rmSync(backup, { recursive: true, force: true });
    return { status: "applied", proof };
  } catch (error) {
    if (!mutationStarted) {
      return {
        status: "not_applied",
        reason: redactText(error.message),
        reconciliation: buildReconciliation(
          preview,
          approval,
          "not_applied",
          { stage: "staging", error: redactText(error.message) },
          now,
        ),
      };
    }
    try {
      faultInjector("before_rollback");
      if (existsSync(canonicalPath)) {
        renameSync(canonicalPath, failed);
      }
      if (!existsSync(backup)) {
        throw new Error("原 Skill 備份不存在");
      }
      renameSync(backup, canonicalPath);
      if (lockChanged) {
        atomicWriteBuffer(
          preflight.local.lock.path,
          preflight.local.lock.raw,
          preflight.local.lock.mode,
        );
      }
      const restored = inspectLocalInstallation(
        binding,
        installedPath,
        {
          homeDirectory,
          expectedFingerprint:
            preview.state.current_fingerprint,
          stateDirectory,
          claudeConfigDirectory,
        },
      );
      rmSync(failed, { recursive: true, force: true });
      return {
        status: "rolled_back",
        reason: redactText(error.message),
        reconciliation: buildReconciliation(
          preview,
          approval,
          "rolled_back",
          {
            installed_fingerprint: restored.installed_fingerprint,
            lock_entry_hash: restored.lock_entry_hash,
            agent_links_hash: restored.agent_links_hash,
          },
          now,
        ),
      };
    } catch (rollbackError) {
      return {
        status: "blocked",
        reason: "本機更新失敗且無法證明已完整回滾",
        reconciliation: buildReconciliation(
          preview,
          approval,
          "blocked",
          {
            apply_error: redactText(error.message),
            rollback_error: redactText(rollbackError.message),
          },
          now,
        ),
      };
    }
  } finally {
    if (existsSync(stage)) {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

/** Reconciles one attempted update without mutating the installation. */
export function reconcileLocalUpdate(
  preview,
  approval,
  {
    binding,
    installedPath,
    homeDirectory = homedir(),
    runner = defaultRunner,
    now = new Date(),
    stateDirectory,
    claudeConfigDirectory,
  },
) {
  verifyLocalUpdateApproval(approval, preview, {
    now: approval.confirmed_at,
    requireFresh: false,
  });
  let local;
  try {
    local = inspectLocalInstallation(binding, installedPath, {
      homeDirectory,
      enforceBindingFingerprint: false,
      stateDirectory,
      claudeConfigDirectory,
    });
  } catch (error) {
    return {
      status: "blocked",
      reason: redactText(error.message),
      reconciliation: buildReconciliation(
        preview,
        approval,
        "blocked",
        { stage: "inspection", error: redactText(error.message) },
        now,
      ),
    };
  }
  let tree;
  let files;
  try {
    verifyPublicationProofLive(
      publicationProofFromPreview(preview),
      runner,
    );
    tree = readPublishedSkillTree(
      preview.state.repository,
      preview.state.source_commit,
      preview.state.skill_path,
      runner,
    );
    files = readPublishedFiles(
      preview.state.repository,
      tree,
      runner,
    );
  } catch (error) {
    return {
      status: "drifted",
      reason: redactText(error.message),
      reconciliation: buildReconciliation(
        preview,
        approval,
        "drifted",
        { stage: "publication", error: redactText(error.message) },
        now,
      ),
    };
  }
  const targetFingerprint = fingerprintPublishedFiles(files);
  const atTarget =
    tree.tree_sha === preview.state.target_tree_sha &&
    local.installed_fingerprint === targetFingerprint &&
    local.lock_entry.skillFolderHash === preview.state.target_tree_sha &&
    local.lock_entry.ref === preview.state.target_ref &&
    local.agent_links_hash === preview.state.agent_links_hash;
  if (atTarget) {
    return {
      status: "applied",
      proof: buildUpdateProof(
        preview,
        targetFingerprint,
        local.lock_entry_hash,
        local.agent_links_hash,
        "update",
        now,
      ),
    };
  }
  const atOriginal =
    local.installed_fingerprint === preview.state.current_fingerprint &&
    local.lock_entry_hash === preview.state.lock_entry_hash &&
    local.agent_links_hash === preview.state.agent_links_hash;
  const status = atOriginal ? "not_applied" : "blocked";
  return {
    status,
    reconciliation: buildReconciliation(
      preview,
      approval,
      status,
      {
        installed_fingerprint: local.installed_fingerprint,
        lock_entry_hash: local.lock_entry_hash,
        agent_links_hash: local.agent_links_hash,
      },
      now,
    ),
  };
}
