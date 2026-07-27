# Repository release checklist

1. Start from the latest protected default branch and create a scoped branch.
2. Validate the complete candidate Diff, public-file allowlist, schemas, Provider claims, and process-artifact exclusions.
3. Run the full Node tests, publication validator, evaluation suite, platform matrix, required forward scenarios, and the five-Provider stable aggregate gate.
4. Build a change inventory from the previous official tag through the candidate commit.
5. Map every in-range commit, detected Pull Request, and accepted `OPT-*` to a release-note entry or an explicit exclusion reason.
6. For contributor mode, verify and reuse the active account's personal Fork read-only or create it only after a separate preview and confirmation; require the resulting Fork proof.
7. Push the approved clean candidate branch only after its dedicated confirmation; require the resulting branch proof before PR creation or update.
8. Create or update the Pull Request only after its dedicated confirmation.
9. Re-read head commit, checks, ruleset, Diff fingerprint, and account before a separately confirmed merge.
10. Preview version, tag, target commit, title, complete notes, and release settings before a separately confirmed release.
11. Verify that the official tag and GitHub Release contain the approved main commit.
12. Only then inspect the recorded installation method. For a proven global `npx-skills` symlink installation, preview and confirm an update pinned to the exact Release commit, reserve the action once, atomically replace Skill and lock, and verify the update proof. Reconcile read-only after interruption. Unsupported methods remain blocked, and the current task keeps using its loaded version.

`stable_candidate_ready` is the pre-release decision and must not depend on an already existing Release. `publication_verified` is post-release evidence and must remain false until the exact official tag and Release are read back.

Never commit `docs/plans/`, `docs/specs/`, raw evaluation output, local run state, conversations, credentials, personal data, or private repository evidence. A public optimization commit contains only the approved implementation, directly related tests, and required durable documentation or contract updates.
