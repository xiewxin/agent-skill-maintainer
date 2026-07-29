# ADR 0008: Transactional candidate cleanup

## Status

Accepted.

## Context

The maintainer intentionally preserved isolated candidates after abort and completion because deletion without exact ownership, approval, and recovery evidence would be unsafe. Terminal runs consequently left managed checkouts with no supported cleanup path. Reusing the lifecycle state would mutate an audit record after completion, while deleting a parent directory or inferring ownership from a name would exceed the maintainer's authority.

## Decision

- Keep the terminal source run byte-for-byte read-only.
- Represent cleanup as a separate versioned transaction with its own preview, expiring approval, attempt, proof, and reconciliation records.
- Accept only a direct-child candidate checkout under the fixed managed candidates root and only when a completed run after merge, Release, or verified local update contains the exact candidate snapshot.
- Revalidate source bytes, candidate identity, clean Git snapshot, canonical path, full regular-file manifest, and active references before reserving an attempt.
- Persist the attempt before mutation, atomically rename the exact checkout into transaction-specific same-filesystem quarantine, verify it again, and remove only the quarantined directory.
- Reject symlinks, special files, traversal, parent cleanup, active or aborted runs, stop-after-PR runs, drift, unknown ownership, and ambiguous recovery.
- Reconcile without replay: distinguish `not_applied`, `pending`, `applied`, and `blocked`; deletion may continue only for the already quarantined resource under the same transaction and an explicit finish.

The first version does not delete run state, raw evaluation, source clones, adjacent candidates, parent directories, or non-maintainer resources.

## Consequences

Candidate storage can be reclaimed without weakening confirmation or audit boundaries. The manifest adds local state proportional to the candidate tree, but it enables safe subset validation after an interrupted recursive delete. Broader retention policies or resource classes require a new decision and tests.
