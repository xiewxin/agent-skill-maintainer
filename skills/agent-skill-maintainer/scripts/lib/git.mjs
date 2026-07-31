/**
 * Safe Git snapshots, isolated candidates, and release-note traceability.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
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
  canonicalJson,
  clone,
  compareUtf8,
  fingerprint,
  isObject,
  resolveCandidatePath,
  resolveLoosePath,
  validateCandidateSnapshotContract,
  validateCandidateProcessArtifacts,
  validateDocument,
  verifyApproval,
} from "./core.mjs";

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const GITHUB_HTTPS_REMOTE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u;
const IGNORED_FINGERPRINT_PARTS = new Set([".git"]);
const PULL_REQUEST_PATTERNS = [
  /\(#(?<number>[1-9][0-9]*)\)\s*$/g,
  /\bmerge pull request #(?<number>[1-9][0-9]*)\b/gi,
];
const RELEASE_MAPPING_FIELDS = new Set([
  "id",
  "disposition",
  "source_commits",
  "source_prs",
  "optimization_ids",
  "note",
  "reason",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const GIT_NULL_PATH = process.platform === "win32" ? "NUL" : devNull;

/** Validates a Git ref and rejects revision or option injection. */
export function validateRef(ref, label = "ref") {
  if (
    typeof ref !== "string" ||
    !REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith(".") ||
    ref.endsWith("/") ||
    ref.startsWith("-")
  ) {
    throw new Error(`${label} 格式不合法`);
  }
  return ref;
}

/** Validates a full Git object ID before using it as a commit revision. */
export function validateCommit(commit, label = "commit") {
  if (
    typeof commit !== "string" ||
    !COMMIT_PATTERN.test(commit)
  ) {
    throw new Error(`${label} 格式不合法`);
  }
  return commit;
}

/** Builds a Git environment with graph overrides, prompts, and diff disabled. */
function safeGitEnvironment({
  readOnly = false,
  gitConfigGlobal = GIT_NULL_PATH,
} = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name === "GIT_CONFIG" ||
      name === "GIT_CONFIG_COUNT" ||
      name === "GIT_CONFIG_PARAMETERS" ||
      name.startsWith("GIT_CONFIG_KEY_") ||
      name.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete environment[name];
    }
  }
  delete environment.GIT_EXTERNAL_DIFF;
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_OBJECT_DIRECTORY;
  delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_EXEC_PATH;
  delete environment.GIT_TEMPLATE_DIR;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = GIT_NULL_PATH;
  environment.GIT_CONFIG_GLOBAL = gitConfigGlobal;
  environment.GIT_GRAFT_FILE = GIT_NULL_PATH;
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_PAGER = "cat";
  environment.LC_ALL = "C";
  if (readOnly) {
    environment.GIT_OPTIONAL_LOCKS = "0";
  }
  return environment;
}

/** Executes Git without a shell and returns bytes or strict UTF-8 text. */
export function runGit(
  repository,
  arguments_,
  {
    binary = false,
    readOnly = false,
    label = "Git command",
    gitConfigGlobal = GIT_NULL_PATH,
  } = {},
) {
  const result = spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      `core.hooksPath=${GIT_NULL_PATH}`,
      ...arguments_,
    ],
    {
      cwd: repository,
      env: safeGitEnvironment({ readOnly, gitConfigGlobal }),
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`${label} 失敗：${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = Buffer.from(result.stderr ?? [])
      .toString("utf8")
      .trim();
    throw new Error(`${label} 失敗：${message}`);
  }
  const output = Buffer.from(result.stdout ?? []);
  if (binary) {
    return output;
  }
  try {
    return UTF8_DECODER.decode(output);
  } catch (error) {
    throw new Error(`${label} 輸出不是 UTF-8`, { cause: error });
  }
}

/** Creates a clean bare transport that can read approved candidate objects. */
export function createIsolatedGitTransport(
  temporaryRoot,
  {
    sourceRepository = null,
    gitConfigGlobal = GIT_NULL_PATH,
  } = {},
) {
  const root = realpathSync(resolve(temporaryRoot));
  if (!statSync(root).isDirectory()) {
    throw new Error("Git transport root 必須是目錄");
  }
  const transport = join(root, "transport.git");
  if (existsSync(transport)) {
    throw new Error("Git transport 已存在");
  }
  runGit(
    root,
    ["init", "--bare", "--", transport],
    {
      label: "Git transport initialization",
      gitConfigGlobal,
    },
  );
  if (sourceRepository === null) {
    return transport;
  }
  const source = realpathSync(resolve(sourceRepository));
  const sourceGitDirectory = join(source, ".git");
  if (
    !lstatSync(sourceGitDirectory).isDirectory() ||
    !statSync(sourceGitDirectory).isDirectory()
  ) {
    throw new Error("Git transport source 必須是隔離 clone");
  }
  const sourceObjects = realpathSync(
    join(sourceGitDirectory, "objects"),
  );
  const alternatesDirectory = join(transport, "objects", "info");
  mkdirSync(alternatesDirectory, { recursive: true });
  writeFileSync(
    join(alternatesDirectory, "alternates"),
    `${JSON.stringify(sourceObjects)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return transport;
}

/** Returns a non-disclosing fingerprint for one canonical candidate path. */
export function fingerprintCandidatePath(candidatePath) {
  const candidate = realpathSync(resolve(candidatePath));
  if (!statSync(candidate).isDirectory()) {
    throw new Error("candidate 必須是目錄");
  }
  return fingerprint({ canonical_candidate_path: candidate });
}

/** Builds a read-only snapshot against the selected ref's merge base. */
export function buildRepositorySnapshot(
  repository,
  { baseRef, processArtifactPrefixes = [] },
) {
  const repositoryPath = realpathSync(resolve(repository));
  if (!statSync(repositoryPath).isDirectory()) {
    throw new Error("repository 必須是目錄");
  }
  const safeBaseRef = validateRef(baseRef, "base_ref");
  const repositoryPrefix = runGit(
    repositoryPath,
    ["rev-parse", "--show-prefix"],
    {
      readOnly: true,
      label: "Git 唯讀命令",
    },
  ).trim();
  if (repositoryPrefix !== "") {
    throw new Error("repository 必須指向 Git 根目錄");
  }
  const headCommit = runGit(repositoryPath, ["rev-parse", "HEAD"], {
    readOnly: true,
    label: "Git 唯讀命令",
  }).trim();
  const mergeBase = runGit(
    repositoryPath,
    ["merge-base", safeBaseRef, "HEAD"],
    { readOnly: true, label: "Git 唯讀命令" },
  ).trim();
  const range = `${mergeBase}..${headCommit}`;
  const changedOutput = runGit(
    repositoryPath,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      range,
    ],
    { binary: true, readOnly: true, label: "Git 唯讀命令" },
  );
  const changedFiles = parseNulPaths(changedOutput).sort();
  const diff = runGit(
    repositoryPath,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      range,
    ],
    { binary: true, readOnly: true, label: "Git 唯讀命令" },
  );
  validateCandidateProcessArtifacts([], {
    excludedPrefixes: processArtifactPrefixes,
  });
  return {
    schema_version: 1,
    base_ref: safeBaseRef,
    merge_base: mergeBase,
    head_commit: headCommit,
    diff_hash: createHash("sha256").update(diff).digest("hex"),
    changed_files: changedFiles,
    process_artifact_prefixes: clone(processArtifactPrefixes),
  };
}

