# Agent Skill Maintainer

**Your Agent Skill ran. Something went wrong. Turn that real usage into a tested, release-ready improvement.**

Agent Skill Maintainer reviews what actually happened in a task—not just what a Skill claims to do. It separates reusable Skill defects from one-off preferences or external failures, proposes the smallest justified change, implements approved improvements in isolation, and verifies them before any publication step.

[繁體中文](README.zh-TW.md)

> **Stable contract:** local analysis, isolated candidate implementation, traceable held-out evaluation and release gates, read-only GitHub capability proof, separately confirmed personal Fork／merge／Release actions, optional compound branch-push-plus-PR publication, bounded post-merge continuation, an exact-Release local update path, and transactional cleanup of exact eligible candidate checkouts are validated.

## What can it do?

Point it at one Skill and give it evidence from the current task, a past experience, an Issue, or PR feedback. It can:

- **Find problems users did not explicitly report**, such as a wrong decision, a missing step, unnecessary work, or a workflow that never closes.
- **Preserve the target Skill's intent first** by mapping its purpose, non-goals, invocation and completion contracts, and durable decisions. Popular patterns remain comparative evidence and cannot override verified boundaries.
- **Diagnose structure only when it affects behavior**, including trigger precision, checkable completion, progressive disclosure, duplicated authority, or stale no-op material—not personal formatting taste.
- **Decide whether the Skill should change** by distinguishing a reproducible Skill defect from a preference, stale version, platform limitation, or unrelated request.
- **Turn evidence into a minimal improvement** with a clear scope, expected closure, and regression case.
- **Implement without touching the installed Skill** by working only in a separately confirmed, isolated clone.
- **Review the complete candidate** for regressions, safety, documentation impact, measurable gain, and accidental process-file or private-data leakage.
- **Prepare and control publication** with a read-only capability proof and state-bound confirmations. Initial branch push and PR creation may stay granular or use one exact `publish_pr` confirmation; merge and Release remain separate. Maintainers push to the verified repository; contributors reuse a verified personal Fork or create it through its own confirmed action.
- **Update a supported installed Skill after publication** through a separate preview and confirmation, exact Release commit materialization, atomic replacement, rollback, and read-only recovery. The current task keeps using the version it loaded at startup.
- **Reclaim an eligible completed candidate safely** through a separate source-state-bound preview, expiring approval, attempt-first quarantine, deletion proof, and non-replay recovery. It never broadens cleanup to a parent directory or rewrites the terminal run.

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
| Publication | Capability-bound previews, granular or compound branch／PR proofs, explicit stop dispositions, and separate merge／Release／local-update confirmations |
| Candidate cleanup | A separate transaction for an exact integrated candidate, with immutable source audit, quarantine, proof, and recovery |

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
verified／confirmed Fork → confirmed (branch push → PR) → merge → release
        ↓
separately confirmed exact-Release local update for a future task
```

The workflow can use compatible planning or evaluation Providers when they fill a verified capability gap, but it keeps one owner per artifact and falls back to its native process when no integration adds value.

## Quick start

### 1. Install

Node.js 22 or later and `npx` are required. After a tagged release has been published:

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
<summary>Show local lifecycle, evaluation, GitHub action, update, and cleanup commands</summary>

The Skill also exposes a local deterministic CLI:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

State defaults to `~/.agent-skill-maintainer`. Use `--state-root` to select an isolated location. These commands do not execute Provider commands.

GitHub writes use four ordered steps: create a state-bound preview, create an expiring approval only after explicit confirmation, consume it through the matching lifecycle transition, then apply it from that active run. First generate the read-only capability proof; action state carries that proof rather than a caller-supplied Release flag. Apply records a one-time attempt before re-checking the active account, permission, base and head commits, and Fork, branch, or PR. In `contribute` mode, verify an existing personal Fork first. If it is missing, create it with its own preview and confirmation. Then use either granular branch／PR actions or the compound `publish_pr` path:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-inspect \
  --repository example/skill > github-capability.json

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

# Optional exact compound path:
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action publish_pr --state publish-pr-state.json \
  --candidate "$CANDIDATE" > publish-pr-preview.json
```

