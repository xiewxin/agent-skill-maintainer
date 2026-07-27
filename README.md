# Agent Skill Maintainer

**Your Agent Skill ran. Something went wrong. Turn that real usage into a tested, release-ready improvement.**

Agent Skill Maintainer reviews what actually happened in a task—not just what a Skill claims to do. It separates reusable Skill defects from one-off preferences or external failures, proposes the smallest justified change, implements approved improvements in isolation, and verifies them before any publication step.

[繁體中文](README.zh-TW.md)

> **Preview:** local analysis, isolated candidate implementation, release gates, separately confirmed GitHub personal Fork／branch／PR／merge／Release apply, and an exact-Release local update path for supported global `npx skills` installs are implemented. The complete live lifecycle is still being validated.

## What can it do?

Point it at one Skill and give it evidence from the current task, a past experience, an Issue, or PR feedback. It can:

- **Find problems users did not explicitly report**, such as a wrong decision, a missing step, unnecessary work, or a workflow that never closes.
- **Decide whether the Skill should change** by distinguishing a reproducible Skill defect from a preference, stale version, platform limitation, or unrelated request.
- **Turn evidence into a minimal improvement** with a clear scope, expected closure, and regression case.
- **Implement without touching the installed Skill** by working only in a separately confirmed, isolated clone.
- **Review the complete candidate** for regressions, safety, documentation impact, measurable gain, and accidental process-file or private-data leakage.
- **Prepare and control publication** with separate previews and confirmations for personal Fork creation, branch push, PR, merge, and Release actions. Maintainers push to the verified repository; contributors reuse a verified personal Fork or create it through its own confirmed action.
- **Update a supported installed Skill after publication** through a separate preview and confirmation, exact Release commit materialization, atomic replacement, rollback, and read-only recovery. The current task keeps using the version it loaded at startup.

It is designed for maintainers improving an existing Agent Skill. It is not a general code reviewer, a new-Skill generator, or an autonomous background scanner.

## A concrete example

Suppose a planning Skill chose the wrong language and produced an optional report by default. Instead of immediately editing its prompt, start with the real task:

```text
Use $agent-skill-maintainer to review ai-development-workflow.
The user had to correct its language choice and disable an optional report.
Check this task for other decision failures, then propose only reusable
improvements that belong to that Skill.
```

The maintainer verifies the released behavior, classifies each observation, and returns a concise decision:

```text
FB-001  Default language ignored the target repository convention.
        Reproduced on the current released version; confidence: high.

OPT-001 Follow repository/user language selection before applying a fallback.
        Minimum change: update the routing rule and add positive/negative cases.
        Decision: accepted.

Candidate
- implemented in an isolated checkout;
- installed Skill unchanged;
- regression and documentation checks passed;
- PR action awaits its own confirmation.
```

If the evidence does not justify a change, “no improvement needed” is a valid result. The workflow does not invent work to make the review look productive.

## What you get

| Stage | Result |
| --- | --- |
| Evidence review | Traceable `FB-*` findings with source, affected version, reproduction status, and confidence |
| Improvement design | Scoped `OPT-*` proposals tied to the Skill's purpose, minimum change, closure, and regression case |
| Human decision | An explicit `accepted`, `rejected`, `deferred`, or `needs_evidence` decision for every proposal |
| Candidate implementation | A separately approved isolated clone; the installed and currently executing Skill remain unchanged |
| Validation | Complete Diff mapping plus safety, regression, documentation, measurable-gain, privacy, and repository-hygiene checks |
| Publication | State-bound previews, Fork／branch／release／local-update proofs, and separate confirmations for every supported write |

## Why not just edit the Skill?

Usage feedback is valuable but ambiguous. A correction may be a real defect, a new requirement, a style preference, stale-version behavior, or a limitation owned by another tool. Direct edits easily create scope creep and regressions.

Agent Skill Maintainer adds the missing maintenance loop:

```text
real use / feedback
        ↓
evidence → FB-* → OPT-* or no change
        ↓
human decision
        ↓
isolated implementation → tests → complete Diff review
        ↓
verified／confirmed Fork → confirmed branch push → PR → merge → release
        ↓
separately confirmed exact-Release local update for a future task
```

The workflow can use compatible planning or evaluation Providers when they fill a verified capability gap, but it keeps one owner per artifact and falls back to its native process when no integration adds value.

## Quick start

### 1. Install

Node.js 22 or later and `npx` are required. After a tagged Preview has been published:

```bash
npx skills add https://github.com/xiewxin/agent-skill-maintainer.git \
  --skill agent-skill-maintainer \
  -g -a codex -a claude-code -y
```

