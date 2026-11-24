---
title: "Interactive mode"
sidebarTitle: "Interactive mode"
description: "Use Atomic's terminal editor, slash commands, startup typing, message queue, sessions, and context files."
---

Interactive mode runs Atomic in a fullscreen terminal interface for day-to-day coding, slash commands, message queueing, and session navigation. For every CLI command, flag, and exit code, see the [CLI reference](/reference/cli).

## Terminal interface

<p align="center"><img src="images/interactive-mode.png" alt="Screenshot of Atomic interactive mode in a dark terminal window displaying the purple Atomic logo, a user prompt, inline tool call results, token and cost statistics above the bottom input box, and the esc to interrupt footer hint." width="600" /></p>

The interface has four main areas:

- **Startup header.** Shortcuts plus named lists of loaded context files, prompt templates, skills, and extensions. Press the expand-tools shortcut (`Ctrl+O` by default) to switch those lists to source paths.
- **Messages.** User messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI.
- **Editor.** The prompt box where you type. Its border color shows the current thinking level.
- **Footer.** Token usage, cache usage, cost, and context usage sit above the editor. Below it, Atomic shows the current model, reasoning level, working directory, Git branch, and session name while idle, or the bound interrupt key while working (`esc to interrupt` on `main`, `esc to pause` while viewing a subagent). When background subagents run, the [agent panel](/background-tasks#the-agent-panel) appears below the footer; selecting a subagent swaps the transcript and points the prompt at it. Press `?` on an empty prompt for the key overview.

Built-in views such as `/settings` or custom extension UI can temporarily replace the editor.

### Startup animation and working indicator

The startup animation introduces Atomic on launch. Press any key, including `Ctrl+C`, to finish it immediately and continue normal input. Setting `quietStartup` to `true` hides it, while `"header"` keeps it. Non-TTY sessions and `ATOMIC_REDUCED_MOTION=1` show the settled logo without animation. Setting `NO_COLOR` (to any value, including an empty string) or `FORCE_COLOR=0` turns off foreground and background colors and text styles (bold, italic, dim, underline, inverse, and strikethrough).

Startup lists loaded context files, skills, prompts, and extensions by name. Custom themes are not listed; choose them in `/settings`. Duplicate local extension names include path details. Expand the startup block with `Ctrl+O` to inspect source paths.

While the agent works, `∀` pulses beside a status message with the current run's elapsed time and output tokens. A new run starts a fresh meter; steering keeps the current meter. Retry, fallback, compaction, cancellation, and error notices take precedence, and approval prompts hide ordinary activity. Set `ATOMIC_REDUCED_MOTION=1` for a static mark (elapsed time still updates once per second) or `NO_COLOR` for plain unstyled output. Extensions can [customize the indicator](/tui#pattern-4b-working-indicator-customization).

Compaction shows a still `∀` mark with elapsed time and the cancel key. Opening a chat during compaction displays how long compaction has been running. Afterwards, one line marks the boundary: `⚛ Context cleared · 182.0k tokens`, or `⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens` when a compactor model ran. Press `Ctrl+O` to inspect where the earlier conversation lives in session history, what the agent recovers first, and any compacted text.

### Editor features

| Feature | How |
| --- | --- |
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press `Tab` to complete paths |
| Prompt history | `↑` and `↓` walk past prompts; `Ctrl+R` searches them and places the chosen prompt in the editor without sending |
| Multi-line input | `Shift+Enter` or `Ctrl+J` |
| Images | Paste with `Ctrl+V` (`Alt+V` or `Ctrl+V` on Windows and WSL), or drag into the terminal |
| Shell command | `!command` runs a command and includes output in model context |
| Hidden shell command | `!!command` runs a command without sending output to model context |
| External editor | `Ctrl+G` opens `externalEditor`, `$VISUAL`, or `$EDITOR` (falling back to `notepad` on Windows or `nano` on macOS and Linux) |

**`@` file picker and completion menus:** The `@` picker searches with `fd` (`--follow --hidden`, respecting `.gitignore` and skipping `.git/`), supports quoted paths with spaces (`@"path with spaces"`), and wraps paths containing spaces automatically. If `fd` is unavailable, it falls back to single-directory listing like `Tab`. Both `@` and `/` menus end with a hint line naming active keys: `Tab` completes without sending, and `Enter` inserts an `@` path or submits a `/`-prefixed completion (including absolute paths). Remapped menu keys appear only when an app shortcut or earlier menu action does not claim them first.

**Prompt history:** Editor `↑` and `↓` keep up to 100 recent adjacent-deduplicated prompts typed during the current run (per viewed agent: `main` or the selected subagent; retrieve queued messages with `Alt+Up` or `Alt+Q` instead). `Ctrl+R` searches the viewed agent's recorded prompts newest first, including prompts expanded from templates or skills and prompts transformed by an `input` hook. When an `input` hook transforms a prompt, Atomic saves and searches the transformed text in `Ctrl+R`, while editor `↑` and `↓` walk the raw text you typed. `Esc` clears search text and then closes search without touching your draft or interrupting the agent. Avoid typing secrets directly into prompts.

**Interactive shell commands (`!` and `!!`):** Only one interactive `!` or `!!` command can run at a time; submitting another warns that a command is already running and restores your text. On native Windows, `!` and `!!` run PowerShell (preferring PowerShell 7 `pwsh.exe`, then Windows PowerShell `powershell.exe`; see [Windows](/windows)). Linux, macOS, and WSL use Bash. Extension-provided execution hooks take precedence. `shellCommandPrefix` is prepended to each command, so match the active shell's syntax (`shellPath` configures Bash, not Windows interactive PowerShell). `Esc` or `Ctrl+C` cancels a running command. While viewing a subagent, `!` and `!!` commands are refused; switch to `main` to run them.

**Suspend and subshell:** On native Windows, `Alt+Z` opens an interactive PowerShell subshell; type `exit` to return to the same Atomic session while background tasks keep running, and `Ctrl+Z` stays editor undo. On POSIX systems and WSL, `Ctrl+Z` suspends Atomic and `fg` resumes it.

See [Keybindings](/keybindings) for all shortcuts and customization.

## Startup typing

On eligible interactive starts, Atomic opens the prompt editor immediately so you can start typing right away, and keeps your text while the session finishes loading.

Immediate startup typing activates in a fullscreen terminal when all of these hold:

- Standard input and output are a TTY, `CI` is unset, and `TERM` is not `dumb`.
- No startup dialog (such as first-run setup or a project trust prompt) is shown.
- No CLI flags are passed outside `--offline`, `--no-mcp`, `--verbose`, `--approve`/`-a`, and `--no-approve`/`-na`.
- None of these editor display settings are set in global, legacy, or project settings: `editorPaddingX`, `autocompleteMaxVisible`, `showHardwareCursor`, `terminal`, `fullscreenScrollbar`, `fullscreenCopyOnSelect`, or `fullscreenWheelScrollLines`.
- No project or legacy `theme` override is set, and the global `theme` is unset or one of the six static built-in themes (`dark`, `light`, `catppuccin-frappe`, `catppuccin-latte`, `catppuccin-macchiato`, `catppuccin-mocha`). `system` and `light/dark` pairs use standard startup.

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

Commands that take no arguments (such as `/new`, `/tools`, `/reload`, `/tree`, `/fork`, `/clone`, `/settings`, and `/session` with anything other than `snapshot`) match only when entered bare. Appending extra text sends that text to the model as a normal prompt.

`/settings` lists each setting and value, shortening long labels on narrow terminals. Type to search; press `Enter` or `Space` to step a value or open its picker (`›`). `Right` never changes or saves a setting. The selected setting's description appears below the list, and `Esc` clears search before closing.

| Command | Description |
| --- | --- |
| `/login [provider]` | Sign in with an OAuth subscription or save an API key. Accepts an optional provider ID or display name |
| `/logout [provider]` | Remove stored credentials from `~/.atomic/agent/auth.json` (leaves environment variables and `models.json` unchanged) |
| `/model [provider/model]` | Switch models and save the startup default. An exact case-insensitive match (`provider/id` or bare `id`, no `:thinking` suffix) switches immediately; other text opens the picker pre-filtered. Searches scoped models when active, otherwise all available models |
| `/thinking [level]` | Set the thinking level (case-insensitive) and save the startup default. Rejects levels unsupported by the current model with an error listing available levels |
| `/scoped-models` | Enable, disable, and reorder models for `Ctrl+P` cycling |
| `/settings` | Change theme, message delivery, transport, and other preferences |
| `/resume [id\|prefix]` | Open a session directly by full ID or unique 8-hex prefix, or browse previous sessions when called with no argument |
| `/new` | Start a new session |
| `/name [name]` | Set the session display name, or print the current name when called with no argument |
| `/session [snapshot]` | Show session location, ID, messages, tokens, and cost; `snapshot` shows worktree snapshots and diffs |
| `/tools` | Show active tools, why other tools are off, and unregistered names in `defaultTools` |
| `/tasks [taskId]` | Inspect background subagents and shells, or open a specific task directly by task ID |
| `/tree` | Jump to any point in the session tree and continue from there |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [instructions]` | Clear or compact the context window so the agent recovers details from session history. A manual `/compact` can take over an automatic compaction in progress; a second manual call warns and is ignored |
| `/copy` | Copy the last assistant message to the clipboard |
| `/export [file]` | Export the session to HTML (default) or to a JSONL export when `file` ends in `.jsonl` (case-insensitive). Accepts quoted paths with spaces and rejects unclosed quotes |
| `/import <file>` | Import an exported `.jsonl` session (accepts quoted paths; asks for confirmation before replacing the current session) |
| `/share` | Upload a private GitHub gist with a shareable HTML link. Requires `gh` installed and authenticated (`gh auth login`); strips worktree snapshot contents and large tool-output blobs from the uploaded copy |
| `/trust` | Save a project trust decision for future sessions |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, context files, system prompt files, `settings.json`, and `models.json` (refused while the agent is streaming or compaction is active) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display the full version history |
| `/debug` | Unlisted diagnostic command that appends a UI and message snapshot to `~/.atomic/agent/atomic-debug.log` and prints the file path (see [Debugging](/development#debugging)) |
| `/exit`, `/quit` | Exit Atomic |

**Bundled extension commands:** Atomic's bundled extensions also register `/agents` (subagents), `/mcp` (MCP servers), `/intercom` (Intercom overlay), `/llama` (load, unload, or download local `llama.cpp` router models from Hugging Face; see [Local models](/llama-cpp)), and `/curator`, `/websearch`, `/search`, `/google-account` ([Web access](/web-access)).

## Message queue

You can submit messages while the agent works. Atomic runs your session in a background session process separate from the terminal UI so queued input and interrupts stay responsive.

### Queueing and interrupting

The same queue and interrupt keys apply on `main` and while viewing a subagent, except `Esc` pauses a viewed subagent instead of interrupting `main`:

- **`Enter`** queues a steering message, delivered after the current assistant turn finishes its tool calls.
- **`Alt+Enter`** (**`Ctrl+Q`** on Windows and WSL) queues a follow-up message, delivered after the agent finishes all work.
- **`Escape`** aborts active or queued work and restores still-queued steering and follow-up messages to the editor. The session stays paused until you submit the next ordinary chat message, which releases any held queue before starting the turn. Another `Escape` while paused restores newly queued text without releasing the pause.
- **`Ctrl+C`** clears editor text first. On an empty editor, it aborts active or queued work and pauses queued messages in place in their original order until your next ordinary submission. After the abort settles, `Ctrl+C` on an empty editor displays `Press Ctrl+C again to exit` without releasing the hold, and a second press within 0.8 seconds exits.
- **`Alt+Up`** (**`Alt+Q`** on Windows and WSL) retrieves queued messages back to the editor without aborting active work or resuming a paused session. It restores only messages the agent has not already taken into its turn, and reports an error without dropping messages if the background session process is unreachable.

Each queue keeps submission order, and steering messages run ahead of follow-ups. Messages submitted during compaction, prompt templates, skills, and messages sent by slash commands wait in queue order until compaction ends or is cancelled. Non-prompt slash commands such as `/settings`, `/tasks`, and `/model` run immediately during compaction.

Messages submitted while Atomic prepares a prompt, waits to retry a failed request, or finishes end-of-run extension hooks queue the same way and join the next turn boundary in order. If the first message sent after compaction fails, it stays queued ahead of later messages so your next submission retries them in order, and `Alt+Up` (or `Alt+Q`) returns them together.

Interrupts hold only messages still waiting in the queue. A message the agent already picked up stays in the transcript; if an interrupt cancels its reply before any output prints, Atomic answers it rather than stranding it. A reply that already began printing stays as printed, and sending a message while a recovered reply streams queues cleanly until it finishes.

On Windows and WSL, follow-up queueing defaults to `Ctrl+Q` and dequeue defaults to `Alt+Q`, avoiding Windows Terminal's `Alt+Enter` fullscreen binding. Only remap `Alt+Enter` in [Terminal setup](/terminal-setup) if you explicitly rebind an action to `alt+enter`.

Configure delivery behavior with `steeringMode` and `followUpMode` in [Settings](/settings#message-delivery).

### Interrupt grace period and recovery

Both abort paths request cooperative cancellation and keep the background session process running during normal interrupts. Pending tool calls abort immediately with `Operation aborted`. Any active tool call still running 10 seconds after the interrupt (configurable via `ATOMIC_TOOL_ABORT_GRACE_MS`; see [Environment variables](/environment-variables)) receives `Operation aborted: <tool> did not stop within 10 seconds after the turn was interrupted`, letting the turn finish while discarding any later output from that call.

`Ctrl+C` also provides explicit recovery. It closes an extension's custom UI if that UI does not handle `Ctrl+C`. If the background session process stops answering, or a cancel or queue-clear request fails or stalls for over one second, `Ctrl+C` terminates and restarts the session process. Recovery never triggers automatically. Restarting the session process interrupts running tools; check `/tasks` and the transcript before repeating actions.

If sending fails, Atomic restores your unsent text (including pasted content) to the editor above any text typed while the send was pending, along with later queued messages in order, without adding a redundant red error. See [Keybindings](/keybindings#application).

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

## Context and system prompt files

Atomic loads `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` from global config directories, ancestor directories up to the filesystem root, and the current directory. See [Add project instructions](/getting-started/project-instructions) for exact single-file-per-directory priority, worktree shadowing, and untrusted-project rules. Disable context files for one run with `--no-context-files` or `-nc`.

### System prompt files

Replace the default system prompt with `SYSTEM.md` or append standing instructions with `APPEND_SYSTEM.md`. Atomic loads only the **first existing file** in this order:

1. `.atomic/SYSTEM.md` (trusted projects only)
2. `.pi/SYSTEM.md` (trusted projects only)
3. `~/.atomic/agent/SYSTEM.md`
4. `~/.pi/agent/SYSTEM.md`

`APPEND_SYSTEM.md` uses the exact same four-path order, so a project `APPEND_SYSTEM.md` **replaces** (does not concatenate with) a global `APPEND_SYSTEM.md`. Passing `--system-prompt` overrides `SYSTEM.md`, and passing `--append-system-prompt` replaces any discovered `APPEND_SYSTEM.md`. Context files and skills still append even when `SYSTEM.md` or `--system-prompt` replaces the default prompt.

The default prompt instructs the agent to write self-describing code without unnecessary comments unless requested. Ask for comments directly in your prompt or add a standing rule in a context file or `APPEND_SYSTEM.md`.

The agent recalls earlier sessions in this project through `history://` when you reference past work, tackle a similar task, or plan verification. Subagents can recall session history too, and with a shell tool the agent also searches commits, issues, and pull requests. See [Recalling earlier work](/sessions#recalling-earlier-work).

## Exporting and sharing sessions

Use `/export [file]` to write a session to HTML (default) or to a JSONL export when the filename ends in `.jsonl` (case-insensitive). Quoted filenames work for paths containing spaces, and unclosed quotes return an error. In exported HTML, press `T` to toggle thinking, `O` to toggle tool output, and `H` to show custom messages hidden in the terminal.

`atomic --export <session.jsonl> [file]` renders a single subagent launch on the selected branch as an `Agent(...)` card showing its prompt, tool calls, and final answer. Parallel launches and other extension tools keep their normal export format.

Use `/share` to upload a private GitHub gist with a shareable link that opens in `https://bastani.ai/session/` (override with `ATOMIC_SHARE_VIEWER_URL`). `/share` requires the GitHub CLI (`gh`) installed and authenticated, and strips worktree snapshot contents and large tool-output blobs before uploading.

Treat exported and shared sessions as sensitive. Transcripts can contain source code, file paths, and credentials; review a session before sharing it with anyone who has the link.

## CLI reference

All CLI commands, flags, model-matching rules, and environment variables live in the [CLI reference](/reference/cli):

- [Modes](/reference/cli#modes), [Model options](/reference/cli#model-options), and [Session options](/reference/cli#session-options)
- [Tool options](/reference/cli#tool-options), [Project trust options](/reference/cli#project-trust-options), [Resource options](/reference/cli#resource-options), and [Other options](/reference/cli#other-options)
- [File arguments](/reference/cli#file-arguments), [Examples](/reference/cli#examples), [Package commands](/reference/cli#package-commands), [Credential commands](/reference/cli#credential-commands), and [Environment variables](/reference/cli#environment-variables)
