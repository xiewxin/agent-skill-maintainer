/**
 * Versioned contracts and deterministic, side-effect-free workflow helpers.
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const SCHEMA_NAMES = Object.freeze([
  "target",
  "evidence",
  "binding",
  "run-state",
  "feedback",
  "optimization",
  "approval",
  "provider-profile",
  "provider-validation-aggregate",
  "provider-selection",
  "repository-snapshot",
  "candidate-snapshot",
  "fork-proof",
  "fork-forward-aggregate",
  "branch-push-proof",
  "validation",
  "pr-proof",
  "merge-proof",
  "publication-proof",
  "update-proof",
  "local-update-preview",
  "local-update-approval",
  "local-update-reconciliation",
  "local-update-forward-aggregate",
  "documentation-impact",
  "github-action-approval",
  "github-action-reconciliation",
  "blinded-forward-aggregate",
]);

export const PROVIDER_IDS = Object.freeze([
  "superpowers",
  "spec-kit",
  "openspec",
  "bmad",
  "matt-pocock-skills",
  "gsd",
  "skill-creator",
  "agents-doc-maintainer",
]);
export const FORMAL_PROVIDER_IDS = Object.freeze([
  "superpowers",
  "spec-kit",
  "openspec",
  "bmad",
  "matt-pocock-skills",
]);
export const LEGACY_PROVIDER_IDS = Object.freeze(["gsd"]);

const SCHEMA_ROOT = fileURLToPath(
  new URL("../../assets/schemas/", import.meta.url),
);
const PROVIDER_PROFILE_ROOT = fileURLToPath(
  new URL("../../assets/providers/", import.meta.url),
);
const CORE_METRICS = Object.freeze([
  "discovery",
  "ownership",
  "closure",
  "actionability",
]);
const MANAGED_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const KNOWN_PERMISSIONS = new Set([
  "read",
  "triage",
  ...MANAGED_PERMISSIONS,
]);
const REQUIRED_SETTINGS = Object.freeze([
  "ruleset_required",
  "required_checks",
  "force_push_blocked",
  "branch_deletion_blocked",
  "actions_read_only",
  "fork_secrets_blocked",
  "release_immutability",
  "private_vulnerability_reporting",
]);
const DECISION_STATUSES = new Set([
  "accepted",
  "rejected",
  "deferred",
  "needs_evidence",
]);
const CHECK_CATEGORIES = new Set([
  "safety",
  "regression",
  "forward",
  "quality",
  "platform",
  "documentation",
]);
const CHECK_STATUSES = new Set(["passed", "failed", "not-run"]);
const RELEASE_VERSION_PATTERN =
  /^v?(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)$/u;
const REQUIRED_CHECK_FIELDS = new Set([
  "id",
  "category",
  "status",
  "summary",
]);
const CHECK_FIELDS = new Set([...REQUIRED_CHECK_FIELDS, "details"]);
const HTTPS_REMOTE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const SSH_REMOTE =
  /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const UNTRUSTED_PROGRAM_SOURCES = new Set([
  "git-hook",
  "install-script",
  "test-script",
  "workflow",
  "repository-script",
]);
const MAINTAINER_PROCESS_PREFIXES = Object.freeze([
  ".agent-skill-maintainer/",
  "evals/.runs/",
  "evals/results/",
]);
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:token|password|secret)=\S+/gi,
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UNIX_PATH_PATTERN = /(^|[^\w])\/(?:Users|home|var|private|opt)\/[^\s]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s]+/g;

export class ApprovalDriftError extends Error {
  /** Indicates that approval no longer matches the active candidate state. */
  constructor(message) {
    super(message);
    this.name = "ApprovalDriftError";
  }
}

/** Returns true only for plain JSON-style objects. */
export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep-clones JSON-compatible workflow documents. */
export function clone(value) {
  return structuredClone(value);
}

/** Produces recursively sorted JSON for stable fingerprints. */
export function canonicalJson(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) {
      return item.map(canonicalize);
    }
    if (isObject(item)) {
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

/** Produces a stable SHA-256 fingerprint for a JSON-compatible value. */
export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Loads a known public JSON Schema. */
export function loadSchema(schemaName) {
  if (!SCHEMA_NAMES.includes(schemaName)) {
    throw new Error(`未知 schema：${schemaName}`);
  }
  const path = resolve(SCHEMA_ROOT, `${schemaName}.schema.json`);
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`無法載入 schema：${schemaName}`, { cause: error });
  }
  if (!isObject(document)) {
    throw new Error(`schema 必須是 JSON object：${schemaName}`);
  }
  return document;
}

/** Validates the project-supported JSON Schema subset. */
function validateValue(value, rule, path) {
  const expectedType = rule.type;
  const typeMatches = {
    array: Array.isArray(value),
    boolean: typeof value === "boolean",
    integer: Number.isInteger(value),
    null: value === null,
    number: typeof value === "number" && Number.isFinite(value),
    object: isObject(value),
    string: typeof value === "string",
  };
  if (
    typeof expectedType === "string" &&
    typeMatches[expectedType] !== true
  ) {
    throw new Error(`${path} 必須是 ${expectedType}`);
  }
  if (
    Array.isArray(expectedType) &&
    !expectedType.some((item) => typeMatches[item] === true)
  ) {
    throw new Error(`${path} 類型不合法`);
  }
  if (Object.hasOwn(rule, "const") && value !== rule.const) {
    throw new Error(`${path} 必須等於 ${JSON.stringify(rule.const)}`);
  }
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    throw new Error(`${path} 不在允許值內`);
  }
  if (typeof value === "string") {
    if (value.length < (rule.minLength ?? 0)) {
      throw new Error(`${path} 不可為空`);
    }
    if (
      typeof rule.pattern === "string" &&
      !new RegExp(`^(?:${rule.pattern})$`, "u").test(value)
    ) {
      throw new Error(`${path} 格式不合法`);
    }
  }
  if (Array.isArray(value) && isObject(rule.items)) {
    value.forEach((item, index) => {
      validateValue(item, rule.items, `${path}[${index}]`);
    });
  }
  if (isObject(value)) {
    validateObject(value, rule, path);
  }
}

