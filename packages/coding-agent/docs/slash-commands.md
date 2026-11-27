---
title: "Slash commands"
sidebarTitle: "Slash commands"
description: "Reference for all built-in slash commands, bundled extension commands, argument rules, subagent-view routing, and collision numbering."
---

Type `/` in Atomic's terminal editor to search and autocomplete every command available in your current session. This page is the canonical reference for all 26 core built-in commands, all 8 bundled extension commands, the diagnostic `/debug` command, and how slash commands are parsed, routed, and disambiguated.

Extensions, prompt templates, and skills can add more commands at runtime, so the `/` menu in your session always reflects your exact active setup. Run `/reload` after adding or editing command resources on disk.

## Models and authentication

| Command | Arguments | Description |
| --- | --- | --- |
| `/model` | `[provider/model]` | Open the model selector, switch directly on an exact match, or pre-filter the selector. Inside the selector, use `←`/`→` to adjust thinking effort on reasoning models and `Tab` to toggle between scoped and all models. |
| `/thinking` | `[level]` | Open the thinking-level selector, or set and persist a specific level directly (such as `off`, `low`, `medium`, `high`). |
| `/scoped-models` | *(bare only)* | Enable or disable models included in `Ctrl+P` / `Shift+Ctrl+P` quick cycling. |
| `/login` | `[provider]` | Configure subscription, account, or API-key authentication. Passing a provider jumps straight to login, opens the method chooser, or filters the provider list. |
| `/logout` | `[provider]` | Remove stored credentials from `~/.atomic/agent/auth.json` (and legacy `~/.pi/agent/auth.json`). Does not clear environment variables, CLI flags, or `models.json` keys. |

## Sessions and context

| Command | Arguments | Description |
| --- | --- | --- |
| `/new` | *(bare only)* | Start a fresh empty session in the current working directory. |
| `/resume` | `[session-id]` | Open the session picker, or switch directly by exact session ID or unique 8-character hex prefix. |
| `/name` | `[name]` | Set the session display name shown in `/resume` and `/session`. When run bare, prints the current name if set, or warns `Usage: /name <name>` if unnamed. |
| `/session` | *(bare or `snapshot`)* | When bare, shows session name (if set), storage location, ID, message and token counts, cache hit rate, wasted cache cost, and total/per-model cost breakdown. `/session snapshot` lists recorded [worktree snapshots](/worktree-snapshots), diffs them against the current working tree, and shows last-resume timings. |
| `/tree` | *(bare only)* | Open the session tree to inspect history and switch branches without losing previous turns. |
| `/fork` | *(bare only)* | Pick an earlier user message and start a new session branched from that point. |
| `/clone` | *(bare only)* | Duplicate the current session at its current position into a new session. |
| `/compact` | `[instructions]` | Compact the active context window with optional focus instructions. Takes over automatic compaction if one is running; warns `Nothing to compact (no messages yet)` when fewer than two messages exist. See [Context and compaction](/compaction). |

## Export and sharing

