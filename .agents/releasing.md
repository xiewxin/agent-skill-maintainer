# Repository release checklist

1. Start from the latest protected default branch and create a scoped branch.
2. Validate the complete candidate Diff, public-file allowlist, schemas, Provider claims, and process-artifact exclusions.
3. Run the full Node tests, publication validator, evaluation suite, platform matrix, and required forward scenarios.
4. Build a change inventory from the previous official tag through the candidate commit.
5. Map every in-range commit, detected Pull Request, and accepted `OPT-*` to a release-note entry or an explicit exclusion reason.
6. Push the approved clean candidate branch only after its dedicated confirmation; require the resulting branch proof before PR creation or update.
7. Create or update the Pull Request only after its dedicated confirmation.
8. Re-read head commit, checks, ruleset, Diff fingerprint, and account before a separately confirmed merge.
9. Preview version, tag, target commit, title, complete notes, and release settings before a separately confirmed release.
10. Verify that the official tag and GitHub Release contain the approved main commit.
11. Only then offer an update through the recorded installation method; local update requires another confirmation.

Never commit `docs/plans/`, `docs/specs/`, raw evaluation output, local run state, conversations, credentials, personal data, or private repository evidence. A public optimization commit contains only the approved implementation, directly related tests, and required durable documentation or contract updates.
