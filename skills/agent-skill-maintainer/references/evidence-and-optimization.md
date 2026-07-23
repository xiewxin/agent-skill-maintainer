# Evidence and optimization

## Evidence sources

Use only sources the user selected or the current task already exposed: the current interaction, explicit past experience, provided files, and specific GitHub Issues, PR reviews, comments, or Discussions. Never scan every installed Skill or unrelated repository history.

## `FB-*` contract

Each run-local feedback record contains:

- unique ID, target Skill, and observed version;
- source type and a redacted locator or digest;
- observed and expected behavior;
- reproduction status and missing evidence;
- classification: defect, new request, preference, platform limit, external cause, or unknown;
- confidence and provisional owner.

User correction is strong evidence, not automatic proof. No correction does not remove the duty to inspect observable failures, wrong decisions, unsafe actions, incorrect attribution, and unnecessary cost.

## `OPT-*` contract

Convert validated feedback only when the change has:

- target Skill intent and problem evidence;
- one owner;
- scope fit or necessary closure;
- minimal change and regression case;
- documentation impact under the target repository's existing guidance contract;
- generalizable value and confidence;
- decision status and reason.

Decision status is one of `accepted`, `rejected`, `deferred`, or `needs_evidence`. Only accepted IDs enter implementation approval. If accepted content changes, request a new approval.

Zero improvements is a valid result when evidence supports it.
