# ADR 0007: Read-only legacy merge recovery

## Status

Accepted.

## Context

Schema v8 requires an explicit `stop_after_merge` disposition and an in-state merge proof before a later Release continuation. A pre-v8 controller could finish after merge while persisting the exact merge proof beside the terminal run instead of inside it. Deterministic migration correctly labels that run `legacy_completed`, but the normal continuation path cannot distinguish a real legacy merge from an unsupported terminal state.

Manually editing the run, repeating the merge, or trusting the detached proof alone would weaken the evidence boundary.

## Decision

- Keep the normal `stop_after_merge` continuation unchanged.
- Allow `publication-continue` to recover only a migrated `legacy_completed` terminal run that still has a valid candidate, validation summary, and open PR proof bound to the candidate head and base branch.
- Require the separately persisted merge proof to match the source repository and PR proof.
- Re-read the Pull Request through GitHub without mutation and require its number, base branch, head commit, merged state, merge commit, and supplied merge proof to match exactly.
- Verify all evidence before creating the continuation run or acquiring its implementation lease.
- Migrate the source only in memory with persistence disabled, so recovery leaves the terminal audit record byte-for-byte unchanged.
- Record the source completion kind plus source-state, merge-proof, and live-verification fingerprints in the new v8 continuation.
- Reject ordinary terminal dispositions, an existing in-state legacy merge proof, incomplete evidence, unmerged PRs, identity drift, and every proof mismatch.

## Consequences

Known pre-v8 merges can finish publication without manual state edits or a repeated GitHub write. Recovery performs one additional read-only GitHub request and remains unavailable when the old evidence is incomplete or ambiguous.
