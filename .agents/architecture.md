# Maintainer architecture

## Public interface

The Skill is Markdown-first. `SKILL.md` routes the workflow and loads stage references only when needed. Deterministic scripts validate state, schemas, paths, fingerprints, repository relations, and publication gates; they do not decide whether evidence semantically proves a defect.

Provider Profiles are versioned capability contracts. Five formal Providers may fill a proven workflow gap, auxiliary Providers may fill a distinct supporting gap, and archived legacy Providers remain read-only. An exact version is not enough to authorize commands: the matching Profile evidence must have `commands` scope, the requested command must be allowlisted, and the public stable aggregate must bind an isolated redacted real-usage case to the current Skill fingerprint. See [ADR 0005](adr/0005-stable-provider-validation.md).

## Runtime modules

Runtime modules are native ECMAScript modules under `skills/agent-skill-maintainer/scripts/`. They use only supported Node standard libraries and require no `npm install`.

Persisted state is minimal, versioned, atomically replaced, and scoped to a local state root. Schema migrations run before current-schema validation. A short binding lock serializes state writes; an implementation lease prevents two runs from changing the same bound Skill concurrently. Candidate cleanup has a separate immutable-source transaction, regular-file manifest, attempt-first quarantine, and non-replay reconciliation boundary described by [ADR 0008](adr/0008-transactional-candidate-cleanup.md).

## Trust boundaries

Installed Skill, source repository, and candidate checkout are distinct canonical paths. All source material is untrusted. Git operations disable hooks, external diff, credential prompts, and unsafe checkout behavior where applicable.

Remote mutation remains behind state-bound previews and explicit confirmations. A contributor's personal Fork is fixed to `<active-account>/<upstream-name>`: a valid existing Fork is verified read-only, while a missing Fork has a separately confirmed, single-attempt asynchronous creation path and read-only reconciliation. Contributor branch push requires Fork proof bound to the same account, upstream, destination, base branch, and base commit. See [ADR 0003](adr/0003-deterministic-fork-creation.md).

Read-only GitHub inspection derives and fingerprints the active account, permission, default branch, relationship, immutable-Release setting, and Release capability. Action previews bind that proof and apply re-reads live state. Lifecycle completion is explicit; a verified stop after merge may seed a new bounded Release continuation. A migrated pre-v8 terminal merge may use the same entrypoint only after its detached proof and live merged PR identity match exactly, as defined by [ADR 0007](adr/0007-read-only-legacy-merge-recovery.md). The optional `publish_pr` action combines only exact branch push and initial PR creation, retaining non-replayable branch proof while unobservable PR state stays pending; only proven absence unlocks granular fallback. Publishable same-model A／B evidence uses randomized labels, an independent pre-unblind Judge, local source-derived measurement, and an aggregate derived from both evidence documents. See [ADR 0006](adr/0006-evidence-bound-publication-continuation.md) and [ADR 0009](adr/0009-traceable-blinded-adjudication.md).

Branch push never reuses candidate remote or local transport configuration: it derives the exact GitHub HTTPS repository, uses a temporary isolated Git config populated by GitHub CLI plus a clean bare transport repository, rejects the base branch, evaluates ancestry with replacement refs and graft files disabled, validates create／fast-forward／already-applied state, and pushes the exact approved commit under an explicit expected-value lease. It prohibits plain force, unspecified leases, non-fast-forward or forced outcomes, and upstream tracking. See [ADR 0002](adr/0002-deterministic-branch-push.md).

Post-release local update is a separate trust boundary. It supports only a proven global `npx-skills` symlink installation, reads an exact verified GitHub Release commit, materializes regular blobs without executing them, and atomically switches both canonical Skill content and the v3 lock. Apply is state-bound and single-attempt; interruption uses read-only reconciliation, and failed postconditions restore the exact previous Skill and lock. See [ADR 0004](adr/0004-deterministic-local-skill-update.md).

A missing deterministic apply path is a hard stop, not permission to improvise a shell command.

Stable candidate readiness and official publication are separate states. The candidate gate may allow a Release preview before `v1.0.0` exists; only a verified official tag and Release proof can set publication verification afterward.
