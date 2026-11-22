---
title: "Interactive use"
description: "Interactive mode, slash commands, the message queue, sessions, and context files."
---

# Using Atomic

This page collects day-to-day usage details that do not fit on the quickstart page.

## On this page and its reference

This page covers interactive use: the interactive loop, slash commands, the message queue, sessions, context files, and the design principles behind them. Every command, flag, argument, and environment variable now lives in the [CLI reference](/reference/cli).

## Interactive mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600" /></p>

The interface has four main areas:

- **Startup header.** Shortcuts plus named lists of loaded context files, prompt templates, skills, and extensions. Press the expand-tools shortcut (`Ctrl+O` by default) to switch those lists to source paths.
- **Messages.** User messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI.
- **Editor.** The prompt box where you type. Its border color shows the current thinking level.
- **Footer.** Token usage, cache usage, cost, and context usage sit above the editor. Below it, Atomic shows the current model, reasoning level, working directory, Git branch, and session name while idle, or the bound interrupt key while working (`esc to interrupt` on `main`, `esc to pause` while viewing a subagent). When background subagents run, the [agent panel](/background-tasks#the-agent-panel) appears below the footer; selecting a subagent swaps the transcript and points the prompt at it. Press `?` on an empty prompt for the key overview.

Built-in views such as `/settings` or custom extension UI can temporarily replace the editor.

### Startup and working identity

The startup animation shows Atomic's identity. Press any key, including Ctrl+C, to finish it immediately and continue normal input. Setting `quietStartup` to `true` hides it, while `"header"` keeps it. Non-TTY sessions and `ATOMIC_REDUCED_MOTION=1` show the settled identity without animation. Setting `NO_COLOR` turns off foreground and background colors and text styles (bold, italic, dim, underline, inverse, and strikethrough).

Startup lists loaded context files, skills, prompts, and extensions by name. Custom themes are not listed; choose them in `/settings`. Duplicate local extension names include path details. Expand the startup block to inspect source paths.

While the agent works, `∀` pulses beside a status message with the current run's elapsed time and output tokens. A new run starts a fresh meter; steering keeps the current meter. Retry, fallback, compaction, cancellation, and error notices take precedence, and approval prompts hide ordinary activity. Set `ATOMIC_REDUCED_MOTION=1` for a static mark (elapsed time still updates once per second) or `NO_COLOR` for plain unstyled output. Extensions can [customize the indicator](/tui#pattern-4b-working-indicator-customization).

Compaction shows a still `∀` mark with elapsed time and the cancel key. Opening a chat during compaction displays how long compaction has been running. Afterwards, one line marks the boundary: `⚛ Context cleared · 182.0k tokens`, or `⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens` when a compactor model ran. Press `Ctrl+O` to inspect where the earlier conversation lives in session history, what the agent recovers first, and any compacted text.

### Editor features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Prompt history | `↑` and `↓` walk past prompts; `Ctrl+R` searches them and places the chosen prompt in the editor without sending |
| Multi-line input | `Shift+Enter` or `Ctrl+J` |
| Images | Paste with `Ctrl+V` (`Alt+V` or `Ctrl+V` on Windows and WSL), or drag into the terminal |
| Shell command | `!command` runs a command and includes output in model context |
| Hidden shell command | `!!command` runs a command without sending output to model context |
| External editor | `Ctrl+G` opens `externalEditor`, `$VISUAL`, or `$EDITOR` |

The `@` and `/` menus end with a hint line naming active keys. `Tab` completes without sending. `Enter` inserts an `@` path; for a `/`-prefixed completion (including an absolute path), `Enter` submits the completed prompt. Remapped menu keys appear only when an app shortcut or earlier menu action does not claim them first.

`Ctrl+R` searches the viewed agent's recorded prompts, newest first, including prompts sent through templates or skills and prompts rewritten by an `input` hook. Editor `↑` and `↓` walk what you typed during the current run (on `main`, the main chat's prompts; while viewing a subagent, that subagent's prompts; queued messages come back with `Alt+Up` or `Alt+Q` rather than `↑`). `Esc` clears search text and then closes the search without touching your draft or interrupting the agent.

When an `input` hook transforms a prompt, Atomic saves the transformed text to session history and searches that transformed text in `Ctrl+R`. Only editor `↑` and `↓` walk the raw text you typed during the current run. Avoid typing secrets directly into prompts.

See [Keybindings](/keybindings) for all shortcuts and customization.

On native Windows, `!` and `!!` run PowerShell (preferring PowerShell 7 `pwsh.exe`, then Windows PowerShell `powershell.exe`; see [Windows](/windows)). Linux, macOS, and WSL use Bash. Extension-provided execution hooks take precedence. `shellCommandPrefix` is prepended to each command, so match the active shell's syntax (`shellPath` configures Bash, not Windows interactive PowerShell). `Esc` or `Ctrl+C` cancels a running command. While viewing a subagent, `!` and `!!` commands are refused; switch to `main` to run them.

On native Windows, `Alt+Z` opens an interactive PowerShell subshell; type `exit` to return to the same Atomic session while background tasks keep running, and `Ctrl+Z` stays editor undo. On POSIX systems and WSL, `Ctrl+Z` suspends Atomic and `fg` resumes it.

## Startup typing

On eligible interactive starts, Atomic opens the prompt editor immediately so you can start typing right away, and your text is kept while the session finishes loading. This applies in a fullscreen terminal when no startup dialog (such as first-run setup or a project trust prompt), non-default editor display setting (other than a built-in global theme), or CLI flag outside `--offline`, `--no-mcp`, `--verbose`, `--approve`/`-a`, and `--no-approve`/`-na` is active.

While the session is still loading:

- Typing and prompt-editing keys (cursor and word movement, deletions, kill ring, undo, and newlines) act immediately and echo live.
- `Ctrl+C` clears prompt text, or exits on a second press within 0.8 seconds on an empty prompt. `Ctrl+D` exits on an empty prompt.
- Non-editing keys (`Enter`, command shortcuts, `Esc`, view-switching keys, and mouse events) wait in order until the session takes over on the same screen.
- Any direct stdout or stderr output written during startup stays visible instead of being overwritten by the prompt.
- Clicking in the prompt before completions finish loading cancels any pending `/` or `@` completion lookup.

When a startup dialog, an ineligible flag (such as `--resume`, `--continue`, or `--name`), or a custom editor display setting applies, Atomic falls back to buffered startup typing before the UI paints:

- `Enter`-submitted ordinary prompts wait until the session is ready.
- Command submissions such as `/settings` or `!pwd` run as separate submissions through normal command routing in input order.
- Unsubmitted text waits in the editor. If it ends with a `/` command or `@` file and no earlier command ran, its completion menu opens once completions are ready unless you click elsewhere first.

When a startup screen appears (project trust, first-run setup, resume picker, or cross-project fork prompt), earlier typed text waits in the prompt as a draft. Text typed into a screen that ignores text, or left in a cancelled or timed-out startup input, joins that draft with line breaks. Nothing sends until you review the draft and press `Enter` after startup.

`Enter` (or a custom submit key) ending an unfinished prompt never answers a startup screen automatically. Use `↑` or `↓` in selectors (the resume picker and text prompts accept `Enter` after you type into them), and answer a fork prompt explicitly with `y` or `n`. Startup typing does not apply to non-TTY input, print or RPC mode, or metadata commands such as `--help` and `--list-models`.

## Slash commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills run as `/skill:name`, and prompt templates expand via `/templatename`. While viewing a subagent, built-in commands target `main` (confirming commands that replace or rewrite the main chat, refusing `/model` and `/thinking`, and using `/copy` for the viewed subagent's last message), while skills, prompt templates, and user or project extension commands target the viewed subagent; see [Commands while viewing a subagent](/background-tasks#commands-while-viewing-a-subagent).

`/settings` lists each setting and value, shortening long labels on narrow terminals. Type to search; press `Enter` or `Space` to step a value or open its picker (`›`). `Right` never changes or saves a setting. The selected setting's description appears below the list, and `Esc` clears search before closing.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models and save the startup default |
| `/thinking` | Switch thinking level and save the startup default |
| `/scoped-models` | Enable, disable, and reorder models for `Ctrl+P` cycling |
| `/settings` | Change theme, message delivery, transport, and other preferences |
| `/resume` | Browse and resume previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the session display name |
| `/session [snapshot]` | Show session location, ID, messages, tokens, and cost; `snapshot` shows worktree snapshots and diffs |
| `/tools` | Show active tools, why other tools are off, and unregistered names in `defaultTools` |
| `/tasks` | Inspect agents and background shells, view output, and manage running tasks |
| `/tree` | Jump to any point in the session tree and continue from there |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [instructions]` | Clear or compact the context window; the agent recovers needed details from session history |
| `/copy` | Copy the last assistant message to the clipboard |
| `/export [file]` | Export the session to HTML (default) or format-4 `.jsonl` when `file` ends in `.jsonl` |
| `/import <file>` | Import a format-4 `.jsonl` session export and replace the current session |
| `/share` | Upload as a private GitHub gist with a shareable HTML link |
| `/trust` | Save a project trust decision for future sessions |
| `/llama` | Manage local `llama.cpp` router models (load, unload, or download from Hugging Face) |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display the full version history |
| `/exit`, `/quit` | Exit Atomic |

Bundled integrations also register `/agents` (subagents), `/mcp` (MCP servers), `/intercom` (Intercom overlay), and `/curator`, `/websearch`, `/search`, `/google-account` ([Web access](/web-access)).

## Message queue

You can submit messages while the agent works. The same queue and interrupt keys apply on `main` and while viewing a subagent, except `Esc` pauses a viewed subagent instead of interrupting `main`:

- **Enter** queues a steering message, delivered after the current assistant turn finishes its tool calls.
- **Alt+Enter** (**Ctrl+Q** on Windows and WSL) queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts active or queued work and restores still-queued steering and follow-up messages to the editor. The session stays paused until you submit the next ordinary chat message, which releases any held queue before starting the turn. Another `Escape` while paused restores newly queued text without releasing the pause.
- **Ctrl+C** clears editor text first. On an empty editor, it aborts active or queued work and pauses queued messages in place in their original order until your next ordinary submission. After the abort settles, `Ctrl+C` on an empty editor displays `Press Ctrl+C again to exit` without releasing the hold, and a second press within 0.8 seconds exits.
- **Alt+Up** (**Alt+Q** on Windows and WSL) retrieves queued messages back to the editor without aborting active work or resuming a paused session. It restores only messages the agent has not already taken into its turn, and reports an error without dropping messages if the engine is unreachable.

Each queue keeps submission order, and steering messages run ahead of follow-ups. Messages submitted during compaction, prompt templates, skills, and messages sent from slash commands via `pi.sendUserMessage()` wait in queue order until compaction ends or is cancelled. Non-prompt slash commands such as `/settings`, `/tasks`, and `/model` run immediately during compaction.

Messages submitted while Atomic prepares a prompt, waits to retry a failed request, or finishes end-of-run extension hooks queue the same way and join the next turn boundary in order. If the first message sent after compaction fails, it stays queued ahead of later messages so your next submission retries them in order, and `Alt+Up` (or `Alt+Q`) returns them together.

Interrupts hold only messages still waiting in the queue. A message the agent already picked up stays in the transcript; if an interrupt cancels its reply before any output prints, Atomic answers it rather than stranding it. A reply that already began printing stays as printed, and sending a message while a recovered reply streams queues cleanly until it finishes.

Both abort paths request cooperative cancellation and leave the engine running during normal interrupts. Pending tool calls abort immediately with `Operation aborted`. Any active tool call still running 10 seconds after the interrupt (configurable via `ATOMIC_TOOL_ABORT_GRACE_MS`; see [Environment variables](/environment-variables)) receives `Operation aborted: <tool> did not stop within 10 seconds after the turn was interrupted`, letting the turn finish while discarding any later output from that call.

`Ctrl+C` also provides explicit recovery. It closes an extension's custom UI if that UI does not handle `Ctrl+C`. If the engine stops answering, or a cancel or queue-clear request fails or stalls for over one second (even while heartbeats continue), `Ctrl+C` terminates and replaces the engine. Recovery never triggers automatically. Replacing the engine interrupts running tools; check `/tasks` and the transcript before repeating actions.

If sending fails, Atomic restores your unsent text (including pasted content) to the editor above any text typed while the send was pending, along with later queued messages in order, without adding a redundant red error. See [Keybindings](/keybindings#application).

On Windows and WSL, follow-up queueing defaults to `Ctrl+Q` and dequeue defaults to `Alt+Q`, avoiding Windows Terminal's `Alt+Enter` fullscreen binding. Only remap `Alt+Enter` in [Terminal setup](/terminal-setup) if you explicitly rebind an action to `alt+enter`.

Configure delivery behavior with `steeringMode` and `followUpMode` in [Settings](/settings#message-delivery).

## Sessions

Sessions auto-save to the local SQLite database `~/.atomic/workflows/journal.sqlite` by default. JSONL session directories such as `~/.atomic/agent/sessions/` are opt-in via `--session-dir`, `ATOMIC_CODING_AGENT_SESSION_DIR`, or `sessions.storage`.

Common session flags include `atomic -c` (continue latest in this directory), `atomic -r` (browse sessions), `atomic --session <id|prefix>`, `atomic --fork <id|prefix>`, `atomic --name "Refactor"`, `atomic --import <file>`, and `atomic --no-session`. See [CLI session options](/reference/cli#session-options) for the full list.

Useful interactive session commands:

- `/session` shows the current session location, ID, and usage stats (`/session snapshot` shows worktree snapshots).
- `/tree` navigates the session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session.
- `/compact [instructions]` clears the context window so the agent recovers needed context from session history (or compacts through a configured `compactionModel`).

See [Sessions](/sessions) and [Compaction](/compaction) for storage selection, ID matching, branching, and compaction details.

## Context files

Atomic loads `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` from `~/.atomic/agent/`, ancestor directories, and the current directory. See [Project instructions](/getting-started/project-instructions) for discovery order and override rules. Disable context files for one run with `--no-context-files` or `-nc`.

### System prompt files

Replace the default system prompt with `.atomic/SYSTEM.md` (project) or `~/.atomic/agent/SYSTEM.md` (global). Append to the default prompt with `APPEND_SYSTEM.md` in either location.

The default prompt instructs the agent to write self-describing code without unnecessary comments unless requested. Ask for comments directly in your prompt or add a standing rule in a context file or `APPEND_SYSTEM.md`.

The agent recalls earlier sessions in this project through `history://` when you reference past work, tackle a similar task, or plan verification. Subagents can recall session history too, and with a shell tool the agent also searches commits, issues, and pull requests. See [Recalling earlier work](/sessions#recalling-earlier-work).

## Exporting and sharing sessions

Use `/export [file]` to write a session to HTML (default) or to format-4 `.jsonl` when the filename ends in `.jsonl`. In exported HTML, press `T` to toggle thinking, `O` to toggle tool output, and `H` to show custom messages hidden in the terminal.

`atomic --export <session.jsonl> [file]` renders an `Agent(...)` card for a single subagent launch on the selected branch, showing the prompt, tool calls, and answer saved in the receipt without opening the child's session. Background handoffs are labeled as handoffs rather than running children, and **Recorded arguments and result** shows the original record. Parallel launches and other extension tools keep their normal export format.

Use `/share` to upload a private GitHub gist with a shareable link that opens in `https://bastani.ai/session/` (override with `ATOMIC_SHARE_VIEWER_URL`).

Treat exported and shared sessions as sensitive. Transcripts can contain source code, file paths, and credentials; review a session before sharing it with anyone who has the link.

## Design principles

Atomic keeps the core CLI small and bundles first-party integrations for subagents, MCP, web access, and [Intercom](/intercom). For reusable multi-step procedures, write a [skill](/skills#skills-as-workflows).

## Moved sections

CLI flags, commands, and environment variables moved to the [CLI reference](/reference/cli):

<a id="cli-reference" />
<a id="package-commands" />
<a id="credential-commands" />
<a id="modes" />
<a id="model-options" />
<a id="session-options" />
<a id="tool-options" />
<a id="project-trust-options" />
<a id="resource-options" />
<a id="other-options" />
<a id="file-arguments" />
<a id="examples" />
<a id="environment-variables" />

- [CLI reference](/reference/cli#cli-reference), [Package commands](/reference/cli#package-commands), and [Credential commands](/reference/cli#credential-commands)
- [Modes](/reference/cli#modes), [Model options](/reference/cli#model-options), and [Session options](/reference/cli#session-options)
- [Tool options](/reference/cli#tool-options), [Project trust options](/reference/cli#project-trust-options), [Resource options](/reference/cli#resource-options), and [Other options](/reference/cli#other-options)
- [File arguments](/reference/cli#file-arguments), [Examples](/reference/cli#examples), and [Environment variables](/reference/cli#environment-variables)
