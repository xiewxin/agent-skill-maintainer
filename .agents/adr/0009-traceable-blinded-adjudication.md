# ADR 0009: Traceable blinded adjudication

## Status

Superseded by [ADR 0011](0011-exact-private-evaluation-binding.md).

## Context

The schema v2 forward aggregate recomputed counts, regressions, and ratios, but each semantic behavior entered the aggregate as baseline and candidate booleans. It did not prove which independent session judged the outputs, whether the verdict preceded unblinding, or which redacted evidence supported each result. Deterministic code cannot infer semantic correctness from an output without silently becoming the Judge.

## Decision

- Lock the held-out rubric and protocol, then commit a randomized A／B assignment before either output.
- Generate baseline and candidate with the same model and tool profile in distinct sessions.
- Use a third distinct Judge session. It sees only A and B, records `pass`, `fail`, or `insufficient_evidence` plus a redacted rationale and evidence hash for every locked behavior, and completes before unblinding.
- Keep raw outputs, event records, random seed, and private evidence local.
- Build adjudication through the deterministic local builder from the committed random seed, private session metadata, and Judge output; it verifies the A／B mapping and computes session, Judge-output, and redacted-evidence hashes without assigning semantic verdicts.
- Recompute objective measurements from private A／B sources through the deterministic builder; bind output and event hashes to the public synthetic measurement.
- Derive schema v3 aggregate behavior rows, counts, regressions, false positives, costs, and pass flags from the adjudication and measurement documents. Bind both fingerprints.
- Treat `insufficient_evidence`, timing violations, reused sessions, identity drift, or any derived-value mismatch as a publication blocker.
- Permit schema v2 boolean aggregates only for historical identification; they cannot satisfy the current gate.

The stable controller loaded before self-maintenance remains the authority for the candidate that introduces these rules. A candidate never uses its new scorer as the sole approval for its own release.

## Consequences

The score becomes traceable without pretending semantic judgment is mechanical. Public artifacts are larger and require a Judge record, but naked summary edits no longer change the result. The protocol reduces provenance ambiguity; it does not eliminate model-evaluation bias.
