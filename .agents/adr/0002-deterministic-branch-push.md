# 0002: Push candidate branches through verified repository identities

## Status

Accepted.

## Context

Pull Request creation requires the approved candidate commit to exist on a GitHub branch. Reusing a candidate's configured remote, a mutable local branch ref, or an ambient Git credential helper would make the source, write target, or authentication path depend on mutable local state. A normal push also observes remote state again after preflight and may accept an intervening fast-forward, so it cannot enforce the approved remote precondition by itself.

Maintainers normally push a branch to the repository they manage. Contributors normally push to their own existing fork and open a Pull Request against upstream. The deterministic path should preserve those established workflows without silently creating repositories or widening permissions.

## Decision

- Treat branch push as a separate lifecycle action with its own state-bound preview, expiring confirmation, one-time attempt, proof, and reconcile path.
- Revalidate the clean committed candidate before reserving the attempt and again before remote access.
- In `managed` mode, target the verified upstream repository.
- In `contribute` mode, target only an existing writable fork owned by the active account and verified as a child of upstream.
- Derive the exact GitHub HTTPS URL from the verified repository identity; never read or modify candidate remotes.
- Use a temporary isolated Git config populated by `gh auth setup-git`, then remove it.
- Perform `ls-remote` and `push` from a clean temporary bare transport repository that exposes only the approved candidate object database; never read candidate-local URL rewrites, credential helpers, proxies, or other transport configuration.
- Reject a head branch equal to the base branch.
- Push the exact approved commit SHA rather than a mutable local branch ref.
- Permit only branch creation, fast-forward, or verification that the branch already points to the approved commit.
- Disable replacement refs and redirect the deprecated graft file to the platform null path for every Git command, so local graph overrides cannot influence snapshot or ancestry decisions.
- Bind creation or fast-forward to the exact approved remote prestate with `--force-with-lease=<ref>:<expected>` as a compare-and-swap guard. Reject plain `--force`, leases without an explicit expected value, non-fast-forward updates, and any forced outcome.
- Never set upstream tracking or automatically create a fork.

## Consequences

Branch push follows normal maintainer and contributor repository behavior while remaining bound to the approved candidate and exact remote prestate. The lease option is used only as an optimistic-lock primitive after an explicit fast-forward check; it does not authorize history replacement. Contributors without a verified existing fork are blocked until fork creation receives a separate deterministic contract. PR creation and update require the matching branch-push proof.
