# Using Atomic

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600" /></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Startup and Working Identity

On an interactive TTY, the startup ∀ assembles from two separated halves in whole-column steps, lands its shadow and session identity, then reveals the one-time manifesto beat. Any key—including Ctrl+C—completes the sequence immediately before normal input routing continues. Terminals narrower than the mark show compact textual identity throughout assembly instead of a blank startup area. Quiet startup suppresses the sequence; a mounted interactive UI without a TTY, or with `ATOMIC_REDUCED_MOTION=1`, starts in the complete settled state. `NO_COLOR` suppresses foreground color across the mark, metadata, and manifesto while retaining weight emphasis.

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

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for CTRL+P cycling |
| `/fast` | Toggle Codex fast mode for chat and workflow stages when `openai/*` or `openai-codex/*` models are available |
| `/workflow` | List/run workflows; manage runs (connect/inspect/pause/interrupt/quit/resume); reload workflow resources |
| `/settings` | Thinking level, theme, message delivery, transport |
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

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **ALT+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts active/queued work and restores queued steering/follow-up messages to the editor. The session remains paused until you submit the next ordinary chat message; that submission releases any held queue before starting the new turn. A later Escape while the queue is paused restores any newly queued steering/follow-up text without releasing the pause.
- **Ctrl+C** aborts active/queued work and pauses queued messages in place. They remain queued, in their original per-queue order, until you submit the next ordinary chat message; that submission resumes the chat and makes each queued item eligible once. After the abort settles, a later idle Ctrl+C clears the editor without releasing the hold, and a second quick idle press exits.
- **ALT+Up** explicitly retrieves queued messages back to the editor without aborting active work or resuming a paused session. Even when retrieval empties the queue, the pause remains active until the next ordinary submission.

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

Atomic's default `Guidelines` section applies Orwell's six writing rules to every standard session:

1. Never use a familiar printed metaphor, simile, or figure of speech.
2. Never use a long word where a short one will do.
3. Cut every word that can be cut.
4. Use active rather than passive voice where possible.
5. Prefer everyday English to foreign phrases, scientific terms, and jargon.
6. Break any rule rather than say anything outright barbarous.

Replace the default system prompt with:

- `.atomic/SYSTEM.md` for a project
- `~/.atomic/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

Treat exported and shared sessions as sensitive: transcripts can contain source code, file paths, credentials, and other private data from your session. Review a session before sharing it, and only upload transcripts you are comfortable making accessible to anyone with the link.

## CLI Reference

```bash
atomic [options] [@files...] [messages...]
```

Use `--` to end option parsing when positional prompt text begins with `-`, `--`, or `@`. Every argument after the terminator is treated as literal message text rather than an option or file argument:

```bash
atomic --print -- "- leading-dash prompt"
```

### Package Commands

```bash
atomic install <source> [-l]       # Install package, -l for project-local
atomic remove <source> [-l]        # Remove package
atomic uninstall <source> [-l]     # Alias for remove
atomic update [source|self|atomic] # Update Atomic only, or one package source
atomic update --all                # Update Atomic and packages; reconcile pinned git refs
atomic update --extensions         # Update packages only; reconcile pinned git refs
atomic update --models             # Force-refresh authenticated provider model catalogs
atomic update --self               # Update Atomic only
atomic update --extension <src>    # Update one package
atomic list                        # List installed packages
atomic config                      # Enable/disable package resources
```

These commands manage Atomic packages and `atomic update` can update the Atomic CLI installation. To uninstall Atomic itself, see [Quickstart](/quickstart#uninstall). `atomic config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `atomic update` never prompts for project trust.

See [Atomic Packages](/packages) for package sources and security notes.

### Credential Commands

```bash
atomic auth check [--provider <p>] [--model <model>] [--json] [--credentials] [--no-refresh]
atomic auth print-api-key --model <model> [--provider <p>]
atomic auth print-bearer-token --model <model> [--provider <p>] [--min-expiry <dur>]
```

`atomic auth check` verifies the effective credential a provider or model would use before a session starts. It requires at least one of `--provider` or `--model`, prints `ready`, `not_ready`, or `invalid` to stdout, and exits `0`, `1`, or `2` for those states. `--json` adds the resolved provider when one is found, credential kind, and any reason. By default, a check never emits credential material.

`--credentials` is an explicit export opt-in. It requires `--provider` or an exact `--model` target; a fuzzy model match on an otherwise-ready provider is refused as `invalid` (exit `2`) rather than exporting a credential for a provider you did not name. If that provider is not ready, the check remains `not_ready` (exit `1`). On a ready check, plain stdout becomes the resolved credential alone and JSON adds it only in the `credentials` field. A non-ready raw export leaves stdout empty and reports its status on stderr; a JSON export returns the status object without a credential. Credential writes can also exit `8` (nothing written) or `9` (only a fragment written). Treat the stream like `print-api-key` or `print-bearer-token` output.