/** Parses NUL-delimited Git paths as strict UTF-8. */
function parseNulPaths(output) {
  const paths = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index === output.length || output[index] === 0) {
      if (index > start) {
        try {
          paths.push(UTF8_DECODER.decode(output.subarray(start, index)));
        } catch (error) {
          throw new Error("候選含非 UTF-8 路徑，無法建立公開合同", {
            cause: error,
          });
        }
      }
      start = index + 1;
    }
  }
  return paths;
}

/** Updates a hash with an unambiguous labeled byte component. */
function updateComponent(digest, label, payload) {
  digest.update(label, "utf8");
  digest.update(Buffer.from([0]));
  digest.update(String(payload.length), "ascii");
  digest.update(Buffer.from([0]));
  digest.update(payload);
}

/** Returns the Git-compatible regular-file mode used by tree identity. */
function regularFileMode(metadata) {
  if (process.platform === "win32") {
    return "100644";
  }
  return (metadata.mode & 0o111) === 0 ? "100644" : "100755";
}

/** Fingerprints regular-file hashes after one full relative-path byte sort. */
export function fingerprintTreeEntries(entries) {
  const ordered = [...entries].sort(
    (first, second) => compareUtf8(first.path, second.path),
  );
  const digest = createHash("sha256");
  for (const entry of ordered) {
    if (
      !["100644", "100755"].includes(entry.mode) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !FINGERPRINT_PATTERN.test(entry.sha256)
    ) {
      throw new Error("tree fingerprint entry 不合法");
    }
    digest.update(`${entry.mode}\0${entry.path}\0`, "utf8");
    digest.update(Buffer.from(entry.sha256, "hex"));
  }
  return digest.digest("hex");
}

/** Produces a stable publishable tree fingerprint without following symlinks. */
export function fingerprintTree(path) {
  const root = realpathSync(resolve(path));
  if (!statSync(root).isDirectory()) {
    throw new Error("fingerprint 目標必須是目錄");
  }
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !IGNORED_FINGERPRINT_PARTS.has(entry.name))
      .sort((first, second) => compareUtf8(first.name, second.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`fingerprint 目標不可含 symlink：${rel}`);
      } else if (metadata.isDirectory()) {
        visit(absolute);
      } else if (metadata.isFile()) {
        files.push({
          mode: regularFileMode(metadata),
          path: rel,
          sha256: createHash("sha256")
            .update(readFileSync(absolute))
            .digest("hex"),
        });
      } else {
        throw new Error(`不支援的 installed tree entry：${rel}`);
      }
    }
  };
  visit(root);
  return fingerprintTreeEntries(files);
}

/** Counts regular files in one tree without following symlinks. */
export function countTreeFiles(path) {
  const root = realpathSync(resolve(path));
  if (!statSync(root).isDirectory()) {
    throw new Error("file count 目標必須是目錄");
  }
  let count = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_FINGERPRINT_PARTS.has(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("file count 目標不可含 symlink");
      }
      if (metadata.isDirectory()) {
        visit(absolute);
      } else if (metadata.isFile()) {
        count += 1;
      } else {
        throw new Error("file count 目標只可含 regular file");
      }
    }
  };
  visit(root);
  return count;
}

