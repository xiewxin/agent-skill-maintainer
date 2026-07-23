# Publication and update

All improvements travel through a Pull Request.

In `managed` mode, create a same-repository branch and PR after confirmation. In `contribute` mode, validate locally first, then use one confirmed preview for the listed fork, push, and upstream PR. Never merge or release a third-party upstream.

PR creation and later PR updates use different confirmations. Before merge, re-read the PR head, checks, ruleset, account, and Diff fingerprint.

Merge is not release. A release requires a SemVer preview, a separate confirmation, and proof that the official tag and GitHub Release contain the approved main commit.

Before the release preview, build a complete inventory from the previous official tag through the candidate commit. Every in-range commit, detected Pull Request, and accepted `OPT-*` must map to a release-note entry or an explicit exclusion reason. Coverage is bound to the candidate commit; incomplete coverage or head drift blocks the preview. Do not summarize only the latest Pull Request.

Only after verified publication may the maintainer offer a local update using the original recorded installation method. A missing or unsafe installation method blocks the update; do not substitute another channel. The current task remains controlled by the old Skill version.

The current Preview exposes state-bound GitHub action previews only. Preview creation never performs a remote write, and the deterministic apply entrypoint remains unavailable until isolated implementation, mock lifecycle tests, and explicit mutation confirmations are complete.
