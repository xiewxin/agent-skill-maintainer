# ADR 0005: Stable Provider validation

## Status

Accepted.

## Context

The Preview catalog recognized several planning workflows from versioned, read-only artifact contracts. That was sufficient for conservative discovery, but it could not justify Provider command execution or a stable support claim. One upstream, GSD, is archived, while Matt Pocock Skills provides an active planning workflow that better fits the fifth formal integration.

A stable release also needs to avoid a circular gate: requiring an official Release proof before allowing the Release preview would make publication impossible.

## Decision

- The formal catalog is Superpowers, GitHub Spec Kit, OpenSpec, BMAD Method, and Matt Pocock Skills.
- GSD remains an archived legacy Profile. Its fixed artifacts may be read, but its commands are never authorized and it does not count toward the formal catalog.
- Provider Profile schema v2 records an immutable Release commit and one of three roles: `formal`, `auxiliary`, or `legacy`.
- Exact version detection authorizes commands only when the matching evidence has `commands` scope and the requested command identifier is in `allowed_when_verified`. Read-only evidence and unknown versions never authorize commands.
- Each formal Provider requires one isolated, controlled, redacted real-usage case bound to the current Skill fingerprint. Cases do not share artifacts or content owners.
- The public repository stores only the aggregate contract. Raw prompts, outputs, conversations, temporary repositories, credentials, tokens, and private paths remain local and are deleted after evaluation.
- `stable_candidate_ready` permits a Release preview after all candidate gates pass. `publication_verified` is a separate post-release state that requires an exact official tag and Release proof.

## Consequences

- A Provider can remain discoverable while its commands stay disabled.
- Version, command, owner, platform, safety, and quality drift block the stable gate deterministically.
- Updating a Provider version requires new fixed-commit evidence and a new controlled case; following `latest` is not a supported shortcut.
- The Provider aggregate is evidence of the candidate only. It does not grant permission to install third-party tools, run hooks, write a tracker, mutate a repository, or publish a Release.
