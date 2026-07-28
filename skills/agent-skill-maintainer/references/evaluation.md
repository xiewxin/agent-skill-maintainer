# Evaluation

Establish a no-skill baseline before evaluating the candidate. Compare the same model, prompt, artifacts, and tools without revealing expected findings.

A publishable same-model blinded A/B must use a fixture held out from optimization iteration. Before either output exists, lock the rubric and the prompt, artifact, model, and tool identities. Run baseline and candidate in distinct sessions; do not give candidate feedback before the verdict. The public aggregate must bind hashes for the prompt, supplied artifacts, rubric, tool profile, and both distinct session identities, plus timestamps proving the lock preceded both runs. Raw outputs remain local and unpublished.

Measure discovery, false positives, ownership, closure, actionability, correction count, elapsed reference time, tool calls, artifact bytes, and any fixture-specific structural limit. Lock quality and cost thresholds before viewing candidate results. Recomputable counts and cost ratios must agree with the published aggregate. Do not collect or estimate Token usage.

A Preview or stable release requires:

- 100% safety gate;
- exactly one passed documentation-impact check recording `updated`, `not-required`, or an explicitly permitted `upstream-follow-up`;
- at least one core quality metric better than baseline;
- no core quality regression;
- false-positive and cost values within locked limits;
- all platforms claimed as supported passing installation, positive and negative triggering, and local analysis.

Equal or worse results are not evidence of benefit and block publication. Publish only synthetic methodology and aggregate results; never publish raw conversations or private code.

## Stable Provider gate

A stable candidate additionally requires exactly one isolated, `controlled-redacted-real-usage` case for each formal Provider: Superpowers, Spec Kit, OpenSpec, BMAD Method, and Matt Pocock Skills. Every case must match the Profile version and immutable Release commit, use only allowlisted command identifiers, retain a unique artifact owner, prove fallback and safety, and record a criteria-based baseline/candidate quality comparison with at least one improvement and no regression. It also records elapsed seconds, tool calls, and artifact bytes for cost visibility without collecting or estimating Token usage. The primary Provider installation and configuration directories must remain unchanged and no remote write may occur. Host-agent runtime caches, logs, and application state are outside this Provider-installation assertion and must not be presented as Provider writes. GSD is legacy and is excluded from this count.

Codex and Claude Code must each pass installation, positive trigger, negative non-trigger, Provider selection, artifact bridge, fallback, and local-only analysis checks on the same candidate.

The aggregate is bound to the candidate Skill fingerprint. Missing, duplicated, synthetic, drifted, unsafe, or worse cases block `stable_candidate_ready`. That pre-release state allows only a Release preview; `publication_verified` remains false until the exact official tag and Release are read back after a separately confirmed publication.
