# ADR 0010: Bound legacy remote Skill identity

## Status

Accepted. Supersedes [ADR 0007](0007-read-only-legacy-merge-recovery.md).

## Context

ADR 0007 permits read-only continuation from a verified pre-v8 terminal merge. Historical snapshots can lack the Skill name and repository-relative path now required to bind Release validation to one complete remote Skill tree. Trusting a caller-selected path, a working copy, or only changed files would allow an ambiguous or incomplete identity to enter the continuation.

## Decision

- Keep recovery limited to a migrated terminal `legacy_completed` run with complete historical candidate, validation, PR, and freshly observed merge evidence.
- Retrieve the complete freshly paginated PR changed-file set and require exact canonical equality with the persisted snapshot before trusting any historical path.
- If the old snapshot lacks Skill name/path, read changed `SKILL.md` paths only from that verified remote set and the freshly observed merge commit tree.
- Require exactly one frontmatter name matching the persisted target.
- Read the complete matching Skill subtree from that same merge commit and recompute its deterministic mode/path/blob fingerprint and file count.
- Apply strict size and entry-count bounds and reject missing, oversized, ambiguous, linked, or non-regular remote entries.
- Record the remote-file and merge-bound Skill identities in the new continuation without changing the terminal source bytes or repeating any remote write. Read-only status parsing may migrate in memory but must not persist the source.

## Consequences

Legacy recovery can produce the exact candidate identity required by current Release validation while remaining read-only. It performs bounded tree/blob reads and fails closed when historical or remote identity evidence is incomplete or ambiguous.