/** Validates object fields against the supported schema subset. */
function validateObject(document, schema, path) {
  const required = schema.required ?? [];
  const missing = required.filter((name) => !Object.hasOwn(document, name));
  if (missing.length > 0) {
    throw new Error(`${path} 缺少必填欄位：${missing.join(", ")}`);
  }
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(document)
      .filter((name) => !Object.hasOwn(properties, name))
      .sort();
    if (unknown.length > 0) {
      throw new Error(`${path} 含未知欄位：${unknown.join(", ")}`);
    }
  }
  for (const [name, value] of Object.entries(document)) {
    const rule = properties[name];
    if (isObject(rule)) {
      validateValue(value, rule, `${path}.${name}`);
    }
  }
}

/** Validates a structured document with a named public schema. */
export function validateDocument(schemaName, document) {
  if (!isObject(document)) {
    throw new Error("文件必須是 JSON object");
  }
  validateValue(document, loadSchema(schemaName), schemaName);
  return true;
}

/** Redacts secrets, personal identifiers, and common private absolute paths. */
export function redactText(value) {
  let redacted = String(value);
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }
  redacted = redacted.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  redacted = redacted.replace(
    UNIX_PATH_PATTERN,
    (_, prefix) => `${prefix}[REDACTED_PATH]`,
  );
  return redacted.replace(WINDOWS_PATH_PATTERN, "[REDACTED_PATH]");
}

/** Selects explicit target Skills or current-evidence candidates only. */
export function selectTargets({
  explicitTargets,
  evidenceCandidates,
  installedSkills: _installedSkills,
}) {
  const explicit = [...new Set(explicitTargets)];
  if (explicit.length > 0) {
    return {
      targets: explicit,
      candidates: [],
      requires_confirmation: false,
    };
  }
  const candidates = [...new Set(evidenceCandidates)];
  return {
    targets: [],
    candidates,
    requires_confirmation: candidates.length > 0,
  };
}

/** Resolves a possibly non-existent path through its nearest real ancestor. */
export function resolveLoosePath(input) {
  let cursor = resolve(input);
  const missingParts = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error("無法解析路徑");
    }
    missingParts.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missingParts);
}

/** Resolves a repository-relative path and rejects root escape. */
export function resolveCandidatePath(root, relativePath) {
  const rootPath = realpathSync(resolve(root));
  if (isAbsolute(relativePath)) {
    throw new Error("候選路徑必須使用倉庫內相對路徑");
  }
  const candidate = resolveLoosePath(resolve(rootPath, relativePath));
  const rel = relative(rootPath, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("候選路徑不可逃逸倉庫根目錄");
  }
  return candidate;
}

/** Validates a complete GitHub HTTPS or SSH repository remote. */
export function validateGithubRemote(remote) {
  if (typeof remote !== "string" || remote.length === 0) {
    throw new Error("GitHub remote 不可為空");
  }
  if ([...remote].some((character) => /\s/u.test(character))) {
    throw new Error("GitHub remote 不可包含空白或控制字元");
  }
  if (HTTPS_REMOTE.test(remote) || SSH_REMOTE.test(remote)) {
    return remote;
  }
  throw new Error("初版只接受完整的 GitHub HTTPS 或 SSH repository remote");
}

/** Classifies commands sourced from untrusted repository programs. */
export function classifyUntrustedCommand(command, { source, cwd }) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error("命令必須是非空字串陣列");
  }
  const isUntrustedProgram = UNTRUSTED_PROGRAM_SOURCES.has(source);
  return {
    allowed: !isUntrustedProgram,
    requires_confirmation: isUntrustedProgram,
    source,
    command: [...command],
    cwd: String(cwd),
    network: "unknown",
    writes: "unknown",
    side_effect: isUntrustedProgram ? "unreviewed" : "read-only",
  };
}

/** Classifies repository relationship without conflating gh availability. */
export function classifyRelationship({
  bindingValid,
  remoteVerified,
  permission,
  canFork,
  ghAvailable,
  releaseEnabled,
}) {
  const nullableEvidence = {
    bindingValid,
    remoteVerified,
  };
  for (const [name, value] of Object.entries(nullableEvidence)) {
    if (
      value !== null &&
      value !== undefined &&
      typeof value !== "boolean"
    ) {
      throw new Error(`${name} 必須是 boolean、null 或 undefined`);
    }
  }
  const booleans = {
    canFork,
    ghAvailable,
    releaseEnabled,
  };
  for (const [name, value] of Object.entries(booleans)) {
    if (typeof value !== "boolean") {
      throw new Error(`${name} 必須是 boolean`);
    }
  }
  let normalizedPermission = null;
  if (permission !== null && permission !== undefined) {
    if (typeof permission !== "string") {
      throw new Error("permission 必須是 string 或 null");
    }
    normalizedPermission = permission.toLowerCase();
    if (!KNOWN_PERMISSIONS.has(normalizedPermission)) {
      throw new Error("permission 不合法");
    }
  }

  let relationship;
  if (bindingValid !== true || remoteVerified !== true) {
    relationship = "analyze-only";
  } else if (MANAGED_PERMISSIONS.has(normalizedPermission)) {
    relationship = "managed";
  } else if (canFork) {
    relationship = "contribute";
  } else {
    relationship = "analyze-only";
  }
  const canImplement = ["managed", "contribute"].includes(relationship);
  return {
    relationship,
    capabilities: {
      analysis: true,
      implementation: canImplement,
      pr: canImplement && ghAvailable,
      merge: relationship === "managed" && ghAvailable,
      release:
        relationship === "managed" && ghAvailable && releaseEnabled,
    },
  };
}

/** Validates a public repository security-settings snapshot. */
export function validateRepositorySettings(settings) {
  if (!isObject(settings)) {
    throw new Error("repository settings 必須是 object");
  }
  const missing = [];
  if (settings.default_branch !== "main") {
    missing.push("default_branch");
  }
  missing.push(
    ...REQUIRED_SETTINGS.filter((name) => settings[name] !== true),
  );
  return { compliant: missing.length === 0, missing };
}

