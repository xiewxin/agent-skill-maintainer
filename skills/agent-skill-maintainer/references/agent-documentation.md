# Agent guidance maintenance

Treat repository guidance as part of a complete candidate, not as a post-merge task automatically left to the upstream author. Update it only when the accepted optimization changes a durable editing, reuse, boundary, safety, validation, or release decision.

## Discover the repository contract

Inspect the smallest useful set of evidence:

- root or nested `AGENTS.md` files relevant to the candidate scope;
- the root index and its linked guide locations, such as `.agents/` or `docs/agents/`;
- machine-owned markers, generators, templates, or section-order contracts;
- referenced paths, commands, tests, and current implementation.

Preserve the target repository's existing location, language, headings, ownership marker, and generator contract. `.agents/` is one convention, not a universal destination. A nested `AGENTS.md` is scoped repository guidance; a document merely stored under `.agents/` is loaded only when the root contract or active task explicitly routes to it.

## Choose the least invasive mode

- `maintain`: incrementally correct existing guidance.
- `contract-aware-maintain`: preserve machine-owned markers, ordering, language, index, and generation rules.
- `bootstrap`: create guidance only when explicitly accepted and no usable contract exists.
- `not-required`: record why the candidate does not change durable guidance.

Do not bootstrap a third-party repository's agent-documentation structure without confirmation.

## Root versus detail

Keep the root `AGENTS.md` concise and stable. It owns project-wide engineering rules, hard boundaries, validation commands, conflict priority, and trigger-oriented links to detail guides.

Put architecture, module, testing, release, or security detail in the repository's existing guide location. Add a guide only when the topic has repeated or non-obvious rules, would make the root specific or long, or cannot fit an existing guide without mixing unrelated concerns.

When a detail guide is added, moved, renamed, removed, or changes scope／read triggers, update the root index with when it must be read. Do not duplicate the detail in the root.

## Candidate checks

Classify proposed documentation changes as keep, update, delete, move, split, merge, bootstrap, or not-required. Before PR validation, verify:

- every added rule has code, config, test, or explicit user evidence;
- root indexes, relative links, referenced paths, and commands resolve;
- no orphan, duplicate, or conflicting guidance was introduced;
- machine-owned contracts remain intact;
- plans, conversations, raw evaluations, personal settings, credentials, and other process artifacts remain excluded.

Record the result as `updated`, `not-required`, or `upstream-follow-up`, with changed guides, root-index action, contract-preservation status, and a concise reason. Carry this record through candidate validation, the Pull Request body, and PR proof. Use `upstream-follow-up` only when repository policy explicitly separates documentation; it is not a default excuse for an incomplete candidate.

If `bootstrap` is accepted, name its target files and structure in an accepted `OPT-*`. The implementation approval fingerprint then covers that explicit bootstrap change; do not treat a general implementation approval as permission to invent agent-documentation structure.

## Optional specialist

If an `agents-doc-maintainer` capability is available, activate it only for the distinct documentation-maintenance gap and keep the candidate owner unchanged. It may perform the focused guidance review, while this Skill remains responsible for evidence ownership, isolation, candidate validation, PR, release, and update gates.

Without that capability, apply this native contract and continue normally.
