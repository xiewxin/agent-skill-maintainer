# Provider integration

Use Provider capabilities only when current evidence shows an active artifact or repository requirement and native processing has a concrete gap.

## Selection

- Optional main Provider: zero or one; owns the requirement-level workflow.
- Optional auxiliary Provider: zero or one; fills a distinct, independently usable gap.
- Repository-required Provider: zero or one; allowed only when repository rules require it and ownership does not overlap.

Each activated Provider needs version evidence, capability gap, unique owner, expected benefit, Token/tool/time cost, risk, validation, and fallback. Installed or popular is not a reason to activate it.

## Formal Profiles

- Superpowers: design exploration, TDD, review, and verification.
- GitHub Spec Kit: `spec.md`, `plan.md`, and `tasks.md`.
- OpenSpec: proposal, design, tasks, delta, and separate archive lifecycle.
- BMAD: use the repository's active Quick Flow or product artifacts.
- GSD: use the current project, requirement, roadmap, state, and phase artifacts.

Skill Creator is auxiliary for trigger metadata, no-skill baseline, candidate A/B, and forward evaluation. Unknown or incompatible versions remain read-only or unavailable; never claim full support without verified evidence.

Agents Doc Maintainer is an optional auxiliary specialist for root／module placement, contract-aware incremental maintenance, drift checks, and index validation. Activate it only when the candidate has a distinct agent-guidance gap. Its absence never blocks the native documentation contract in `agent-documentation.md`.

Machine-readable Profiles live in `assets/providers/`. A Profile with no `tested_versions` and `last_verified_at` is intentionally unverified: it may help recognize artifacts, but it cannot authorize Provider commands or a formal support claim.