/** Validates the structured agent-guidance impact carried into validation and PR proof. */
export function validateDocumentationImpact(document) {
  const impact = clone(document);
  validateDocument("documentation-impact", impact);
  if (impact.contract_preserved !== true) {
    throw new Error("Agent 指引既有合同未保留");
  }
  if (new Set(impact.changed_guides).size !== impact.changed_guides.length) {
    throw new Error("Agent 指引 changed_guides 不可重複");
  }
  for (const path of impact.changed_guides) {
    if (
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      path.split(/[\\/]/u).includes("..")
    ) {
      throw new Error("Agent 指引 changed_guides 必須是倉庫內相對路徑");
    }
  }
  requireRedacted(impact.reason, "documentation_impact.reason");
  if (
    impact.status === "updated" &&
    impact.changed_guides.length === 0
  ) {
    throw new Error("updated 文檔影響必須列出 changed_guides");
  }
  if (
    impact.status === "not-required" &&
    impact.changed_guides.length > 0
  ) {
    throw new Error("not-required 不可同時列出 changed_guides");
  }
  if (
    impact.status === "upstream-follow-up" &&
    impact.root_index_action !== "upstream-follow-up"
  ) {
    throw new Error("upstream-follow-up 必須記錄對應 root_index_action");
  }
  return impact;
}

/** Blocks maintainer output and target-contract process artifacts in a candidate Diff. */
export function validateCandidateProcessArtifacts(
  changedFiles,
  { excludedPrefixes = [] } = {},
) {
  if (!Array.isArray(changedFiles) || !Array.isArray(excludedPrefixes)) {
    throw new Error("候選檔案與排除前綴必須是 array");
  }
  for (const path of changedFiles) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new Error("候選檔案必須是倉庫內相對路徑");
    }
  }
  if (new Set(excludedPrefixes).size !== excludedPrefixes.length) {
    throw new Error("過程檔排除前綴不可重複");
  }
  const prefixes = [...MAINTAINER_PROCESS_PREFIXES, ...excludedPrefixes].map(
    (prefix) => {
      if (
        typeof prefix !== "string" ||
        prefix.length === 0 ||
        isAbsolute(prefix) ||
        prefix.includes("\\") ||
        prefix.split("/").includes("..")
      ) {
        throw new Error("過程檔排除前綴必須是倉庫內相對路徑");
      }
      return prefix.endsWith("/") ? prefix : `${prefix}/`;
    },
  );
  const blocked = [...changedFiles]
    .filter((path) =>
      prefixes.some((prefix) => {
        const directory = prefix.slice(0, -1);
        return path === directory || path.startsWith(prefix);
      }),
    )
    .sort();
  if (blocked.length > 0) {
    throw new Error(`候選 Diff 含過程檔：${blocked.join(", ")}`);
  }
  return true;
}

/** Loads and validates the public Provider Profile catalog. */
export function loadProviderProfiles(profileRoot = PROVIDER_PROFILE_ROOT) {
  const required = new Set([
    "schema_version",
    "profile_schema_version",
    "provider_id",
    "role_type",
    "version_detection",
    "tested_versions",
    "last_verified_at",
    "supported_platforms",
    "capabilities",
    "artifact_contracts",
    "command_policy",
    "fallback",
  ]);
  const profiles = {};
  for (const providerId of PROVIDER_IDS) {
    let profile;
    try {
      profile = JSON.parse(
        readFileSync(resolve(profileRoot, `${providerId}.json`), "utf8"),
      );
    } catch (error) {
      throw new Error(`無法載入 Provider Profile：${providerId}`, {
        cause: error,
      });
    }
    if (!isObject(profile)) {
      throw new Error(`Provider Profile 必須是 object：${providerId}`);
    }
    const missing = [...required]
      .filter((name) => !Object.hasOwn(profile, name))
      .sort();
    if (missing.length > 0) {
      throw new Error(
        `Provider Profile 缺少欄位：${providerId}: ${missing.join(", ")}`,
      );
    }
    if (profile.profile_schema_version !== 2 || profile.schema_version !== 2) {
      throw new Error(`Provider Profile 版本不支援：${providerId}`);
    }
    if (profile.provider_id !== providerId) {
      throw new Error(`Provider Profile ID 與檔名不一致：${providerId}`);
    }
    validateDocument("provider-profile", profile);
    if (!["formal", "auxiliary", "legacy"].includes(profile.role_type)) {
      throw new Error(`Provider role_type 不合法：${providerId}`);
    }
    for (const name of [
      "tested_versions",
      "verification_evidence",
      "capabilities",
      "artifact_contracts",
    ]) {
      if (!Array.isArray(profile[name])) {
        throw new Error(`${name} 必須是 array：${providerId}`);
      }
    }
    const evidenceVersions = profile.verification_evidence
      .map((item) => item?.version)
      .sort();
    const testedVersions = [...profile.tested_versions].sort();
    if (
      canonicalJson(evidenceVersions) !== canonicalJson(testedVersions)
    ) {
      throw new Error(
        `Provider tested_versions 與 verification_evidence 不一致：${providerId}`,
      );
    }
    if (
      testedVersions.length === 0 &&
      profile.last_verified_at !== null
    ) {
      throw new Error(
        `未測版本的 Provider 不可宣稱 last_verified_at：${providerId}`,
      );
    }
    if (
      testedVersions.length > 0 &&
      (
        typeof profile.last_verified_at !== "string" ||
        !Number.isFinite(Date.parse(profile.last_verified_at))
      )
    ) {
      throw new Error(
        `Provider 版本證據缺少有效 last_verified_at：${providerId}`,
      );
    }
    profiles[providerId] = profile;
  }
  return profiles;
}

/** Resolves Provider support from tested-version evidence. */
export function resolveProviderSupport(profile, { detectedVersion }) {
  if (detectedVersion === null || detectedVersion === undefined) {
    return {
      status: profile.fallback?.missing ?? "unavailable",
      commands_allowed: false,
    };
  }
  if ((profile.unsupported_versions ?? []).includes(detectedVersion)) {
    return { status: "unsupported", commands_allowed: false };
  }
  if (!profile.tested_versions.includes(detectedVersion)) {
    return {
      status: profile.fallback?.unknown_version ?? "compatible-read-only",
      commands_allowed: false,
    };
  }
  if (
    typeof profile.last_verified_at !== "string" ||
    !Number.isFinite(Date.parse(profile.last_verified_at))
  ) {
    return {
      status: profile.fallback?.unknown_version ?? "compatible-read-only",
      commands_allowed: false,
    };
  }
  if (profile.role_type === "legacy") {
    return {
      status: "compatible-read-only",
      commands_allowed: false,
      allowed_commands: [],
    };
  }
  const commands = profile.command_policy?.allowed_when_verified ?? [];
  const evidence = profile.verification_evidence
    .find((item) => item.version === detectedVersion);
  const commandsVerified = evidence?.scope === "commands";
  return {
    status: "verified",
    commands_allowed: commandsVerified && commands.length > 0,
    allowed_commands: commandsVerified ? clone(commands) : [],
  };
}

