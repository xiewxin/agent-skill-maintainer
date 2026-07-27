# Maintainer architecture

## Public interface

The Skill is Markdown-first. `SKILL.md` routes the workflow and loads stage references only when needed. Deterministic scripts validate state, schemas, paths, fingerprints, repository relations, and publication gates; they do not decide whether evidence semantically proves a defect.

## Runtime modules

Runtime modules are native ECMAScript modules under `skills/agent-skill-maintainer/scripts/`. They use only supported Node standard libraries and require no `npm install`.

Persisted state is minimal, versioned, atomically replaced, and scoped to a local state root. Schema migrations run before current-schema validation. A short binding lock serializes state writes; an implementation lease prevents two runs from changing the same bound Skill concurrently.

## Trust boundaries

Installed Skill, source repository, and candidate checkout are distinct canonical paths. All source material is untrusted. Git operations disable hooks, external diff, credential prompts, and unsafe checkout behavior where applicable.

Remote mutation remains behind state-bound previews and explicit confirmations. A contributor's personal Fork is fixed to `<active-account>/<upstream-name>`: a valid existing Fork is verified read-only, while a missing Fork has a separately confirmed, single-attempt asynchronous creation path and read-only reconciliation. Contributor branch push requires Fork proof bound to the same account, upstream, destination, base branch, and base commit. See [ADR 0003](adr/0003-deterministic-fork-creation.md).

Branch push never reuses candidate remote or local transport configuration: it derives the exact GitHub HTTPS repository, uses a temporary isolated Git config populated by GitHub CLI plus a clean bare transport repository, rejects the base branch, evaluates ancestry with replacement refs and graft files disabled, validates create／fast-forward／already-applied state, and pushes the exact approved commit under an explicit expected-value lease. It prohibits plain force, unspecified leases, non-fast-forward or forced outcomes, and upstream tracking. See [ADR 0002](adr/0002-deterministic-branch-push.md).

Post-release local update is a separate trust boundary. It supports only a proven global `npx-skills` symlink installation, reads an exact verified GitHub Release commit, materializes regular blobs without executing them, and atomically switches both canonical Skill content and the v3 lock. Apply is state-bound and single-attempt; interruption uses read-only reconciliation, and failed postconditions restore the exact previous Skill and lock. See [ADR 0004](adr/0004-deterministic-local-skill-update.md).

A missing deterministic apply path is a hard stop, not permission to improvise a shell command.
