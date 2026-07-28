# ADR 0006: Evidence-bound publication continuation

## Status

Accepted.

## Context

Three publication boundaries were under-specified:

- a caller could supply `release_enabled` without proving current repository settings;
- a run could become terminal immediately after merge and could not later honor a Release request;
- branch push and initial Pull Request creation always required two confirmations even though they form one pre-integration handoff.

Publishable same-model comparison evidence also did not prove that its fixture and rubric were held out from candidate iteration.

## Decision

- Generate a fingerprinted GitHub capability proof through read-only inspection of the active account, repository permission, default branch, and immutable-Release setting. Bind it into every GitHub action preview and re-check live state before apply.
- Require an explicit, phase-matched completion disposition. `stop_after_merge` also requires the exact merge and Pull Request proofs.
- Allow a new release-continuation run only from a terminal `stop_after_merge` run and an exactly matching merge proof. The continuation starts at merge with copied, revalidated candidate and publication evidence; Release remains separately previewed and confirmed.
- Add optional `publish_pr`, which binds one confirmation to the exact branch push followed by initial Pull Request creation. A push-only outcome keeps non-replayable branch proof. Unobservable PR state remains pending; only read-only absence proof unlocks a fresh granular PR confirmation.
- Require publishable same-model blinded A/B evidence to bind a fixture held out from iteration, a rubric locked before both outputs, matching model／prompt／artifacts／tools, distinct sessions, recomputable quality and cost measures, and no raw outputs.

## Consequences

Repository capability cannot silently drift behind a caller boolean. Terminal completion records why the workflow stopped, while a later Release request has a bounded recovery path. One low-risk confirmation is removed from the common PR handoff without combining merge, Release, or local update. Evaluation claims become stricter and independently auditable, at the cost of additional proof fields and fixtures.
