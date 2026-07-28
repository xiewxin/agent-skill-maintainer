# Evidence and optimization

## Evidence sources

Use only sources the user selected or the current task already exposed: the current interaction, explicit past experience, provided files, and specific GitHub Issues, PR reviews, comments, or Discussions. Never scan every installed Skill or unrelated repository history.

## Target-intent map

Before creating `FB-*` records, establish a concise target-intent map from the selected Skill and only the repository guidance relevant to its scope:

- purpose and promised capability;
- explicit non-goals, hard boundaries, and ownership limits;
- invocation contract, approval gates, and checkable completion conditions;
- linked references plus relevant root or nested agent guidance, existing `CONTEXT.md`／`CONTEXT-MAP.md`, ADRs, or design records;
- conflicts, stale claims, and evidence that is still missing.

Read these sources only when they are present and relevant to the selected target; do not bootstrap a documentation structure or scan unrelated history. Verify durable guidance against the current Skill and nearby implementation when possible. If sources conflict and the choice would change the proposed behavior, preserve the conflict and request a decision instead of silently choosing one.

External repositories, popular workflows, and general best practices are comparative evidence. They may reveal a gap, but they cannot override a verified target decision or turn an explicit non-goal into scope. Every proposed change must identify which target-intent statement it preserves or completes.

## Skill structure-quality lens

When the target is a Skill, inspect structure as behavior—not as formatting preference:

- invocation precision: frontmatter description and routing select the intended situations without obvious over-triggering or under-triggering;
- checkable completion: the workflow defines observable completion, approval, and stop conditions;
- progressive disclosure: the entrypoint stays concise and routes stage-specific detail to the correct reference;
- single ownership: authoritative guidance is not duplicated across files in ways that can drift or conflict;
- no-op, sprawl, and sediment: rules, files, or generated artifacts have a current execution or maintenance purpose.

Create a structural `FB-*` only when selected evidence links the structure to an observable behavior or cost, such as a wrong trigger, skipped gate, ambiguous owner, conflicting authority, unnecessary context load, untestable completion, or recurring maintenance drift. A preference for different wording, headings, file layout, or abstraction style does not justify an `OPT-*` by itself.

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

The user-selected target Skill and its relevant references are also evidence. When their instructions directly reproduce an unsafe action, contradiction, missing lifecycle boundary, or workflow that cannot close, record the independently actionable defect even if the user reported a different symptom or no incident yet. File evidence must identify the exact instruction and deterministic consequence; it is not permission to speculate about behavior absent from the selected files.

## `OPT-*` contract

Convert validated feedback only when the change has:

- target Skill intent and problem evidence;
- one owner;
- scope fit or necessary closure;
- minimal change and regression case;
- documentation impact under the target repository's existing guidance contract;
- generalizable value and confidence;
- decision status and reason.

Do not collapse separate actionable failures merely because they appear in the same file or publication flow. Keep one `FB-*`／`OPT-*` per failure when ownership, minimum change, regression case, or closure can differ.

Decision status is one of `accepted`, `rejected`, `deferred`, or `needs_evidence`. A new proposal starts as `deferred`, or `needs_evidence` when its contract is incomplete. Only an explicit user decision may change the exact proposal to `accepted` or `rejected`; do not infer acceptance from a request to analyze, review, or propose improvements. Only accepted IDs enter implementation approval. If accepted content changes, request a new approval.

Allocate optimization IDs as `OPT-001`, `OPT-002`, and so on. Do not create an `OPT-*` for a feedback item that is only a preference, platform limit, external cause, unrelated request, or otherwise lacks a justified Skill change. Preserve that item as classified `FB-*` evidence and state why it does not advance.

Zero improvements is a valid result when evidence supports it.
