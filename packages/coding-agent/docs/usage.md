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

- **Startup header** - shortcuts plus named lists of loaded context files, prompt templates, skills, and extensions; use the expand-tools shortcut (Ctrl+O by default) to switch those lists to source paths
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - token/cache usage, cost, and context usage above the editor; below it, the current model, reasoning level, working directory, Git branch, and session name while the agent is idle, or the bound interrupt key while it works (a turn, compaction, automatic retry, or `!` command). Press `?` on an empty prompt for the main chat's key overview

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Startup and Working Identity

The startup animation shows Atomic's identity. Press any key, including Ctrl+C, to finish it immediately and continue normal input. Setting `quietStartup` to `true` suppresses it, while `"header"` keeps it; non-TTY sessions and `ATOMIC_REDUCED_MOTION=1` show the settled identity without animation. `NO_COLOR` removes foreground colors while retaining weight emphasis.

Startup lists loaded context files, skills, prompts, and extensions by name. Custom themes are not listed; choose them in `/settings`. Duplicate local extension names include path information. Expand the startup disclosure to see source paths.

While the agent works, `∀` pulses beside a working message, followed by the current run's elapsed time and output tokens. A new run starts a fresh meter; steering keeps the current run's meter. Retry, fallback, compaction, cancellation, and error messages take precedence; approval prompts hide ordinary activity. Set `ATOMIC_REDUCED_MOTION=1` for a static indicator or `NO_COLOR` for activity without foreground colors. Elapsed time still updates once per second with reduced motion. Extensions can [customize the indicator](/tui#pattern-4b-working-indicator-customization).

Compaction uses a still `∀` mark with elapsed time and the cancel key. Opening a chat during compaction shows the time since that compaction began. Afterwards, one line marks the boundary: `⚛ Context cleared · 182k tokens`, or `⚛ Context compacted · morph/morph-compactor · 182k → 21.4k tokens` when a compactor model ran. Use the expand key, normally Ctrl+O, to read the whole boundary message: where the earlier conversation is in session history, what the agent recovers first, and any compacted text.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Prompt history | ↑ and ↓ walk through past prompts; Ctrl+R searches them and puts the chosen one in the editor without sending it |
| Multi-line input | SHIFT+Enter, or CTRL+Enter on Windows Terminal |
| Images | Paste with CTRL+V, ALT+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | CTRL+G opens `$VISUAL` or `$EDITOR` |

The `@` and `/` menus end with one hint line naming the keys that work there. Tab completes without sending. Enter inserts an `@` path; for a `/`-prefixed completion, including an absolute path, Enter submits the completed prompt. Remapped menu keys appear only when an app shortcut or earlier menu action does not take them first.

Ctrl+R searches the prompts the current chat has recorded, newest first: prompts sent through templates or skills as you typed them, and a prompt an `input` hook rewrote as the hook left it. ↑ and ↓ still walk through what you typed. In writable subagent and workflow stage chats, the search uses that chat's transcript. Esc clears the search, then closes it without changing your draft or interrupting the agent. While search or completion is open, its own hint line replaces the chat's normal keys. Read-only chats keep their transcript scrolling keys and do not open prompt search.

Prompt history keeps what you typed, including input rewritten by an extension before it reaches the model. An `input` hook does not erase the original from saved session history. Avoid typing secrets directly into prompts.

See [Keybindings](/keybindings) for all shortcuts and customization.

On native Windows, `!` and `!!` execute PowerShell (preferring PowerShell 7 `pwsh.exe`, then Windows PowerShell `powershell.exe`; see [Windows](/windows) for the locations checked). Linux, macOS, and WSL use Bash. Extension-provided execution operations still take precedence. `shellCommandPrefix` is still prepended, so use syntax matching the selected shell; `shellPath` configures Bash, not Windows interactive PowerShell. Escape or Ctrl+C cancels a running command. `!!` output remains excluded from model context.

On Windows, ALT+Z lends the terminal to an interactive PowerShell subshell. Type `exit` to return to the same Atomic session; owned background tasks keep running. CTRL+Z remains editor undo. On POSIX systems, CTRL+Z suspends Atomic and `fg` resumes it.

## Startup typing

In an interactive terminal, you can type while Atomic starts, before the prompt box is ready.

When no startup screen needs an answer:
- Enter-submitted ordinary prompts wait until the session is ready.
- Command-like submissions such as `/settings` or `!pwd` run as separate editor submissions through normal command routing.
- Later submissions wait behind an earlier command and run in input order. Ordinary prompts cannot overtake commands, and commands are not merged with following prompts.

When a startup screen appears, including project trust, first-time setup, the resume picker or a cross-project fork question, your earlier text waits in the prompt as a draft. Text typed into a screen that does not use text joins that draft, with line breaks between typed lines. Text left in a startup input that you cancel, or that times out, also joins the draft. Nothing is sent until you review the draft and press Enter after startup.

Enter or a custom prompt-submit key ending an unfinished prompt does not answer the screen. Use ↑ or ↓ to choose in a selector; the resume picker and text input also accept Enter after you start typing into them. Answer a fork question with `y` or `n` explicitly if you were typing a prompt or an earlier line was kept as a draft.

Startup typing does not apply to non-TTY input, print or RPC mode, or metadata commands such as `--help` and `--list-models`.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

`/settings` lists each setting with its value, shortening long labels first on narrow terminals. Type to search; Enter or Space changes the selected setting, stepping a value in place or opening its picker (a value followed by `›`). Right does not change or save a setting, including inside a value picker. The selected setting's description shows under the list, and Esc clears a search before it closes.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models and automatically save the startup default |
| `/thinking` | Switch thinking level and automatically save the startup default |
| `/scoped-models` | Enable/disable models for CTRL+P cycling |
| `/workflows` | Browse running and completed workflows |
| `/workflow-authoring` | Load the reference for writing workflow definitions |
| `/settings` | Theme, message delivery, transport, and other preferences |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tools` | Show active tools, why other tools are off, and selected tool names that nothing registered |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [instructions]` | Clear the context window; the agent recovers what it needs from session history |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, context files and workflow resources |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display the full version history |
| `/exit` | Exit Atomic |
| `/quit` | Quit Atomic |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **ALT+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts active/queued work and restores queued steering/follow-up messages to the editor. The session remains paused until you submit the next ordinary chat message; that submission releases any held queue before starting the new turn. A later Escape while the queue is paused restores any newly queued steering/follow-up text without releasing the pause.
- **Ctrl+C** clears the editor first when it has text. With an empty editor, it aborts active/queued work and pauses queued messages in place. They remain queued, in their original per-queue order, until you submit the next ordinary chat message; that submission resumes the chat and makes each queued item eligible once. After the abort settles, Ctrl+C on an empty editor shows "Press Ctrl+C again to exit" without releasing the hold, and a second press within 0.8 s exits.
- **ALT+Up** explicitly retrieves queued messages back to the editor without aborting active work or resuming a paused session. Even when retrieval empties the queue, the pause remains active until the next ordinary submission. It restores exactly what the session still held when it handled the key press: a message queued an instant earlier comes back, and one the agent has already taken into its turn does not come back a second time. If the engine process cannot be reached, nothing is removed and Atomic shows an error.

Each queue preserves submission order, and steering messages take priority over follow-ups. Messages submitted during compaction keep their queue type and join that queue when compaction finishes or is cancelled, even if the agent is still working. Prompt templates and skills wait the same way. Slash commands that do not send a prompt, such as `/settings`, `/tasks`, `/model` and extension commands like `/workflows`, run immediately during compaction. A message that such a command sends, for example through `pi.sendUserMessage()`, also waits until compaction ends. It is shown as queued, goes out once, and keeps its place after the messages typed before the command. **ALT+Up** and Ctrl+C return it to the editor like the rest of the queue.

Messages you submit while Atomic is still preparing a prompt, while it waits to retry a failed request, or while extensions finish handling the end of a run are queued the same way. They show as queued at once and join the run at its next turn boundary, in the order you submitted them. If the agent refuses one, Atomic returns the text to the editor, or keeps it queued, and shows the error.

If the first message sent after compaction fails, it stays queued with the messages after it, in the order you typed them, and Atomic shows the error. Anything you submit next is queued behind them, and your next submission sends them again in order. **ALT+Up** retrieves them to the editor in that same order.

Both interrupts hold a queued message only while it is still waiting in the queue. A message the agent has already picked up is written into the transcript, and an interrupt that cancels its reply before any output appears no longer strands it: Atomic answers it instead of returning it to the editor. A reply that had already started printing is left as-is and is not restarted. Sending a message while that recovered reply is still streaming is safe — it is delivered as soon as the reply finishes.

Both abort routes ask the agent to stop cooperatively, and neither route terminates the engine during normal cancellation. The turn ends once each of its tool calls has stopped. A tool call still waiting for an earlier call to finish ends at once with `Operation aborted` and does not run. A tool call that has not stopped 10 seconds after the interrupt (set `ATOMIC_TOOL_ABORT_GRACE_MS` to change this; see [Environment variables](/environment-variables)) gets the result `Operation aborted: <tool> did not stop within 10 seconds after the turn was interrupted`, and the turn ends anyway. Such a call may keep running in the background, but later tool calls no longer wait for it. Anything it returns or throws after the grace period is discarded; it does not enter the chat or a later model request.

Ctrl+C also provides a recovery path. It reaches Atomic even when an extension's custom UI owns the screen, closing that UI if it does not handle the key. If the engine stops answering, a queue clear or cancellation remains unanswered for over one second, or either operation fails, Ctrl+C replaces the engine. This includes cancelling chat, shell commands, compaction, and retries, even while engine heartbeats continue. It also covers a replacement that hangs during startup or fails to start. Recovery is explicit: a stalled control does not restart the engine on its own. Replacing the engine interrupts its running workflows and tools; inspect workflow status before resuming work.

If a message could not be sent, Atomic restores it to the editor exactly as typed, including pasted content. It appears above anything typed while the send was pending, separated by a blank line, together with later queued messages in their original order. Atomic does not also show a red error. See [Keybindings](/keybindings#application).

On Windows Terminal, ALT+Enter is fullscreen by default. Remap it as described in [Terminal setup](/terminal-setup) if you want Atomic to receive the shortcut.

Configure delivery in [Settings](/settings) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.atomic/agent/sessions/`, organized by working directory.

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse and select a session
atomic --no-session        # No resumable session (released history may use disk; see Sessions)
atomic --session <id|prefix> # Use an exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a format-4 JSONL export into session storage
atomic --session-id <id>   # Use/create an exact project-local session ID
atomic --name "Refactor"   # Set the session display name
atomic --fork <id|prefix>    # Fork an exact ID or unique 8-hex UUID prefix
```

When `--session-id` does not match an exact session in the current project, Atomic warns that no session was found and then creates the requested new session. Reusing an existing exact ID opens it without that warning.

`--session` and `--fork` resolve exact custom IDs first within each search scope. UUID-backed sessions also support a unique, exactly 8-character hexadecimal prefix; ambiguous prefixes list their matching full UUIDs, while other UUID truncations are rejected after checking for exact custom IDs, including global IDs such as `cafe`. Current-project matches retain priority over the global session store. Repeated catalog entries for the same UUID count as one match.

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact [instructions]` clears the context window. The model then sees the system prompt and one message that says where the earlier conversation is in session history and what to recover first, followed by your instructions. With a compactor model configured, the compactor's output replaces the context instead.

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

The default prompt asks the agent to write self-describing code and not add code comments unless you ask for them or the task calls for them. To get comments, request them in your prompt (for example "add JSDoc to the exported functions"), or make it a standing rule in a context file or `APPEND_SYSTEM.md` (for example "Document every exported function with a JSDoc block"). The default guideline explicitly defers to those instructions, so no other configuration is needed.

The agent remembers earlier work through `history://`: it recalls this project's past sessions and workflow runs, and the preferences you stated in them, when you refer to earlier work, when a task resembles one done before, and before it chooses between a workflow and inline work, how to verify a change, or how long a task will take. Workflow stages and subagents recall the same history by default. With a shell tool, the agent also searches commits, issues, PRs and their comments for relevant prior work. See [Recalling earlier work](/sessions#recalling-earlier-work).

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML. In the exported page, press `T` to toggle thinking, `O` to toggle tool output, and `H` to show custom messages that are hidden in the terminal. Hidden messages stay hidden until you toggle them, and selecting one in the sidebar reveals them.

`atomic --export <session.jsonl> [file]` can show an `Agent(...)` card for a single subagent launch on the selected branch. Expand it to read the prompt, tool calls and answer saved in the receipt. A recorded background handoff is labeled as a handoff, not as a currently running child. Open **Recorded arguments and result** for the original record. The export never opens the child's session. Parallel launches, incomplete or ambiguous receipts, and other extension tools keep their usual export format.

Use `/share` to upload a private GitHub gist with a shareable link. The link opens the session in Atomic's viewer at `https://bastani.ai/session/`; set `ATOMIC_SHARE_VIEWER_URL` to use your own viewer instead.

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
