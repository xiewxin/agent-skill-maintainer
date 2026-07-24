#!/usr/bin/env node
/**
 * Validates the public repository structure and common disclosure risks.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROVIDER_IDS,
  SCHEMA_NAMES,
  loadProviderProfiles,
  validateDocument,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_ROOT = resolve(ROOT, "skills", "agent-skill-maintainer");
const REQUIRED_FILES = Object.freeze([
  ".gitattributes",
  "LICENSE",
  "AGENTS.md",
  "README.md",
  "README.zh-TW.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "package.json",
  ".agents/architecture.md",
  ".agents/documentation.md",
  ".agents/releasing.md",
  ".agents/adr/0001-node-runtime.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/skill-feedback.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/workflows/validation.yml",
  "evals/evidence/preview-v0.1.0.json",
  "skills/agent-skill-maintainer/assets/schemas/blinded-forward-aggregate.schema.json",
  "skills/agent-skill-maintainer/SKILL.md",
  "skills/agent-skill-maintainer/agents/openai.yaml",
  "skills/agent-skill-maintainer/scripts/maintainer.mjs",
]);
const EXCLUDED_PARTS = new Set([
  ".git",
  "node_modules",
]);
const PROCESS_PREFIXES = Object.freeze([
  ["docs", "plans"],
  ["docs", "specs"],
  ["docs", "superpowers"],
  ["evals", "results"],
  ["evals", ".runs"],
  [".agent-skill-maintainer"],
  [".codex"],
  [".claude"],
  [".idea"],
  [".vscode"],
]);
const REQUIRED_IGNORE_PATTERNS = new Set([
  "docs/plans/",
  "docs/specs/",
  "docs/superpowers/",
  ".agent-skill-maintainer/",
  "evals/results/",
  "evals/.runs/",
  ".codex/",
  ".claude/",
  "node_modules/",
  "*.log",
  "*.tmp",
  ".DS_Store",
]);
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
const PRIVATE_PATH_PATTERNS = [
  /\/Users\/[^/\s]+\//u,
  /\/home\/[^/\s]+\//u,
];

/** Returns repository-relative path components. */
function relativeParts(path) {
  return relative(ROOT, path).split(sep);
}

/** Returns whether a relative path is a local-only process artifact. */
export function isProcessArtifact(relativePath) {
  const parts = relativePath.split("/");
  const name = parts.at(-1);
  if (name === ".DS_Store" || [".log", ".tmp"].includes(extname(name))) {
    return true;
  }
  return PROCESS_PREFIXES.some((prefix) =>
    prefix.every((part, index) => parts[index] === part),
  );
}

/** Walks public regular text files without following symlinks. */
function publicTextFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const parts = relativeParts(path);
      if (parts.some((part) => EXCLUDED_PARTS.has(part))) {
        continue;
      }
      const relativePath = parts.join("/");
      if (isProcessArtifact(relativePath)) {
        continue;
      }
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        files.push({ path, relativePath, content: null, symlink: true });
      } else if (metadata.isDirectory()) {
        visit(path);
      } else if (metadata.isFile()) {
        let content = null;
        try {
          content = readFileSync(path, "utf8");
        } catch {
          // Binary files are checked by the explicit public-file contracts.
        }
        files.push({ path, relativePath, content, symlink: false });
      }
    }
  };
  visit(ROOT);
  return files;
}

