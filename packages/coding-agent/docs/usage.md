---
title: "Interactive use"
description: "Interactive mode, slash commands, the message queue, sessions, and context files."
---

# Using Atomic

This page collects day-to-day usage details that do not fit on the quickstart page.

## On this page and its reference

This page covers interactive use: the interactive loop, slash commands, the message queue, sessions, context files, and the design principles behind them. Every command, flag, argument, and environment variable now lives in the [CLI reference](/reference/cli).

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600" /></p>

The interface has four main areas:

- **Startup header** - shortcuts plus named lists of loaded context files, prompt templates, skills, extensions, and themes; use the expand-tools shortcut (Ctrl+O by default) to switch those lists to source paths
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Startup and Working Identity

On an interactive TTY, the startup ∀ assembles from two separated halves in whole-column steps, lands its shadow and session identity, then reveals the one-time manifesto beat. Any key—including Ctrl+C—completes the sequence immediately before normal input routing continues. Terminals narrower than the mark show compact textual identity throughout assembly instead of a blank startup area. Quiet startup suppresses the sequence; a mounted interactive UI without a TTY, or with `ATOMIC_REDUCED_MOTION=1`, starts in the complete settled state. `NO_COLOR` suppresses foreground color across the mark, metadata, and manifesto while retaining weight emphasis.

Interactive startup lists loaded context files, skills, prompts, extensions, and themes by name. The Extensions section includes isolated engine extensions such as workflows, subagents, MCP, web access, and Intercom without loading them a second time in the terminal host. Its compact list uses builtin package names and adds parent path segments when a local extension would otherwise have the same label. If no parent segment is available, it shows the local extension's display path and adds a deterministic numeric suffix only when that path is also already taken. Expand the startup disclosure to view source paths.

While ordinary agent work is active, the exact one-cell `∀` remains visible and follows a pronounced ten-frame dark → accent → bright/bold → accent → dark luminance ramp at an 88ms cadence. Optional theme tone overrides control any terminal-supported foreground phase exactly, including palette indices 0–255; Atomic derives omitted tones from selected-surface, `accent`, and `text` roles. Dark, light, custom, and dynamically reloaded themes therefore remain correct without changing glyph shape or geometry. It occupies the same inline, one-row footprint as the standard spinner: one glyph immediately before the existing text. Main and workflow-stage chat preserve all 453 of Atomic's original randomized whimsical working verbs, selecting one message per turn; even the longest fits the tested 64-column surface. Every agent and SDK turn resets to the dark regular phase with a fresh lifecycle-relative cadence, while turn, terminal, error, replacement, and disposal paths stop the active timer cleanly. Restoring the ordinary indicator after an extension override also resets its phase and cadence; extension-provided frames and intervals remain unchanged and render verbatim. Under `NO_COLOR`, regular/bold weight preserves visible activity without foreground-color escapes. With `ATOMIC_REDUCED_MOTION=1`, `∀` remains static, regular, and accent-colored without an animation timer. Factual retry, fallback, error, cancellation, and compaction status suppresses the thematic indicator, while blocker and human-approval/prompt surfaces hide ordinary work chrome and factual receipts remain verbatim.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | SHIFT+Enter, or CTRL+Enter on Windows Terminal |
| Images | Paste with CTRL+V, ALT+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | CTRL+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](/keybindings) for all shortcuts and customization.

On native Windows, `!` and `!!` execute PowerShell (preferring `pwsh.exe`, then `powershell.exe` on `PATH`). Linux, macOS, and WSL use Bash. Extension-provided execution operations still take precedence. `shellCommandPrefix` is still prepended, so use syntax matching the selected shell; `shellPath` configures Bash, not Windows interactive PowerShell. Escape or Ctrl+C cancels a running command. `!!` output remains excluded from model context.

On Windows, ALT+Z lends the terminal to an interactive PowerShell subshell. Type `exit` to return to the same Atomic session; owned background tasks keep running. CTRL+Z remains editor undo. On POSIX systems, CTRL+Z suspends Atomic and `fg` resumes it.

## Startup typing

On normal interactive TTY startup, Atomic starts a short-lived raw keyboard capture before deferred resources finish loading and keeps it active until the TUI input handler is mounted. Text typed before the prompt box is fully mounted is replayed into the editor. Enter-submitted ordinary prompts are queued for the prompt loop once startup is ready; command-like submissions such as `/settings` or `!pwd` are replayed as standalone editor submissions through normal command routing. If a command-like submission is captured, later captured submissions wait behind it and replay in original input order after that command is routed, so a later ordinary prompt cannot run before the earlier command and commands are not merged with following prompts. Startup work that can affect correctness, such as project trust prompts, resume/session selectors, cross-project session confirmations, explicit resource flags, metadata commands, non-TTY input, or explicit provider/model selection, still stays on the synchronous path instead of using this pre-session capture.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models and automatically save the startup default |
| `/thinking` | Switch thinking level and automatically save the startup default |
| `/scoped-models` | Enable/disable models for CTRL+P cycling |
| `/workflow` | List/run workflows; manage runs (connect/inspect/pause/quit/resume); reload workflow resources |
| `/settings` | Theme, message delivery, transport, and other preferences |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact` | Run Verbatim Compaction with transcript-bound deletion tools |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/exit` | Exit Atomic |
| `/quit` | Quit Atomic |