/** Reads regular files from one immutable commit subtree. */
export function inspectCandidateCommitTree(
  repository,
  commit,
  treePath,
) {
  const safeCommit = validateCommit(commit, "candidate commit");
  const arguments_ = [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    safeCommit,
  ];
  if (treePath !== ".") {
    arguments_.push("--", treePath);
  }
  const output = runGit(repository, arguments_, {
    binary: true,
    readOnly: true,
    label: "Git candidate commit tree",
  });
  const prefix = treePath === "." ? "" : `${treePath}/`;
  const files = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) {
      continue;
    }
    if (index === start) {
      start = index + 1;
      continue;
    }
    const entry = output.subarray(start, index);
    start = index + 1;
    const separator = entry.indexOf(9);
    if (separator <= 0) {
      throw new Error("candidate commit tree entry 不合法");
    }
    const metadata = entry
      .subarray(0, separator)
      .toString("ascii")
      .split(" ");
    if (metadata.length !== 3) {
      throw new Error("candidate commit tree metadata 不合法");
    }
    const [mode, type, objectId] = metadata;
    let fullPath;
    try {
      fullPath = UTF8_DECODER.decode(entry.subarray(separator + 1));
    } catch (error) {
      throw new Error("candidate commit tree 路徑不是 UTF-8", {
        cause: error,
      });
    }
    if (
      (prefix !== "" && !fullPath.startsWith(prefix)) ||
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      !COMMIT_PATTERN.test(objectId)
    ) {
      throw new Error(
        `candidate commit tree 含非 regular file：${fullPath}`,
      );
    }
    const relativePath =
      prefix === "" ? fullPath : fullPath.slice(prefix.length);
    if (
      relativePath.length === 0 ||
      relativePath.split("/").some(
        (part) =>
          part.length === 0 ||
          part === "." ||
          part === "..",
      )
    ) {
      throw new Error("candidate commit tree 路徑不合法");
    }
    if (
      relativePath.split("/").some(
        (part) => IGNORED_FINGERPRINT_PARTS.has(part),
      )
    ) {
      continue;
    }
    const content = runGit(
      repository,
      ["cat-file", "blob", objectId],
      {
        binary: true,
        readOnly: true,
        label: "Git candidate commit blob",
      },
    );
    files.push({
      mode,
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  files.sort((first, second) => compareUtf8(first.path, second.path));
  return {
    fingerprint: fingerprintTreeEntries(files),
    file_count: files.length,
    file_sha256: Object.fromEntries(
      files.map((file) => [file.path, file.sha256]),
    ),
    file_modes: Object.fromEntries(
      files.map((file) => [file.path, file.mode]),
    ),
  };
}

/** Reads and validates one Skill name from repository-relative frontmatter. */
export function readCandidateSkillName(candidateRoot, skillPath) {
  const content = readCandidateRegularFile(
    resolveCandidatePath(candidateRoot, skillPath),
    "SKILL.md",
  ).toString("utf8");
  const frontmatter = content.match(
    /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u,
  );
  const names = [
    ...(frontmatter?.groups?.body ?? "").matchAll(
      /^name:\s*(?<name>[^\r\n#]+?)\s*$/gmu,
    ),
  ].map((match) => match.groups.name.trim());
  if (
    names.length !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(names[0])
  ) {
    throw new Error(
      "candidate SKILL.md 必須有唯一且合法的 frontmatter name",
    );
  }
  return names[0];
}

/** Reads one exact regular file from an immutable candidate commit. */
export function readCandidateCommitRegularFile(
  repository,
  commit,
  relativePath,
) {
  const safeCommit = validateCommit(commit, "candidate commit");
  const output = runGit(
    repository,
    [
      "ls-tree",
      "-z",
      "--full-tree",
      safeCommit,
      "--",
      relativePath,
    ],
    {
      binary: true,
      readOnly: true,
      label: "Git candidate commit file",
    },
  );
  if (
    output.length < 2 ||
    output[output.length - 1] !== 0 ||
    output.subarray(0, output.length - 1).includes(0)
  ) {
    throw new Error(
      `candidate commit 缺少 exact regular file：${relativePath}`,
    );
  }
  const entry = output.subarray(0, output.length - 1);
  const separator = entry.indexOf(9);
  const metadata = entry
    .subarray(0, separator)
    .toString("ascii")
    .split(" ");
  let fullPath;
  try {
    fullPath = UTF8_DECODER.decode(entry.subarray(separator + 1));
  } catch (error) {
    throw new Error("candidate commit file 路徑不是 UTF-8", {
      cause: error,
    });
  }
  if (
    separator <= 0 ||
    metadata.length !== 3 ||
    !["100644", "100755"].includes(metadata[0]) ||
    metadata[1] !== "blob" ||
    !COMMIT_PATTERN.test(metadata[2]) ||
    fullPath !== relativePath
  ) {
    throw new Error(
      `candidate commit file 不是 regular file：${relativePath}`,
    );
  }
  return runGit(
    repository,
    ["cat-file", "blob", metadata[2]],
    {
      binary: true,
      readOnly: true,
      label: "Git candidate commit file",
    },
  );
}

/** Reads one in-tree regular file without following symlinks. */
export function readCandidateRegularFile(root, relativePath) {
  const candidateRoot = realpathSync(resolve(root));
  const target = resolve(candidateRoot, relativePath);
  if (resolveCandidatePath(candidateRoot, relativePath) !== target) {
    throw new Error(`candidate file 路徑包含 symlink：${relativePath}`);
  }
  const rel = relative(candidateRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`candidate file 路徑不合法：${relativePath}`);
  }
  let cursor = candidateRoot;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`candidate file 路徑包含 symlink：${relativePath}`);
    }
  }
  const before = lstatSync(target);
  if (!before.isFile()) {
    throw new Error(`candidate file 必須是 regular file：${relativePath}`);
  }
  const descriptor = openSync(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`candidate file 開啟時已漂移：${relativePath}`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(target);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`candidate file 讀取期間已漂移：${relativePath}`);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

/** Returns true when canonical paths are equal or nested. */
function pathsOverlap(first, second) {
  const firstToSecond = relative(first, second);
  const secondToFirst = relative(second, first);
  const nested = (value) =>
    value === "" ||
    (value !== ".." &&
      !value.startsWith(`..${sep}`) &&
      !isAbsolute(value));
  return nested(firstToSecond) || nested(secondToFirst);
}

/** Validates distinct installed, source, and candidate canonical paths. */
export function validateIsolatedPaths({
  installedPath,
  sourcePath,
  candidatePath,
}) {
  const paths = {
    installed: realpathSync(resolve(installedPath)),
    source: realpathSync(resolve(sourcePath)),
    candidate: resolveLoosePath(resolve(candidatePath)),
  };
  const names = Object.keys(paths);
  for (let index = 0; index < names.length; index += 1) {
    for (let other = index + 1; other < names.length; other += 1) {
      if (pathsOverlap(paths[names[index]], paths[names[other]])) {
        throw new Error(
          `${names[index]} 與 ${names[other]} canonical path 不可重疊`,
        );
      }
    }
  }
  return paths;
}

/** Validates a candidate branch name. */
function validateBranchName(branchName) {
  if (
    typeof branchName !== "string" ||
    !BRANCH_PATTERN.test(branchName) ||
    branchName.includes("..") ||
    branchName.includes("@{") ||
    branchName.endsWith(".") ||
    branchName.endsWith("/") ||
    branchName.startsWith("-")
  ) {
    throw new Error("候選 branch 格式不合法");
  }
  return branchName;
}

/** Parses and validates all tracked tree entries before materialization. */
function listSafeTreeEntries(source, headCommit) {
  const output = runGit(
    source,
    ["ls-tree", "-r", "-z", "--full-tree", headCommit],
    { binary: true, label: "Git isolation command" },
  );
  const entries = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) {
      continue;
    }
    if (index === start) {
      start = index + 1;
      continue;
    }
    const raw = output.subarray(start, index);
    const tab = raw.indexOf(9);
    if (tab < 0) {
      throw new Error("source tree entry 格式不合法");
    }
    const metadata = raw.subarray(0, tab).toString("ascii").split(" ");
    if (metadata.length !== 3) {
      throw new Error("source tree metadata 格式不合法");
    }
    const [mode, objectType, objectId] = metadata;
    let path;
    try {
      path = UTF8_DECODER.decode(raw.subarray(tab + 1));
    } catch (error) {
      throw new Error("source tree 路徑不是 UTF-8", { cause: error });
    }
    if (mode === "120000") {
      throw new Error(
        `source tree 含 symbolic link，隔離候選拒絕展開：${path}`,
      );
    }
    if (mode === "160000" || objectType === "commit") {
      throw new Error(
        `source tree 含未展開 submodule，隔離候選拒絕建立：${path}`,
      );
    }
    if (objectType !== "blob") {
      throw new Error(`source tree entry 類型不安全：${path}`);
    }
    entries.push({ mode, objectId, path });
    start = index + 1;
  }
  return entries;
}

