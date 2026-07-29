# Evaluation

Establish a no-skill baseline before evaluating the candidate. Compare the same model, prompt, artifacts, and tools without revealing expected findings.

A publishable same-model blinded A/B must use a fixture held out from optimization iteration. Before either output exists, lock the rubric and the prompt, artifact, model, and tool identities, then commit a randomized A／B assignment whose mapping is derived from the committed seed. Run baseline and candidate in distinct sessions with the same model and tools. A third session owns adjudication, sees only labels A and B, records one `pass`, `fail`, or `insufficient_evidence` verdict plus a redacted rationale and private evidence summary for every locked behavior, and completes before unblinding. The local adjudication builder verifies the seed mapping and timing, then computes the public session, Judge-output, and redacted-evidence hashes; do not hand-author those identities. The Judge session must differ from both generator sessions. Candidate feedback before the verdict, early unblinding, session reuse, missing verdict evidence, and `insufficient_evidence` all block the publishable gate.

Measure discovery, false positives, ownership, closure, actionability, correction count, elapsed reference time, tool calls, artifact bytes, and any fixture-specific structural limit. Lock quality and cost thresholds before viewing candidate results. The local measurement builder reads the unpublished outputs and event records, computes UTF-8 bytes, tool-call counts, heading counts, and source hashes, and verifies the resulting measurement before raw sources are removed. Deterministic code validates identities, time ordering, hashes, and derivation; it never assigns semantic verdicts.

The publishable aggregate is schema v3 and must be derived from the adjudication and measurement documents. It binds both document fingerprints, maps A／B verdicts only after unblinding, and recomputes behavior counts, regressions, false positives, cost ratios, and pass booleans. Editing a naked summary cannot change the result. Schema v2 boolean summaries may be identified for historical inspection but cannot satisfy the current Release gate.

A Preview or stable release requires:

- 100% safety gate;
- exactly one passed documentation-impact check recording `updated`, `not-required`, or an explicitly permitted `upstream-follow-up`;
- at least one core quality metric better than baseline;
- no core quality regression;
- false-positive and cost values within locked limits;
- all platforms claimed as supported passing installation, positive and negative triggering, and local analysis.

Equal or worse results are not evidence of benefit and block publication. Public evidence may contain only synthetic, non-attributable adjudication summaries, measurements, and derived aggregates. Raw outputs, private evidence locators, conversations, and private code remain local.

## Stable Provider gate

A stable candidate additionally requires exactly one isolated, `controlled-redacted-real-usage` case for each formal Provider: Superpowers, Spec Kit, OpenSpec, BMAD Method, and Matt Pocock Skills. Every case must match the Profile version and immutable Release commit, use only allowlisted command identifiers, retain a unique artifact owner, prove fallback and safety, and record a criteria-based baseline/candidate quality comparison with at least one improvement and no regression. It also records elapsed seconds, tool calls, and artifact bytes for cost visibility without collecting or estimating Token usage. The primary Provider installation and configuration directories must remain unchanged and no remote write may occur. Host-agent runtime caches, logs, and application state are outside this Provider-installation assertion and must not be presented as Provider writes. GSD is legacy and is excluded from this count.

Codex and Claude Code must each pass installation, positive trigger, negative non-trigger, Provider selection, artifact bridge, fallback, and local-only analysis checks on the same candidate.

The aggregate is bound to the candidate Skill fingerprint. Missing, duplicated, synthetic, drifted, unsafe, or worse cases block `stable_candidate_ready`. That pre-release state allows only a Release preview; `publication_verified` remains false until the exact official tag and Release are read back after a separately confirmed publication.