Review the Skill before use; installed Skills run with the agent's permissions. The installer and runtime are separate: `npx skills add` installs the Skill, while deterministic local actions use the included zero-dependency `.mjs` files. No `npm install` or build step is required after installation.

### 2. Review a Skill

```text
Use $agent-skill-maintainer to review the Skill used in this task and propose evidence-backed improvements.
```

Specify the target Skill when known. Without one, the maintainer may show only candidates supported by the current task evidence and asks you to choose. It never scans every installed Skill by default.

## Deterministic CLI (advanced)

<details>
<summary>Show local lifecycle, GitHub action, and local update commands</summary>

The Preview also exposes a local deterministic CLI:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

State defaults to `~/.agent-skill-maintainer`. Use `--state-root` to select an isolated location. These commands do not execute Provider commands.

GitHub writes use four ordered steps: create a state-bound preview, create an expiring approval only after explicit confirmation, consume it through the matching lifecycle transition, then apply it from that active run. Apply records a one-time attempt before re-checking the active account, permission, base and head commits, and Fork, branch, or PR. In `contribute` mode, verify an existing personal Fork first. If it is missing, create it with its own preview and confirmation. Then push the clean committed candidate branch with another confirmation before previewing PR creation:

```bash
# Existing-Fork path (`action_target.operation` is `reuse`):
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-fork-verify \
  --state fork-reuse-state.json > fork-proof.json

# Missing-Fork path (`action_target.operation` is `create`):
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action fork_create --state fork-create-state.json > fork-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview fork-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > fork-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase fork_creation --updates fork-transition-updates.json \
  > fork-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview fork-preview.json --approval fork-approval.json \
  > fork-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview fork-preview.json --approval fork-approval.json \
  > fork-reconciliation.json

node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action branch_push --state branch-push-state.json \
  --candidate "$CANDIDATE" > github-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview github-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > github-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase branch_push --updates branch-transition-updates.json \
  > branch-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  --candidate "$CANDIDATE" > github-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  > github-reconciliation.json
```

The existing-Fork and missing-Fork paths are mutually exclusive: reuse state sets `action_target.operation` to `reuse`, while create state sets it to `create`. Do not feed a failed reuse state into creation without rebuilding and previewing the exact create action.

After an official publication proof exists, a supported local update uses its own preview, approval, lifecycle transition, apply, and read-only reconcile:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-preview \
  --state update-state.json --binding binding.json \
  --installed "$INSTALLED_SKILL" > update-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-approve \
  --preview update-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > update-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase local_update --updates update-transition-updates.json \
  > update-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview update-preview.json --approval update-approval.json \
  --binding binding.json --installed "$INSTALLED_SKILL" \
  > update-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview update-preview.json --approval update-approval.json \
  --binding binding.json --installed "$INSTALLED_SKILL" \
  > update-reconciliation.json