/** Materializes reviewed Git blobs without checkout filters or archive tools. */
function materializeTree(source, headCommit, candidate) {
  for (const entry of listSafeTreeEntries(source, headCommit)) {
    const target = resolveCandidatePath(candidate, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    const payload = runGit(source, ["cat-file", "blob", entry.objectId], {
      binary: true,
      label: "Git isolation command",
    });
    writeFileSync(target, payload, { flag: "wx" });
    const executable = entry.mode.endsWith("755");
    chmodSync(target, executable ? 0o755 : 0o644);
  }
}

/** Creates an isolated clean candidate without executing repository programs. */
export function createIsolatedCandidate({
  installedPath,
  expectedInstalledFingerprint,
  sourcePath,
  candidateRoot,
  candidateName,
  branchName,
  baseRef,
  repository,
  runId,
  binding,
  relationship,
  processArtifactPrefixes = [],
  optimizations,
  approval,
}) {
  if (
    typeof expectedInstalledFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(expectedInstalledFingerprint)
  ) {
    throw new Error("installed fingerprint 格式不合法");
  }
  validateDocument("binding", binding);
  if (
    binding.source_repository !== repository ||
    binding.installed_fingerprint !== expectedInstalledFingerprint ||
    binding.remote_verified !== true ||
    binding.relationship !== relationship ||
    !["managed", "contribute"].includes(relationship)
  ) {
    throw new Error("binding、remote 或 relationship 尚未確認，不可建立候選");
  }
  const safeBranch = validateBranchName(branchName);
  const root = realpathSync(resolve(candidateRoot));
  const candidate = resolveCandidatePath(root, candidateName);
  const paths = validateIsolatedPaths({
    installedPath,
    sourcePath,
    candidatePath: candidate,
  });
  if (existsSync(candidate)) {
    throw new Error(`candidate 已存在：${candidateName}`);
  }
  const currentFingerprint = fingerprintTree(paths.installed);
  if (currentFingerprint !== expectedInstalledFingerprint) {
    throw new Error("installed Skill 已改變，必須重新確認 binding");
  }
  const snapshot = buildRepositorySnapshot(paths.source, {
    baseRef,
    processArtifactPrefixes,
  });
  verifyApproval(approval, optimizations, {
    runId,
    bindingId: binding.binding_id,
    relationship,
    repository,
    headCommit: snapshot.head_commit,
    diffHash: snapshot.diff_hash,
    processArtifactPrefixes,
  });
  listSafeTreeEntries(paths.source, snapshot.head_commit);

  runGit(
    root,
    [
      "clone",
      "--no-checkout",
      "--no-local",
      "--",
      paths.source,
      candidate,
    ],
    { label: "Git isolation command" },
  );
  runGit(
    candidate,
    ["branch", "--", safeBranch, snapshot.head_commit],
    { label: "Git isolation command" },
  );
  runGit(
    candidate,
    ["symbolic-ref", "HEAD", `refs/heads/${safeBranch}`],
    { label: "Git isolation command" },
  );
  runGit(candidate, ["reset", "--mixed", snapshot.head_commit], {
    label: "Git isolation command",
  });
  materializeTree(paths.source, snapshot.head_commit, candidate);
  const status = runGit(candidate, ["status", "--porcelain"], {
    label: "Git isolation command",
  }).trim();
  if (status.length > 0) {
    throw new Error("隔離候選建立後並非 clean 狀態");
  }
  return {
    schema_version: 1,
    candidate_path: candidate,
    branch: safeBranch,
    repository_snapshot: snapshot,
    approved_opt_ids: approval.approved_opt_ids,
    installed_fingerprint: currentFingerprint,
    isolated: true,
  };
}

/** Validates one-to-many changed-file to accepted-OPT mappings. */
function validateFileMapping(changedFiles, approvedOptIds, fileOptMap) {
  if (
    !Array.isArray(approvedOptIds) ||
    approvedOptIds.length === 0 ||
    new Set(approvedOptIds).size !== approvedOptIds.length
  ) {
    throw new Error("approved_opt_ids 必須非空且不可重複");
  }
  if (!isObject(fileOptMap)) {
    throw new Error("file_opt_map 必須是 object");
  }
  const changed = new Set(changedFiles);
  const mapped = new Set(Object.keys(fileOptMap));
  const missing = [...changed].filter((path) => !mapped.has(path)).sort();
  const extra = [...mapped].filter((path) => !changed.has(path)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`缺少 ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      details.push(`多出 ${extra.join(", ")}`);
    }
    throw new Error(`候選 Diff 未完整映射：${details.join("；")}`);
  }
  const approved = new Set(approvedOptIds);
  const normalized = {};
  for (const path of changedFiles) {
    const optIds = [...fileOptMap[path]];
    if (optIds.length === 0 || new Set(optIds).size !== optIds.length) {
      throw new Error(`${path} 的 OPT-* 映射必須非空且不可重複`);
    }
    const unknown = [...new Set(optIds)]
      .filter((id) => !approved.has(id))
      .sort();
    if (unknown.length > 0) {
      throw new Error(`${path} 映射未核准 OPT：${unknown.join(", ")}`);
    }
    normalized[path] = optIds;
  }
  const mappedOptimizationIds = new Set(Object.values(normalized).flat());
  const unmappedOptimizations = [...approved]
    .filter((id) => !mappedOptimizationIds.has(id))
    .sort();
  if (unmappedOptimizations.length > 0) {
    throw new Error(
      `核准 OPT 未對應任何候選檔案：${unmappedOptimizations.join(", ")}`,
    );
  }
  return normalized;
}

export { validateCandidateProcessArtifacts } from "./core.mjs";

/** Reads the exact committed, staged, unstaged, and untracked candidate state. */
function readCandidateDiffState(candidate, repositorySnapshot) {
  const range = `${repositorySnapshot.merge_base}..${repositorySnapshot.head_commit}`;
  const digest = createHash("sha256");
  const diffCommands = [
    [
      "committed",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        range,
      ],
    ],
    [
      "staged",
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
      ],
    ],
    [
      "unstaged",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
      ],
    ],
  ];
  for (const [label, command] of diffCommands) {
    updateComponent(
      digest,
      label,
      runGit(candidate, command, {
        binary: true,
        readOnly: true,
        label: "Git candidate command",
      }),
    );
  }
  const pathCommands = [
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      range,
    ],
    ["diff", "--cached", "--name-only", "-z"],
    ["diff", "--name-only", "-z"],
  ];
  const changedFiles = new Set();
  for (const command of pathCommands) {
    for (const path of parseNulPaths(
      runGit(candidate, command, {
        binary: true,
        readOnly: true,
        label: "Git candidate command",
      }),
    )) {
      changedFiles.add(path);
    }
  }
  const untracked = parseNulPaths(
    runGit(
      candidate,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        binary: true,
        readOnly: true,
        label: "Git candidate command",
      },
    ),
  ).sort();
  for (const path of untracked) {
    const target = resolveCandidatePath(candidate, path);
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`untracked entry 類型不安全：${path}`);
    }
    updateComponent(digest, `untracked:${path}`, readFileSync(target));
    changedFiles.add(path);
  }
  const sortedFiles = [...changedFiles].sort();
  return {
    candidateDiffHash: digest.digest("hex"),
    changedFiles: sortedFiles,
    untrackedFiles: untracked,
  };
}

/** Builds a candidate snapshot across committed, staged, unstaged, and untracked changes. */
export function buildCandidateSnapshot({
  candidatePath,
  installedPath,
  sourcePath,
  skillPath,
  targetSkill,
  targetSkillPath,
  evaluationFixturePath,
  baseRef,
  approvedOptIds,
  fileOptMap,
  processArtifactPrefixes = [],
}) {
  const paths = validateIsolatedPaths({
    installedPath,
    sourcePath,
    candidatePath,
  });
  const candidate = paths.candidate;
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error("candidate 必須是已存在的隔離 Git 目錄");
  }
  const repositorySnapshot = buildRepositorySnapshot(candidate, {
    baseRef,
    processArtifactPrefixes,
  });
  const candidateState = readCandidateDiffState(
    candidate,
    repositorySnapshot,
  );
  if (typeof skillPath !== "string" || skillPath.trim().length === 0) {
    throw new Error("candidate Skill 路徑不可為空");
  }
  const candidateSkill = resolveCandidatePath(candidate, skillPath);
  if (
    !existsSync(candidateSkill) ||
    !statSync(candidateSkill).isDirectory() ||
    !existsSync(join(candidateSkill, "SKILL.md")) ||
    !statSync(join(candidateSkill, "SKILL.md")).isFile()
  ) {
    throw new Error("candidate Skill 路徑必須是含 SKILL.md 的目錄");
  }
  const normalizedSkillPath =
    relative(candidate, candidateSkill).split(sep).join("/") || ".";
  if (
    typeof targetSkillPath !== "string" ||
    targetSkillPath !== normalizedSkillPath
  ) {
    throw new Error("candidate Skill 路徑與已確認 target 不一致");
  }
  const skillName = readCandidateSkillName(
    candidate,
    normalizedSkillPath,
  );
  if (
    typeof targetSkill !== "string" ||
    targetSkill !== skillName
  ) {
    throw new Error("candidate SKILL.md name 與已確認 target 不一致");
  }
  let evaluationFixture = {};
  if (evaluationFixturePath !== undefined) {
    const fixtureContent = readCandidateRegularFile(
      candidate,
      evaluationFixturePath,
    );
    const normalizedFixturePath = relative(
      candidate,
      resolveCandidatePath(candidate, evaluationFixturePath),
    ).split(sep).join("/");
    try {
      const parsed = JSON.parse(fixtureContent.toString("utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("fixture 必須是 JSON object");
      }
    } catch (error) {
      throw new Error("evaluation fixture 必須是有效 JSON object", {
        cause: error,
      });
    }
    evaluationFixture = {
      evaluation_fixture_path: normalizedFixturePath,
      evaluation_fixture_sha256: createHash("sha256")
        .update(fixtureContent)
        .digest("hex"),
    };
  }
  const sortedFiles = candidateState.changedFiles;
  validateCandidateProcessArtifacts(sortedFiles, {
    excludedPrefixes: processArtifactPrefixes,
  });
  const approved = [...approvedOptIds];
  const snapshot = {
    schema_version: 1,
    repository_snapshot: repositorySnapshot,
    candidate_diff_hash: candidateState.candidateDiffHash,
    skill_path: normalizedSkillPath,
    skill_name: skillName,
    candidate_skill_fingerprint: fingerprintTree(candidateSkill),
    ...evaluationFixture,
    changed_files: sortedFiles,
    approved_opt_ids: approved,
    process_artifact_prefixes: clone(processArtifactPrefixes),
    file_opt_map: validateFileMapping(
      sortedFiles,
      approved,
      fileOptMap,
    ),
    diff_mapping_complete: true,
    isolated: true,
  };
  validateDocument("candidate-snapshot", snapshot);
  return snapshot;
}

/** Revalidates a clean candidate checkout against one persisted snapshot. */
export function validateCandidateCheckoutForCleanup(
  candidatePath,
  candidateSnapshot,
) {
  const expected = validateCandidateSnapshotContract(candidateSnapshot);
  const candidate = realpathSync(resolve(candidatePath));
  const repositoryPrefix = runGit(
    candidate,
    ["rev-parse", "--show-prefix"],
    { readOnly: true, label: "Git cleanup preflight" },
  ).trim();
  if (repositoryPrefix !== "") {
    throw new Error("cleanup candidate 必須指向 Git 根目錄");
  }
  const status = runGit(
    candidate,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    {
      binary: true,
      readOnly: true,
      label: "Git cleanup preflight",
    },
  );
  if (status.length > 0) {
    throw new Error("cleanup candidate 已漂移或尚未提交");
  }
  const currentRepository = buildRepositorySnapshot(candidate, {
    baseRef: expected.repository_snapshot.base_ref,
    processArtifactPrefixes: expected.process_artifact_prefixes,
  });
  const currentDiff = readCandidateDiffState(candidate, currentRepository);
  if (
    canonicalJson(currentRepository) !==
      canonicalJson(expected.repository_snapshot) ||
    currentDiff.candidateDiffHash !== expected.candidate_diff_hash ||
    canonicalJson(currentDiff.changedFiles) !==
      canonicalJson(expected.changed_files)
  ) {
    throw new Error("cleanup candidate snapshot 已漂移");
  }
  return {
    candidate_path: candidate,
    repository_snapshot: currentRepository,
    candidate_diff_hash: currentDiff.candidateDiffHash,
  };
}

/** Revalidates a clean candidate before reserving a remote push attempt. */
export function validateBranchPushCandidate(
  candidatePath,
  candidateSnapshot,
  {
    candidatePathFingerprint,
    branch,
  },
) {
  const candidateContract =
    validateCandidateSnapshotContract(candidateSnapshot);
  const candidate = realpathSync(resolve(candidatePath));
  if (fingerprintCandidatePath(candidate) !== candidatePathFingerprint) {
    throw new Error("candidate canonical path fingerprint 已漂移");
  }
  const repositoryPrefix = runGit(
    candidate,
    ["rev-parse", "--show-prefix"],
    {
      readOnly: true,
      label: "Git candidate preflight",
    },
  ).trim();
  if (repositoryPrefix !== "") {
    throw new Error("candidate 必須指向 Git 根目錄");
  }
  const safeBranch = validateBranchName(branch);
  const currentBranch = runGit(
    candidate,
    ["branch", "--show-current"],
    { readOnly: true, label: "Git candidate preflight" },
  ).trim();
  if (currentBranch !== safeBranch) {
    throw new Error("candidate branch 已漂移");
  }
  const headCommit = runGit(candidate, ["rev-parse", "HEAD"], {
    readOnly: true,
    label: "Git candidate preflight",
  }).trim();
  if (
    headCommit !== candidateContract.repository_snapshot.head_commit
  ) {
    throw new Error("candidate HEAD 已漂移");
  }
  const status = runGit(candidate, ["status", "--porcelain", "-z"], {
    binary: true,
    readOnly: true,
    label: "Git candidate preflight",
  });
  if (status.length > 0) {
    throw new Error("candidate 必須先提交所有核准變更");
  }
  const repositorySnapshot = buildRepositorySnapshot(candidate, {
    baseRef: candidateContract.repository_snapshot.base_ref,
    processArtifactPrefixes:
      candidateContract.repository_snapshot.process_artifact_prefixes,
  });
  if (
    canonicalJson(repositorySnapshot) !==
    canonicalJson(candidateContract.repository_snapshot)
  ) {
    throw new Error("candidate repository snapshot 已漂移");
  }
  const candidateState = readCandidateDiffState(
    candidate,
    repositorySnapshot,
  );
  if (
    candidateState.candidateDiffHash !==
      candidateContract.candidate_diff_hash ||
    canonicalJson(candidateState.changedFiles) !==
      canonicalJson(candidateContract.changed_files)
  ) {
    throw new Error("candidate Diff 已漂移");
  }
  if (
    candidateContract.skill_path === undefined ||
    candidateContract.skill_name === undefined ||
    candidateContract.candidate_skill_fingerprint === undefined
  ) {
    throw new Error(
      "branch push candidate 缺少 Skill fingerprint 綁定",
    );
  }
  const candidateSkill = resolveCandidatePath(
    candidate,
    candidateContract.skill_path,
  );
  if (
    !existsSync(candidateSkill) ||
    !statSync(candidateSkill).isDirectory() ||
    fingerprintTree(candidateSkill) !==
      candidateContract.candidate_skill_fingerprint ||
    readCandidateSkillName(candidate, candidateContract.skill_path) !==
      candidateContract.skill_name
  ) {
    throw new Error("candidate Skill fingerprint 已漂移");
  }
  const committedSkill = inspectCandidateCommitTree(
    candidate,
    headCommit,
    candidateContract.skill_path,
  );
  if (
    committedSkill.fingerprint !==
      candidateContract.candidate_skill_fingerprint ||
    committedSkill.file_count !== countTreeFiles(candidateSkill)
  ) {
    throw new Error(
      "candidate HEAD Skill fingerprint 與 snapshot 不一致",
    );
  }
  if (
    candidateContract.evaluation_fixture_path === undefined ||
    candidateContract.evaluation_fixture_sha256 === undefined
  ) {
    throw new Error("branch push candidate 缺少 fixture 綁定");
  }
  const committedFixture = readCandidateCommitRegularFile(
    candidate,
    headCommit,
    candidateContract.evaluation_fixture_path,
  );
  if (
    createHash("sha256").update(committedFixture).digest("hex") !==
    candidateContract.evaluation_fixture_sha256
  ) {
    throw new Error(
      "candidate HEAD fixture SHA-256 與 snapshot 不一致",
    );
  }
  let fixtureDocument;
  try {
    fixtureDocument = JSON.parse(committedFixture.toString("utf8"));
  } catch (error) {
    throw new Error("candidate HEAD fixture 不是有效 JSON", {
      cause: error,
    });
  }
  const targetPaths = fixtureDocument?.target_files?.paths;
  const targetHashes =
    fixtureDocument?.target_files?.candidate_sha256;
  if (
    !Array.isArray(targetPaths) ||
    targetPaths.length === 0 ||
    fixtureDocument?.runtime_bundle?.candidate_file_count !==
      committedSkill.file_count ||
    targetPaths.some(
      (path) =>
        committedSkill.file_sha256[path] !== targetHashes?.[path],
    )
  ) {
    throw new Error(
      "candidate HEAD Skill target hashes 與 fixture 不一致",
    );
  }
  return {
    candidate_path: candidate,
    candidate_path_fingerprint: candidatePathFingerprint,
    branch: safeBranch,
    head_commit: headCommit,
    candidate_diff_hash: candidateState.candidateDiffHash,
  };
}

/** Validates one immutable GitHub HTTPS remote and branch target. */
function validateGithubRemoteTarget(remoteUrl, branch) {
  if (
    typeof remoteUrl !== "string" ||
    !GITHUB_HTTPS_REMOTE.test(remoteUrl)
  ) {
    throw new Error("GitHub HTTPS remote 格式不合法");
  }
  return validateBranchName(branch);
}

/** Reads one exact GitHub branch ref without using repository remote config. */
export function readGithubRemoteBranch(
  repository,
  {
    remoteUrl,
    branch,
    gitConfigGlobal,
    runner = runGit,
  },
) {
  const safeBranch = validateGithubRemoteTarget(remoteUrl, branch);
  const output = runner(
    repository,
    [
      "ls-remote",
      "--heads",
      "--",
      remoteUrl,
      `refs/heads/${safeBranch}`,
    ],
    {
      readOnly: true,
      label: "Git remote branch read",
      gitConfigGlobal,
    },
  ).trim();
  if (output.length === 0) {
    return null;
  }
  const lines = output.split(/\r?\n/u);
  if (lines.length !== 1) {
    throw new Error("Git remote branch 回傳多個 ref");
  }
  const [commit, ref, ...extra] = lines[0].split(/\s+/u);
  if (
    extra.length > 0 ||
    !COMMIT_PATTERN.test(commit) ||
    ref !== `refs/heads/${safeBranch}`
  ) {
    throw new Error("Git remote branch 回傳格式不合法");
  }
  return commit;
}

/** Returns whether one local commit is an ancestor of another. */
export function isCommitAncestor(
  repository,
  ancestor,
  descendant,
  { runner = runGit } = {},
) {
  if (!COMMIT_PATTERN.test(ancestor) || !COMMIT_PATTERN.test(descendant)) {
    throw new Error("Git commit 格式不合法");
  }
  const mergeBase = runner(
    repository,
    ["merge-base", ancestor, descendant],
    { readOnly: true, label: "Git fast-forward check" },
  ).trim();
  return mergeBase === ancestor;
}

/** Pushes one exact commit from an isolated transport repository. */
export function pushGithubBranch(
  repository,
  {
    remoteUrl,
    branch,
    headCommit,
    expectedRemoteCommit,
    gitConfigGlobal,
    runner = runGit,
  },
) {
  const safeBranch = validateGithubRemoteTarget(remoteUrl, branch);
  if (!COMMIT_PATTERN.test(headCommit)) {
    throw new Error("Git head commit 格式不合法");
  }
  if (
    expectedRemoteCommit !== null &&
    (typeof expectedRemoteCommit !== "string" ||
      !COMMIT_PATTERN.test(expectedRemoteCommit))
  ) {
    throw new Error("Git expected remote commit 格式不合法");
  }
  runner(
    repository,
    ["cat-file", "-e", `${headCommit}^{commit}`],
    {
      readOnly: true,
      label: "Git push object preflight",
      gitConfigGlobal,
    },
  );
  const destination = `refs/heads/${safeBranch}`;
  const output = runner(
    repository,
    [
      "push",
      "--porcelain",
      `--force-with-lease=${destination}:${expectedRemoteCommit ?? ""}`,
      "--",
      remoteUrl,
      `${headCommit}:${destination}`,
    ],
    {
      label: "Git branch push",
      gitConfigGlobal,
    },
  );
  if (/^\+\t.*forced update/imu.test(output)) {
    throw new Error("Git branch push 出現未允許的 forced update");
  }
  return output;
}

/** Extracts PR identifiers from common merge and squash subjects. */
function pullRequestsFromSubject(subject) {
  const numbers = new Set();
  for (const pattern of PULL_REQUEST_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of subject.matchAll(pattern)) {
      numbers.add(Number(match.groups.number));
    }
  }
  return [...numbers].sort((first, second) => first - second);
}

/** Builds the complete previous-tag-to-candidate release inventory. */
export function buildReleaseChangeInventory(
  repository,
  { previousRef, candidateRef },
) {
  const repositoryPath = realpathSync(resolve(repository));
  const safePreviousRef = validateRef(previousRef, "previous_ref");
  const safeCandidateRef = validateRef(candidateRef, "candidate_ref");
  const previousCommit = runGit(
    repositoryPath,
    ["rev-parse", `${safePreviousRef}^{commit}`],
    { readOnly: true, label: "Git release inventory" },
  ).trim();
  const candidateCommit = runGit(
    repositoryPath,
    ["rev-parse", `${safeCandidateRef}^{commit}`],
    { readOnly: true, label: "Git release inventory" },
  ).trim();
  const mergeBase = runGit(
    repositoryPath,
    ["merge-base", previousCommit, candidateCommit],
    { readOnly: true, label: "Git release inventory" },
  ).trim();
  if (mergeBase !== previousCommit) {
    throw new Error("previous_ref 不是 candidate_ref 的祖先");
  }
  const log = runGit(
    repositoryPath,
    [
      "log",
      "--reverse",
      "--format=%H%x09%s",
      `${previousCommit}..${candidateCommit}`,
    ],
    { readOnly: true, label: "Git release inventory" },
  );
  const pullRequests = new Set();
  const commits = log
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab <= 0 || tab === line.length - 1) {
        throw new Error("Git log 含無法解析的提交");
      }
      const commit = line.slice(0, tab);
      const subject = line.slice(tab + 1);
      const prs = pullRequestsFromSubject(subject);
      prs.forEach((number) => pullRequests.add(number));
      return { commit, subject, pull_requests: prs };
    });
  if (commits.length === 0) {
    throw new Error("候選版本相對上一版本沒有新提交");
  }
  return {
    schema_version: 1,
    previous_ref: safePreviousRef,
    previous_commit: previousCommit,
    candidate_ref: safeCandidateRef,
    candidate_commit: candidateCommit,
    commits,
    pull_requests: [...pullRequests].sort((first, second) => first - second),
  };
}

/** Validates a unique list of non-empty strings. */
function validateStringList(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} 必須是字串組成的 array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} 不可包含重複項目`);
  }
  return [...value];
}

