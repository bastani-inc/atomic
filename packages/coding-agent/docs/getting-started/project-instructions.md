---
title: "Add project instructions"
sidebarTitle: "Project instructions"
description: "Guide Atomic with repository conventions in AGENTS.md and CLAUDE.md files, including exact precedence and system prompt rules."
---

**Outcome:** Atomic loads your repository's conventions automatically at startup.

**Prerequisites:** [Run your first session](/getting-started/first-session) is complete.

## Create an AGENTS.md file

Create an `AGENTS.md` file in your project root to tell Atomic your build commands, conventions, and guardrails:

```markdown
# Project Instructions

- Run `bun run typecheck` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Run `/reload` or restart Atomic after editing context files so changes take effect.

## Discovery and precedence rules

Atomic loads context files automatically at startup using these exact rules:

- **One file per directory:** Inside each directory, Atomic loads at most one context file, choosing the first regular file (or symlink to a regular file; UTF-8 BOMs are stripped) in this exact order:
  1. `AGENTS.override.md`
  2. `AGENTS.md`
  3. `AGENTS.MD`
  4. `CLAUDE.md`
  5. `CLAUDE.MD`

  Because Atomic stops at the first match in each directory, `AGENTS.md` shadows `CLAUDE.md`, and `AGENTS.override.md` shadows both. Uppercase `AGENTS.override.MD` is not recognized.
- **Global directories:** When `ATOMIC_CODING_AGENT_DIR` is not set, Atomic checks both `~/.pi/agent/` and `~/.atomic/agent/` and loads both when they resolve to different directories (legacy `~/.pi/agent/` first, then `~/.atomic/agent/`). When `ATOMIC_CODING_AGENT_DIR` is set, Atomic checks only that directory.
- **Root-to-cwd traversal:** Atomic walks from your current working directory all the way up to the filesystem root (`/` or the Windows drive root); it does not stop at the Git repository root or `$HOME`. Files load top-down (global directories, then outermost ancestors, down to your current directory) and are concatenated in that order.
- **Nested linked Git worktrees:** When your working directory is inside a linked Git worktree nested under a repository (for example `<repo>/.worktrees/feature`) and the worktree root has a context file, Atomic skips the matching file from the main repository root (or any file in the main repository root when the worktree uses `AGENTS.override.md`) so instructions are not loaded twice.
- **Untrusted projects:** Before you trust a project, Atomic still loads your global context files (`~/.atomic/agent/`) while skipping all project and ancestor-directory context files. See [Security](/security).
- **Disable for one run:** Pass `--no-context-files` (`-nc`) to skip all context files for that run.

## System prompt files

To customize Atomic's base system prompt rather than adding project instructions, use `SYSTEM.md` (replaces the default prompt) or `APPEND_SYSTEM.md` (appends to the default prompt):

- Atomic loads only the **first existing file** in this order:
  1. `.atomic/SYSTEM.md` (trusted projects only)
  2. `.pi/SYSTEM.md` (trusted projects only)
  3. `~/.atomic/agent/SYSTEM.md`
  4. `~/.pi/agent/SYSTEM.md`
- `APPEND_SYSTEM.md` follows the exact same four-path order. Unlike context files, a project `APPEND_SYSTEM.md` **replaces** a global `APPEND_SYSTEM.md` instead of concatenating with it.
- Passing `--system-prompt <text|path>` overrides `SYSTEM.md`. Passing `--append-system-prompt <text|path>` **replaces** any discovered `APPEND_SYSTEM.md`.
- Context files (`AGENTS.md`/`CLAUDE.md`) and skills still append even when `SYSTEM.md` or `--system-prompt` replaces the default prompt.

## Verify Atomic loaded them

Run `/reload`, then ask:

```text
What project instructions are you following in this repository?
```

Atomic should cite your rules (such as `bun run typecheck`). If it gives generic advice, check that:

- The file is named `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`.
- It is a regular file (or symlink to one) in your current directory or an ancestor directory.
- No higher-priority file in the same directory shadows it.
- The project is trusted (see [Security](/security)).

## Next step

Continue to [Interactive mode](/usage), then [Configure Atomic](/guides/configuration).
