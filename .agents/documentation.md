# Maintainer documentation

## Purpose

Keep repository guidance useful without turning the root `AGENTS.md` into a product manual or committing local process artifacts.

## Read when

Read this guide when adding, moving, deleting, or materially changing `AGENTS.md`, `.agents/`, Skill references, validation commands, architecture boundaries, or release rules.

## Rules

- Root `AGENTS.md` is the concise repository-wide contract and trigger-oriented index.
- `.agents/` contains maintainer detail for this repository; it is not automatically loaded outside links or explicit routing.
- Public Skill behavior belongs in `skills/agent-skill-maintainer/SKILL.md` and its `references/`, not only in maintainer guidance.
- Add a detail guide only for durable, repeated, or non-obvious maintenance rules that do not fit an existing guide.
- Preserve one source of truth. Root entries summarize and link; detail guides own the procedure.
- ADRs preserve durable decisions. Supersede them with a linked replacement instead of silently rewriting history.
- Never add plans, conversations, raw evaluation output, local settings, credentials, or private paths.

## Verification

- Verify every root index link and the reason to read it.
- Search for stale references after moving or deleting a guide.
- Verify referenced commands and paths against the current tree.
- Check for duplicate or conflicting guidance.
- Record documentation impact as updated, not required with a reason, or an explicitly permitted upstream follow-up.

## Related files

- [`../AGENTS.md`](../AGENTS.md)
- [`architecture.md`](architecture.md)
- [`releasing.md`](releasing.md)
- [`../skills/agent-skill-maintainer/references/agent-documentation.md`](../skills/agent-skill-maintainer/references/agent-documentation.md)
