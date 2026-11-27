---
title: "Use Atomic in the terminal"
sidebarTitle: "Use interactive mode"
description: "Use Atomic's fullscreen terminal interface, editor shortcuts, slash commands, message queue, and session tools."
---

Interactive mode runs Atomic in a fullscreen terminal interface for day-to-day coding, slash commands, message queueing, and session navigation. Atomic runs the agent session in a separate background process from the terminal UI so typing, queueing, and interrupts stay responsive while tools run. See [How Atomic works](/how-atomic-works) for the architecture, or [CLI reference](/reference/cli) for every command and flag.

## First-time setup

On a brand-new installation (when `ATOMIC_CODING_AGENT_DIR` is unset and `~/.atomic/agent/settings.json` does not exist yet), interactive mode opens a quick two-step setup prompt before the editor:

1. **Choose a theme:** Pick `Dark`, `Light`, or `System` (defaulting to your terminal's detected appearance, with live preview as you move through options).
2. **Choose analytics preference:** Opt in or out of anonymous usage analytics. Your choice and a random local tracking ID are stored in `settings.json`; Atomic does not transmit analytics data in this release.

Navigate with `↑`/`↓` or `j`/`k`, confirm with `Enter`, or press `Esc`/`Ctrl+C` to skip setup without writing `settings.json`.

## Terminal interface

The screen has four main areas:

- **Startup header.** Shortcuts plus named lists of loaded context files, prompt templates, skills, and extensions. Press `Ctrl+O` to expand source paths. Custom themes are not listed here; pick them in `/settings`.
- **Transcript.** User messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI.
- **Editor.** The prompt box where you type. Its border color reflects the active thinking level.
- **Footer.** Token usage, cache usage, cost, and context usage sit above the editor. Below it, Atomic shows the active model, reasoning level, working directory, Git branch, and session name while idle, or the interrupt key while working (`esc to interrupt` on `main`, `esc to pause` while viewing a subagent).

When background subagents run, the [agent panel](/background-tasks#the-agent-panel) appears below the footer. Selecting a subagent swaps the transcript and routes your prompt to it. Press `↓` on an empty prompt to focus the agent panel, `←` on an empty prompt while viewing a subagent to return to `main`, `Ctrl+X Ctrl+K` (twice within 3 seconds) to stop all background work, and `?` on an empty prompt for active shortcuts.

Built-in views such as `/settings`, `/model`, or custom extension UI temporarily replace the editor while open.

### Startup animation and working indicator

The startup animation introduces Atomic on launch; press any key (including `Ctrl+C`) to finish it immediately. Set `quietStartup` to `true` to hide it, or `"header"` to keep it. Non-TTY runs, Apple `Terminal.app`, and `ATOMIC_REDUCED_MOTION=1` skip the animation and show the static mark.

To disable terminal colors and text styles (bold, italic, dim, underline, inverse, strikethrough), set `NO_COLOR` (to any value, including an empty string) or `FORCE_COLOR=0` / `FORCE_COLOR=false`. Setting `FORCE_COLOR` to `1`, `2`, `3`, `true`, or `""` forces color output.

While the agent works, `∀` pulses beside a status line with elapsed time and output tokens. A new run resets the meter; steering keeps the current meter. Retry, fallback, compaction, cancellation, and error notices take precedence, and approval prompts hide ordinary activity. Extensions can [customize the working indicator](/tui#pattern-4b-working-indicator-customization).

During compaction, `∀` stays still with elapsed time and the cancel key. Afterwards, a single boundary line appears—`⚛ Context cleared · 182.0k tokens`, or `⚛ Context compacted · morph/morph-compactor · 182.0k → 21.4k tokens` when a compactor model ran. Press `Ctrl+O` to inspect what was compacted and where the earlier conversation lives in session history.

### Transcript interaction

- **Clickable blocks.** Single-click any expandable block (tool calls, grouped summaries, `!` shell blocks, finished-agent cards, compaction boundaries) to open or fold that block without affecting others. `Ctrl+O` toggles all blocks together.
- **Clickable key hints.** Click key hints below the prompt, in dialogs, or in `/tasks` to trigger that key or command without losing your prompt draft.
- **Scrolling and jump to bottom.** Scroll with the mouse wheel, or hold `Alt+wheel` to scroll five times as far when your terminal forwards Alt with wheel events. While scrolled up, the current turn's opening prompt stays pinned at the top and a `↓ jump to bottom · ctrl+end` pill appears above the editor.

See [Transcript scrolling and mouse](/keybindings#transcript-scrolling-and-mouse) for mouse selection, auto-copy, right-click paste, and paging shortcuts.

### Editor features

| Feature | How |
| --- | --- |
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press `Tab` to complete file paths |
| Prompt history | `↑` / `↓` step through recent prompts; `Ctrl+R` searches past prompts and inserts your pick without sending |
| Multi-line input | `Shift+Enter` or `Ctrl+J` |
| Images | Paste with `Ctrl+V` (`Alt+V` or `Ctrl+V` on Windows and WSL), or drag into the terminal ([Terminal setup](/terminal-setup)) |
| Shell command | `!command` runs a shell command and includes its output in model context |
| Hidden shell command | `!!command` runs a shell command without adding its output to model context |
| External editor | `Ctrl+G` opens `externalEditor`, `$VISUAL`, or `$EDITOR` (falling back to `notepad` on Windows or `nano` on macOS and Linux) |

- **`@` file picker and completion menus:** The `@` picker fuzzy-searches project files while respecting `.gitignore` and skipping `.git/`, supports quoted paths with spaces (`@"path with spaces"`), and wraps paths containing spaces automatically (falling back to single-directory listing if `fd` is unavailable). In `@` and `/` menus, `Tab` completes without sending, and `Enter` inserts an `@` path or submits a `/` command.
- **Prompt history (`↑`/`↓` and `Ctrl+R`):** `↑` and `↓` walk up to 100 recent prompts typed during the current run (collapsing consecutive identical prompts) for whichever agent you are viewing. `Ctrl+R` searches recorded prompts newest first and deduplicates identical prompts across the session:
  - For prompt templates and skills (such as `/skill:tdd edge cases`), `Ctrl+R` saves and searches the **unexpanded command you typed** rather than the expanded body (only older entries without raw text fall back to expanded text).
  - If an extension transforms a prompt through the [`input` event](/extensions/events#input), `Ctrl+R` searches the transformed text while `↑`/`↓` walk the raw text you typed.
  - While viewing a subagent, `Ctrl+R` searches that subagent's 100-entry editor history (without timestamps) rather than the full session store.
  - Press `Esc` to clear the search query first, then close search without losing your draft or interrupting the agent. Avoid typing secrets directly into prompts.
- **Interactive shell commands (`!` and `!!`):** Only one interactive `!` or `!!` command can run at a time; submitting another warns and restores your draft. On native Windows, `!` and `!!` run PowerShell (preferring PowerShell 7 `pwsh.exe`, then Windows PowerShell `powershell.exe`; see [Windows](/windows)), while Linux, macOS, and WSL use Bash. [`shellCommandPrefix`](/shell-aliases) is prepended to each command, so match the active shell's syntax. Press `Esc` or `Ctrl+C` to cancel a running command. `!` and `!!` are disabled while viewing a subagent; switch to `main` to run them.
- **Double-Escape (`doubleEscapeAction`):** Pressing `Escape` twice within 500 ms on an empty, idle editor opens `/tree` by default. Change it to `"tree"`, `"fork"`, or `"none"` in [Settings](/settings#interface-and-display).
- **Suspend and subshell:** On POSIX systems and WSL, `Ctrl+Z` suspends Atomic and `fg` resumes it. On native Windows, `Alt+Z` opens an interactive PowerShell subshell while background tasks keep running (type `exit` to return), leaving `Ctrl+Z` for editor undo.

See [Keybindings](/keybindings) for all shortcuts and customization.

## Startup typing

You can start typing immediately while Atomic finishes loading. In interactive mode, typing and editing keys act live while `Enter`, command shortcuts, and mouse events wait until the session is ready.

<Tip>
If a startup dialog appears (such as first-time setup, a project trust prompt, `--resume`, or a cross-project fork confirmation), anything you already typed waits in your prompt as a draft and never auto-submits or answers the dialog for you. Review the draft and press `Enter` after startup finishes.
</Tip>

## Slash commands

Type `/` in the editor to open command completion. [Extensions](/extensions) can register custom commands, [skills](/skills) run as `/skill:name`, and [prompt templates](/prompt-templates) expand via `/templatename`.

Commands that take no arguments match only when entered by themselves; adding extra text sends the line to the model as a regular prompt. While viewing a subagent, built-in commands target `main` (confirming destructive changes, refusing `/model` and `/thinking`, and using `/copy` for the viewed subagent's last message), while skills, templates, and user or project extension commands target the viewed subagent.

Here are the everyday commands you will use most often:

| Command | Description |
| --- | --- |
| `/login [provider]` | Sign in with an OAuth account/subscription or save an API key ([Authentication](/getting-started/authentication)) |
| `/logout [provider]` | Remove stored credentials from `~/.atomic/agent/auth.json` (leaves env vars and `models.json` untouched) |
| `/model [provider/model]` | Switch models and save the startup default ([Choose a model](/models/choose-a-model)). Exact matches switch immediately; other text pre-filters the picker. Inside the picker, press `←`/`→` to adjust effort level and `Tab` to toggle scoped vs. all models |
| `/thinking [level]` | Set the thinking level and save the startup default (rejects levels unsupported by the current model) |
| `/scoped-models` | Enable, disable, and reorder models for `Ctrl+P` cycling ([`enabledModels`](/settings#enabledmodels)) |
| `/settings` | Change [theme](/themes), delivery mode, transport, and other [settings](/settings). Type to search, press `Enter`/`Space` to toggle or open pickers (`Right` never edits a setting), and `Esc` clears search before closing |
| `/resume [id\|prefix]` | Open a session by exact ID or unique 8-hex prefix, or browse sessions with no argument |
| `/new` | Start a new session |
| `/name [name]` | Set the session display name, or print the current name (warns `Usage: /name <name>` if unnamed) |
| `/session [snapshot]` | Show session ID, name, token/cache usage, and per-model cost; `snapshot` shows [worktree snapshots](/worktree-snapshots) and diffs |
| `/tools` | Show active [tools](/tools) and why other tools are disabled |
| `/tasks [taskId]` | Inspect [background tasks](/background-tasks) (subagents and shells), or open a specific task by ID |
| `/tree` | Navigate the session tree and continue from any point |
| `/fork` | Create a new session branching from an earlier user message |
| `/clone` | Duplicate the active branch into a new session |
| `/compact [instructions]` | Clear or compact the context window (requires at least two messages; manual `/compact` can take over an active auto-compaction) |
| `/copy` | Copy the viewed agent's last assistant message to the clipboard |
| `/export [file]` | Export to HTML (`atomic-session-<session>.html` in the current directory by default) or JSONL when `file` ends in `.jsonl` |
| `/import <file>` | Import an exported `.jsonl` session (confirms before replacing the current session) |
| `/share` | Export `session.jsonl` to a secret GitHub gist via `gh` and print both viewer and gist URLs |
| `/trust` | Save a [project trust](/security) decision (restart Atomic for a changed decision to apply to the current session) |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, context files, `settings.json`, and `models.json` (refused while streaming or compacting) |
| `/hotkeys` | Show a quick summary of common editor, app, and extension shortcuts (press `?` on an empty prompt or picker for contextual keys) |
| `/exit`, `/quit` | Exit Atomic |

Atomic's bundled extensions also register `/agents` ([Subagents](/subagents)), `/mcp` ([MCP servers](/mcp-servers)), `/intercom` ([Intercom](/intercom)), `/llama` ([Local models](/llama-cpp)), and `/curator`, `/websearch`, `/search`, `/google-account` ([Web access](/web-access)).

For the complete command catalog, exact argument parsing rules, and subagent-view routing, see the [Slash commands reference](/slash-commands).

## Message queue

Because Atomic runs the session in a separate background process from the terminal UI ([How Atomic works](/how-atomic-works)), you can keep typing, queue follow-ups, or interrupt work while the agent streams or runs tools.

### Queueing and interrupting

The same keys apply on `main` and while viewing a subagent, except `Esc` pauses a viewed subagent instead of interrupting `main`:

| Action | macOS / Linux | Windows / WSL | Effect |
| --- | --- | --- | --- |
| Queue steering message | `Enter` | `Enter` | Runs after the current turn finishes its tool calls |
| Queue follow-up message | `Alt+Enter` | `Ctrl+Q` | Runs after the agent finishes all current work |
| Abort and restore queue | `Esc` | `Esc` | Aborts active or queued work, restores queued messages to the editor, and pauses until your next ordinary message |
| Clear, interrupt, or exit | `Ctrl+C` | `Ctrl+C` | Clears editor text first; on an empty editor aborts work and holds queued messages in order; pressing twice within 0.8 s while idle exits |
| Retrieve queued messages | `Alt+Up` | `Alt+Q` | Pulls still-queued messages back into the editor without aborting active work or unpausing |

Steering messages always run ahead of follow-ups in submission order. Messages, templates, and skills submitted during compaction or retry waits queue in order until compaction completes or is cancelled, while non-prompt slash commands such as `/settings`, `/tasks`, and `/model` run immediately.

Interrupts hold only messages still waiting in the queue. A message the agent already started stays in the transcript; if an interrupt cancels its reply before any output appears, Atomic answers it rather than stranding it.

On Windows and WSL, follow-up queueing uses `Ctrl+Q` and dequeue uses `Alt+Q` to avoid Windows Terminal's `Alt+Enter` fullscreen toggle. Configure delivery rules with `steeringMode` and `followUpMode` in [Settings](/settings#message-delivery).

### Interrupt grace period and recovery

Normal interrupts request cooperative cancellation while keeping the background session process running. Pending tool calls abort immediately. If an active tool call does not stop within **10 seconds** (configurable via [`ATOMIC_TOOL_ABORT_GRACE_MS`](/environment-variables#diagnostics-and-performance)), the turn moves on with an abort notice and discards late output from that call.

<Note>
**Manual recovery with `Ctrl+C`:** If a custom extension dialog stops responding to input, `Ctrl+C` closes it. If the background session process stops answering—or a cancel or queue-clear request stalls for over one second—`Ctrl+C` terminates and restarts the session process. Recovery never triggers automatically. Check `/tasks` and the transcript before repeating interrupted actions.
</Note>

If sending fails, Atomic restores your unsent text (including pasted content) to the editor above anything typed while the send was pending, keeping later queued messages in order. See [Application keybindings](/keybindings#application).

## Sessions

Sessions auto-save to `~/.atomic/workflows/journal.sqlite` by default; JSONL session directories (`~/.atomic/agent/sessions/`) and shared PostgreSQL databases are opt-in.

Common startup flags include `atomic -c` (continue latest in this directory), `atomic -r` (browse sessions), `atomic --session <id|prefix>`, `atomic --fork <id|prefix>`, `atomic --name "Refactor"`, `atomic --import <file>`, and `atomic --no-session`. See [Manage sessions](/sessions), [Context and compaction](/compaction), and [CLI session options](/reference/cli#session-options).

## Context and system prompt files

Atomic automatically loads project instructions (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`) from global config, ancestor directories, and the current trusted project, plus optional `SYSTEM.md` (replace the default system prompt) and `APPEND_SYSTEM.md` (append standing instructions). See [Add project instructions](/getting-started/project-instructions) for exact precedence, worktree deduplication, and trust rules. Disable context files for one run with `--no-context-files` (`-nc`).

The agent can also recall earlier sessions in the same project through `history://` when you reference past work or comparable tasks. See [Recalling earlier work](/sessions#recalling-earlier-work).

## Exporting and sharing sessions

Use `/export [file]` to export the current session to HTML (defaulting to `atomic-session-<session>.html` in the current working directory) or to JSONL when `file` ends in `.jsonl` (case-insensitive). Paths containing spaces can be quoted; unclosed quotes return an error. In exported HTML, press `T` to toggle thinking blocks, `O` to toggle tool output, and `H` to show hidden custom messages.

Use `/import <file>` to load an exported `.jsonl` session; Atomic asks for confirmation before replacing the current session.

Use `/share` to export a copy of the session as `session.jsonl` (stripping worktree snapshot contents and large tool-output blobs), upload it as a secret GitHub gist with `gh`, and print both:

- **`Share URL`:** Opens the gist in `https://bastani.ai/session/` (override with [`ATOMIC_SHARE_VIEWER_URL`](/environment-variables)).
- **`Gist`:** The raw GitHub gist URL.

`/share` requires the GitHub CLI (`gh`) installed and authenticated (`gh auth login`). Press `Esc` or `Ctrl+C` while uploading to cancel.

<Warning>
Treat exported and shared sessions as sensitive. Transcripts can contain source code, file paths, and credentials—review a session before sharing it with anyone who has the link.
</Warning>

## Next steps

<Columns cols={2}>
  <Card title="CLI reference" href="/reference/cli">
    Every flag, subcommand, model-matching rule, and exit code.
  </Card>
  <Card title="Slash commands" href="/slash-commands">
    Complete list of built-in and bundled extension slash commands.
  </Card>
  <Card title="Keybindings" href="/keybindings">
    All keyboard shortcuts, picker controls, and custom keybindings.
  </Card>
  <Card title="How Atomic works" href="/how-atomic-works">
    Mental model of the agent loop, two-process runtime, and context assembly.
  </Card>
</Columns>