/** Validates versioned schemas and conservative Provider Profiles. */
export function validateStructuredAssets(skillRoot = SKILL_ROOT) {
  const errors = [];
  const schemaRoot = resolve(skillRoot, "assets", "schemas");
  for (const schemaName of SCHEMA_NAMES) {
    const path = resolve(schemaRoot, `${schemaName}.schema.json`);
    let schema;
    try {
      schema = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`invalid schema asset: ${schemaName}.schema.json: ${error.message}`);
      continue;
    }
    if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      errors.push(`unsupported schema draft: ${schemaName}.schema.json`);
    }
    const version = schema?.properties?.schema_version?.const;
    if (!Number.isInteger(version) || version <= 0) {
      errors.push(`missing schema_version const: ${schemaName}.schema.json`);
    }
    if (!(schema?.required ?? []).includes("schema_version")) {
      errors.push(`schema_version must be required: ${schemaName}.schema.json`);
    }
  }
  let profiles;
  try {
    profiles = loadProviderProfiles(resolve(skillRoot, "assets", "providers"));
  } catch (error) {
    errors.push(`invalid Provider Profile: ${error.message}`);
    return errors;
  }
  if (
    JSON.stringify(Object.keys(profiles).sort()) !==
    JSON.stringify([...PROVIDER_IDS].sort())
  ) {
    errors.push("Provider Profile catalog is incomplete");
  }
  for (const [providerId, profile] of Object.entries(profiles)) {
    if (profile.tested_versions.length > 0 && !profile.last_verified_at) {
      errors.push(`tested Provider Profile lacks last_verified_at: ${providerId}`);
    }
    if (profile.command_policy?.default !== "deny") {
      errors.push(`Provider Profile command policy must default deny: ${providerId}`);
    }
  }
  return errors;
}

/** Returns all blockers for public publication. */
export function validatePublication() {
  const errors = validateStructuredAssets();
  for (const relativePath of REQUIRED_FILES) {
    try {
      if (!lstatSync(resolve(ROOT, relativePath)).isFile()) {
        errors.push(`missing required file: ${relativePath}`);
      }
    } catch {
      errors.push(`missing required file: ${relativePath}`);
    }
  }
  let ignorePatterns = new Set();
  try {
    ignorePatterns = new Set(
      readFileSync(resolve(ROOT, ".gitignore"), "utf8").split(/\r?\n/u),
    );
  } catch {
    errors.push(".gitignore is required");
  }
  for (const pattern of [...REQUIRED_IGNORE_PATTERNS].sort()) {
    if (!ignorePatterns.has(pattern)) {
      errors.push(`process artifact pattern must be ignored: ${pattern}`);
    }
  }
  let packageDocument;
  try {
    packageDocument = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    if (
      Object.hasOwn(packageDocument, "dependencies") &&
      Object.keys(packageDocument.dependencies).length > 0
    ) {
      errors.push("runtime dependencies are not allowed");
    }
  } catch (error) {
    errors.push(`invalid package.json: ${error.message}`);
  }
  try {
    const aggregate = JSON.parse(
      readFileSync(
        resolve(ROOT, "evals", "evidence", "preview-v0.1.0.json"),
        "utf8",
      ),
    );
    validateDocument("blinded-forward-aggregate", aggregate);
  } catch (error) {
    errors.push(`invalid forward evaluation aggregate: ${error.message}`);
  }

  for (const file of publicTextFiles()) {
    if (file.symlink) {
      errors.push(`public symlink is not allowed: ${file.relativePath}`);
      continue;
    }
    if (file.content === null) {
      continue;
    }
    const isValidator = file.relativePath === "scripts/validate-publication.mjs";
    const isTest = file.relativePath.startsWith("tests/");
    if (
      !isValidator &&
      !isTest &&
      (file.content.includes("[TODO") || file.content.includes("TODO:"))
    ) {
      errors.push(`placeholder found: ${file.relativePath}`);
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(file.content)) {
        errors.push(`secret-like value found: ${file.relativePath}`);
      }
    }
    if (!isValidator && !isTest) {
      for (const pattern of PRIVATE_PATH_PATTERNS) {
        if (pattern.test(file.content)) {
          errors.push(`private absolute path found: ${file.relativePath}`);
        }
      }
    }
  }
  return errors;
}

/** Runs the publication validator. */
export function main() {
  const errors = validatePublication();
  if (errors.length > 0) {
    process.stdout.write(`${errors.join("\n")}\n`);
    return 1;
  }
  process.stdout.write("publication validation passed\n");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
