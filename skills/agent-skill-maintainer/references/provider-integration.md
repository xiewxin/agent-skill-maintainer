# Provider integration

Use Provider capabilities only when current evidence shows an active artifact or repository requirement and native processing has a concrete gap.

## Selection

- Optional main Provider: zero or one; owns the requirement-level workflow.
- Optional auxiliary Provider: zero or one; fills a distinct, independently usable gap.
- Repository-required Provider: zero or one; allowed only when repository rules require it and ownership does not overlap.

Each activated Provider needs version evidence, capability gap, unique owner, expected benefit, elapsed time, tool-call and artifact-size cost, risk, validation, and fallback. Token usage is not collected or estimated. Isolation checks compare the Provider's primary installation and configuration paths, not unrelated host-agent runtime caches or application state. Installed or popular is not a reason to activate it.

## Profile roles

- Superpowers: design exploration, TDD, review, and verification.
- GitHub Spec Kit: `spec.md`, `plan.md`, and `tasks.md`.
- OpenSpec: proposal, design, tasks, delta, and separate archive lifecycle.
- BMAD: use the repository's active Quick Flow or product artifacts.
- Matt Pocock Skills: conversation-derived specification and vertical ticket decomposition.

These five are formal Profiles. GSD is an archived legacy Profile: its fixed project, requirement, roadmap, state, and phase artifacts may be recognized read-only, but it is not a formal integration and its commands are never authorized.

Skill Creator is auxiliary for trigger metadata, no-skill baseline, candidate A/B, and forward evaluation. A Profile may mark a version verified only for the exact evidence scope recorded in `verification_evidence`; artifact-contract verification never authorizes Provider commands or implies end-to-end platform support. Unknown or incompatible versions remain read-only or unavailable.

Agents Doc Maintainer is an optional auxiliary specialist for root／module placement, contract-aware incremental maintenance, drift checks, and index validation. Activate it only when the candidate has a distinct agent-guidance gap. Its absence never blocks the native documentation contract in `agent-documentation.md`.

Machine-readable Profiles live in `assets/providers/`. A Profile with no `tested_versions` and `last_verified_at` is intentionally unverified: it may help recognize artifacts, but it cannot authorize Provider commands or a formal support claim.

An exact version still defaults to command denial. Command access requires all of the following:

1. the current task has a concrete native capability gap;
2. the Provider has a unique, non-overlapping artifact owner;
3. the detected version exactly matches one tested Release commit;
4. the matching evidence scope is `commands`;
5. every requested command identifier is allowlisted;
6. the user separately confirms any install, initialization, hook, tracker, or other side effect.

The stable aggregate records one isolated real-usage case for each formal Provider. It is a publication gate, not reusable authorization for future Provider executions.