The existing-Fork and missing-Fork paths are mutually exclusive: reuse state sets `action_target.operation` to `reuse`, while create state sets it to `create`. Do not feed a failed reuse state into creation without rebuilding and previewing the exact create action.

`publish_pr` contains only the exact branch push and initial PR creation. A push-only result cannot replay the compound approval. Unobservable PR state remains `pending` and permits only read-only reconcile; a fresh granular `pr_create` preview is allowed only after that reconcile proves the PR absent and records `partial`. Merge, Release, and local update are never part of the compound confirmation. Completing after merge requires a `stop_after_merge` disposition and merge proof. A later Release request starts a bounded continuation:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs publication-continue \
  --state-root "$STATE_ROOT" \
  --source-run-id "$SOURCE_RUN_ID" --run-id "$RELEASE_RUN_ID" \
  --binding-id "$BINDING_ID" --merge-proof merge-proof.json
```

For a migrated pre-v8 `legacy_completed` run, this command is also the only supported recovery path. It first requires the persisted candidate, validation, and PR proof, then re-reads the merged PR and compares its repository, number, base, candidate head, and merge commit with the detached proof. Recovery migrates the source only in memory and leaves that terminal audit record unchanged; the new continuation records source-state, merge-proof, and live-verification fingerprints. Any mismatch stops before a continuation run or lease is created; no merge or other remote write is repeated.

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

An eligible completed candidate can be cleaned later through its own transaction. Preview is read-only except for the independent transaction record; create the approval only after showing its exact relative target, fingerprints, file count, and bytes:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs cleanup-preview \
  --state-root "$STATE_ROOT" --source-run-id "$SOURCE_RUN_ID" \
  --candidate "$CANDIDATE_NAME" > cleanup-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs cleanup-approve \
  --state-root "$STATE_ROOT" --preview cleanup-preview.json \
  --confirmed-at "$CONFIRMED_AT" --expires-at "$EXPIRES_AT" \
  > cleanup-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs cleanup-apply \
  --state-root "$STATE_ROOT" --preview cleanup-preview.json \
  --approval cleanup-approval.json > cleanup-proof.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs cleanup-reconcile \
  --state-root "$STATE_ROOT" --transaction-id "$TRANSACTION_ID" \
  --finish false > cleanup-reconciliation.json
```

`cleanup-reconcile --finish true` is allowed only when that same approved transaction already quarantined the exact candidate. The first version cleans no run state, raw evaluation, source clone, parent directory, adjacent candidate, aborted run, or stop-after-PR candidate.

Blinded scoring now has three public artifacts: pre-unblind adjudication, measurement recomputed from private outputs and events, and a derived schema v3 aggregate. `eval-measure` reads the private A／B source files; `eval-adjudicate` computes session and evidence identities from the private randomized assignment, session metadata, and Judge output; `eval-derive` binds both documents to the candidate Skill fingerprint. Raw outputs, the seed, and unredacted Judge evidence remain local.

Set both time variables to fresh ISO 8601 timestamps after confirmation; the expiry should be short-lived. Each transition-updates document must contain the current passed `validation_summary`, exact capability-bound `action_preview`, and its approval array; contributor branch or `publish_pr` actions also include the bound `fork_proof`. The lifecycle validates these documents before consuming the approval.

`github-fork-verify` is read-only and reuses only `<active-account>/<upstream-name>` when it is writable, points to the bound upstream, and exposes the approved base commit. A missing Fork may be created with one `default_branch_only=true` request; asynchronous visibility or an uncertain response stays `pending`, and read-only reconciliation never repeats the request. The CLI tells the user to reconcile later. An explicit GitHub 4xx refusal is `blocked` with a redacted reason; a result still unresolved after five minutes is also `blocked`. Both require manual investigation rather than a blind retry.

