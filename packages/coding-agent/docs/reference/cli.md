---
title: CLI reference
description: Every Atomic command, flag, argument, and environment variable.
---

# CLI reference

```bash
atomic [options] [@files...] [messages...]
```

Use `--` to end option parsing when positional prompt text begins with `-`, `--`, or `@`. Every argument after the terminator is treated as literal message text rather than an option or file argument:

```bash
atomic --print -- "- leading-dash prompt"
```

## Package Commands

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

These commands manage Atomic packages and `atomic update` can update the Atomic CLI installation. To uninstall Atomic itself, see [Quickstart](/getting-started/installation#uninstall). `atomic config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `atomic update` never prompts for project trust.

See [Atomic Packages](/packages) for package sources and security notes.

## Credential Commands

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

Raw credential exports leave stdout empty on non-zero exits, except exit `9`. That exit means the stream failed after writing part of the credential. Discard the fragment; those bytes cannot be recalled.

Once the complete credential reaches stdout, the command has succeeded. If the stream then fails to drain, for example because a reader closed the pipe, Atomic reports it on stderr and keeps exit code `0`.

`auth check --credentials --json` may instead write a credential-free JSON status object on a non-zero check result. See [Security](/security#credential-export) before wiring this into a script.

## Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode (fullscreen TUI) |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](/json) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](/rpc) |
| `--export <in> [out]` | Export a session to HTML |

Interactive sessions use fullscreen, with a scrolling transcript above the docked editor and status area. Wheel and trackpad input goes to a focused workflow graph or stage chat first, then the transcript when not consumed. Scrolling, scrollbar dragging, and selection remain available outside overlays.

Selection copies automatically unless `fullscreenCopyOnSelect` is false. Ctrl+X returns tool detail or stage chat to the graph, returns the graph to main chat, or clears a scoped-model selection. It does not copy; `/copy` copies the last assistant message.

On exit, `fullscreenExitOutput: "transcript"` prints the final transcript and resume hint. `"resume-hint"` restores the previous screen and prints only the hint. See [Settings](/settings) and [Terminal setup](/terminal-setup).

In print mode, Atomic also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | atomic -p "Summarize this text"
```

When a print-mode turn correctly finishes by calling an opt-in terminating structured-output tool created with `createStructuredOutputTool` (for example from an extension, SDK caller, or workflow item with a schema), Atomic ends after that tool result without an extra follow-up assistant turn. Print-mode stdout contains the terminating structured JSON payload, so `atomic -p` remains script-friendly while the same value is also available through the SDK `capture` sink, tool `details`, a configured file sink, or workflow `result.structured`. This also works for custom factory names such as `final_decision`. Non-terminating or unrelated tool results are not printed as the final response.

## Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model capability mapping still governs availability |
| `--models <patterns>` | Comma-separated patterns for CTRL+P cycling |
| `--list-models [search]` | List available models |

## Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a session file, exact ID, or unique 8-hex UUID prefix |
| `--session-id <id>` | Use an exact project session ID; warn and create it when missing |
| `--fork <path\|id>` | Fork a session file, exact ID, or unique 8-hex UUID prefix into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--name <name>`, `-n <name>` | Set the session display name |
| `--no-session` | Ephemeral mode; do not save |

## Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific coding, extension, and custom tools, including Intercom |
| `--exclude-tools <list>`, `-xt <list>` | Exclude specific coding, extension, and custom tools, including Intercom |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable every tool, including Intercom, even with `--tools` |

Default built-in tools: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, plus `powershell` on native Windows when a PowerShell executable is available. `ls` remains available but is not a default. `defaultTools` selects initial coding tools without narrowing extension/custom tools. `--tools` selects an explicit allowlist; `--exclude-tools` subtracts from it. `--no-builtin-tools` suppresses coding defaults when no allowlist is given. `--no-tools` overrides all selection. To retain Intercom with an allowlist, include `intercom` explicitly.

## Project Trust Options

| Option | Description |
|--------|-------------|
| `--approve`, `-a` | Trust project-local files/resources for this run |
| `--no-approve`, `-na` | Ignore project-local files/resources for this run |

Project trust gates `.atomic`/legacy `.pi` project resources, project package settings, project-local context files, and `.agents/skills` discovered from the project tree. Saved trust decisions can be managed with `/trust`; see [Security](/security).

## Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions`, `-ne` | Disable optional extension discovery; mandatory bundled Intercom remains loaded |
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

## Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--use-theme <name[/name]>` | Set the interactive theme for this run without saving it; see [Themes](/themes#initial-theme) |
| `--offline` | Disable automatic network activity, including update checks, package updates, telemetry, and model catalog refreshes |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## File Arguments

Prefix files with `@` to include them in the message:

```bash
atomic @prompt.md "Answer this"
atomic -p @screenshot.png "What's in this image?"
atomic @code.ts @test.ts "Review these files"
```

## Examples

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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `atomic` by the CLI, RPC, and compiled binary entry points and in every Atomic-owned child-process environment so generic tooling can identify Atomic processes; child environments override caller-supplied values without mutating the caller's environment object |
| `ATOMIC_CODING_AGENT_DIR` | Override config directory; default is `~/.atomic/agent`. Bundled intercom runtime/config files live under its `intercom/` subdirectory |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `ATOMIC_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `ATOMIC_REDUCED_MOTION` | Set to `1` to skip startup choreography and render the ordinary working identity as a static regular accent `∀` without a timer |
| `ATOMIC_OFFLINE` | Disable automatic network activity, including update checks, package update checks, install/update telemetry, and model catalog refreshes |
| `ATOMIC_SKIP_VERSION_CHECK` | Skip the Atomic version update check at startup. This prevents the latest-version request |
| `ATOMIC_TELEMETRY` | Override version-adoption pings: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks (`PI_TELEMETRY` is a legacy alias) |
| `NODE_COMPILE_CACHE` | Override the directory for Node's persistent compile cache, which Atomic enables automatically on Node >= 22.8 to speed up startup (most noticeable on Windows). Set `NODE_DISABLE_COMPILE_CACHE=1` to opt out |
| `PI_CACHE_RETENTION` | Prompt-cache retention: `long` (default), `short`, or `none`, subject to provider/model support |
| `ATOMIC_NO_PTY` | Set to `1` to disable PTY use for bash commands (`PI_NO_PTY` is a legacy alias) |
| `VISUAL`, `EDITOR` | External editor for CTRL+G |

Every bash execution receives one execution-time snapshot of the active session. Foreground/background observation controls how long the caller waits, not the command's execution timeout. Omitted `wait` uses the owner's policy, normally yielding after 10 seconds; explicit background observation requires a supported task owner. Without one, foreground execution waits until completion. See [Background tasks](/background-tasks#choose-how-long-to-wait).

| Atomic variable | Exact compatibility alias | Value |
|-----------------|---------------------------|-------|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_SESSION_FILE` | `PI_SESSION_FILE` | Active session JSONL path; omitted for unsaved sessions |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active model provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

The snapshot is taken when the command executes, not when the tool is created, so resumed sessions, workflow stages, isolated sessions, model changes, and concurrent sessions cannot reuse stale metadata. Atomic preserves all unrelated inherited and caller-supplied environment variables; only the ten names above are cleared and overlaid. Factory-created bash tools expose the same metadata by default and can set `exposeSessionEnvironment: false` to omit it.

`PI_*` aliases are also supported for app-specific `ATOMIC_*` variables for legacy compatibility. For example, [Intercom](/intercom) honors `PI_CODING_AGENT_DIR` when `ATOMIC_CODING_AGENT_DIR` is unset and still reads legacy `~/.pi/agent/intercom/config.json` when the Atomic config is absent. `PI_CACHE_RETENTION` is not one of those aliases and has no `ATOMIC_*` equivalent. Long retention is the default for main chat, workflow stages, and subagents where supported; use `PI_CACHE_RETENTION=short atomic` to opt back into shorter caching. See [Prompt-cache retention](/environment-variables#prompt-cache-retention) for overrides and pricing tradeoffs. Intercom's default broker starter works across Node-based installs, Bun source checkouts, and standalone Atomic binaries without requiring `npx`, `tsx`, or `bun` to be present on `PATH`; custom broker commands remain explicit opt-in overrides.
