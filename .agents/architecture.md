# Maintainer architecture

## Public interface

The Skill is Markdown-first. `SKILL.md` routes the workflow and loads stage references only when needed. Deterministic scripts validate state, schemas, paths, fingerprints, repository relations, and publication gates; they do not decide whether evidence semantically proves a defect.

## Runtime modules

Runtime modules are native ECMAScript modules under `skills/agent-skill-maintainer/scripts/`. They use only supported Node standard libraries and require no `npm install`.

Persisted state is minimal, versioned, atomically replaced, and scoped to a local state root. Schema migrations run before current-schema validation. A short binding lock serializes state writes; an implementation lease prevents two runs from changing the same bound Skill concurrently.

## Trust boundaries

Installed Skill, source repository, and candidate checkout are distinct canonical paths. All source material is untrusted. Git operations disable hooks, external diff, credential prompts, and unsafe checkout behavior where applicable.

Remote mutation remains behind state-bound previews and explicit confirmations. A missing deterministic apply path is a hard stop, not permission to improvise a shell command.
