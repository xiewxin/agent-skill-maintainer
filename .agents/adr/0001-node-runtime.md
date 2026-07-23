# 0001: Use zero-dependency native ECMAScript modules

## Status

Accepted.

## Context

Repository state, approval fingerprints, isolation guards, Git snapshots, release-note coverage, and publication verification are core capabilities. Unlike an optional helper, their runtime cannot disappear without disabling the Skill's safe workflow.

The primary public installation path is `npx skills add`, and the target platforms support executing Node scripts. Maintaining equivalent Python and JavaScript implementations would create contract drift.

## Decision

- Implement deterministic runtime and tests as native `.mjs`.
- Use Node standard libraries only; installed execution requires no package installation or build.
- Keep the Skill body declarative and use scripts only for deterministic state and safety boundaries.
- Remove the Python implementation after behavioral parity is proven.
- Validate Ubuntu, macOS, and Windows in CI.

## Consequences

Node is a core runtime prerequisite for deterministic maintainer actions. `npx` remains the recommended installer, but installation and execution are documented as separate concerns. Runtime migration must preserve existing schemas, state migration, safety failures, and machine-readable CLI output.
