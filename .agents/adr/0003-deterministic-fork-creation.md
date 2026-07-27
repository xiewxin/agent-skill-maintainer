# ADR 0003: Deterministic personal Fork creation

## Status

Accepted on 2026-07-24.

## Context

`contribute` publication needs a writable personal Fork before branch push. Treating a missing Fork as a manual prerequisite leaves the workflow incomplete, while an ordinary retry loop is unsafe because GitHub accepts Fork creation asynchronously and a lost response does not prove that the POST failed.

## Decision

- Fork creation is a separate `fork_create` action with its own state-bound preview, expiring confirmation, reserved attempt, apply, and read-only reconcile.
- The destination is fixed to `<active-account>/<upstream-repository-name>`. Organization destinations, custom names, clone, and Git remote changes are not supported.
- Creation uses one argument-array call to GitHub REST with `default_branch_only=true`.
- An existing writable personal Fork whose parent is the approved upstream is verified read-only and produces `operation=reuse` proof without a creation action.
- A new Fork produces proof only after owner, parent, permission, and availability of the approved base commit are verified.
- An accepted but not yet observable creation or uncertain response remains `pending`. An explicit GitHub 4xx refusal records `blocked` with a redacted reason. Reconcile never repeats POST; after five minutes an unresolved result becomes `blocked`. Insufficient Fork permission also blocks; identity, parent, account, or upstream-relationship drift becomes `drifted`.
- `contribute` branch push requires Fork proof bound to the same account, upstream, destination, base branch, and base commit.

## Consequences

The contributor path can close without an ad-hoc GitHub command, and an interrupted Fork request cannot create duplicates through blind retry. The current release still excludes organization Forks, synchronization of stale Forks, Fork deletion, and automatic waiting longer than one minute.
