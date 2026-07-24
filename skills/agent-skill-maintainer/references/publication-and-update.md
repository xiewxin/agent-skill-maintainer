# Publication and update

All improvements travel through a Pull Request.

In `managed` mode, create a same-repository branch and PR after confirmation. In `contribute` mode, validate locally first, then use one confirmed preview for the listed fork, push, and upstream PR. Never merge or release a third-party upstream.

PR creation and later PR updates use different confirmations. Before merge, re-read the PR head, checks, ruleset, account, and Diff fingerprint.

Merge is not release. A release requires a SemVer preview, a separate confirmation, and proof that the official tag and GitHub Release contain the approved main commit.

Before the release preview, build a complete inventory from the previous official tag through the candidate commit. Every in-range commit, detected Pull Request, and accepted `OPT-*` must map to a release-note entry or an explicit exclusion reason. Coverage is bound to the candidate commit; incomplete coverage or head drift blocks the preview. Do not summarize only the latest Pull Request.

Only after verified publication may the maintainer offer a local update using the original recorded installation method. A missing or unsafe installation method blocks the update; do not substitute another channel. The current task remains controlled by the old Skill version.

The current Preview provides deterministic apply for PR creation, PR metadata update, merge, and non-draft GitHub Release after a state-bound preview and explicit confirmation. The matching active run must have consumed that approval through its legal lifecycle transition. Apply records a one-time attempt before remote access, so failure or interruption cannot replay the same confirmation. It then re-reads the active account, repository permission, base and head commits, default branch, and relevant Pull Request state. If a remote write may have succeeded before output or postcondition reading failed, run the read-only reconcile path. It either recovers the exact PR, merge, or publication proof, or records a state-bound `not_applied` absence proof from the relevant GitHub read paths. Only a recorded absence proof allows the same lifecycle phase to accept a fresh preview and separate confirmation; an unresolved or applied attempt cannot be retried. Commands use argument arrays with interactive prompting disabled; merge never enables admin bypass or auto-merge.

Release apply additionally requires Release immutability to be enabled and confirms that neither the requested tag nor Release exists. After creation, verify the official Release metadata and dereferenced tag both point to the approved commit. A failed postcondition is a blocked recovery case, not permission to repeat the same approval.

The apply path does not create or push a branch, create a fork, clean candidate resources, or update the installed Skill. Those capabilities remain unavailable until they have their own deterministic implementation and confirmation contract. Never substitute ad-hoc commands for a missing path.