```

The first supported installation contract is a global `npx-skills` install whose canonical `.agents/skills/<skill>` directory is shared with Codex and／or Claude Code through the normal symlink layout. The standard global v3 Lock location, absolute `XDG_STATE_HOME`, and absolute `CLAUDE_CONFIG_DIR` are recognized. The binding, Lock, source repository, Skill subpath, canonical path fingerprint, installed tree, and Agent links must all agree. The update reads only the exact official Release commit, rejects source symlinks and submodules, atomically switches the canonical directory and lock entry, advances the Lock `ref` to that Release tag, and restores both on a failed postcondition. It never calls a generic “update latest” path. Project, copy, plugin, manual, and unknown installs are blocked instead of being converted to another method.

Set both time variables to fresh ISO 8601 timestamps after confirmation; the expiry should be short-lived. Each transition-updates document must contain the current passed `validation_summary`, the exact `action_preview`, and its approval array; contributor branch push also includes the bound `fork_proof`. The lifecycle validates these documents before consuming the approval.

`github-fork-verify` is read-only and reuses only `<active-account>/<upstream-name>` when it is writable, points to the bound upstream, and exposes the approved base commit. A missing Fork may be created with one `default_branch_only=true` request; asynchronous visibility or an uncertain response stays `pending`, and read-only reconciliation never repeats the request. The CLI tells the user to reconcile later. An explicit GitHub 4xx refusal is `blocked` with a redacted reason; a result still unresolved after five minutes is also `blocked`. Both require manual investigation rather than a blind retry.

For `managed`, branch push targets the verified repository. For `contribute`, it requires the bound Fork proof. Push rejects the base branch, never changes candidate remotes, performs remote transport from a clean temporary bare repository without reading candidate-local Git configuration, disables local replacement refs and graft files during Git graph checks, and pushes the exact approved commit under an explicit expected-value lease so remote-prestate drift fails. Plain force, unspecified leases, non-fast-forward updates, and forced outcomes are prohibited. `github-apply` only accepts an approval already consumed by the active lifecycle transition, and the same approval cannot be replayed after an attempted write. If a remote write may have succeeded but its response was interrupted, `github-reconcile` checks the remote through read-only paths and records the action-specific recovery result. An unresolved or applied attempt cannot be retried. The CLI prints JSON to stdout, and the caller decides where local process state is stored. Never create the approval before the exact preview has been shown and confirmed.

</details>

## Current Preview status

Available and tested locally:

- traceable and redacted Evidence → `FB-*` → `OPT-*` or no-improvement contracts;
- versioned forward-stage schemas and recoverable local run state;
- installed/source fingerprint checks and deterministic isolated-clone candidates;
- complete candidate Diff hashing and file-to-`OPT-*` mapping;
- validation gates for safety, regression, documentation impact, and measurable gain;
- read-only reuse or separately confirmed single-attempt creation of the active account's personal Fork, with owner, parent, permission, base-commit, pending, blocked, and drift checks;
- clean-candidate branch creation／fast-forward／already-applied verification for managed repositories and verified existing contributor forks, with exact commit and remote-prestate binding and without history replacement, candidate-local transport configuration, or candidate-remote mutation;
- state-bound GitHub previews and deterministic apply for PR creation, update, merge, and Release;
- read-only recovery for Fork creation and recovery or absence proof for branch push, PR, merge, or Release after an interrupted apply;
- active-account, permission, base/head-commit, branch or PR, approval-expiry, active-run, replay, and argument-safety checks before every GitHub write;
- unused-tag, Release-immutability, and post-creation commit checks for GitHub Release;
- non-draft Release enforcement before an official publication proof can be produced;
- separately confirmed local update for supported global `npx-skills` symlink installs, pinned to the verified Release commit with atomic Skill／Lock replacement, rollback, proof, and read-only reconciliation;
- controlled temporary-HOME update from one public Release to the next, including Codex canonical content, Claude Code symlink, exact Lock `ref`, and the official `skills check -g` result;
- complete previous-tag-to-candidate release-note coverage;
- conservative Provider Profiles with a native fallback;
- publication, repository-settings, redaction, and process-artifact checks.

Still being validated before it is enabled or claimed as supported:

- worktree creation, organization-owned or custom-named Forks, and Fork synchronization or deletion; the current isolated path uses a local clone and contributor mode supports only the active account's personal Fork;
- project-scoped, copy-mode, plugin, manual, or unknown local Skill updates;
- execution of Provider commands;
- formal Codex or Claude Code support and the complete live GitHub lifecycle.

## Safety and privacy

- Candidate analysis and implementation keep the installed and currently executing Skill read-only. Only a separately confirmed post-release local-update action may replace a supported installed copy, and it affects future tasks rather than hot-swapping the current task.
- Conversations, Issues, files, hooks, scripts, workflows, and Skill instructions are treated as untrusted evidence.
- Implementation requires an isolated checkout and a dedicated approval.
- Personal Fork creation, branch push, PR creation, PR update, merge, release, local update, and cleanup require separate confirmations. Read-only verification and reuse of an existing valid Fork does not.
- A merged PR is not treated as a release.
- Raw conversations, plans, evaluations, temporary state, secrets, personal data, private source code, and other local process files do not belong in the public repository. Optimization commits stay focused on the approved change, directly related tests, and required durable contracts or guidance.

## Scope and platform status

The Preview targets GitHub repositories and Agent Skills. GitLab, Bitbucket, autonomous background scans, permanent authorization, automatic merging, and automatic release are out of scope.

The candidate passed isolated project installation, positive triggering, negative non-triggering, reference reading, stable-ID, decision-boundary, and no-file-mutation checks on Codex CLI `0.139.0` and Claude Code `2.1.152`. The complete live GitHub lifecycle remains Preview until its separate release gate passes.

The read-only artifact contracts are version-scoped to Superpowers `v6.1.1`, Spec Kit `v0.13.4`, OpenSpec `v1.6.0`, BMAD Method `v6.10.0`, and the archived GSD `v1.42.3`. This does not authorize Provider commands or claim end-to-end platform support. Unknown versions remain read-only; missing Providers are unavailable.

## License

[MIT](LICENSE)