/** Activates only Providers with a proven gap and non-overlapping ownership. */
export function selectProviders(
  providers,
  { nativeGap = null } = {},
) {
  const profiles = loadProviderProfiles();
  if (
    nativeGap !== null &&
    (typeof nativeGap !== "string" || nativeGap.trim().length === 0)
  ) {
    throw new Error("native_gap 必須是非空字串或 null");
  }
  const active = [];
  const inactive = [];
  const allowedRoles = new Set(["main", "auxiliary", "repository-required"]);
  for (const provider of providers) {
    const item = clone(provider);
    if (!isObject(item)) {
      throw new Error("Provider decision 必須是 object");
    }
    if (!PROVIDER_IDS.includes(item.id)) {
      throw new Error("Provider ID 不在公開 Profile 目錄");
    }
    if (!allowedRoles.has(item.role)) {
      throw new Error("Provider role 不合法");
    }
    if (typeof item.installed !== "boolean") {
      throw new Error("Provider installed 必須是 boolean");
    }
    if (
      item.capability_gap !== null &&
      item.capability_gap !== undefined &&
      (typeof item.capability_gap !== "string" ||
        item.capability_gap.trim().length === 0)
    ) {
      throw new Error("Provider capability_gap 格式不合法");
    }
    item.capability_gap ??= null;
    item.owner ??= null;
    if (!isObject(profiles[item.id])) {
      throw new Error(`缺少 Provider Profile：${item.id}`);
    }
    const support = resolveProviderSupport(profiles[item.id], {
      detectedVersion: item.detected_version ?? null,
    });
    if (
      item.support_status !== undefined &&
      item.support_status !== support.status
    ) {
      throw new Error("Provider support_status 與 Profile 版本證據不一致");
    }
    item.support_status = support.status;
    item.required_access ??= "commands";
    if (!item.installed) {
      item.inactive_reason = "unavailable";
      inactive.push(item);
      continue;
    }
    if (!item.capability_gap) {
      item.inactive_reason = "no_capability_gap";
      inactive.push(item);
      continue;
    }
    const supportStatus = item.support_status ?? "unavailable";
    if (
      ![
        "verified",
        "compatible-read-only",
        "unsupported",
        "unavailable",
      ].includes(supportStatus)
    ) {
      throw new Error("Provider support_status 不合法");
    }
    const requiredAccess = item.required_access ?? "commands";
    if (!["read-only", "commands"].includes(requiredAccess)) {
      throw new Error("Provider required_access 不合法");
    }
    if (["unsupported", "unavailable"].includes(supportStatus)) {
      item.inactive_reason = supportStatus;
      inactive.push(item);
      continue;
    }
    if (
      supportStatus === "compatible-read-only" &&
      requiredAccess !== "read-only"
    ) {
      item.inactive_reason = "commands_not_verified";
      inactive.push(item);
      continue;
    }
    if (requiredAccess === "commands" && support.commands_allowed !== true) {
      item.inactive_reason = "commands_not_verified";
      inactive.push(item);
      continue;
    }
    active.push(item);
  }

  for (const role of allowedRoles) {
    if (active.filter((item) => item.role === role).length > 1) {
      throw new Error("同一 Provider role 最多只能啟用一個");
    }
  }
  if (active.length > 3) {
    throw new Error("單次任務最多啟用三個 Provider");
  }
  const owners = active.map((item) => item.owner);
  if (
    owners.some((owner) => owner === null || owner === undefined) ||
    new Set(owners).size !== owners.length
  ) {
    throw new Error("每項正式能力必須具備唯一可寫 owner");
  }
  const decision = {
    schema_version: 1,
    native_gap: nativeGap,
    active,
    inactive,
  };
  validateDocument("provider-selection", decision);
  return decision;
}

/** Validates versioned records and run-local identifier uniqueness. */
function validatedRecords(schemaName, records, idPrefix) {
  const validated = [];
  const seenIds = new Set();
  for (const record of records) {
    const item = clone(record);
    validateDocument(schemaName, item);
    if (seenIds.has(item.id)) {
      throw new Error(`同一任務內的 ${idPrefix}-* ID 不可重複`);
    }
    seenIds.add(item.id);
    validated.push(item);
  }
  return validated;
}

/** Rejects text that still contains known sensitive material. */
function requireRedacted(value, label) {
  if (redactText(value) !== value) {
    throw new Error(`${label} 尚未脫敏`);
  }
}

/** Validates redacted, versioned, unique evidence records. */
export function validateEvidenceRecords(records) {
  const validated = validatedRecords("evidence", records, "EV");
  for (const item of validated) {
    requireRedacted(item.source_ref, "evidence.source_ref");
    requireRedacted(item.redacted_summary, "evidence.redacted_summary");
  }
  return validated;
}

/** Validates feedback completeness and evidence traceability. */
export function validateFeedbackRecords(records, evidence) {
  const evidenceItems = validateEvidenceRecords(evidence);
  const knownEvidenceIds = new Set(evidenceItems.map((item) => item.id));
  const validated = validatedRecords("feedback", records, "FB");
  for (const item of validated) {
    if (item.source_ids.length === 0) {
      throw new Error("每個 FB-* 至少需要一個 evidence");
    }
    if (new Set(item.source_ids).size !== item.source_ids.length) {
      throw new Error("單一 FB-* 不可重複引用同一 evidence");
    }
    const unknown = [...new Set(item.source_ids)]
      .filter((id) => !knownEvidenceIds.has(id))
      .sort();
    if (unknown.length > 0) {
      throw new Error(`FB-* 引用了未知 evidence：${unknown.join(", ")}`);
    }
    for (const field of [
      "phenomenon",
      "expected_behavior",
      "reproduction",
      "provisional_owner",
    ]) {
      requireRedacted(item[field], `feedback.${field}`);
    }
  }
  return validated;
}

