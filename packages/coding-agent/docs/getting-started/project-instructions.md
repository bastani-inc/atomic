---
title: "Add project instructions"
sidebarTitle: "Add project instructions"
description: "Guide Atomic with repository conventions in AGENTS.md and CLAUDE.md files, including precedence and system prompt rules."
---

**Outcome:** Atomic loads your repository's build commands, coding conventions, and guardrails automatically at startup.

**Prerequisites:** [Run your first session](/getting-started/first-session) is complete.

## Create an AGENTS.md file

Add an `AGENTS.md` file at the root of your repository:

```markdown
# Project Instructions

- Run `npm run typecheck` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Run `/reload` (or restart Atomic) after editing instruction files so the updated rules take effect.

## Discovery and precedence

Atomic loads at most **one** instruction file per directory, choosing the first regular file (or symlink to one) in this exact order:

| Priority | Filename | Notes |
| --- | --- | --- |
| 1 | `AGENTS.override.md` | Shadows all other instruction files in the same directory. |
| 2 | `AGENTS.md` | Recommended default; shadows `CLAUDE.md`. |
| 3 | `AGENTS.MD` | Uppercase fallback. |
| 4 | `CLAUDE.md` | Loaded when no `AGENTS*` file exists in the same directory. |
| 5 | `CLAUDE.MD` | Uppercase fallback. |

Files load top-down—first from your global config directory (`~/.atomic/agent/`), then from ancestor directories down to your current working directory—and are concatenated in that order.

<Note>
**Project trust:** In an untrusted project, Atomic still loads your global instruction files from `~/.atomic/agent/`, while skipping all project and ancestor-directory instruction files until you trust the project. See [Security](/security).
</Note>

<Accordion title="Traversal, linked worktrees, and legacy directory details">

- **Root-to-cwd traversal:** Atomic walks from your current working directory all the way up to the filesystem root (`/` or the Windows drive root); it does not stop at the Git repository root or `$HOME`.
- **File matching details:** Leading UTF-8 BOMs are stripped automatically. Uppercase `AGENTS.override.MD` is not recognized.
- **Global directories:** When `ATOMIC_CODING_AGENT_DIR` is unset, Atomic checks both `~/.pi/agent/` and `~/.atomic/agent/` and loads both when they resolve to different directories (`~/.pi/agent/` first, then `~/.atomic/agent/`). When `ATOMIC_CODING_AGENT_DIR` is set, Atomic checks only that directory.
- **Nested linked Git worktrees:** When your working directory is inside a linked Git worktree nested under a repository (for example `<repo>/.worktrees/feature`) and the worktree root has an instruction file, Atomic skips the matching file from the main repository root (or any file in the main repository root when the worktree uses `AGENTS.override.md`) so instructions are not loaded twice.
- **Disable for one run:** Pass `--no-context-files` (`-nc`) to skip all instruction files for a single run.

</Accordion>

## System prompt files

To replace or append to Atomic's base system prompt—rather than adding project conventions—create `SYSTEM.md` (replaces the default prompt) or `APPEND_SYSTEM.md` (appends to it).

Atomic loads only the **first existing file** in this order:

1. `.atomic/SYSTEM.md` *(trusted projects only)*
2. `.pi/SYSTEM.md` *(trusted projects only)*
3. `~/.atomic/agent/SYSTEM.md`
4. `~/.pi/agent/SYSTEM.md`

`APPEND_SYSTEM.md` uses the exact same four-path order. Unlike `AGENTS.md` context files, a project `APPEND_SYSTEM.md` **replaces** a global `APPEND_SYSTEM.md` rather than concatenating with it.

- `--system-prompt <text|path>` overrides `SYSTEM.md`.
- `--append-system-prompt <text|path>` replaces any discovered `APPEND_SYSTEM.md`.
- Instruction files (`AGENTS.md`/`CLAUDE.md`) and skills still append even when `SYSTEM.md` or `--system-prompt` replaces the base prompt.

## Verify Atomic loaded them

Run `/reload`, then ask:

```text
What project instructions are you following in this repository?
```

Atomic should cite the rules from your file (such as `npm run typecheck`). If it gives generic advice instead, check that:

- The filename matches one of the five supported names in the table above.
- The file is a regular file (or symlink to one) in your current directory or an ancestor directory.
- No higher-priority file in the same directory shadows it.
- The project is trusted (run `/trust` or see [Security](/security)).

## Next step

Read [How Atomic works](/how-atomic-works) for the full mental model, or continue to [Use interactive mode](/usage) and [Configure Atomic](/guides/configuration).
