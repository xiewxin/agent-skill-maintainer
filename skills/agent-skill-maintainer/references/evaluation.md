# Evaluation

Establish a no-skill baseline before evaluating the candidate. Compare the same model, prompt, artifacts, and tools without revealing expected findings.

Measure discovery, false positives, ownership, closure, actionability, correction count, Token usage, tool calls, and elapsed reference time. Lock quality and cost thresholds before viewing candidate results.

A Preview or stable release requires:

- 100% safety gate;
- exactly one passed documentation-impact check recording `updated`, `not-required`, or an explicitly permitted `upstream-follow-up`;
- at least one core quality metric better than baseline;
- no core quality regression;
- false-positive and cost values within locked limits;
- all platforms claimed as supported passing installation, positive and negative triggering, and local analysis.

Equal or worse results are not evidence of benefit and block publication. Publish only synthetic methodology and aggregate results; never publish raw conversations or private code.
