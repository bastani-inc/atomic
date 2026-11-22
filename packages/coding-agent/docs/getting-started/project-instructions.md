---
title: Project instructions
description: Give Atomic durable, repository-specific instructions with AGENTS.md.
---

# Project instructions

**Outcome:** Atomic loads your repository's conventions automatically at startup.

**Prerequisites:** [First session](/getting-started/first-session) is complete.

## Give Atomic project instructions

Create an `AGENTS.md` file in your project root to tell Atomic your build commands, conventions, and guardrails:

```markdown
# Project Instructions

- Run `bun run typecheck` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

At startup, Atomic loads context files in this order:

1. **Global:** `~/.atomic/agent/AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` (legacy `~/.pi/agent/` also works).
2. **Project hierarchy:** `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` from parent directories down to the current directory.

Inside any single directory, `AGENTS.override.md` replaces `AGENTS.md` and `CLAUDE.md`. Atomic concatenates files loaded from different directories. Run `/reload` or restart Atomic after editing context files.

## Verify Atomic loaded them

Run `/reload`, then ask:

```text
What project instructions are you following in this repository?
```

Atomic should cite your rules (such as `bun run typecheck`). If it gives generic advice, check that:

- The file is named `AGENTS.md`.
- It sits in your current directory or a parent directory.
- No `AGENTS.override.md` in the same directory overrides it.
- The project is trusted (see [Security](/security)).

## Next step

Continue to [Interactive use](/usage), then [Configuration](/guides/configuration).