Checks refresh expired OAuth credentials by default, using Atomic's normal locked `auth.json` update path. Pass `--no-refresh` to read credentials without creating, locking, or mutating `auth.json`; this is useful when a probe must not change stored auth state. It still reads Atomic's primary and legacy credential paths and resolves configured API-key values, including `!command`, through the normal provider configuration. In this read-only mode, malformed `auth.json` is `invalid` (exit `2`) rather than an unavailable credential. An OAuth credential export requires at least 30 minutes of life: the normal path can refresh it, while `--no-refresh` refuses a shorter-lived token.

The credential commands print one configured credential for an external client — a proxy, a script, or another tool that needs the same key Atomic already holds. The credential goes to **stdout and nothing else**; warnings, provider selection, refresh notices, and help all go to stderr, so `KEY=$(atomic auth print-api-key --model gpt-5.5)` can never capture a diagnostic.

`--model` is required for the two `print-*` exports. An exporting auth check needs `--provider` or an exact `--model` target. When several configured providers offer a model, pass `--provider` to choose one. The two `print-*` subcommands accept only `--provider` and `--model`: any other flag — including `--export`, `--session-dir`, `--print`, and `--help` — is a usage error rather than a flag this path happens to ignore.

`atomic auth` on its own — and `atomic auth help`, `--help`, or `-h` — prints this usage on stderr and exits `0`. `atomic auth check --help` (or `-h`) does the same until a `--` terminator; after it, the flag is not help. Any other subcommand exits `1` and names all three valid commands. Help never uses stdout, so raw credential export stdout is a credential or empty; a JSON export writes an object that carries a credential only in its `credentials` field.

`print-bearer-token` works only on OAuth providers and `print-api-key` only on API-key providers; asking for the wrong kind is an error rather than a silent fallback. A bearer token with less than `--min-expiry` remaining (default `30m`, accepting `ms`, `s`, `m`, or `h`) is refreshed first. Both `--min-expiry 30m` and `--min-expiry=30m` are accepted. `--min-expiry` with `print-api-key` is a usage error — even after a `--` terminator — because an API key has no expiry. A failed refresh leaves your stored credential untouched.

Credential-export exits (`print-api-key`, `print-bearer-token`, and the `--credentials` write itself):

| Exit | Meaning |
|------|---------|
| `0` | Credential written to stdout, one trailing newline |
| `1` | Usage error |
| `2` | No credential configured for that model/provider |
| `3` | Several configured providers match — pass `--provider` |
| `4` | That credential kind is unsupported for the provider |
| `5` | OAuth refresh failed; the stored credential is unchanged |
| `6` | The provider cannot mint a token that lives as long as `--min-expiry` |
| `7` | The provider's OAuth credential could not be used — no claim is made about the stored credential |
| `8` | The credential could not be written; nothing was emitted |
| `9` | Only part of the credential was written; discard the output |

Auth-check exits:

| Exit | `atomic auth check` |
|------|---------------------|
| `0` | `ready` |
| `1` | `not_ready`, including a fuzzy `--model` with `--credentials` when its resolved provider is not ready |
| `2` | `invalid`, including check usage errors (unknown option, neither `--provider` nor `--model`, and a fuzzy `--model` with `--credentials` when its resolved provider is otherwise ready) |
| `8` | With `--credentials`, the credential could not be written; nothing was emitted |
| `9` | With `--credentials`, only part of the credential was written; discard the output |

Exit `5` is reported only for a refresh that itself failed, which happens before anything is persisted; that is the only exit that promises your stored credential is untouched. Any other OAuth failure exits `7` and makes no such promise.