/** Validates a unique list of positive PR numbers. */
function validatePrList(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isInteger(item) || item <= 0)
  ) {
    throw new Error(`${label} 必須是正整數組成的 array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} 不可包含重複項目`);
  }
  return [...value];
}

/** Evaluates release-note coverage across commits, PRs, and accepted OPT records. */
export function evaluateReleaseNoteCoverage(
  inventory,
  { mappings, requiredOptimizationIds },
) {
  if (!isObject(inventory)) {
    throw new Error("release inventory 必須是 object");
  }
  if (!Array.isArray(inventory.commits) || inventory.commits.length === 0) {
    throw new Error("release inventory commits 不可為空");
  }
  for (const name of ["candidate_commit", "previous_commit"]) {
    if (typeof inventory[name] !== "string" || inventory[name].length === 0) {
      throw new Error(`release inventory ${name} 不可為空`);
    }
  }
  const expectedCommits = inventory.commits.map((item) => {
    if (!isObject(item) || typeof item.commit !== "string" || !item.commit) {
      throw new Error("release inventory commit ID 不可為空");
    }
    return item.commit;
  });
  const expectedPrs = validatePrList(
    inventory.pull_requests,
    "release inventory pull_requests",
  );
  const requiredOptimizations = new Set(requiredOptimizationIds);
  if (
    [...requiredOptimizations].some(
      (item) => typeof item !== "string" || !item.startsWith("OPT-"),
    )
  ) {
    throw new Error("required_optimization_ids 必須使用 OPT-* ID");
  }

  const coveredCommits = [];
  const coveredPrs = [];
  const coveredOptimizations = [];
  const validatedMappings = [];
  const seenIds = new Set();
  for (const mapping of mappings) {
    if (!isObject(mapping)) {
      throw new Error("release note mapping 必須是 object");
    }
    const missing = [...RELEASE_MAPPING_FIELDS]
      .filter((name) => !Object.hasOwn(mapping, name))
      .sort();
    const unknown = Object.keys(mapping)
      .filter((name) => !RELEASE_MAPPING_FIELDS.has(name))
      .sort();
    if (missing.length > 0) {
      throw new Error(`release note mapping 缺少欄位：${missing.join(", ")}`);
    }
    if (unknown.length > 0) {
      throw new Error(`release note mapping 含未知欄位：${unknown.join(", ")}`);
    }
    if (
      typeof mapping.id !== "string" ||
      !mapping.id.startsWith("NOTE-") ||
      seenIds.has(mapping.id)
    ) {
      throw new Error("release note mapping ID 必須是唯一 NOTE-*");
    }
    seenIds.add(mapping.id);
    if (!["included", "excluded"].includes(mapping.disposition)) {
      throw new Error("release note disposition 不合法");
    }
    if (
      typeof mapping.note !== "string" ||
      typeof mapping.reason !== "string"
    ) {
      throw new Error("release note 與 reason 必須是 string");
    }
    if (mapping.disposition === "included" && !mapping.note.trim()) {
      throw new Error("included release note 不可為空");
    }
    if (mapping.disposition === "excluded" && !mapping.reason.trim()) {
      throw new Error("excluded release note 必須說明理由");
    }
    const sourceCommits = validateStringList(
      mapping.source_commits,
      "source_commits",
    );
    const sourcePrs = validatePrList(mapping.source_prs, "source_prs");
    const optimizationIds = validateStringList(
      mapping.optimization_ids,
      "optimization_ids",
    );
    if (
      sourceCommits.length === 0 &&
      sourcePrs.length === 0 &&
      optimizationIds.length === 0
    ) {
      throw new Error("release note mapping 至少需要一個來源");
    }
    if (sourceCommits.some((item) => !expectedCommits.includes(item))) {
      throw new Error("release note mapping 引用範圍外提交");
    }
    if (sourcePrs.some((item) => !expectedPrs.includes(item))) {
      throw new Error("release note mapping 引用範圍外 PR");
    }
    if (optimizationIds.some((item) => !requiredOptimizations.has(item))) {
      throw new Error("release note mapping 引用非 accepted OPT");
    }
    coveredCommits.push(...sourceCommits);
    coveredPrs.push(...sourcePrs);
    coveredOptimizations.push(...optimizationIds);
    validatedMappings.push(clone(mapping));
  }

  const missingItems = (expected, covered) =>
    expected.filter((item) => !new Set(covered).has(item)).sort();
  const duplicates = (items) => {
    const counts = new Map();
    items.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
    return [...counts]
      .filter(([, count]) => count > 1)
      .map(([item]) => item)
      .sort();
  };
  const result = {
    complete: false,
    previous_commit: inventory.previous_commit,
    candidate_commit: inventory.candidate_commit,
    missing_commits: missingItems(expectedCommits, coveredCommits),
    missing_prs: missingItems(expectedPrs, coveredPrs),
    missing_optimization_ids: missingItems(
      [...requiredOptimizations],
      coveredOptimizations,
    ),
    duplicate_commits: duplicates(coveredCommits),
    duplicate_prs: duplicates(coveredPrs),
    duplicate_optimization_ids: duplicates(coveredOptimizations),
    inventory: clone(inventory),
    mappings: validatedMappings,
    required_optimization_ids: [...requiredOptimizations].sort(),
  };
  result.complete = [
    result.missing_commits,
    result.missing_prs,
    result.missing_optimization_ids,
    result.duplicate_commits,
    result.duplicate_prs,
    result.duplicate_optimization_ids,
  ].every((items) => items.length === 0);
  result.proof_fingerprint = fingerprint({
    inventory: result.inventory,
    mappings: result.mappings,
    required_optimization_ids: result.required_optimization_ids,
  });
  return result;
}

/** Re-evaluates and verifies a complete persisted release-note coverage proof. */
export function verifyReleaseNoteCoverageProof(coverage) {
  if (!isObject(coverage)) {
    throw new Error("Release 說明覆蓋證明必須是 object");
  }
  for (const name of [
    "inventory",
    "mappings",
    "required_optimization_ids",
    "proof_fingerprint",
  ]) {
    if (!Object.hasOwn(coverage, name)) {
      throw new Error(`Release 說明覆蓋證明缺少：${name}`);
    }
  }
  const expected = evaluateReleaseNoteCoverage(coverage.inventory, {
    mappings: coverage.mappings,
    requiredOptimizationIds: new Set(coverage.required_optimization_ids),
  });
  if (canonicalJson(expected) !== canonicalJson(coverage)) {
    throw new Error("Release 說明覆蓋證明已被修改或不完整");
  }
  if (expected.complete !== true) {
    throw new Error("Release 說明尚未完成完整變更範圍對帳");
  }
  return clone(expected);
}
