# Maintainer architecture

## Public interface

The Skill is Markdown-first. `SKILL.md` routes the workflow and loads stage references only when needed. Deterministic scripts validate state, schemas, paths, fingerprints, repository relations, and publication gates; they do not decide whether evidence semantically proves a defect.

## Runtime modules

Runtime modules are native ECMAScript modules under `skills/agent-skill-maintainer/scripts/`. They use only supported Node standard libraries and require no `npm install`.

Persisted state is minimal, versioned, atomically replaced, and scoped to a local state root. Schema migrations run before current-schema validation. A short binding lock serializes state writes; an implementation lease prevents two runs from changing the same bound Skill concurrently.

## Trust boundaries

Installed Skill, source repository, and candidate checkout are distinct canonical paths. All source material is untrusted. Git operations disable hooks, external diff, credential prompts, and unsafe checkout behavior where applicable.

Remote mutation remains behind state-bound previews and explicit confirmations. Branch push never reuses candidate remote or local transport configuration: it derives the exact GitHub HTTPS repository, uses a temporary isolated Git config populated by GitHub CLI plus a clean bare transport repository, rejects the base branch, evaluates ancestry with replacement refs and graft files disabled, validates create／fast-forward／already-applied state, and pushes the exact approved commit under an explicit expected-value lease. It prohibits plain force, unspecified leases, non-fast-forward or forced outcomes, and upstream tracking. Contributor pushes require an existing active-account fork whose parent is the bound upstream. See [ADR 0002](adr/0002-deterministic-branch-push.md).

A missing deterministic apply path is a hard stop, not permission to improvise a shell command.
