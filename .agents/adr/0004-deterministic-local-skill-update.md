# ADR 0004: Deterministic local Skill update

## Status

Accepted.

## Context

After a verified Release, a maintainer may want the installed Skill updated for later tasks. A generic installer update can follow a moving version, change the installation mode, execute unreviewed behavior, or leave Skill content and lock state inconsistent. Editing the currently loaded Skill also risks changing the running workflow mid-task.

The repository needs one narrow, recoverable path that proves exactly what is installed without weakening the candidate-isolation boundary.

## Decision

Support only global `npx-skills` installations whose canonical content is `.agents/skills/<skill>` and whose Codex and／or Claude Code access follows the normal symlink contract.

A local update:

- begins only after a verified non-draft GitHub Release proof;
- binds the exact Release commit, source repository, Skill subpath, v3 lock entry, installed tree, canonical-path contract, and Agent links;
- has a dedicated preview, short-lived approval, lifecycle transition, one-time attempt reservation, apply, proof, and read-only reconciliation contract;
- reads GitHub tree and blob objects at the exact approved commit;
- accepts regular files and directories only and never executes published content;
- stages beside the canonical directory and atomically replaces both Skill content and lock;
- restores the exact prior Skill and lock when postconditions fail;
- persists fingerprints and repository-relative identity, never local absolute paths;
- affects only future tasks; the current task keeps its startup-loaded Skill.

Project-scoped, copy-mode, plugin, manual, unknown, or drifted installations remain blocked. The workflow never substitutes a generic “update latest” command.

## Consequences

The first update path is deliberately narrow, but it is reproducible, reviewable, and recoverable. Additional installation modes require separate contracts, tests, and confirmation semantics. A blocked or ambiguous recovery remains visible for manual inspection instead of being hidden by cleanup or blind retry.
