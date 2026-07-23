# Agent Skill Maintainer

> Preview software. The workflow and safety contracts are under active validation.

An Agent Skill for turning real usage evidence, corrections, and repository feedback into scoped improvements without editing the installed Skill. The current Preview implements the local contracts, safety foundation, and isolated-clone candidate workflow; remote GitHub mutation is not enabled yet.

## Install

Node.js 22 or later and `npx` are required. After a tagged Preview has been published:

```bash
npx skills add https://github.com/xiewxin/agent-skill-maintainer.git \
  --skill agent-skill-maintainer \
  -g -a codex -a claude-code -y
```

Review the Skill before use; installed Skills run with the agent's permissions.
The installer and runtime are separate: `npx skills add` installs the Skill, while deterministic local actions use the included zero-dependency `.mjs` files. No `npm install` or build step is required after installation.

## Use

```text
Use $agent-skill-maintainer to review the Skill used in this task and propose evidence-backed improvements.
```

Specify the target Skill when known. Without one, the maintainer may show only candidates supported by the current task evidence and asks you to choose.

The Preview also exposes a local-only deterministic CLI:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

State defaults to `~/.agent-skill-maintainer`. Use `--state-root` to select an isolated location. These commands do not access GitHub or execute Provider commands.

## Current Preview status

Implemented and tested locally:

- versioned forward-stage schemas;
- traceable and redacted Evidence → `FB-*` → `OPT-*`／zero-improvement contracts;
- minimal atomic run state, resume data, stale operation-lock recovery, and one implementation lease per binding;
- zero-dependency Node `target`, `start`, `status`, and schema `validate` commands;
- read-only merge-base Git snapshots and state-bound GitHub action previews;
- complete previous-tag-to-candidate change inventories and release-note coverage for commits, Pull Requests, and accepted `OPT-*`;
- installed/source fingerprint checks, isolated clone candidates, complete candidate Diff hashing, and file-to-`OPT-*` mapping;
- validation contracts that require complete Diff mapping and a 100% safety gate;
- conservative Profiles for Superpowers, Spec Kit, OpenSpec, BMAD, GSD, Skill Creator, and Agents Doc Maintainer;
- repository-contract-aware agent-guidance impact checks with a native fallback;
- publication, repository-settings, redaction, Provider-selection, and measurable-gain gates.

Not enabled yet:

- worktree or fork creation; the current isolated path uses a local clone;
- GitHub push, PR, merge, tag, Release, or local Skill update;
- execution of Provider commands;
- formal Codex or Claude Code support claims.

## Safety model

- Installed and currently executing Skills remain read-only.
- Issues, files, hooks, scripts, workflows, and Skill instructions are untrusted evidence.
- Implementation uses an isolated checkout and a dedicated approval.
- PR creation, PR update, merge, release, local update, and cleanup require separate confirmations.
- A merged PR is not treated as a release.
- No raw conversations, secrets, personal data, or private source code belong in the public repository.

## Platform status

Codex and Claude Code are target platforms. A platform is listed as supported only after installation, positive and negative triggering, and the local analysis workflow pass its release gate. Until then, support remains experimental.

All Provider Profiles currently have no verified-version claim. Unknown versions are read-only; missing Providers are unavailable.

## Scope

The Preview targets GitHub repositories and Agent Skills. GitLab, Bitbucket, autonomous background scans, permanent authorization, automatic merging, and automatic release are out of scope.

See [README.zh-TW.md](README.zh-TW.md) for Traditional Chinese.

## License

[MIT](LICENSE)
