import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fingerprint,
  loadProviderProfiles,
} from "../skills/agent-skill-maintainer/scripts/lib/core.mjs";
import {
  fingerprintTree,
} from "../skills/agent-skill-maintainer/scripts/lib/git.mjs";
import {
  applyLocalUpdate,
  buildLocalUpdateApproval,
  buildLocalUpdatePreview,
  canonicalInstallPathFingerprint,
  inspectLocalInstallation,
  reconcileLocalUpdate,
  validateLocalUpdateBinding,
  verifyLocalUpdateApproval,
} from "../skills/agent-skill-maintainer/scripts/lib/update.mjs";
import {
  runMaintainerCommand,
} from "../skills/agent-skill-maintainer/scripts/maintainer.mjs";

const COMMIT = "c".repeat(40);
const ROOT_TREE = "a".repeat(40);
const SKILL_TREE = "b".repeat(40);
const PROVIDER_HASH = "d".repeat(64);
const NOW = new Date("2026-07-27T08:00:00.000Z");
const OLD_SKILL = `---
name: example-skill
description: Old fixture.
---

# Old
`;
const NEW_SKILL = `---
name: example-skill
description: New fixture.
---

# New
`;
const NEW_GUIDE = "# Guide\n";

/** Computes one Git object identifier for a blob fixture. */
function blobSha(payload) {
  const content = Buffer.from(payload, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.length}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

/** Returns one successful subprocess result. */
function success(stdout) {
  return {
    status: 0,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
  };
}

/** Creates an isolated npx-skills global installation and remote fixture. */
function createUpdateFixture({
  useXdgState = false,
  useClaudeConfig = false,
  releaseTarget = COMMIT,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "maintainer-update-"));
  const home = join(root, "home");
  const installed = join(
    home,
    ".agents",
    "skills",
    "example-skill",
  );
  const claudeConfigDirectory = useClaudeConfig
    ? join(root, "claude config")
    : join(home, ".claude");
  const claude = join(
    claudeConfigDirectory,
    "skills",
    "example-skill",
  );
  const stateDirectory = useXdgState
    ? join(root, "xdg state")
    : undefined;
  const lockPath = stateDirectory === undefined
    ? join(home, ".agents", ".skill-lock.json")
    : join(stateDirectory, "skills", ".skill-lock.json");
  mkdirSync(installed, { recursive: true });
  mkdirSync(dirname(claude), { recursive: true });
  writeFileSync(join(installed, "SKILL.md"), OLD_SKILL);
  symlinkSync(
    useClaudeConfig
      ? installed
      : "../../.agents/skills/example-skill",
    claude,
    "dir",
  );
  const oldFingerprint = fingerprintTree(installed);
  const installedAt = "2026-07-01T00:00:00.000Z";
  const updatedAt = "2026-07-01T00:00:00.000Z";
  const lock = {
    version: 3,
    skills: {
      "example-skill": {
        source: "example/skill",
        sourceType: "github",
        sourceUrl: "https://github.com/example/skill.git",
        skillPath: "skills/example-skill/SKILL.md",
        skillFolderHash: "e".repeat(40),
        installedAt,
        updatedAt,
      },
    },
    dismissed: {
      findSkillsPrompt: true,
    },
    lastSelectedAgents: ["codex", "claude-code"],
  };
  mkdirSync(dirname(lockPath), {
    recursive: true,
  });
  writeFileSync(
    lockPath,
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  const binding = {
    schema_version: 1,
    binding_id: "binding-001",
    skill: "example-skill",
    source_repository: "example/skill",
    installed_fingerprint: oldFingerprint,
    install_method: "npx-skills",
    remote_verified: true,
    relationship: "managed",
    release_enabled: true,
    installation: {
      scope: "global",
      mode: "symlink",
      source_type: "github",
      source_url: "https://github.com/example/skill.git",
      skill_path: "skills/example-skill/SKILL.md",
      agents: ["claude-code", "codex"],
      lock_schema_version: 3,
      canonical_path_fingerprint:
        canonicalInstallPathFingerprint("example-skill"),
    },
  };
  const publicationProof = {
    schema_version: 1,
    repository: "example/skill",
    version: "v1.0.0",
    tag: "v1.0.0",
    commit: COMMIT,
    release_url:
      "https://github.com/example/skill/releases/tag/v1.0.0",
    official: true,
  };
  const state = {
    run_id: "run-001",
    binding_id: "binding-001",
    skill: "example-skill",
    repository: "example/skill",
    relationship: "managed",
    from_version: "v0.1.0",
    publication_proof: publicationProof,
    provider_contract_hash: PROVIDER_HASH,
  };
  const blobs = new Map([
    [blobSha(NEW_SKILL), NEW_SKILL],
    [blobSha(NEW_GUIDE), NEW_GUIDE],
  ]);
  const commands = [];
  const runner = (arguments_) => {
    commands.push(arguments_);
    if (arguments_[0] === "release") {
      return success({
        tagName: "v1.0.0",
        targetCommitish: releaseTarget,
        url: publicationProof.release_url,
        isDraft: false,
      });
    }
    const endpoint = arguments_[1];
    if (
      arguments_[0] === "api" &&
      endpoint === "repos/example/skill/commits/v1.0.0"
    ) {
      return success(`${COMMIT}\n`);
    }
    if (
      arguments_[0] === "api" &&
      endpoint ===
        `repos/example/skill/git/trees/${COMMIT}?recursive=1`
    ) {
      return success({
        sha: ROOT_TREE,
        truncated: false,
        tree: [
          {
            path: "skills",
            mode: "040000",
            type: "tree",
            sha: "f".repeat(40),
          },
          {
            path: "skills/example-skill",
            mode: "040000",
            type: "tree",
            sha: SKILL_TREE,
          },
          {
            path: "skills/example-skill/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: blobSha(NEW_SKILL),
          },
          {
            path: "skills/example-skill/references",
            mode: "040000",
            type: "tree",
            sha: "1".repeat(40),
          },
          {
            path: "skills/example-skill/references/guide.md",
            mode: "100644",
            type: "blob",
            sha: blobSha(NEW_GUIDE),
          },
        ],
      });
    }
    const blobMatch = endpoint?.match(
      /^repos\/example\/skill\/git\/blobs\/(?<sha>[a-f0-9]{40})$/u,
    );
    if (blobMatch?.groups?.sha && blobs.has(blobMatch.groups.sha)) {
      return success({
        encoding: "base64",
        content: Buffer.from(
          blobs.get(blobMatch.groups.sha),
          "utf8",
        ).toString("base64"),
      });
    }
    return {
      status: 1,
      stdout: "",
      stderr: `Unexpected command: ${arguments_.join(" ")}`,
    };
  };
  return {
    root,
    home,
    installed,
    claude,
    claudeConfigDirectory:
      useClaudeConfig ? claudeConfigDirectory : undefined,
    stateDirectory,
    lockPath,
    lock,
    binding,
    publicationProof,
    state,
    runner,
    commands,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Builds the preview and approval shared by apply tests. */
function authorizeFixture(fixture) {
  const preview = buildLocalUpdatePreview(
    fixture.state,
    fixture.binding,
    fixture.installed,
    {
      homeDirectory: fixture.home,
      runner: fixture.runner,
    },
  );
  const approval = buildLocalUpdateApproval(preview, {
    confirmedAt: NOW.toISOString(),
    expiresAt: new Date(
      NOW.getTime() + 15 * 60 * 1000,
    ).toISOString(),
  });
  return { preview, approval };
}

test("supported npx-skills binding and installation are exact", () => {
  const fixture = createUpdateFixture();
  try {
    const binding = validateLocalUpdateBinding(fixture.binding);
    assert.deepEqual(binding.installation.agents, [
      "claude-code",
      "codex",
    ]);
    const local = inspectLocalInstallation(
      fixture.binding,
      fixture.installed,
      { homeDirectory: fixture.home },
    );
    assert.equal(
      local.installed_fingerprint,
      fixture.binding.installed_fingerprint,
    );
    assert.equal(
      local.lock_entry.skillFolderHash,
      fixture.lock.skills["example-skill"].skillFolderHash,
    );
    assert.equal(local.agent_links.length, 2);
    assert.throws(
      () =>
        validateLocalUpdateBinding({
          ...fixture.binding,
          installation: {
            ...fixture.binding.installation,
            mode: "copy",
          },
        }),
      /符號連結模式/u,
    );
    assert.throws(
      () =>
        validateLocalUpdateBinding({
          ...fixture.binding,
          installation: {
            ...fixture.binding.installation,
            agents: ["codex", "unknown-agent"],
          },
        }),
      /允許值|尚未支援/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("supported global XDG Lock and Claude config directories are explicit", () => {
  const fixture = createUpdateFixture({
    useXdgState: true,
    useClaudeConfig: true,
  });
  try {
    const local = inspectLocalInstallation(
      fixture.binding,
      fixture.installed,
      {
        homeDirectory: fixture.home,
        stateDirectory: fixture.stateDirectory,
        claudeConfigDirectory: fixture.claudeConfigDirectory,
      },
    );
    assert.equal(
      local.lock.path,
      fixture.lockPath,
    );
    assert.equal(local.agent_links.length, 2);
    assert.throws(
      () =>
        inspectLocalInstallation(
          fixture.binding,
          fixture.installed,
          {
            homeDirectory: fixture.home,
            stateDirectory: "relative-state",
            claudeConfigDirectory:
              fixture.claudeConfigDirectory,
          },
        ),
      /XDG_STATE_HOME 必須是絕對路徑/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("preview and approval bind the exact release without private paths", () => {
  const fixture = createUpdateFixture({
    releaseTarget: "main",
  });
  try {
    const { preview, approval } = authorizeFixture(fixture);
    assert.equal(preview.state.target_tree_sha, SKILL_TREE);
    assert.equal(preview.state.source_commit, COMMIT);
    assert.equal(preview.state.current_fingerprint,
      fixture.binding.installed_fingerprint);
    assert.equal(
      JSON.stringify(preview).includes(fixture.root),
      false,
    );
    assert.equal(
      verifyLocalUpdateApproval(approval, preview, { now: NOW }),
      true,
    );
    assert.throws(
      () =>
        verifyLocalUpdateApproval(
          { ...approval, to_version: "v2.0.0" },
          preview,
          { now: NOW },
        ),
      /fingerprint/u,
    );
    assert.throws(
      () =>
        buildLocalUpdatePreview(
          {
            ...fixture.state,
            publication_proof: {
              ...fixture.state.publication_proof,
              version: "--help",
              tag: "--help",
              release_url:
                "https://github.com/example/skill/releases/tag/--help",
            },
          },
          fixture.binding,
          fixture.installed,
          {
            homeDirectory: fixture.home,
            runner: fixture.runner,
          },
        ),
      /官方發布證明不完整/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("approved update atomically installs the published Skill and Lock", () => {
  const fixture = createUpdateFixture();
  try {
    const { preview, approval } = authorizeFixture(fixture);
    const result = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.proof.operation, "update");
    assert.equal(result.proof.activation, "future_tasks_only");
    assert.equal(result.proof.source_commit, COMMIT);
    assert.equal(
      readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
      NEW_SKILL,
    );
    assert.equal(
      readFileSync(
        join(fixture.installed, "references", "guide.md"),
        "utf8",
      ),
      NEW_GUIDE,
    );
    const lock = JSON.parse(
      readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      ),
    );
    assert.equal(
      lock.skills["example-skill"].skillFolderHash,
      SKILL_TREE,
    );
    assert.equal(
      lock.skills["example-skill"].ref,
      "v1.0.0",
    );
    assert.equal(
      lock.skills["example-skill"].installedAt,
      fixture.lock.skills["example-skill"].installedAt,
    );
    assert.equal(
      lock.skills["example-skill"].source,
      "example/skill",
    );
    assert.deepEqual(lock.dismissed, fixture.lock.dismissed);
    assert.equal(
      fingerprintTree(fixture.installed),
      result.proof.installed_fingerprint,
    );
  } finally {
    fixture.cleanup();
  }
});

test("fault injection never leaves a false success", () => {
  const scenarios = [
    ["before_source", "not_applied"],
    ["after_staging", "not_applied"],
    ["after_backup", "rolled_back"],
    ["after_switch", "rolled_back"],
    ["after_lock_write", "rolled_back"],
    ["before_postcondition", "rolled_back"],
    ["before_cleanup", "rolled_back"],
  ];
  for (const [stage, expectedStatus] of scenarios) {
    const fixture = createUpdateFixture();
    try {
      const originalLock = readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      );
      const { preview, approval } = authorizeFixture(fixture);
      const result = applyLocalUpdate(preview, approval, {
        binding: fixture.binding,
        installedPath: fixture.installed,
        homeDirectory: fixture.home,
        runner: fixture.runner,
        now: NOW,
        faultInjector(currentStage) {
          if (currentStage === stage) {
            throw new Error(`synthetic ${stage} failure`);
          }
        },
      });
      assert.equal(result.status, expectedStatus, stage);
      assert.equal(result.proof, undefined, stage);
      assert.equal(
        readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
        OLD_SKILL,
        stage,
      );
      assert.equal(
        readFileSync(
          join(fixture.home, ".agents", ".skill-lock.json"),
          "utf8",
        ),
        originalLock,
        stage,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("malformed Lock and local symbolic links block without repair", () => {
  const malformed = createUpdateFixture();
  try {
    const lockPath = join(
      malformed.home,
      ".agents",
      ".skill-lock.json",
    );
    writeFileSync(lockPath, "{ malformed");
    assert.throws(
      () =>
        inspectLocalInstallation(
          malformed.binding,
          malformed.installed,
          { homeDirectory: malformed.home },
        ),
      /不是合法 JSON/u,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "{ malformed");
  } finally {
    malformed.cleanup();
  }

  const invalidTimestamp = createUpdateFixture();
  try {
    const lockPath = join(
      invalidTimestamp.home,
      ".agents",
      ".skill-lock.json",
    );
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.skills["example-skill"].updatedAt = "not-a-date";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.throws(
      () =>
        inspectLocalInstallation(
          invalidTimestamp.binding,
          invalidTimestamp.installed,
          { homeDirectory: invalidTimestamp.home },
        ),
      /Lock entry/u,
    );
  } finally {
    invalidTimestamp.cleanup();
  }

  const hiddenContent = createUpdateFixture();
  try {
    const hiddenPath = join(
      hiddenContent.installed,
      "node_modules",
    );
    mkdirSync(hiddenPath);
    writeFileSync(join(hiddenPath, "payload.js"), "export default 1;\n");
    assert.throws(
      () =>
        inspectLocalInstallation(
          hiddenContent.binding,
          hiddenContent.installed,
          { homeDirectory: hiddenContent.home },
        ),
      /fingerprint 排除目錄/u,
    );
  } finally {
    hiddenContent.cleanup();
  }

  const linked = createUpdateFixture();
  try {
    symlinkSync(
      "../SKILL.md",
      join(linked.installed, "linked.md"),
    );
    assert.throws(
      () =>
        inspectLocalInstallation(
          linked.binding,
          linked.installed,
          { homeDirectory: linked.home },
        ),
      /不可包含 symbolic link/u,
    );
  } finally {
    linked.cleanup();
  }
});

test("post-switch failure restores the original Skill and Lock", () => {
  const fixture = createUpdateFixture();
  try {
    const originalLock = readFileSync(
      join(fixture.home, ".agents", ".skill-lock.json"),
      "utf8",
    );
    const { preview, approval } = authorizeFixture(fixture);
    const result = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
      faultInjector(stage) {
        if (stage === "after_lock_write") {
          throw new Error("synthetic post-switch failure");
        }
      },
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(result.reconciliation.status, "rolled_back");
    assert.equal(
      readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
      OLD_SKILL,
    );
    assert.equal(
      readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      ),
      originalLock,
    );
    assert.equal(
      fingerprintTree(fixture.installed),
      fixture.binding.installed_fingerprint,
    );
  } finally {
    fixture.cleanup();
  }
});

test("postcondition Release drift restores the original installation", () => {
  const fixture = createUpdateFixture();
  try {
    const originalLock = readFileSync(
      join(fixture.home, ".agents", ".skill-lock.json"),
      "utf8",
    );
    const { preview, approval } = authorizeFixture(fixture);
    let tagReads = 0;
    const movingTagRunner = (arguments_) => {
      if (
        arguments_[0] === "api" &&
        arguments_[1] === "repos/example/skill/commits/v1.0.0"
      ) {
        tagReads += 1;
        if (tagReads > 1) {
          return success(`${"9".repeat(40)}\n`);
        }
      }
      return fixture.runner(arguments_);
    };
    const result = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: movingTagRunner,
      now: NOW,
    });
    assert.equal(result.status, "rolled_back");
    assert.equal(
      readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
      OLD_SKILL,
    );
    assert.equal(
      readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      ),
      originalLock,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a verified current publication is reported as already applied", () => {
  const fixture = createUpdateFixture();
  try {
    const first = authorizeFixture(fixture);
    const applied = applyLocalUpdate(
      first.preview,
      first.approval,
      {
        binding: fixture.binding,
        installedPath: fixture.installed,
        homeDirectory: fixture.home,
        runner: fixture.runner,
        now: NOW,
      },
    );
    assert.equal(applied.status, "applied");
    const currentBinding = {
      ...fixture.binding,
      installed_fingerprint: fingerprintTree(fixture.installed),
    };
    const currentState = {
      ...fixture.state,
      from_version: "v1.0.0",
    };
    const preview = buildLocalUpdatePreview(
      currentState,
      currentBinding,
      fixture.installed,
      {
        homeDirectory: fixture.home,
        runner: fixture.runner,
      },
    );
    const approval = buildLocalUpdateApproval(preview, {
      confirmedAt: NOW.toISOString(),
      expiresAt: new Date(
        NOW.getTime() + 15 * 60 * 1000,
      ).toISOString(),
    });
    const result = applyLocalUpdate(preview, approval, {
      binding: currentBinding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.proof.operation, "already_applied");
  } finally {
    fixture.cleanup();
  }
});

test("an unprovable rollback is blocked without claiming success", () => {
  const fixture = createUpdateFixture();
  try {
    const { preview, approval } = authorizeFixture(fixture);
    const result = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
      faultInjector(stage) {
        if (stage === "after_lock_write") {
          throw new Error("synthetic apply failure");
        }
        if (stage === "before_rollback") {
          throw new Error("synthetic rollback failure");
        }
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reconciliation.status, "blocked");
    assert.equal(result.proof, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("published symbolic links are rejected before any local write", () => {
  const fixture = createUpdateFixture();
  try {
    const unsafeRunner = (arguments_) => {
      const result = fixture.runner(arguments_);
      if (
        arguments_[0] === "api" &&
        arguments_[1] ===
          `repos/example/skill/git/trees/${COMMIT}?recursive=1`
      ) {
        const tree = JSON.parse(result.stdout);
        tree.tree.find(
          (entry) =>
            entry.path === "skills/example-skill/SKILL.md",
        ).mode = "120000";
        return success(tree);
      }
      return result;
    };
    assert.throws(
      () =>
        buildLocalUpdatePreview(
          fixture.state,
          fixture.binding,
          fixture.installed,
          {
            homeDirectory: fixture.home,
            runner: unsafeRunner,
          },
        ),
      /symbolic link/u,
    );
    assert.equal(
      readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
      OLD_SKILL,
    );
  } finally {
    fixture.cleanup();
  }
});

test("published submodules and portable path collisions are rejected", () => {
  for (const kind of [
    "submodule",
    "collision",
    "directory_collision",
  ]) {
    const fixture = createUpdateFixture();
    try {
      const unsafeRunner = (arguments_) => {
        const result = fixture.runner(arguments_);
        if (
          arguments_[0] === "api" &&
          arguments_[1] ===
            `repos/example/skill/git/trees/${COMMIT}?recursive=1`
        ) {
          const tree = JSON.parse(result.stdout);
          if (kind === "submodule") {
            tree.tree.push({
              path: "skills/example-skill/vendor",
              mode: "160000",
              type: "commit",
              sha: "9".repeat(40),
            });
          } else if (kind === "collision") {
            tree.tree.push({
              path: "skills/example-skill/skill.md",
              mode: "100644",
              type: "blob",
              sha: blobSha(NEW_GUIDE),
            });
          } else {
            tree.tree.push({
              path: "skills/example-skill/References",
              mode: "040000",
              type: "tree",
              sha: "8".repeat(40),
            });
          }
          return success(tree);
        }
        return result;
      };
      assert.throws(
        () =>
          buildLocalUpdatePreview(
            fixture.state,
            fixture.binding,
            fixture.installed,
            {
              homeDirectory: fixture.home,
              runner: unsafeRunner,
            },
          ),
        kind === "submodule" ? /submodule/u : /路徑衝突/u,
      );
      assert.equal(
        readFileSync(join(fixture.installed, "SKILL.md"), "utf8"),
        OLD_SKILL,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("reconcile proves an applied update without rewriting it", () => {
  const fixture = createUpdateFixture();
  try {
    const { preview, approval } = authorizeFixture(fixture);
    const applied = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
    });
    assert.equal(applied.status, "applied");
    const before = fingerprint({
      skill: fingerprintTree(fixture.installed),
      lock: readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      ),
    });
    const reconciled = reconcileLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: new Date(NOW.getTime() + 60_000),
    });
    const after = fingerprint({
      skill: fingerprintTree(fixture.installed),
      lock: readFileSync(
        join(fixture.home, ".agents", ".skill-lock.json"),
        "utf8",
      ),
    });
    assert.equal(reconciled.status, "applied");
    assert.equal(reconciled.proof.installed_fingerprint,
      applied.proof.installed_fingerprint);
    assert.equal(after, before);
  } finally {
    fixture.cleanup();
  }
});

test("reconcile refuses a moved or deleted publication tag", () => {
  const fixture = createUpdateFixture();
  try {
    const { preview, approval } = authorizeFixture(fixture);
    const applied = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
    });
    assert.equal(applied.status, "applied");
    const driftedRunner = (arguments_) => {
      if (
        arguments_[0] === "api" &&
        arguments_[1] === "repos/example/skill/commits/v1.0.0"
      ) {
        return success(`${"9".repeat(40)}\n`);
      }
      return fixture.runner(arguments_);
    };
    const reconciled = reconcileLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: driftedRunner,
      now: new Date(NOW.getTime() + 60_000),
    });
    assert.equal(reconciled.status, "drifted");
    assert.equal(reconciled.proof, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("source or local drift returns a non-applied reconciliation", () => {
  const fixture = createUpdateFixture();
  try {
    const { preview, approval } = authorizeFixture(fixture);
    writeFileSync(
      join(fixture.installed, "SKILL.md"),
      `${OLD_SKILL}\nManual drift.\n`,
    );
    const result = applyLocalUpdate(preview, approval, {
      binding: fixture.binding,
      installedPath: fixture.installed,
      homeDirectory: fixture.home,
      runner: fixture.runner,
      now: NOW,
    });
    assert.equal(result.status, "not_applied");
    assert.equal(result.reconciliation.status, "not_applied");
    assert.match(result.reason, /fingerprint/u);
  } finally {
    fixture.cleanup();
  }
});

test("CLI preview and approval expose only the deterministic update path", () => {
  const fixture = createUpdateFixture();
  try {
    const statePath = join(fixture.root, "update-state.json");
    const bindingPath = join(fixture.root, "binding.json");
    const previewPath = join(fixture.root, "preview.json");
    writeFileSync(statePath, JSON.stringify(fixture.state));
    writeFileSync(bindingPath, JSON.stringify(fixture.binding));
    const preview = runMaintainerCommand(
      [
        "update-preview",
        "--state",
        statePath,
        "--binding",
        bindingPath,
        "--installed",
        fixture.installed,
      ],
      {
        homeDirectory: fixture.home,
        githubRunner: fixture.runner,
      },
    );
    writeFileSync(previewPath, JSON.stringify(preview));
    const approval = runMaintainerCommand([
      "update-approve",
      "--preview",
      previewPath,
      "--confirmed-at",
      NOW.toISOString(),
      "--expires-at",
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    ]);
    assert.equal(approval.action, "local_update");
    assert.equal(approval.preview_fingerprint, preview.fingerprint);
    assert.throws(
      () =>
        runMaintainerCommand([
          "update-preview",
          "--state",
          statePath,
          "--binding",
          bindingPath,
          "--installed",
          fixture.installed,
          "--candidate",
          fixture.root,
        ]),
      /未知參數/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("CLI apply reserves once and persists the verified update proof", () => {
  const fixture = createUpdateFixture();
  try {
    const providerHash = fingerprint(loadProviderProfiles());
    const state = {
      ...fixture.state,
      provider_contract_hash: providerHash,
    };
    const preview = buildLocalUpdatePreview(
      state,
      fixture.binding,
      fixture.installed,
      {
        homeDirectory: fixture.home,
        runner: fixture.runner,
      },
    );
    const confirmedAt = new Date(Date.now() - 60_000);
    const approval = buildLocalUpdateApproval(preview, {
      confirmedAt: confirmedAt.toISOString(),
      expiresAt: new Date(
        confirmedAt.getTime() + 15 * 60 * 1000,
      ).toISOString(),
    });
    const stateRoot = join(fixture.root, "state");
    const runPath = join(
      stateRoot,
      "runs",
      "run-001",
      "state.json",
    );
    const repositorySnapshot = {
      schema_version: 1,
      base_ref: "main",
      merge_base: "1".repeat(40),
      head_commit: "2".repeat(40),
      diff_hash: "3".repeat(64),
      changed_files: ["SKILL.md"],
      process_artifact_prefixes: ["docs/plans/"],
    };
    const candidateSnapshot = {
      schema_version: 1,
      repository_snapshot: repositorySnapshot,
      candidate_diff_hash: "4".repeat(64),
      changed_files: ["SKILL.md"],
      approved_opt_ids: ["OPT-001"],
      process_artifact_prefixes: ["docs/plans/"],
      file_opt_map: {
        "SKILL.md": ["OPT-001"],
      },
      diff_mapping_complete: true,
      isolated: true,
    };
    mkdirSync(dirname(runPath), { recursive: true });
    writeFileSync(
      runPath,
      `${JSON.stringify({
        schema_version: 8,
        run_id: "run-001",
        binding_id: "binding-001",
        phase: "local_update",
        status: "active",
        target: {
          skill: "example-skill",
          repository: "example/skill",
        },
        approvals: [],
        consumed_approval_fingerprints: [approval.fingerprint],
        attempted_github_action_fingerprints: [],
        github_action_attempts: [],
        github_action_reconciliations: [],
        attempted_local_update_fingerprints: [],
        local_update_attempts: [],
        local_update_reconciliations: [],
        repository_snapshot: repositorySnapshot,
        candidate_snapshot: candidateSnapshot,
        publication_proof: fixture.publicationProof,
        release_version: "v1.0.0",
      }, null, 2)}\n`,
    );
    const previewPath = join(fixture.root, "apply-preview.json");
    const approvalPath = join(fixture.root, "apply-approval.json");
    const bindingPath = join(fixture.root, "apply-binding.json");
    writeFileSync(previewPath, JSON.stringify(preview));
    writeFileSync(approvalPath, JSON.stringify(approval));
    writeFileSync(bindingPath, JSON.stringify(fixture.binding));
    writeFileSync(
      join(fixture.installed, "SKILL.md"),
      `${OLD_SKILL}\nManual drift.\n`,
    );
    assert.throws(
      () =>
        runMaintainerCommand(
          [
            "update-apply",
            "--state-root",
            stateRoot,
            "--run-id",
            "run-001",
            "--preview",
            previewPath,
            "--approval",
            approvalPath,
            "--binding",
            bindingPath,
            "--installed",
            fixture.installed,
          ],
          {
            homeDirectory: fixture.home,
            githubRunner: fixture.runner,
          },
        ),
      /fingerprint/u,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(runPath, "utf8"))
        .attempted_local_update_fingerprints,
      [],
    );
    writeFileSync(join(fixture.installed, "SKILL.md"), OLD_SKILL);
    const result = runMaintainerCommand(
      [
        "update-apply",
        "--state-root",
        stateRoot,
        "--run-id",
        "run-001",
        "--preview",
        previewPath,
        "--approval",
        approvalPath,
        "--binding",
        bindingPath,
        "--installed",
        fixture.installed,
      ],
      {
        homeDirectory: fixture.home,
        githubRunner: fixture.runner,
      },
    );
    assert.equal(result.status, "applied");
    const persisted = JSON.parse(readFileSync(runPath, "utf8"));
    assert.deepEqual(
      persisted.attempted_local_update_fingerprints,
      [approval.fingerprint],
    );
    assert.equal(
      persisted.update_proof.installed_fingerprint,
      result.proof.installed_fingerprint,
    );
    assert.throws(
      () =>
        runMaintainerCommand(
          [
            "update-apply",
            "--state-root",
            stateRoot,
            "--run-id",
            "run-001",
            "--preview",
            previewPath,
            "--approval",
            approvalPath,
            "--binding",
            bindingPath,
            "--installed",
            fixture.installed,
          ],
          {
            homeDirectory: fixture.home,
            githubRunner: fixture.runner,
          },
        ),
      /不可重放/u,
    );
  } finally {
    fixture.cleanup();
  }
});