For `managed`, branch push targets the verified repository. For `contribute`, it requires the bound Fork proof. Push rejects the base branch, never changes candidate remotes, performs remote transport from a clean temporary bare repository without reading candidate-local Git configuration, disables local replacement refs and graft files during Git graph checks, and pushes the exact approved commit under an explicit expected-value lease so remote-prestate drift fails. Plain force, unspecified leases, non-fast-forward updates, and forced outcomes are prohibited. `github-apply` only accepts an approval already consumed by the active lifecycle transition, and the same approval cannot be replayed after an attempted write. If a remote write may have succeeded but its response was interrupted, `github-reconcile` checks the remote through read-only paths and records the action-specific recovery result. A compound `pending` result permits only reconcile; a compound `partial` result proves PR absence and may fall back only to granular PR creation. An unresolved or applied attempt cannot be retried. The CLI prints JSON to stdout, and the caller decides where local process state is stored. Never create the approval before the exact preview has been shown and confirmed.

</details>

## Verified capability status

Available and tested locally:

- traceable and redacted Evidence → `FB-*` → `OPT-*` or no-improvement contracts;
- versioned forward-stage schemas and recoverable local run state;
- installed/source fingerprint checks and deterministic isolated-clone candidates;
- complete candidate Diff hashing and file-to-`OPT-*` mapping;
- validation gates for safety, regression, documentation impact, and measurable gain;
- randomized A／B adjudication with a distinct Judge session, per-behavior verdict evidence, locally recomputed objective measurement, and a schema v3 aggregate derived from both evidence documents;
- separately confirmed candidate cleanup with immutable source-run bytes, attempt-first quarantine, manifest validation, proof, and interrupted-attempt reconciliation;
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
- five fixed-version formal Provider Profiles with allowlisted commands, isolated real-usage evidence, dual-platform validation, and a native fallback;
- publication, repository-settings, redaction, and process-artifact checks.

Intentionally unsupported in this version:

- worktree creation, organization-owned or custom-named Forks, and Fork synchronization or deletion; the current isolated path uses a local clone and contributor mode supports only the active account's personal Fork;
- project-scoped, copy-mode, plugin, manual, or unknown local Skill updates;
- autonomous GitHub writes, automatic merge or release, and permanent authorization;
- cleanup of run state, raw evaluations, source clones, parent directories, adjacent candidates, non-integrated candidates, or resources whose exact ownership cannot be proven.

## Safety and privacy

- Candidate analysis and implementation keep the installed and currently executing Skill read-only. Only a separately confirmed post-release local-update action may replace a supported installed copy, and it affects future tasks rather than hot-swapping the current task.
- Conversations, Issues, files, hooks, scripts, workflows, and Skill instructions are treated as untrusted evidence.
- Implementation requires an isolated checkout and a dedicated approval.
- Personal Fork creation, PR update, merge, release, local update, and cleanup require separate confirmations. Initial branch push plus PR creation may use `publish_pr` or remain granular. Read-only capability inspection and reuse of an existing valid Fork do not require a write confirmation.
- A merged PR is not treated as a release.
- Raw conversations, plans, evaluations, temporary state, secrets, personal data, private source code, and other local process files do not belong in the public repository. Optimization commits stay focused on the approved change, directly related tests, and required durable contracts or guidance.

## Scope and platform status

The stable contract targets GitHub repositories and Agent Skills. GitLab, Bitbucket, autonomous background scans, permanent authorization, automatic merging, and automatic release are out of scope.

The candidate passed isolated project installation, positive triggering, negative non-triggering, Provider selection, artifact bridging, fallback, stable-ID, decision-boundary, and no-file-mutation checks on Codex CLI `0.139.0` and Claude Code `2.1.220`.

Formal command-scoped Profiles are fixed to Superpowers `v6.2.0`, Spec Kit `v0.14.2`, OpenSpec `v1.6.0`, BMAD Method `v6.10.0`, and Matt Pocock Skills `v1.1.0`. Only each Profile's allowlisted commands may be used, and only after a concrete capability gap, unique artifact owner, exact-version detection, and separate confirmation of side effects. The archived GSD `v1.42.3` remains legacy and command-disabled. Unknown versions remain read-only; missing Providers are unavailable.

## License

[MIT](LICENSE)
