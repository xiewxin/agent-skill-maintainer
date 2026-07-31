# ADR 0011: Exact private evaluation binding

## Status

Accepted. Supersedes [ADR 0009](0009-traceable-blinded-adjudication.md).

## Context

ADR 0009 made blinded adjudication traceable, but schema v3 evidence could not prove that every generator, Judge, runtime, platform session, and public summary came from one exact locked evaluation input. Re-derived summaries could remain internally consistent while mixing stale candidate fingerprints, input views, raw outputs, runtime workspaces, or platform sessions.

## Decision

- Lock the complete held-out fixture and commit its canonical evaluation-input fingerprint before generation and assignment.
- Derive role-specific label-neutral generator and Judge views. Bind every raw output and private session to the exact role view and locked input without exposing the A/B mapping or candidate identity.
- Give the Judge only identity-neutral output copies in an exact committed input bundle and require a zero-tool Judge session.
- Derive tool counts from complete provider JSONL transcripts whose final message equals the raw output and whose tool starts/completions form one exact sequence. Independently enforce the locked read-only transcript profile, including exactly one eval-bind smoke and one combined runtime observation; reject network/write tools, forbidden paths, and duplicate required commands.
- Bind complete persistent runtime trees, file counts, exact read-only smoke records, stable behavior-clause IDs, raw output hashes, and ordered measurement/Judge/unblind times.
- After unblinding, require the locked neutral controller to sign a short-lived challenge before isolated Codex and Claude Code positive/negative sessions start. Bind each challenge to the observed provider version, executable hash, and controller-owned execution-profile hash. The controller starts every provider with fixed read-only argv, validates complete native transcripts, and signs one receipt per finished session; a caller cannot submit its own execution record. Each receipt binds the workspace, controller-recorded times, response/transcript hashes, unique provider nonce, tool count, and tool-sequence hash. Challenge and provider nonces are disjoint. Completion is signed at a controller-generated `attested_at` before expiry, and platform responses cannot prefill completion.
- Build a local-only schema v5 binding from raw assignment, sessions, outputs, events, Judge output, times, and captured platform evidence. Recompute and canonical-compare its source manifest, adjudication, measurement, platform summary, aggregate, and all derived pass fields.
- Lock an independently implemented controller by source hash and public key before evaluation. Keep the corresponding private key outside the candidate and run directories and out of reusable harness code; accept only an absolute, owner-only regular file after `lstat` and real-path containment checks. Require its signed challenge, controller-managed session receipts, post-execution completion, and source/result attestation so candidate scorer code is not the sole builder and verifier. Recheck the live controller bytes at binding and publication boundaries.
- Keep the A/B runtime workspaces readable until the publication gate closes so validation can rerun their exact tree and smoke checks.
- Reject incomplete clause evidence, early or reused sessions, input replay, identity drift, unredacted public rationale, non-v5 evidence, public-only evidence, or any derived mismatch.
- Preserve the stable controller as authority; a candidate never self-approves its release solely with the scorer it introduces.

## Consequences

Evidence is larger and more expensive to generate, but stale or mixed sources cannot be made publishable by rewriting summaries. Raw sources and paths remain private, while public evidence contains redacted summaries and deterministic commitments.