| Command | Arguments | Description |
| --- | --- | --- |
| `/copy` | *(bare only)* | Copy the last assistant message (or the viewed subagent's last assistant message) to the clipboard. |
| `/export` | `[path]` | Export the current session. Defaults to `atomic-session-<sessionId>.html` in the current working directory, or exports JSONL when `[path]` ends in `.jsonl`. Wrap paths containing spaces in single or double quotes; extra tokens after the first path are ignored. |
| `/import` | `<path.jsonl>` | Prompt for confirmation, then import and switch to a JSONL session while preserving its ID and working directory. Wrap paths containing spaces in quotes; extra tokens after the first path are ignored. |
| `/share` | *(bare only)* | Export the session as `session.jsonl` and upload it as a secret GitHub gist (`gh gist create --public=false`), printing both the web viewer URL (`Share URL:`) and raw `Gist:` URL. Requires GitHub CLI (`gh`) installed and authenticated via `gh auth login`. Press `Esc` or `Ctrl+C` to cancel while uploading. |

<Warning>
**Review sessions before exporting or sharing.** Exported files and shared gists can include prompts, tool arguments, command output, file contents, and any secrets that appeared during the conversation.
</Warning>

## Runtime, tasks, and workspace

| Command | Arguments | Description |
| --- | --- | --- |
| `/settings` | *(bare only)* | Open the interactive settings menu. |
| `/tools` | *(bare only)* | List active tools, inactive tools (with reasons), missing helper binaries, and which Git binary Atomic is using. |
| `/tasks` | `[task-id]` | Open the [background task inspector](/background-tasks) for running and completed subagents and shells, or jump directly to a specific task ID. |
| `/trust` | *(bare only)* | Open the project trust selector and save a trust decision for future sessions. Restart Atomic for the new decision to take effect in the current session. |
| `/reload` | *(bare only)* | Reload keybindings, extensions, skills, prompt templates, themes, and project context files. Wait for active streaming or compaction to finish first. |
| `/hotkeys` | *(bare only)* | Print the table of editor, core app, and extension keyboard shortcuts. Press `?` for shortcuts specific to the active view, or see [Keybindings](/keybindings) for the complete reference. |
| `/changelog` | *(bare only)* | Display Atomic's release changelog entries inside the chat transcript. |
| `/exit` | *(bare only)* | Exit Atomic cleanly. |
| `/quit` | *(bare only)* | Alias for `/exit`. |

## Bundled extension commands

Atomic ships eight slash commands through its bundled lazy extensions. They are available by default without installing extra packages:

| Command | Arguments | Description |
| --- | --- | --- |
| `/agents` | `[filter]` | Open the interactive subagent browser to inspect available [subagents](/subagents) and their configurations, optionally pre-filtered by `[filter]`. |
| `/mcp` | `[login\|logout\|reconnect] [server]` | When bare, opens the interactive [MCP server](/mcp-servers) manager (or prints status outside the TUI). Subcommands sign in, sign out, or reconnect a server, with tab completion for subcommands and eligible server names. |
| `/intercom` | *(none)* | Open the [Intercom](/intercom) overlay to view live sessions and send direct messages (also bound to `Alt+M`). |
| `/llama` | *(none)* | Open the interactive [`llama.cpp`](/llama-cpp) router model manager to load, unload, or download Hugging Face GGUF models (interactive mode only). |
| `/curator` | `[on\|off\|none\|summary-review]` | Toggle or set the [web-access](/web-access) search curator workflow (`on` sets `summary-review`; `off` sets `none`; bare toggles between them). |
| `/websearch` | `[query1, query2, ...]` | Open the interactive browser web-search curator, optionally pre-populated with comma-separated search queries. |
| `/search` | *(none)* | Browse, inspect, or delete stored [web-access](/web-access) search and fetch results. |
| `/google-account` | *(none)* | Show the active Google account detected for Gemini Web search (requires `allowBrowserCookies: true` in `~/.atomic/web-search.json`). |

## Unlisted diagnostic command

| Command | Arguments | Description |
| --- | --- | --- |
| `/debug` | *(bare only)* | Append a diagnostic snapshot of the current rendered terminal lines (with visible widths) and session messages (JSONL) to `~/.atomic/agent/atomic-debug.log` (or under `ATOMIC_CODING_AGENT_DIR`), then display the file path. Not listed in `/` autocomplete; see [Diagnostics and debugging](/development). |

## Parsing and argument rules

Atomic splits any `/name args` submission at the first whitespace character (space, tab, or line break, counting CRLF as a single break). Whether a core built-in is intercepted depends on whether it accepts arguments:

- **Argument-taking built-ins (10 commands):** `/tasks`, `/model`, `/thinking`, `/export`, `/import`, `/name`, `/login`, `/logout`, `/compact`, and `/resume`. Atomic intercepts these whether typed bare or followed by arguments.
- **Exact-subcommand built-in (1 command):** `/session` matches only when bare or when the argument is literally `snapshot` (`/session snapshot`, with no extra trailing words). Any other text after `/session` passes through as ordinary chat text.
- **Bare-only built-ins (15 commands + `/debug`):** `/settings`, `/scoped-models`, `/share`, `/trust`, `/reload`, `/quit`, `/exit`, `/tools`, `/changelog`, `/hotkeys`, `/tree`, `/fork`, `/clone`, `/new`, `/copy`, and `/debug`. Atomic intercepts these **only** when nothing follows the command name. Adding trailing text—such as `/copy that` or `/new approach`—sends the line to the model as a regular message.

## Extension, prompt template, and skill commands

Beyond built-ins, three resource types contribute slash commands:

- **Extensions:** Commands registered with `atomic.registerCommand()` execute immediately—even while the model is streaming or compaction is active—without entering the message queue. See [Extension API reference](/extensions/api-reference).
- **Prompt templates:** Markdown templates appear under their filename (`/review`, `/pr-check`) and expand into user message text before sending. See [Prompt templates](/prompt-templates).
- **Skills:** Skills are invocable as `/skill:<name> [args]` when skill commands are enabled. See [Skills](/skills).

When you submit a line starting with `/`, Atomic resolves it in this order:

1. Interactive built-in commands (subject to the bare-only vs. argument rules above).
2. Registered extension commands (including bundled extension commands).
3. Extension `input` hooks (which can handle or transform the text).
4. Skill command expansion (`/skill:<name>`).
5. Prompt template expansion (`/<template>`).
6. Ordinary chat text sent to the model.

### Command collision numbering

If two or more loaded extensions register the same command name (for example `review`), Atomic disambiguates **every** colliding command with a 1-based numeric suffix in extension load order: `/review:1`, `/review:2`, and so on. No bare `/review` command remains.

## Routing while viewing a subagent

Atomic shares one chat screen between the main conversation and any subagent you select from the agent panel or `/tasks`. When you type a slash command while viewing a subagent, Atomic routes it according to what it affects:

| Commands | Behavior while viewing a subagent |
| --- | --- |
| `/settings`, `/scoped-models`, `/tasks`, `/resume`, `/export`, `/share`, `/trust`, `/login`, `/logout`, `/reload`, `/exit`, `/quit` | Run on `main` in place while the subagent stays on screen. |
| All 8 bundled extension commands (`/agents`, `/mcp`, `/intercom`, `/curator`, `/google-account`, `/search`, `/websearch`, `/llama`) | Run on `main` in place while the subagent stays on screen. |
| `/session`, `/session snapshot`, `/tools`, `/changelog`, `/hotkeys`, `/name`, `/debug` | Switch the screen to `main` first so printed output lands in the main transcript (preserving main's draft). |
| `/compact`, `/tree`, `/fork`, `/clone`, `/new`, `/import`, and any registered extension command named `/clear` or `/rewind` | Ask to confirm first (`/<command> acts on the main conversation, not <agent>`, defaulting to **Cancel**). Once confirmed, `/new` and `/import` switch to `main` immediately; `/fork` and `/clone` switch once the new session is ready; cancelling restores your text to the subagent prompt. |
| `/model`, `/thinking` | Refused with a notice under the subagent transcript. Switch back to `main` to change the main conversation's model or thinking level. |
| `/copy` | Copies the viewed subagent's last assistant message to the clipboard. |
| `/skill:<name>`, prompt templates, user/project extension commands, and non-matching slash text | Sent to the viewed subagent's own session using its own skills, templates, extensions, and working directory. |

<Note>
**Dedicated subagent chat views inside `/tasks`:** In a standalone subagent chat page opened inside `/tasks`, `/tasks`, `/copy`, and `/hotkeys` run locally for that subagent, other built-ins show `/<name> is not available in a subagent chat` without reaching the subagent, and all skills, templates, extension commands, and ordinary text go directly to the subagent.
</Note>

See [Background tasks](/background-tasks) and [Subagents](/subagents) for full details on inspecting and steering subagents.
