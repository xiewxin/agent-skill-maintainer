import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  writeFileSync(join(repository, "SKILL.md"), "base\n", "utf8");
  runGit(repository, "add", "SKILL.md");
  runGit(repository, "commit", "-m", "base");
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
