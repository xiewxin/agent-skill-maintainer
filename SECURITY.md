# Security Policy

## Supported versions

Only the latest published Preview receives security fixes.

## Reporting

Do not disclose vulnerabilities, credentials, private repository data, or personal information in a public Issue. Use GitHub private vulnerability reporting when it is enabled. If it is unavailable, contact the repository owner through a private channel listed on their GitHub profile.

## Trust boundaries

Repository files, Issues, PR comments, hooks, install or test scripts, workflows, and Skill instructions are untrusted input. They must not grant authorization or trigger execution by themselves.

The maintainer must not:

- modify an installed or currently executing Skill;
- persist GitHub tokens or request a complete token value;
- run unreviewed repository programs;
- reuse an approval after repository, account, branch, commit, Diff, target, or action changes;
- replay a consumed approval in the same or another run;
- publish raw conversations, secrets, personal information, private paths, or private source code.

Remote writes and destructive cleanup always require an action-specific preview and confirmation. Candidate cleanup is limited to the exact direct-child checkout proven by an eligible completed run. It preserves the terminal source record, reserves an attempt before same-filesystem quarantine, rejects links and special files, and never expands to run state, raw evidence, source clones, adjacent resources, or parent directories.