/** Validates optimization completeness and feedback traceability. */
export function validateOptimizationRecords(records, feedback) {
  const feedbackItems = [...feedback];
  const knownFeedbackIds = new Set();
  for (const item of feedbackItems) {
    validateDocument("feedback", item);
    if (knownFeedbackIds.has(item.id)) {
      throw new Error("同一任務內的 FB-* ID 不可重複");
    }
    knownFeedbackIds.add(item.id);
  }
  const validated = validatedRecords("optimization", records, "OPT");
  for (const item of validated) {
    if (item.feedback_ids.length === 0) {
      throw new Error("每個 OPT-* 至少需要一個 feedback");
    }
    if (new Set(item.feedback_ids).size !== item.feedback_ids.length) {
      throw new Error("單一 OPT-* 不可重複引用同一 feedback");
    }
    const unknown = [...new Set(item.feedback_ids)]
      .filter((id) => !knownFeedbackIds.has(id))
      .sort();
    if (unknown.length > 0) {
      throw new Error(`OPT-* 引用了未知 feedback：${unknown.join(", ")}`);
    }
    for (const field of [
      "intent_evidence",
      "problem_evidence",
      "owner",
      "scope",
      "closure",
      "minimum_change",
      "regression_case",
      "generalized_value",
      "decision_reason",
    ]) {
      requireRedacted(item[field], `optimization.${field}`);
    }
  }
  return validated;
}

/** Builds an evidence-backed zero-improvement conclusion. */
export function buildZeroImprovementOutcome(evidence, feedback, { rationale }) {
  const evidenceItems = validateEvidenceRecords(evidence);
  if (evidenceItems.length === 0) {
    throw new Error("零改善結論至少需要一筆 evidence");
  }
  const feedbackItems = validateFeedbackRecords(feedback, evidenceItems);
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new Error("零改善結論必須記錄理由");
  }
  requireRedacted(rationale, "zero_improvement.rationale");
  const unresolved = feedbackItems
    .filter((item) => ["skill-defect", "unknown"].includes(item.classification))
    .map((item) => item.id);
  if (unresolved.length > 0) {
    throw new Error(
      `仍有未處理的缺陷或未知 feedback，不可宣告零改善：${unresolved.join(", ")}`,
    );
  }
  return {
    schema_version: 1,
    conclusion: "no-proven-improvement",
    evidence_ids: evidenceItems.map((item) => item.id),
    feedback_ids: feedbackItems.map((item) => item.id),
    rationale: rationale.trim(),
  };
}

/** Requires either validated OPT records or one exact zero-improvement result. */
export function validateOptimizationOutcome({
  optimizations,
  zeroImprovement,
  evidence,
  feedback,
}) {
  const evidenceItems = validateEvidenceRecords(evidence);
  const feedbackItems = validateFeedbackRecords(feedback, evidenceItems);
  const optimizationItems = validateOptimizationRecords(
    optimizations,
    feedbackItems,
  );
  if (optimizationItems.length > 0 && zeroImprovement !== null) {
    throw new Error("OPT-* 與零改善結論不可同時成立");
  }
  if (optimizationItems.length > 0) {
    return {
      schema_version: 1,
      conclusion: "optimization-proposals",
      optimization_ids: optimizationItems.map((item) => item.id),
    };
  }
  if (zeroImprovement === null) {
    throw new Error("必須提供 OPT-* 或明確零改善結論");
  }
  const expected = buildZeroImprovementOutcome(evidenceItems, feedbackItems, {
    rationale: zeroImprovement?.rationale ?? "",
  });
  if (canonicalJson(zeroImprovement) !== canonicalJson(expected)) {
    throw new Error("零改善結論與目前 evidence／feedback 不一致");
  }
  return clone(expected);
}

/** Validates optimization decisions and returns accepted records. */
export function selectAcceptedOptimizations(optimizations) {
  const validated = [];
  const seenIds = new Set();
  for (const optimization of optimizations) {
    const item = clone(optimization);
    validateDocument("optimization", item);
    if (typeof item.id !== "string" || !item.id.startsWith("OPT-")) {
      throw new Error("每個最佳化項目都必須具備 OPT-* ID");
    }
    if (seenIds.has(item.id)) {
      throw new Error("同一任務內的 OPT-* ID 不可重複");
    }
    if (!DECISION_STATUSES.has(item.decision_status)) {
      throw new Error("最佳化項目缺少合法的逐項決策");
    }
    if (
      typeof item.decision_reason !== "string" ||
      item.decision_reason.trim().length === 0
    ) {
      throw new Error("最佳化項目必須記錄決策理由");
    }
    seenIds.add(item.id);
    validated.push(item);
  }
  return validated.filter((item) => item.decision_status === "accepted");
}

/** Builds an implementation approval bound to accepted OPT and repository state. */
export function buildApproval(
  optimizations,
  {
    runId,
    bindingId,
    relationship,
    repository,
    headCommit,
    diffHash,
    processArtifactPrefixes,
  },
) {
  const accepted = selectAcceptedOptimizations(optimizations);
  if (accepted.length === 0) {
    throw new Error("沒有 accepted 的 OPT-*，不得建立實作核准");
  }
  const approval = {
    schema_version: 1,
    action: "implementation",
    run_id: runId,
    binding_id: bindingId,
    relationship,
    repository,
    head_commit: headCommit,
    diff_hash: diffHash,
    process_artifact_prefixes: clone(processArtifactPrefixes),
    approved_opt_ids: accepted.map((item) => item.id),
    optimizations_hash: fingerprint(accepted),
  };
  approval.fingerprint = fingerprint(approval);
  validateDocument("approval", approval);
  return approval;
}

/** Verifies that an implementation approval still matches current state. */
export function verifyApproval(
  approval,
  optimizations,
  {
    runId,
    bindingId,
    relationship,
    repository,
    headCommit,
    diffHash,
    processArtifactPrefixes,
  },
) {
  const current = buildApproval(optimizations, {
    runId,
    bindingId,
    relationship,
    repository,
    headCommit,
    diffHash,
    processArtifactPrefixes,
  });
  if (canonicalJson(approval) !== canonicalJson(current)) {
    throw new ApprovalDriftError(
      "最佳化內容或目標狀態已改變，必須重新確認",
    );
  }
  return true;
}

