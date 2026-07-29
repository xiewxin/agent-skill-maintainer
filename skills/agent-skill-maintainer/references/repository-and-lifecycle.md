# Repository and lifecycle

## Relationship modes

- `managed`: the active GitHub account has verified write, maintain, or admin permission.
- `contribute`: upstream is not writable, but a fork and upstream Pull Request are possible.
- `analyze-only`: binding, source, permission, implementation authorization, or repository relation is missing or ambiguous.

Owner names alone do not determine the mode. Use the read-only GitHub capability proof: active account, repository identity, permission, default branch, and immutable-Release setting derive relationship and Release capability. Bind its fingerprint into action previews and re-read live state before apply; do not accept a caller-supplied `release_enabled` flag.

## Language boundary

Use the user's language for analysis and confirmation. Use the target repository's established language and nearby style for code, tests, comments, internal messages, guidance, Pull Requests, and release notes. When upstream collaboration uses a different established language, preserve it; if evidence is ambiguous, ask before implementation or remote preview.

## Lifecycle

`target_selection → evidence_collection → feedback_validation → optimization_design → optimization_approval → isolation → implementation → validation → [fork_creation] → (publish_pr | branch_push → pr_creation) → pr_update → merge → release → local_update`

`fork_creation` appears only when `contribute` lacks a verified personal Fork. An already valid Fork is checked through the read-only verification path and supplies `operation=reuse` proof without entering the creation action.

Every forward transition consumes versioned upstream output. Missing fields, stale state, or fingerprint drift returns to the owning stage instead of being guessed downstream.

## Isolation boundary

Before candidate creation, recheck the installed fingerprint, source repository snapshot, accepted `OPT-*` content, and implementation approval. The installed, source, and candidate canonical paths must be distinct and must not contain one another; resolve root aliases before comparing them.

Create the candidate with `clone --no-checkout`, disabled hooks, disabled global Git configuration, and no interactive credential prompt. Reject source-tree symlink and submodule entries. Enumerate the reviewed tree and materialize each blob with `git cat-file` instead of a normal checkout, archive extractor, or system `tar`, so an untrusted smudge filter cannot execute and the path checks remain cross-platform. If any guard fails, keep the target `analyze-only` or blocked; never fall back to modifying the installed or source copy.

## Action confirmations

Implementation, Fork creation, PR update, merge, release, local update, and cleanup are distinct actions. Initial branch push and PR creation may remain distinct or use the optional `publish_pr` action under one exact confirmation; no other action joins that compound boundary. Bind each confirmation to the active run, binding, capability proof, account, repository, relationship, base/head branches and commits, Diff hash, action target, Provider contracts, and expiry. Consume a confirmation after one successful transition; repeating the same action requires a new preview and confirmation even when the target is unchanged.

For `contribute`, the personal Fork destination is fixed to the active account and upstream repository name. A valid existing Fork is reused read-only. A missing Fork uses a separately confirmed `fork_create` request with `default_branch_only=true`; apply records the attempt before POST. The post-reservation preflight is still before the remote write, so its failure records `not_applied` and requires a fresh preview and confirmation. Once POST begins, an interrupted transport or otherwise uncertain response stays `pending`; an explicit GitHub 4xx refusal records `blocked` plus a redacted reason. Reconciliation never repeats POST. Five minutes after an unresolved attempt it becomes `blocked`; insufficient Fork permission also blocks, while identity, parent, account, or upstream-relationship mismatch becomes drift. Pending results instruct a later read-only reconcile; blocked results instruct manual investigation.

Branch push requires a clean fully committed candidate whose canonical path fingerprint, non-base branch, HEAD, snapshot and Diff still match the active run. `managed` targets the verified upstream repository. `contribute` additionally requires verified Fork proof bound to the same active account, upstream, personal destination, base branch, and base commit. Remote branch creation and fast-forward use the exact approved commit plus an explicit expected-value lease as a compare-and-swap guard; already-at-commit verification does not write. Divergence, remote-prestate drift, non-fast-forward updates, and forced outcomes block.

`publish_pr` applies that exact branch operation first, then creates the exact initial Pull Request. It records both proofs when complete. If the branch is verified but PR state is unobservable, it records non-replayable `pending` plus branch proof and permits only read-only reconcile. If read-only checks prove the PR absent, it records `partial`; only that state may enter granular `pr_creation` with a fresh preview and confirmation. It never repeats the push or broadens the compound action to merge.

Abort invalidates approvals but does not delete candidate work. Cleanup requires a separate preview containing the exact run and resources.

Local run state is versioned and written atomically. A short operation lock serializes state writes; entering isolated implementation also acquires a persistent lease for the binding. Another run cannot implement the same binding until the owning run reaches a terminal state. A stale short lock may be recovered only when its owner process no longer exists.

The current lifecycle state schema is v8 and uses the full stage names above. It records local-update attempt fingerprints, mutation-free reconciliation outcomes, verified update proofs, explicit completion dispositions, and bounded publication-continuation provenance without absolute installation paths. Entering `local_update` requires the exact publication proof, preview, and local-update approval. Apply reserves a fingerprint once before mutation. `completed` is legal only with the phase-matched disposition and required proof: no improvements, stop after PR, stop after verified merge, stop after verified Release, or verified local update. A later release continuation is normally seeded from a terminal `stop_after_merge` run and its exactly matching merge proof. A migrated pre-v8 `legacy_completed` run is the only exception: its candidate, validation and PR proof must remain complete, the detached merge proof must match them, and a fresh read-only GitHub observation must confirm the exact PR number, base, candidate head, merged state and merge commit before any continuation state or lease is created. That recovery migrates the source in memory with persistence disabled, leaves the terminal audit record byte-for-byte unchanged, and writes the source completion kind plus source-state, merge-proof, and live-verification fingerprints only into the new continuation. A retry transition is legal only after a recorded `not_applied` or `rolled_back` outcome and always needs a new preview and confirmation.

Legacy Preview states are migrated deterministically before current-schema validation when every required proof can be preserved. A terminal `legacy_completed` run may recover only through the bounded read-only merge verification above; manual state repair is not a substitute. A known active remote-action or local-update state whose required proof cannot be inferred is blocked with recovery guidance; unknown versions or phases are blocked instead of guessed.