### Drafting feedback

Use `/feedback <what happened or what you want to change>` to draft a bug report or enhancement request in the normal conversation. A bug needs a title, what happened, and reproduction steps; an enhancement needs a title, the requested change, and why it helps. Answer any clarification, then review the prepared title and body and request edits. Preparing a draft does not post it. Review the text for private information before sharing it.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **ALT+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts active/queued work and restores queued steering/follow-up messages to the editor. The session remains paused until you submit the next ordinary chat message; that submission releases any held queue before starting the new turn. A later Escape while the queue is paused restores any newly queued steering/follow-up text without releasing the pause.
- **Ctrl+C** aborts active/queued work and pauses queued messages in place. They remain queued, in their original per-queue order, until you submit the next ordinary chat message; that submission resumes the chat and makes each queued item eligible once. After the abort settles, a later idle Ctrl+C clears the editor without releasing the hold, and a second quick idle press exits.
- **ALT+Up** explicitly retrieves queued messages back to the editor without aborting active work or resuming a paused session. Even when retrieval empties the queue, the pause remains active until the next ordinary submission.

Both interrupts hold a queued message only while it is still waiting in the queue. A message the agent has already picked up is written into the transcript, and an interrupt that cancels its reply before any output appears no longer strands it: Atomic answers it instead of returning it to the editor. A reply that had already started printing is left as-is and is not restarted. Sending a message while that recovered reply is still streaming is safe — it is delivered as soon as the reply finishes.

Both abort routes are cooperative: they ask the agent to stop and wait for it — Escape waits as long as the agent needs — and never terminate the engine that runs your tools. Ctrl+C additionally acts as an escape hatch: it always reaches Atomic when an extension's custom UI has taken over the screen — closing that UI if it does not handle the key itself — and it replaces the engine when it stops answering entirely, including a replacement that hangs before it finishes starting or one that failed to start. A message that could not be sent comes back to the editor rather than being lost: exactly as you typed it, with pasted content intact, placed above anything you typed while the send was pending and separated by a blank line, together with anything still queued behind it in the order you entered it. Atomic does not also show a red error for it. See [Keybindings](/keybindings#application).

On Windows Terminal, ALT+Enter is fullscreen by default. Remap it as described in [Terminal setup](/terminal-setup) if you want Atomic to receive the shortcut.

Configure delivery in [Settings](/settings) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.atomic/agent/sessions/`, organized by working directory.

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse and select a session
atomic --no-session        # Ephemeral mode; do not save
atomic --session <path|id> # Use a specific session file or partial session ID
atomic --session-id <id>   # Use/create an exact project-local session ID
atomic --name "Refactor"   # Set the session display name
atomic --fork <path|id>    # Fork a session into a new session file
```

When `--session-id` does not match an exact session in the current project, Atomic warns that no session was found and then creates the requested new session. Reusing an existing exact ID opens it without that warning.

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` uses verbatim line compaction: the model selects one-based numbered ranges to delete, Atomic validates them, and retained text is reconstructed mechanically with `(filtered N lines)` markers. Exactly the configured number of newest context-visible messages remains ordinary; the default is two and zero preserves none.

See [Sessions](/sessions) and [Compaction](/compaction) for details.

## Context Files

Atomic loads `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` at startup from:

- `~/.atomic/agent/` for global instructions (legacy `~/.pi/agent/` also works)
- parent directories, walking up from the current working directory
- the current directory

If a directory contains `AGENTS.override.md`, Atomic uses it instead of that directory's `AGENTS.md` or `CLAUDE.md`. Context files from other directories still layer normally.

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.atomic/SYSTEM.md` for a project
- `~/.atomic/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

Treat exported and shared sessions as sensitive: transcripts can contain source code, file paths, credentials, and other private data from your session. Review a session before sharing it, and only upload transcripts you are comfortable making accessible to anyone with the link.

## CLI Reference

Moved to [CLI reference](/reference/cli#cli-reference).

### Package Commands

Moved to [CLI reference](/reference/cli#package-commands).

### Credential Commands

Moved to [CLI reference](/reference/cli#credential-commands).

### Modes

Moved to [CLI reference](/reference/cli#modes).

### Model Options

Moved to [CLI reference](/reference/cli#model-options).

### Session Options

Moved to [CLI reference](/reference/cli#session-options).

### Tool Options

Moved to [CLI reference](/reference/cli#tool-options).

### Project Trust Options

Moved to [CLI reference](/reference/cli#project-trust-options).

### Resource Options

Moved to [CLI reference](/reference/cli#resource-options).

### Other Options

Moved to [CLI reference](/reference/cli#other-options).

### File Arguments

Moved to [CLI reference](/reference/cli#file-arguments).

### Examples

Moved to [CLI reference](/reference/cli#examples).

### Environment Variables

Moved to [CLI reference](/reference/cli#environment-variables).

## Design Principles

Atomic keeps the core CLI small, while this distribution bundles first-party package extensions for workflows, subagents, MCP, web access, and [intercom](/intercom). Other workflows can still be installed as extensions or packages, or handled externally with tools such as containers and tmux.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