/** Evaluates whether measurable quality and safety gates allow publication. */
export function publicationGate({
  baseline,
  candidate,
  safetyPassRate,
  falsePositiveRate,
  cost,
  thresholds,
  supportedPlatforms,
}) {
  const reasons = [];
  if (safetyPassRate !== 1) {
    reasons.push("safety_gate_failed");
  }
  const missingMetrics = CORE_METRICS.filter(
    (metric) =>
      !Object.hasOwn(baseline, metric) || !Object.hasOwn(candidate, metric),
  );
  if (missingMetrics.length > 0) {
    reasons.push("missing_core_metrics");
  } else {
    if (CORE_METRICS.some((metric) => candidate[metric] < baseline[metric])) {
      reasons.push("core_quality_regression");
    }
    if (!CORE_METRICS.some((metric) => candidate[metric] > baseline[metric])) {
      reasons.push("no_proven_gain");
    }
  }
  if (falsePositiveRate > thresholds.max_false_positive_rate) {
    reasons.push("false_positive_limit_exceeded");
  }
  if (cost > thresholds.max_cost) {
    reasons.push("cost_limit_exceeded");
  }
  if (
    !isObject(supportedPlatforms) ||
    Object.keys(supportedPlatforms).length === 0 ||
    !Object.values(supportedPlatforms).every(Boolean)
  ) {
    reasons.push("unsupported_claimed_platform");
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      baseline: { ...baseline },
      candidate: { ...candidate },
      safety_pass_rate: safetyPassRate,
      false_positive_rate: falsePositiveRate,
      cost,
      thresholds: { ...thresholds },
      supported_platforms: { ...supportedPlatforms },
    },
  };
}

/** Validates the redacted five-Provider aggregate for a stable candidate. */
export function validateProviderValidationAggregate(
  aggregate,
  {
    currentSkillFingerprint,
    profiles = loadProviderProfiles(),
  },
) {
  validateDocument("provider-validation-aggregate", aggregate);
  const blockers = [];
  const addBlocker = (reason) => {
    if (!blockers.includes(reason)) {
      blockers.push(reason);
    }
  };
  if (aggregate.candidate_skill_fingerprint !== currentSkillFingerprint) {
    addBlocker("candidate_fingerprint_mismatch");
  }
  if (!Number.isFinite(Date.parse(aggregate.evaluated_at))) {
    addBlocker("provider_evaluation_time_invalid");
  }
  if (!Number.isFinite(Date.parse(aggregate.case_measurements_evaluated_at))) {
    addBlocker("provider_case_measurement_time_invalid");
  }
  if (!Number.isFinite(Date.parse(aggregate.candidate_bridge_evaluated_at))) {
    addBlocker("provider_candidate_bridge_time_invalid");
  }
  if (
    Date.parse(aggregate.case_measurements_evaluated_at) >
      Date.parse(aggregate.evaluated_at) ||
    Date.parse(aggregate.candidate_bridge_evaluated_at) >
      Date.parse(aggregate.evaluated_at) ||
    Date.parse(aggregate.case_measurements_evaluated_at) >
      Date.parse(aggregate.candidate_bridge_evaluated_at)
  ) {
    addBlocker("provider_evidence_time_inconsistent");
  }
  if (
    aggregate.raw_outputs_published !== false ||
    aggregate.local_installations_modified !== false
  ) {
    addBlocker("provider_publication_boundary_failed");
  }

  const caseIds = aggregate.cases.map((item) => item.provider_id);
  for (const providerId of FORMAL_PROVIDER_IDS) {
    const matches = caseIds.filter((item) => item === providerId).length;
    if (matches === 0) {
      addBlocker("missing_provider_case");
    }
    if (matches > 1) {
      addBlocker("duplicate_provider_case");
    }
  }
  if (caseIds.some((providerId) => !FORMAL_PROVIDER_IDS.includes(providerId))) {
    addBlocker("unexpected_provider_case");
  }
  if (new Set(caseIds).size !== caseIds.length) {
    addBlocker("duplicate_provider_case");
  }

  const owners = [];
  for (const item of aggregate.cases) {
    const profile = profiles[item.provider_id];
    if (!isObject(profile) || profile.role_type !== "formal") {
      addBlocker("provider_profile_not_formal");
      continue;
    }
    const evidence = profile.verification_evidence
      .find((candidate) => candidate.version === item.provider_version);
    if (
      !profile.tested_versions.includes(item.provider_version) ||
      !evidence
    ) {
      addBlocker("provider_version_mismatch");
    } else {
      if (evidence.release_commit !== item.release_commit) {
        addBlocker("provider_commit_mismatch");
      }
      if (evidence.scope !== "commands") {
        addBlocker("provider_commands_not_verified");
      }
    }
    const allowedCommands =
      profile.command_policy?.allowed_when_verified ?? [];
    if (
      item.command_ids.length === 0 ||
      item.command_ids.some((command) => !allowedCommands.includes(command))
    ) {
      addBlocker("provider_command_mismatch");
    }
    const allowedArtifactKinds = new Set(
      profile.artifact_contracts.map((contract) => contract.capability),
    );
    if (
      item.artifact_kinds.length === 0 ||
      new Set(item.artifact_kinds).size !== item.artifact_kinds.length ||
      item.artifact_kinds.some(
        (artifactKind) => !allowedArtifactKinds.has(artifactKind),
      )
    ) {
      addBlocker("provider_artifact_mismatch");
    }
    if (
      canonicalJson([...profile.supported_platforms].sort()) !==
      canonicalJson(["claude-code", "codex"])
    ) {
      addBlocker("provider_platform_not_verified");
    }
    if (item.evidence_kind !== "controlled-redacted-real-usage") {
      addBlocker("synthetic_provider_evidence");
    }
    owners.push(item.owner);
    if (item.owner_unique !== true) {
      addBlocker("provider_owner_conflict");
    }
    const quality = item.quality;
    if (
      quality.max_score <= 0 ||
      quality.baseline_score < 0 ||
      quality.candidate_score < 0 ||
      quality.baseline_score > quality.max_score ||
      quality.candidate_score > quality.max_score ||
      quality.candidate_score <= quality.baseline_score ||
      quality.improvements.length === 0 ||
      new Set(quality.improvements).size !== quality.improvements.length ||
      quality.regressions.length > 0
    ) {
      addBlocker("provider_quality_regression");
    }
    const cost = item.cost;
    if (
      cost.elapsed_seconds < 0 ||
      cost.tool_calls < 0 ||
      cost.artifact_bytes <= 0
    ) {
      addBlocker("provider_cost_invalid");
    }
    if (
      item.isolated_home !== true ||
      item.isolated_repository !== true ||
      item.primary_provider_installation_modified !== false ||
      item.remote_writes_executed !== false ||
      item.telemetry_disabled !== true ||
      item.fallback_validated !== true ||
      item.safety_passed !== true ||
      item.passed !== true
    ) {
      addBlocker("provider_case_failed");
    }
  }
  if (new Set(owners).size !== owners.length) {
    addBlocker("provider_owner_conflict");
  }

  const platformIds = aggregate.platforms.map((item) => item.id);
  if (
    canonicalJson([...platformIds].sort()) !==
      canonicalJson(["claude-code", "codex"]) ||
    new Set(platformIds).size !== platformIds.length
  ) {
    addBlocker("provider_platform_set_invalid");
  }
  const platformChecks = [
    "installation_validated",
    "positive_trigger",
    "negative_non_trigger",
    "provider_selection",
    "artifact_bridge",
    "fallback",
    "local_analysis_only",
    "passed",
  ];
  if (
    aggregate.platforms.some(
      (platform) =>
        platform.files_modified !== false ||
        platformChecks.some((field) => platform[field] !== true),
    )
  ) {
    addBlocker("provider_platform_validation_failed");
  }
  if (aggregate.passed !== true) {
    addBlocker("provider_aggregate_not_passed");
  }
  return {
    passed: blockers.length === 0,
    blockers,
    candidate_skill_fingerprint: aggregate.candidate_skill_fingerprint,
    formal_provider_ids: [...FORMAL_PROVIDER_IDS],
    case_provider_ids: [...caseIds],
    platform_ids: [...platformIds],
  };
}