For raw credential exports, stdout is empty on every non-zero exit but one. Once the credential reaches stdout the command has succeeded: if the stream then fails to drain — a reader that closed the pipe, for example — that is reported on stderr and the exit code stays `0`, because a non-zero exit here would contradict the bytes the caller already holds. The exception is exit `9`, which reports that only part of the credential was written before the stream failed; those bytes cannot be recalled, so stdout is not empty, and the output is a fragment to discard rather than a credential to use. `auth check --credentials --json` may instead write a credential-free JSON status object on a non-zero check result. See [Security](/security#credential-export) before wiring this into a script.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode (fullscreen TUI) |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](/json) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](/rpc) |
| `--export <in> [out]` | Export a session to HTML |

Interactive sessions always use fullscreen: the transcript scrolls independently above a sticky dock containing the editor, status line, usage meter, extension widgets, and footer. Wheel and trackpad gestures go first to a focused workflow graph or stage chat overlay; events those overlays do not consume fall through to the alternate-screen viewport. Non-overlay focused components do not block pi-tui's mouse path, so transcript scrolling, scrollbar interaction, and drag selection still work.

In print mode, Atomic also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | atomic -p "Summarize this text"
```

When a print-mode turn correctly finishes by calling an opt-in terminating structured-output tool created with `createStructuredOutputTool` (for example from an extension, SDK caller, or workflow item with a schema), Atomic ends after that tool result without an extra follow-up assistant turn. Print-mode stdout contains the terminating structured JSON payload, so `atomic -p` remains script-friendly while the same value is also available through the SDK `capture` sink, tool `details`, a configured file sink, or workflow `result.structured`. This also works for custom factory names such as `final_decision`. Non-terminating or unrelated tool results are not printed as the final response.

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model capability mapping still governs availability |
| `--models <patterns>` | Comma-separated patterns for CTRL+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--session-id <id>` | Use an exact project session ID; warn and create it when missing |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--name <name>`, `-n <name>` | Set the session display name |
| `--no-session` | Ephemeral mode; do not save |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Denylist specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Default built-in tools: `read`, `bash`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`. `find.paths` accepts directories, files, or glob paths such as `*.ts` and honors `timeout`; `search` accepts `pattern`, optional `paths`, `i`, `gitignore`, and `skip` for regex content-search pagination. Use `--exclude-tools` to disable one or more tools while leaving the rest available, for example `atomic --exclude-tools ask_user_question`.

### Project Trust Options

| Option | Description |
|--------|-------------|
| `--approve`, `-a` | Trust project-local files/resources for this run |
| `--no-approve`, `-na` | Ignore project-local files/resources for this run |

Project trust gates `.atomic`/legacy `.pi` project resources, project package settings, project-local context files, and `.agents/skills` discovered from the project tree. Saved trust decisions can be managed with `/trust`; see [Security](/security).

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions`, `-ne` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills`, `-ns` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates`, `-np` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable context-file discovery and loading |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
atomic --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--offline` | Disable startup network operations, including update checks, package updates, and telemetry |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
atomic @prompt.md "Answer this"
atomic -p @screenshot.png "What's in this image?"
atomic @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
atomic "List all .ts files in src/"

# Non-interactive
atomic -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | atomic -p "Summarize this text"

# Different model
atomic --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
atomic --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
atomic --model sonnet:high "Solve this complex problem"

# Limit model cycling
atomic --models "claude-*,gpt-4o"

# Read-only mode
atomic --tools read,search,find,ls -p "Review the code"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `atomic` by the CLI, RPC, and compiled binary entry points and in every Atomic-owned child-process environment so generic tooling can identify Atomic processes; child environments override caller-supplied values without mutating the caller's environment object |
| `ATOMIC_CODING_AGENT_DIR` | Override config directory; default is `~/.atomic/agent`. Bundled intercom runtime/config files live under its `intercom/` subdirectory |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `ATOMIC_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `ATOMIC_REDUCED_MOTION` | Set to `1` to skip startup choreography and render the ordinary working identity as a static regular accent `∀` without a timer |
| `ATOMIC_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `ATOMIC_SKIP_VERSION_CHECK` | Skip the Atomic version update check at startup. This prevents the latest-version request |
| `ATOMIC_TELEMETRY` | Override install/update telemetry: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `NODE_COMPILE_CACHE` | Override the directory for Node's persistent compile cache, which Atomic enables automatically on Node >= 22.8 to speed up startup (most noticeable on Windows). Set `NODE_DISABLE_COMPILE_CACHE=1` to opt out |
| `PI_CACHE_RETENTION` | Provider/upstream-specific prompt-cache retention knob; set to `long` where supported |
| `ATOMIC_NO_PTY` | Set to `1` to disable PTY use for bash commands (`PI_NO_PTY` is a legacy alias) |
| `VISUAL`, `EDITOR` | External editor for CTRL+G |

Every foreground or background bash execution receives one execution-time snapshot of the active session:

| Atomic variable | Exact compatibility alias | Value |
|-----------------|---------------------------|-------|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_SESSION_FILE` | `PI_SESSION_FILE` | Active session JSONL path; omitted for unsaved sessions |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active model provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

The snapshot is taken when the command executes, not when the tool is created, so resumed sessions, workflow stages, isolated sessions, model changes, and concurrent sessions cannot reuse stale metadata. Atomic preserves all unrelated inherited and caller-supplied environment variables; only the ten names above are cleared and overlaid. Factory-created bash tools expose the same metadata by default and can set `exposeSessionEnvironment: false` to omit it.

`PI_*` aliases are also supported for app-specific `ATOMIC_*` variables for legacy compatibility. For example, [Intercom](/intercom) honors `PI_CODING_AGENT_DIR` when `ATOMIC_CODING_AGENT_DIR` is unset and still reads legacy `~/.pi/agent/intercom/config.json` when the Atomic config is absent. `PI_CACHE_RETENTION` is not one of those aliases and has no `ATOMIC_*` equivalent. Use `PI_CACHE_RETENTION=long` when configuring prompt-cache retention for providers/upstreams that support long-lived caches. Intercom's default broker starter works across Node-based installs, Bun source checkouts, and standalone Atomic binaries without requiring `npx`, `tsx`, or `bun` to be present on `PATH`; custom broker commands remain explicit opt-in overrides.

## Design Principles

Atomic keeps the core CLI small, while this distribution bundles first-party package extensions for workflows, subagents, MCP, web access, [intercom](/intercom), and [i-have-adhd](/i-have-adhd). Other workflows can still be installed as extensions or packages, or handled externally with tools such as containers and tmux.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
