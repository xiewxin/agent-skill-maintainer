# Contributing

Contributions are welcome through Pull Requests.

## Development

Use Node.js 22 or later and the standard library only for runtime code. No package installation or build step is required.

```bash
node --test tests/*.test.mjs
node scripts/validate-publication.mjs
node evals/run-evals.mjs --suite all
```

Write a failing test before changing behavior. Keep examples fictional and reusable. Do not commit raw conversations, private repository content, credentials, personal information, local absolute paths, generated run state, local plans/specs, tool work directories, or raw evaluation results. Public eval fixtures and aggregate reports must be fictional, reusable, and non-attributable.

## Pull Requests

- Link each behavior change to an `OPT-*` ID.
- Explain scope, risk, tests, compatibility, and release impact.
- Confirm the installed Skill was not modified.
- Keep GitHub writes and releases outside tests.

Provider Profile updates must include the verified version, verification date, artifact contract, command policy, fallback, and regression fixtures.