/** Normalizes one supported Release version while rejecting malformed prefixes. */
function normalizeReleaseVersion(version) {
  if (typeof version !== "string") {
    return null;
  }
  return version.match(RELEASE_VERSION_PATTERN)?.groups?.version ?? null;
}

/** Separates pre-release candidate readiness from post-release verification. */
export function stableReleaseGate({
  providerValidation,
  expectedRepository,
  expectedVersion,
  expectedCommit,
  publicationProof,
}) {
  if (!isObject(providerValidation)) {
    throw new Error("providerValidation 必須是 object");
  }
  const stableCandidateReady = providerValidation.passed === true;
  let publicationVerified = false;
  const blockers = [...(providerValidation.blockers ?? [])];
  if (publicationProof !== null && publicationProof !== undefined) {
    validateDocument("publication-proof", publicationProof);
    const expectedNormalized = normalizeReleaseVersion(expectedVersion);
    const proofNormalized = normalizeReleaseVersion(
      publicationProof.version,
    );
    publicationVerified =
      stableCandidateReady &&
      expectedNormalized !== null &&
      proofNormalized === expectedNormalized &&
      publicationProof.official === true &&
      publicationProof.repository === expectedRepository &&
      publicationProof.tag === `v${expectedNormalized}` &&
      publicationProof.commit === expectedCommit;
    if (!publicationVerified) {
      blockers.push("publication_proof_mismatch");
    }
  }
  return {
    stable_candidate_ready: stableCandidateReady,
    release_preview_allowed: stableCandidateReady,
    publication_verified: publicationVerified,
    blockers: [...new Set(blockers)],
  };
}

/** Validates candidate checks and builds the PR-forward validation result. */
export function buildValidationResult(
  candidateSnapshot,
  { checks, requiredCheckIds },
) {
  const candidate = validateCandidateSnapshotContract(candidateSnapshot);
  const validatedChecks = [];
  const seenIds = new Set();
  for (const check of checks) {
    if (!isObject(check)) {
      throw new Error("validation check 必須是 object");
    }
    const missing = [...REQUIRED_CHECK_FIELDS]
      .filter((name) => !Object.hasOwn(check, name))
      .sort();
    const unknown = Object.keys(check)
      .filter((name) => !CHECK_FIELDS.has(name))
      .sort();
    if (missing.length > 0) {
      throw new Error(`validation check 缺少欄位：${missing.join(", ")}`);
    }
    if (unknown.length > 0) {
      throw new Error(`validation check 含未知欄位：${unknown.join(", ")}`);
    }
    if (typeof check.id !== "string" || check.id.trim().length === 0) {
      throw new Error("validation check ID 不可為空");
    }
    if (seenIds.has(check.id)) {
      throw new Error("validation check ID 不可重複");
    }
    if (!CHECK_CATEGORIES.has(check.category)) {
      throw new Error("validation check category 不合法");
    }
    if (!CHECK_STATUSES.has(check.status)) {
      throw new Error("validation check status 不合法");
    }
    if (typeof check.summary !== "string" || check.summary.trim().length === 0) {
      throw new Error("validation check summary 不可為空");
    }
    requireRedacted(check.summary, "validation check summary");
    seenIds.add(check.id);
    validatedChecks.push(clone(check));
  }
  const required = new Set(requiredCheckIds);
  if (
    required.size === 0 ||
    [...required].some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error("required_check_ids 必須是非空字串集合");
  }
  const byId = Object.fromEntries(
    validatedChecks.map((check) => [check.id, check]),
  );
  const documentationChecks = validatedChecks.filter(
    (check) => check.category === "documentation",
  );
  if (documentationChecks.length !== 1) {
    throw new Error("候選驗證必須包含且只能包含一項文檔影響檢查");
  }
  if (!isObject(documentationChecks[0].details)) {
    throw new Error("文檔影響檢查必須包含結構化 details");
  }
  documentationChecks[0].details = validateDocumentationImpact(
    documentationChecks[0].details,
  );
  const missing = [...required].filter((id) => !Object.hasOwn(byId, id)).sort();
  if (missing.length > 0) {
    throw new Error(`缺少必要檢查：${missing.join(", ")}`);
  }
  const safetyChecks = validatedChecks.filter(
    (check) => check.category === "safety",
  );
  const safetyPassRate =
    safetyChecks.length === 0
      ? 0
      : safetyChecks.filter((check) => check.status === "passed").length /
        safetyChecks.length;
  const blockers = [];
  if (safetyPassRate !== 1) {
    blockers.push("safety_gate_failed");
  }
  if ([...required].some((id) => byId[id].status !== "passed")) {
    blockers.push("required_check_failed");
  }
  if (validatedChecks.some((check) => check.status === "failed")) {
    blockers.push("validation_check_failed");
  }
  const result = {
    schema_version: 1,
    candidate_diff_hash: candidate.candidate_diff_hash,
    passed: blockers.length === 0,
    checks: validatedChecks,
    safety_pass_rate: safetyPassRate,
    blockers,
  };
  validateDocument("validation", result);
  return result;
}

