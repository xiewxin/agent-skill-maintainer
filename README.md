# Agent Skill Maintainer

**Your Agent Skill ran. Something went wrong. Turn that real usage into a tested, release-ready improvement.**

Agent Skill Maintainer reviews what actually happened in a task—not just what a Skill claims to do. It separates reusable Skill defects from one-off preferences or external failures, proposes the smallest justified change, implements approved improvements in isolation, and verifies them before any publication step.

[繁體中文](README.zh-TW.md)

> **Preview:** local analysis, isolated candidate implementation, release gates, and separately confirmed GitHub branch push, PR, merge, and Release apply are implemented. Local Skill update and the complete live lifecycle are still being validated.

## What can it do?

Point it at one Skill and give it evidence from the current task, a past experience, an Issue, or PR feedback. It can:

- **Find problems users did not explicitly report**, such as a wrong decision, a missing step, unnecessary work, or a workflow that never closes.
- **Decide whether the Skill should change** by distinguishing a reproducible Skill defect from a preference, stale version, platform limitation, or unrelated request.
- **Turn evidence into a minimal improvement** with a clear scope, expected closure, and regression case.
- **Implement without touching the installed Skill** by working only in a separately confirmed, isolated clone.
- **Review the complete candidate** for regressions, safety, documentation impact, measurable gain, and accidental process-file or private-data leakage.
- **Prepare and control publication** with separate previews and confirmations for branch push, PR, merge, and Release actions. Maintainers push to the verified repository; contributors push only to their verified existing fork.

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
| Publication | State-bound previews, branch-push proof, and separate confirmations for each supported GitHub write |

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
confirmed branch push → PR → merge → release
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
<summary>Show local lifecycle and GitHub action commands</summary>

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

GitHub actions use three separate steps: create a state-bound preview, create an expiring approval only after explicit confirmation, then apply it from the matching active run. The lifecycle consumes the approval first; apply records a one-time attempt before re-checking the active account, permission, base and head commits, and branch or PR. Push the clean committed candidate branch with its own confirmation before previewing PR creation:

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action branch_push --state branch-push-state.json \
  --candidate "$CANDIDATE"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview github-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  --candidate "$CANDIDATE"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json
```

Set both time variables to fresh ISO 8601 timestamps after confirmation; the expiry should be short-lived. For `managed`, branch push targets the verified repository. For `contribute`, it requires an existing writable fork owned by the active account and verified as a child of upstream; this Preview does not create a fork. It rejects the base branch, never changes candidate remotes, performs remote transport from a clean temporary bare repository without reading candidate-local Git configuration, disables local replacement refs and graft files during Git graph checks, and pushes the exact approved commit under an explicit expected-value lease so remote-prestate drift fails. Plain force, unspecified leases, non-fast-forward updates, and forced outcomes are prohibited. `github-apply` only accepts an approval already consumed by the active lifecycle transition, and the same approval cannot be replayed after an attempted write. If the remote write may have succeeded but its response was interrupted, `github-reconcile` checks the remote through read-only paths: it either reconstructs the bound proof, or records a `not_applied` absence proof. Only the latter unlocks a new preview and separate confirmation; an unresolved attempt cannot be retried. The CLI prints JSON to stdout, and the caller decides where local process state is stored. Never create the approval before the exact preview has been shown and confirmed.

</details>

## Current Preview status

Available and tested locally:

- traceable and redacted Evidence → `FB-*` → `OPT-*` or no-improvement contracts;
- versioned forward-stage schemas and recoverable local run state;
- installed/source fingerprint checks and deterministic isolated-clone candidates;
- complete candidate Diff hashing and file-to-`OPT-*` mapping;
- validation gates for safety, regression, documentation impact, and measurable gain;
- clean-candidate branch creation／fast-forward／already-applied verification for managed repositories and verified existing contributor forks, with exact commit and remote-prestate binding and without history replacement, candidate-local transport configuration, or candidate-remote mutation;
- state-bound GitHub previews and deterministic apply for PR creation, update, merge, and Release;
- read-only recovery or absence proof for branch push, PR, merge, or Release after an interrupted apply;
- active-account, permission, base/head-commit, branch or PR, approval-expiry, active-run, replay, and argument-safety checks before every GitHub write;
- unused-tag, Release-immutability, and post-creation commit checks for GitHub Release;
- non-draft Release enforcement before an official publication proof can be produced;
- complete previous-tag-to-candidate release-note coverage;
- conservative Provider Profiles with a native fallback;
- publication, repository-settings, redaction, and process-artifact checks.

Still being validated before it is enabled or claimed as supported:

- worktree or fork creation; the current isolated path uses a local clone and contributor push requires an existing fork;
- local Skill update;
- execution of Provider commands;
- formal Codex or Claude Code support and the complete live GitHub lifecycle.

## Safety and privacy

- Installed and currently executing Skills remain read-only.
- Conversations, Issues, files, hooks, scripts, workflows, and Skill instructions are treated as untrusted evidence.
- Implementation requires an isolated checkout and a dedicated approval.
- Branch push, PR creation, PR update, merge, release, local update, and cleanup require separate confirmations.
- A merged PR is not treated as a release.
- Raw conversations, plans, evaluations, temporary state, secrets, personal data, private source code, and other local process files do not belong in the public repository. Optimization commits stay focused on the approved change, directly related tests, and required durable contracts or guidance.

## Scope and platform status

The Preview targets GitHub repositories and Agent Skills. GitLab, Bitbucket, autonomous background scans, permanent authorization, automatic merging, and automatic release are out of scope.

The candidate passed isolated project installation, positive triggering, negative non-triggering, reference reading, stable-ID, decision-boundary, and no-file-mutation checks on Codex CLI `0.139.0` and Claude Code `2.1.152`. The complete live GitHub lifecycle remains Preview until its separate release gate passes.

The read-only artifact contracts are version-scoped to Superpowers `v6.1.1`, Spec Kit `v0.13.4`, OpenSpec `v1.6.0`, BMAD Method `v6.10.0`, and the archived GSD `v1.42.3`. This does not authorize Provider commands or claim end-to-end platform support. Unknown versions remain read-only; missing Providers are unavailable.

## License

[MIT](LICENSE)
