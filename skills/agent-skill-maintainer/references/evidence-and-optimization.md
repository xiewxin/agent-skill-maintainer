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

Allocate IDs sequentially with three or more digits: `FB-001`, `FB-002`, and so on. They are unique within the run, including when one request spans multiple repositories.

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

Decision status is one of `accepted`, `rejected`, `deferred`, or `needs_evidence`. A new proposal starts as `deferred`, or `needs_evidence` when its contract is incomplete. Only an explicit user decision may change the exact proposal to `accepted` or `rejected`; do not infer acceptance from a request to analyze, review, or propose improvements. Only accepted IDs enter implementation approval. If accepted content changes, request a new approval.

Allocate optimization IDs as `OPT-001`, `OPT-002`, and so on. Do not create an `OPT-*` for a feedback item that is only a preference, platform limit, external cause, unrelated request, or otherwise lacks a justified Skill change. Preserve that item as classified `FB-*` evidence and state why it does not advance.

Zero improvements is a valid result when evidence supports it.