/** Revalidates a persisted candidate snapshot without trusting summary booleans. */
export function validateCandidateSnapshotContract(candidateSnapshot) {
  const candidate = clone(candidateSnapshot);
  validateDocument("candidate-snapshot", candidate);
  validateDocument("repository-snapshot", candidate.repository_snapshot);
  if (
    canonicalJson(candidate.process_artifact_prefixes) !==
    canonicalJson(candidate.repository_snapshot.process_artifact_prefixes)
  ) {
    throw new Error(
      "candidate 過程檔合同與 repository snapshot 不一致",
    );
  }
  if (
    candidate.isolated !== true ||
    candidate.diff_mapping_complete !== true
  ) {
    throw new Error("candidate 必須完成隔離與 Diff 映射");
  }
  for (const [name, items] of [
    ["changed_files", candidate.changed_files],
    ["approved_opt_ids", candidate.approved_opt_ids],
  ]) {
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      new Set(items).size !== items.length
    ) {
      throw new Error(`${name} 必須非空且不可重複`);
    }
  }
  if (!isObject(candidate.file_opt_map)) {
    throw new Error("file_opt_map 必須是 object");
  }
  const changed = new Set(candidate.changed_files);
  const mappedFiles = Object.keys(candidate.file_opt_map);
  if (
    mappedFiles.length !== changed.size ||
    mappedFiles.some((path) => !changed.has(path))
  ) {
    throw new Error("candidate file_opt_map 未完整覆蓋 changed_files");
  }
  const approved = new Set(candidate.approved_opt_ids);
  const mappedOptimizations = new Set();
  for (const [path, optimizationIds] of Object.entries(
    candidate.file_opt_map,
  )) {
    if (
      !Array.isArray(optimizationIds) ||
      optimizationIds.length === 0 ||
      new Set(optimizationIds).size !== optimizationIds.length
    ) {
      throw new Error(`${path} 的 OPT-* 映射不合法`);
    }
    for (const id of optimizationIds) {
      if (!approved.has(id)) {
        throw new Error(`${path} 映射未核准 OPT：${id}`);
      }
      mappedOptimizations.add(id);
    }
  }
  const unmapped = [...approved].filter((id) => !mappedOptimizations.has(id));
  if (unmapped.length > 0) {
    throw new Error(`核准 OPT 未對應任何候選檔案：${unmapped.join(", ")}`);
  }
  validateCandidateProcessArtifacts(candidate.changed_files, {
    excludedPrefixes: candidate.process_artifact_prefixes,
  });
  return candidate;
}

/** Validates branch-push proof against the current candidate and target. */
export function validateBranchPushProofContract(
  branchPushProof,
  candidateSnapshot,
  {
    repository,
    relationship,
    baseBranch,
    baseCommit,
    headBranch,
    headRepository,
  },
) {
  if (!isObject(branchPushProof)) {
    throw new Error("Branch push proof 必須是 object");
  }
  const candidate = validateCandidateSnapshotContract(candidateSnapshot);
  const proof = clone(branchPushProof);
  validateDocument("branch-push-proof", proof);
  if (
    proof.repository !== repository ||
    proof.relationship !== relationship ||
    proof.base_branch !== baseBranch ||
    proof.base_commit !== baseCommit ||
    proof.branch !== headBranch ||
    proof.head_repository !== headRepository ||
    proof.commit !== candidate.repository_snapshot.head_commit ||
    proof.candidate_diff_hash !== candidate.candidate_diff_hash ||
    proof.forced !== false ||
    proof.verified !== true
  ) {
    throw new Error(
      "Branch push proof 與目前倉庫、候選或遠端分支不一致",
    );
  }
  if (
    proof.operation === "create" &&
    proof.previous_remote_commit !== null
  ) {
    throw new Error("Branch create proof 不可包含舊遠端提交");
  }
  if (
    proof.operation === "fast-forward" &&
    (typeof proof.previous_remote_commit !== "string" ||
      proof.previous_remote_commit.length === 0 ||
      proof.previous_remote_commit === proof.commit)
  ) {
    throw new Error("Branch fast-forward proof 缺少有效舊遠端提交");
  }
  if (
    proof.operation === "verify-existing" &&
    proof.previous_remote_commit !== proof.commit
  ) {
    throw new Error("Branch verify proof 的遠端提交不一致");
  }
  return proof;
}

/** Validates a Fork proof against the active contribute target. */
export function validateForkProofContract(
  forkProof,
  {
    repository,
    forkRepository,
    account,
    baseBranch,
    baseCommit,
  },
) {
  if (!isObject(forkProof)) {
    throw new Error("Fork proof 必須是 object");
  }
  const proof = clone(forkProof);
  validateDocument("fork-proof", proof);
  if (
    proof.repository !== repository ||
    proof.fork_repository !== forkRepository ||
    proof.account !== account ||
    proof.relationship !== "contribute" ||
    proof.base_branch !== baseBranch ||
    proof.base_commit !== baseCommit ||
    proof.parent_repository !== repository ||
    proof.default_branch_only !== true ||
    proof.base_commit_available !== true ||
    proof.verified !== true
  ) {
    throw new Error("Fork proof 與目前帳號、上游或基準提交不一致");
  }
  return proof;
}

/** Rebuilds a PR-ready validation result and requires all forward categories. */
export function validatePrReadyValidation(
  validationSummary,
  candidateSnapshot,
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
  return summary;
}

/** Validates PR proof and binds its guidance impact to candidate validation. */
export function validatePrProofContract(
  prProof,
  documentationImpact,
  { repository, baseBranch, headCommit },
) {
  const proof = clone(prProof);
  validateDocument("pr-proof", proof);
  if (
    proof.number < 1 ||
    proof.repository !== repository ||
    proof.base_branch !== baseBranch ||
    proof.head_commit !== headCommit
  ) {
    throw new Error("PR proof 與目前倉庫、分支或候選提交不一致");
  }
  const currentImpact = validateDocumentationImpact(
    proof.documentation_impact,
  );
  const expectedImpact = validateDocumentationImpact(documentationImpact);
  if (canonicalJson(currentImpact) !== canonicalJson(expectedImpact)) {
    throw new Error("PR proof 的文檔影響與候選驗證不一致");
  }
  return proof;
}
