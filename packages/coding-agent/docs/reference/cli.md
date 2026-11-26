---
title: "CLI reference"
sidebarTitle: "CLI"
description: "Commands, flags, model-matching rules, file arguments, subcommands, and exit codes for the atomic CLI."
---

```bash
atomic [options] [@files...] [messages...]
```

## Option parsing rules

- **Space-separated values:** Built-in CLI options require space-separated values (`--model gpt-4o`). Passing `--flag=value` (such as `--model=gpt-4o` or `--mode=json`) is not supported for built-in flags and fails with `Error: Unknown option`. Only extension-registered flags, `atomic auth print-bearer-token --min-expiry=...`, and `atomic blueprint cache-key --format=...` accept `=`.
- **End-of-options terminator (`--`):** Use `--` when positional prompt text begins with `-`, `--`, or `@`. Every argument after `--` is treated as literal message text rather than an option or `@file` argument:

```bash
atomic --print -- "- leading-dash prompt"
```

- **Unknown flags and validation:** Unknown `--flags` are passed to loaded extensions; if no extension registers them, startup fails with `Error: Unknown option: --<name>`. Invalid `--mode` values or invalid CLI storage flags print `Error: ...` and exit `1`. Invalid `--thinking` values print a warning and continue with the default thinking level.

## Modes

| Flag | Description |
| --- | --- |
| *(default)* | Interactive mode (fullscreen TUI) when both stdin and stdout are a TTY |
| `-p`, `--print` | Print response and exit (see [Non-interactive mode](/guides/non-interactive)) |
| `--mode text\|json\|rpc` | Choose output or protocol mode (`json` streams JSON lines, see [JSON mode](/json); `rpc` runs stdin/stdout RPC, see [RPC mode](/rpc)). For TypeScript hosts, use the [SDK](/sdk) |
| `--export <in> [out]` | Export a session to HTML (defaults to `<stem>.html` next to `<in>`), print `Exported to: <path>`, and exit `0` |

**`--mode text` vs. automatic print mode:** Passing `--mode text` alone in an interactive terminal still launches interactive mode; it selects plain-text output for print mode (or overrides an earlier `--mode json`). Conversely, if stdin or stdout is not a TTY (such as piping into `atomic` or redirecting `atomic > out.txt`), Atomic automatically switches to print mode even without `-p`. Both print mode and `--mode json` automatically exclude `ask_user_question`.

**Multiple prompts and piped stdin:** Passing multiple positional prompts (for example `atomic -p "step 1" "step 2"`) runs them sequentially in one session; plain-text print mode prints only the final prompt's answer to stdout, while `--mode json` streams every turn. In print mode, Atomic reads piped stdin and separates it from CLI prompt text with a newline:

```bash
cat README.md | atomic -p "Summarize this text"
```

Once piped input starts arriving, Atomic waits until EOF. If a pipe sends nothing within 2 seconds, a run with a prompt argument or `@file` starts without stdin and warns if bytes arrive later. A run with no prompt argument keeps waiting and notes that on stderr. Set `ATOMIC_STDIN_TIMEOUT_MS` to adjust the wait, or `0` to always wait for piped EOF.

**Structured-output termination:** When a print-mode turn calls an opt-in terminating structured-output tool (such as `final_decision`), Atomic exits immediately after that tool result without another assistant turn and writes the JSON payload to stdout. Non-terminating tool results are not printed as the final response. See [Structured decisions](/sdk/structured-decisions).

**Fullscreen interactive options:** Interactive sessions run fullscreen with a scrolling transcript above the docked editor and status area. Adjust **Fullscreen wheel scroll lines** in `/settings` (or `fullscreenWheelScrollLines`: `"auto"` or `1` to `100`). Text selection copies automatically unless `fullscreenCopyOnSelect` is `false`. `Ctrl+X` does not copy; followed by `Ctrl+K` it stops all background work (see [Keybindings](/keybindings#navigation)), and `/scoped-models` uses it to clear selections. On exit, `fullscreenExitOutput: "transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the hint. See [Settings](/settings) and [Terminal setup](/terminal-setup).

## Model options

Configure provider logins and API keys in [Model providers](/providers), or add custom models and overrides in [Configure custom models](/models).

| Option | Description |
| --- | --- |
| `--provider <name>` | Provider to search for `--model`, such as `anthropic`, `openai`, or `google`; requires `--model` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key overriding environment variables. Does not disambiguate providers that share a model |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; model capability mapping still governs availability |
| `--models <patterns>` | Comma-separated patterns for scoped model cycling (`Ctrl+P`) and initial model scope |
| `--fallback-models <models>` | Comma-separated fallback models tried in order after retryable failures; replaces [`fallbackModels`](/settings#fallbackmodels) for this run |
| `--no-fallback` | Never fall back to another model in this run; cannot be combined with `--fallback-models` |
| `--list-models [search]` | List available models and exit |

### How `--model`, `--models`, and `--fallback-models` match models

These three flags use different matching and credential rules:

| Behavior | `--model` | `--models` | `--fallback-models` |
| --- | --- | --- | --- |
| Glob wildcards (`*`, `?`, `[`) | No (characters are literal) | Yes (case-insensitive against `provider/id` and bare `id`) | No (characters are literal) |
| Exact and fuzzy substring match | Yes (case-insensitive) | Yes (case-insensitive, after exact and glob) | Yes (case-insensitive) |
| Searches unauthenticated models | Yes (so `--api-key` works) | No (authenticated models only) | No (authenticated models only) |
| `:<thinking>` suffix | Strict, case-insensitive (invalid suffix fails) | Lenient on fuzzy matches, case-insensitive (invalid suffix warns and uses default) | Strict, case-insensitive (invalid suffix warns and skips entry) |
| Ambiguous bare model ID | Prefers an authenticated provider (unless `--api-key` is passed); asks for `--provider` if still ambiguous | Adds every matching authenticated provider | Prefers the active or default provider; warns if still ambiguous |
| Unknown model on a known provider | Synthesizes a custom model from that provider's defaults with a warning | Warns and skips the pattern | Warns and skips the entry |

Key details for each flag:

- **`--model <pattern>`:** Checks exact `provider/id` or raw `id` before substring matching on model `id` and display `name` (preferring non-dated aliases over `-YYYYMMDD` snapshots, then lexicographically newest). Full text is matched before splitting `:<thinking>` so model IDs containing colons (such as `qwen/qwen3-coder:exacto`) resolve intact. If `--provider <p>` or `<p>/<id>` names a known provider whose catalog omits `<id>`, Atomic warns and runs with a synthesized custom model inheriting that provider's defaults (enabling reasoning when a non-`off` `:<thinking>` suffix is given). Explicit `--thinking` always overrides a `:<thinking>` suffix.
- **`--models <patterns>`:** Evaluates each comma-separated pattern in order: exact literal match, then glob match (`*`, `?`, `[`), then fuzzy substring match. Duplicate matches keep the first pattern's thinking level. On a new session without `--model`, Atomic starts on your saved default model if it is inside the scope, otherwise on the first scoped model. For how model scoping also affects `/model`, `/scoped-models`, and subagents, see [`enabledModels`](/settings#enabledmodels).
- **`--fallback-models <models>`:** Accepts `provider/model[:thinking]`, bare IDs, or fuzzy matches, and requires configured credentials for each entry.

**Fallback precedence and stderr output:** A model selected with `--model` runs strictly as named and falls back only to `--fallback-models`, ignoring global and project `fallbackModels` settings. In interactive mode this holds for the whole process, even after `/model`, `Ctrl+P`, `/new`, or `/resume`. Start Atomic without `--model` to use settings fallbacks. Child subagents running on the main session's model inherit the same fallback chain.

In print mode, all fallback notices go to **stderr** (keeping stdout clean for scripts): `Model fallback: <model> failed, continuing on <fallback>: <reason>` when switching, and `Model: ran on <fallback>, not the requested <model>.` after a fallback answer finishes. Failed runs write `Model <model> failed: <reason>` to stderr.

## Session options

| Option | Description |
| --- | --- |
| `-c`, `--continue` | Continue the most recent session for the current directory |
| `-r`, `--resume` | Browse and select a session |
| `--session <id\|prefix>` | Open by exact ID or unique 8-hex UUID prefix in its working directory. If it matches only another directory, Atomic offers to fork it here. Exits `75` if another live process holds the session open ([When the session is already open](/guides/resume-on-any-machine#when-the-session-is-already-open)) |
| `--import <file>` | Import an exported JSONL session into session storage |
| `--session-id <id>` | Use an exact project session ID; warn and create it when missing |
| `--fork <id\|prefix>` | Fork an exact ID or unique 8-hex UUID prefix into a new session in the current directory |
| `--session-dir <dir>` | Select JSONL session storage and lookup directory |
| `--session-store <path>` | Select a SQLite session database; relative paths resolve from the working directory |
| `--session-prefix <prefix>` | Use a non-default table prefix with `--session-store` |
| `--name <name>`, `-n <name>` | Set the session display name (rejects empty or whitespace-only values) |
| `--no-session` | Run without saving a resumable session |
| `--storage <json>` | Select shared storage for this process in the JSON form of the `storage` setting; never saved. See [Selecting storage per process](/storage#selecting-storage-per-process) |
| `--storage-file <path>` | Read the `--storage` selection from a JSON file |

**Conflict and validation rules:**

- `--import` cannot combine with `--session`, `--fork`, `--session-id`, `--continue`, or `--resume` (it can combine with `--no-session` or `--session-dir`).
- `--fork` cannot combine with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot combine with `--session`, `--continue`, or `--resume`. IDs must start and end with an ASCII letter or digit and contain only ASCII letters, digits, `.`, `_`, or `-`.
- `--session-store` cannot combine with `--session-dir` or `--no-session`.
- `--session-prefix` requires `--session-store`.
- `--storage` cannot combine with `--storage-file`, and neither accepts `{ "dir": "..." }`.
- `--storage` and `--storage-file` cannot combine with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` (startup fails with `StorageConfigError` and `conflicting-overrides`; unset the variable or pass an explicit session flag). See [Storage and team variables](/environment-variables#storage-and-team-variables).
- Invalid CLI storage flags exit cleanly with `Error: ...` and exit code `1`.

See [Choosing a store](/sessions#choosing-a-store) for full precedence and conflict details.

## Tool options

| Option | Description |
| --- | --- |
| `--tools <list>`, `-t <list>` | Allowlist tool names or `*` patterns, or modify defaults with only `+name`/`-name` entries; an allowlist keeps MCP tools unless an entry starts with `mcp__` |
| `--exclude-tools <list>`, `-xt <list>` | Exclude tool names or `*` patterns, including MCP tools and Intercom |
| `--no-builtin-tools`, `-nbt` | Disable built-in coding tools while keeping extension and custom tools enabled |
| `--no-tools`, `-nt` | Disable every tool, including Intercom, even when `--tools` is passed |

Default built-in coding tools: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, `codemode`, plus `powershell` on native Windows when a PowerShell executable is available. `ls` remains available but is off by default.

**Pattern matching rules:** Pattern matching in `--tools` and `--exclude-tools` is **case-sensitive** and supports **only `*` wildcards** (`?` and `[...]` are literal). Modifier entries (`+name`/`-name`) accept exact names only (no `*`) and cannot mix with plain allowlist entries; use `--exclude-tools` for pattern exclusions.

`defaultTools` selects initial coding tools without narrowing extension or custom tools. `--tools` sets an explicit allowlist, and `--exclude-tools` subtracts from it. `--no-builtin-tools` suppresses coding defaults when no allowlist is given. Bundled Intercom stays loaded with `--no-extensions`, but its tool follows allowlists, exclusions, and `--no-tools` like other extension tools.

To remove [codemode](/tools#codemode) or add [tool search](/tools#tool_search) alongside defaults, pass `atomic --tools -codemode,+tool_search` for one run or set `"defaultTools": ["-codemode", "+tool_search"]`. On `/reload`, CLI modifiers still apply on top of the reloaded `defaultTools` setting. Modifiers do not narrow extension tools or filter MCP exposure, and `--no-tools` disables every tool.

### MCP tools

`--tools read,codemode` keeps non-hidden MCP tools with `codemode` or `deferred` exposure callable from codemode scripts. MCP tools unmatched by the allowlist are not declared directly, regardless of exposure. Unmatched direct-exposure tools stay registered but inactive. Only an enabled `tool_search` can load unmatched non-direct tools.

An entry starting with `mcp__` filters MCP tools too. For example, `atomic --tools read,codemode,'mcp__docs__*'` keeps only tools from the `docs` server. MCP resource tools count as MCP tools, and exclusions apply to both server and resource tools. Use `--no-mcp` to disable built-in MCP connections and resources.

## Project trust options

| Option | Description |
| --- | --- |
| `--approve`, `-a` | Trust project-local files and resources for this run |
| `--no-approve`, `-na` | Ignore project-local files and resources for this run |

Project trust gates `.atomic` and legacy `.pi` project resources, project package settings, project-local context files, and `.agents` resources discovered from the project tree. Manage saved trust decisions with `/trust`; see [Security](/security).

## Resource options

| Option | Description |
| --- | --- |
| `-e`, `--extension <source>` | Load an extension from a path, npm, or git; repeatable |
| `--no-extensions`, `-ne` | Disable optional extension discovery; mandatory bundled Intercom remains loaded |
| `--no-mcp` | Disable built-in MCP support for this run, even when explicitly enabled; replacement extensions are unaffected |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills`, `-ns` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates`, `-np` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable context-file discovery and loading |

Combine `--no-*` with explicit flags to load only what you specify, ignoring settings:

```bash
atomic --no-extensions -e ./my-extension.ts
```

## Other options

| Option | Description |
| --- | --- |
| `--system-prompt <text\|path>` | Replace the default prompt with literal text or the contents of an existing file (context files and skills still append; overrides `SYSTEM.md`) |
| `--append-system-prompt <text\|path>` | Append literal text or file contents to the system prompt; repeatable. Replaces any discovered `APPEND_SYSTEM.md` file |
| `--use-theme <name[/name]>` | Set the interactive theme for this run without saving it; see [Themes](/themes#initial-theme) |
| `--offline` | Disable automatic network activity, including update checks, package updates, telemetry, and model catalog refreshes |
| `--debug` | Turn on [debug mode](/development#debugging) for this run, the same as `ATOMIC_DEBUG=1` |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## File arguments

Prefix files with `@` to include them in the initial message:

```bash
atomic @prompt.md "Answer this"
atomic -p @screenshot.png "What's in this image?"
atomic @code.ts @test.ts "Review these files"
```

`@file` paths expand `~`, resolve relative to the current working directory, skip empty (0-byte) files silently, and exit `1` if missing or unreadable. UTF-8 text files (BOM stripped) are wrapped in `<file name="/abs/path">...</file>` blocks, and supported image files are attached as images. `@file` arguments are not allowed in `--mode rpc` (exits `1`).

## Examples

```bash
# Interactive with initial prompt
atomic "List all .ts files in src/"

# Non-interactive print mode
atomic -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | atomic -p "Summarize this text"

# Different model with explicit provider
atomic --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
atomic --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand (case-insensitive)
atomic --model sonnet:high "Solve this complex problem"

# Limit model cycling with globs
atomic --models "claude-*,gpt-4o"

# Read-only mode
atomic --tools read,search,find,ls -p "Review the code"
```

## Package commands

```bash
atomic install <source> [-l]            # Install package, -l for project-local
atomic remove <source> [-l]             # Remove package
atomic uninstall <source> [-l]          # Alias for remove
atomic update [source|self|atomic|pi]   # Update Atomic only, or one package source
atomic update --all                     # Update Atomic and packages; reconcile pinned git refs
atomic update --extensions              # Update packages only; reconcile pinned git refs
atomic update --models                  # Force-refresh authenticated provider model catalogs (15s timeout)
atomic update --self                    # Update Atomic only
atomic update --force                   # Reinstall Atomic even if the current version is latest
atomic update --extension <src>         # Update one package
atomic list                             # List installed packages
atomic config [-l] [-a|-na]             # Open resource TUI (-l starts in project settings)
```

These commands manage Atomic packages, and `atomic update` updates the Atomic CLI installation. Passing both `--self` and `--extensions` behaves like `--all`. To uninstall Atomic itself, see [Uninstall](/getting-started/installation#uninstall).

`atomic config` and project package commands accept `--approve` (`-a`) or `--no-approve` (`-na`) to trust or ignore project-local settings for one command. `atomic update` never prompts for project trust.

After updating the Atomic CLI, `atomic update` runs the new version's [`atomic intercom upgrade`](#storage-and-intercom-commands) when `atomic` on `PATH` reports the installed version and lists that command. Otherwise it prints a note and leaves the broker alone. A failed broker upgrade prints a warning and keeps exit code `0`.

If you upgrade Atomic in place while a session is running and see a restart notice, restart that session (for example with `atomic -r`) so updated modules and built-in extensions load cleanly. Errors in your own extensions are reported as usual.

`atomic update --models` refreshes configured provider catalogs (with a 15-second total timeout) without updating packages. Built-in catalogs from models.dev do not refresh your provider login. Account-specific catalogs still need valid credentials; if an OAuth refresh fails, the command warns with `atomic auth login <provider>` and continues refreshing other catalogs. Other failures, such as a network error, exit nonzero.

See [Atomic packages](/packages) for package sources and security notes.

### Custom update command

If a wrapper or another package manager provides Atomic, set `ATOMIC_SELF_UPDATE_COMMAND` so `atomic update` runs its update command:

```bash
export ATOMIC_SELF_UPDATE_COMMAND="mise use -g npm:{packageName}@{version}"
```

`atomic update` runs this command only when a newer release exists, replacing `{packageName}`, `{version}`, and `{installSpec}` (`{packageName}@{version}`) with that release. It bypasses install-method detection, so it works for installs Atomic cannot update itself.

The environment value is split on spaces; `PI_SELF_UPDATE_COMMAND` works as a legacy alias. For arguments that contain spaces, set the global `selfUpdateCommand` array in `~/.atomic/agent/settings.json` instead (for example `["nix", "profile", "upgrade", "atomic"]`). Project settings are ignored for this key.

After the command finishes, Atomic checks the version on disk or from `atomic --version` on `PATH`. A wrapper that installs each version into a new directory still reports success. A command that exits `0` without installing the new version prints a warning instead.

## Credential commands

```bash
atomic auth login <provider> [--api-key] [--no-browser]
atomic auth logout <provider>
atomic auth check [--provider <p>] [--model <model>] [--json] [--credentials] [--no-refresh]
atomic auth print-api-key --model <model> [--provider <p>]
atomic auth print-bearer-token --model <model> [--provider <p>] [--min-expiry <dur>]
```

`atomic auth login <provider>` signs in to a provider in an interactive terminal and exits without starting a session. It opens the browser for account sign-in like `/login <provider>`, or prints instructions for another sign-in method when available. Providers without account sign-in prompt for an API key. See [Subscriptions](/providers#subscriptions) and [Credential resolution order](/providers/reference#resolution-order).

`atomic auth login` does not load extensions. For extension-registered providers (including bundled [`llama.cpp`](/llama-cpp)), sign in inside an interactive session with `/login <provider>`.

`<provider>` accepts a provider ID or display name such as `openai` or `OpenAI`. An ambiguous name (such as a `models.json` provider sharing a built-in display name) is rejected with the matching IDs; an exact provider ID always matches that provider. After sign-in, Atomic refreshes that provider's model catalog. If the refresh fails, times out after 15 seconds, or is interrupted with `Ctrl+C`, the login stays saved and refreshes on the next start.

| Option | Description |
| --- | --- |
| `--api-key` | Save an API key instead of signing in with an account; input is not echoed |
| `--no-browser` | Skip opening a browser and use another sign-in method such as a device code, for example over SSH. Prompts if several methods exist. Cannot be combined with `--api-key` |

`atomic auth logout <provider>` removes credentials saved by `atomic auth login` or `/login` while leaving environment variables and `models.json` unchanged. For built-in or `models.json` providers, it exits `0` even when nothing is stored. Extensions are not loaded; remove an extension provider's credentials by its provider ID (once none remain stored, that ID exits `1` as an unknown provider).

`atomic auth check` verifies the effective credential for a provider or model before starting a session (see [Verify readiness before a session](/providers#verify-readiness-before-a-session)). Pass at least one of `--provider` or `--model`. It prints `ready`, `not_ready`, or `invalid` to stdout and exits `0`, `1`, or `2`. `--json` adds the resolved provider, credential kind, and any failure reason. By default, checks never print credential material.

`--credentials` opts in to credential export from `atomic auth check`. It requires `--provider` or an exact `--model` target. A fuzzy model match on a ready provider returns `invalid` (exit `2`) instead of exporting a credential you did not name; on a non-ready provider it stays `not_ready` (exit `1`).

On a ready check with `--credentials`, plain stdout contains only the resolved credential, and `--json` adds it only in the `credentials` field. On a non-ready check, plain stdout stays empty while stderr reports the status, and `--json` omits `credentials`. Write failures exit `8` (nothing written) or `9` (partial fragment written).

Checks refresh expired OAuth credentials by default through Atomic's locked `auth.json` update path. Pass `--no-refresh` for a read-only check that never creates, locks, or modifies `auth.json`. Read-only mode still reads primary and legacy credential paths and resolves configured API-key values including `!command`, but treats malformed `auth.json` as `invalid` (exit `2`). OAuth credential exports require at least 30 minutes of remaining lifetime; normal mode can refresh, while `--no-refresh` refuses shorter-lived tokens.

The credential print commands emit one configured credential for an external client such as a proxy or script. The credential goes to **stdout and nothing else**. Warnings, provider selection, refresh notices, and help go to stderr, so `KEY=$(atomic auth print-api-key --model gpt-5.5)` never captures diagnostics.

`--model` is required for both `print-*` commands. Pass `--provider` when several configured providers offer the same model. The two `print-*` subcommands accept only `--provider` and `--model` (plus `--min-expiry` for `print-bearer-token`). Any other flag, including `--export`, `--session-dir`, and `--print`, is a usage error rather than an ignored flag.

Passing `--help` or `-h` to `atomic auth` or any `auth` subcommand (`login`, `logout`, `print-api-key`, `print-bearer-token`, or `check`), before a `--` terminator and not as the value of a value-taking flag, prints auth help to stderr and exits `0`. Bare `atomic auth` and `atomic auth help` do the same. Any unknown subcommand exits `1` and lists all five valid commands. Help never writes to stdout, so raw credential export stdout is always a credential or empty.

`print-bearer-token` works only on OAuth providers and `print-api-key` only on API-key providers; requesting the wrong kind fails instead of falling back. A bearer token with less than `--min-expiry` remaining (default `30m`, accepting `ms`, `s`, `m`, or `h`) is refreshed first. Both `--min-expiry 30m` and `--min-expiry=30m` work. Passing `--min-expiry` to `print-api-key` is a usage error, even after `--`. A failed refresh leaves your stored credential untouched.

Credential-export exits (`print-api-key`, `print-bearer-token`, and `--credentials` writes):

| Exit | Meaning |
| --- | --- |
| `0` | Credential written to stdout, one trailing newline |
| `1` | Usage error |
| `2` | No credential configured for that model or provider |
| `3` | Several configured providers match; pass `--provider` |
| `4` | That credential kind is unsupported for the provider |
| `5` | OAuth refresh failed; the stored credential is unchanged |
| `6` | The provider cannot mint a token that lives as long as `--min-expiry` |
| `7` | The provider's OAuth credential could not be used; stored state is not guaranteed unchanged |
| `8` | The credential could not be written; nothing was emitted |
| `9` | Only part of the credential was written; discard the output |

Auth-check exits:

| Exit | `atomic auth check` |
| --- | --- |
| `0` | `ready` |
| `1` | `not_ready`, including a fuzzy `--model` with `--credentials` when its resolved provider is not ready |
| `2` | `invalid`, including check usage errors (unknown option, neither `--provider` nor `--model`, or a fuzzy `--model` with `--credentials` when its resolved provider is otherwise ready) |
| `8` | With `--credentials`, the credential could not be written; nothing was emitted |
| `9` | With `--credentials`, only part of the credential was written; discard the output |

Exit `5` happens only when the refresh itself fails before persistence, so it is the only OAuth exit that guarantees your stored credential was not changed. Any other OAuth failure exits `7`.

Raw credential exports leave stdout empty on nonzero exits except exit `9`. Exit `9` means the stream failed partway through writing the credential; discard those bytes. Once the full credential reaches stdout, exit code stays `0` even if draining fails later (for example because a reader closed the pipe), with a diagnostic on stderr.

`auth check --credentials --json` may write a credential-free JSON status object on a nonzero check result. See [Security](/security#credential-export) before wiring credential export into a script.

## MCP commands

```bash
atomic mcp add <server> [options] -- <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l]
atomic mcp list [--json]
atomic mcp login <server> [-l] [--timeout <seconds>]
atomic mcp logout <server> [-l]
```

Configure and check MCP servers and sign in to OAuth servers without starting a session. These commands read `~/.atomic/agent/mcp.json` and, in trusted projects, `.atomic/mcp.json`, without loading extensions.

| Command | Description |
| --- | --- |
| `add <server>` | Add or replace a server entry in `mcp.json` |
| `remove <server>` | Remove a server entry from `mcp.json` |
| `list` | Connect to enabled servers and print state, tools, and errors (exits `1` on config or connection failure) |
| `login <server>` | Sign in to an OAuth HTTP server through the browser |
| `logout <server>` | Delete stored OAuth credentials for the server |

| Option | Commands | Description |
| --- | --- | --- |
| `-l`, `--local` | `add`, `remove`, `login`, `logout` | Target `.atomic/mcp.json` in the current project instead of `~/.atomic/agent/mcp.json` |
| `--url <url>` | `add` | Streamable HTTP server URL (instead of a stdio command) |
| `--env <KEY=VALUE>` | `add` | Environment variable for a stdio server; repeatable |
| `--cwd <dir>` | `add` | Working directory for a stdio server |
| `--header <KEY=VALUE>` | `add` | HTTP request header; repeatable |
| `--bearer-token-env-var <NAME>` | `add` | Send `Authorization: Bearer ${NAME}` |
| `--oauth-client-id <id>` | `add` | Pre-registered OAuth client ID |
| `--oauth-client-secret <secret>` | `add` | OAuth client secret (accepts `${NAME}` or `!command`) |
| `--oauth-callback-port <port>` | `add` | Fixed local OAuth callback port |
| `--oauth-client-name <name>` | `add` | Client name sent during dynamic OAuth registration |
| `--exposure <mode>` | `add` | Tool exposure: `codemode` (default), `deferred`, `direct`, or `hidden` |
| `--description <text>` | `add` | Short server description shown in the system prompt |
| `--json` | `list` | Print the server report as JSON |
| `--timeout <seconds>` | `login` | Total sign-in timeout in seconds (default `300`) |

Passing `--help` or `-h` after `--` (for example `atomic mcp add srv -- cmd --help`) or as the value of a value-taking flag passes through to the command or option instead of printing MCP help. See [MCP shell commands](/mcp-servers#shell-commands).

## Storage and Intercom commands

```bash
atomic storage status [--json]                                       # Selection, source, adapter, and connection per domain
atomic storage join <postgres-url> --password-file <path>|--token-file <path>|--auth azure|aws|gcp [--prefix <prefix>]  # Use a shared PostgreSQL database
atomic storage migrate [--db <url> [--password-file <path> | --token-file <path> | --auth azure|aws|gcp]] [--prefix <prefix>]
atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]
atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]
atomic storage export <dir> [--sessions] [--limit <n>] [--since <time>] [--storage <json> | --storage-file <path>]
atomic storage import <dir> [--sessions] [--storage <json> | --storage-file <path>]
atomic team status [--json]                                          # Profile in effect plus the storage report
atomic intercom status                                               # This machine's Intercom broker and multi-node state
atomic intercom restart                                              # Replace the broker so it reads the current selection
atomic intercom upgrade                                              # Replace a broker an older Atomic started, when safe
```

`atomic storage status` reports the selected storage for sessions and Intercom, where each selection came from (environment variable, project settings, global settings, or default), any outranked selections, whether each adapter loads, and whether each database answers `SELECT 1`. It also shows the running Intercom broker, its multi-node routing state, and peer brokers live in the shared database. It modifies nothing and exits `1` if a selection is invalid, an adapter fails to load, or a database does not answer.

`atomic storage join` verifies the credential and connection (`SELECT 1` with a 15-second timeout) using `@bastani/atomic-storage-postgres` (for `postgres://` or `postgresql://` URLs), writes only the global `storage` setting, and reports any environment variables or settings that override it. It creates no tables and prints the install command if the adapter package is missing.

- Pass exactly one of `--password-file` (copied to a mode `600` `storage-token.<id>` file), `--token-file` (referenced in place and re-read on every new connection), or `--auth azure|aws|gcp`. Passwords in the URL are rejected, and settings store only file references.
- A libSQL URL (`libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:`) is refused with `libsql-removed`: Atomic 0.10.11 removed libSQL support. See [Moving off libSQL](/storage#moving-off-libsql).

`atomic team status` adds the active profile (`individual`, `team`, `ci`, or `custom`) and project Intercom group. `atomic team join` and `atomic team leave` were removed with libSQL support in 0.10.11 and fail with `libsql-removed`. See [Team and CI setup](/guides/team-setup).

`atomic storage migrate` creates or upgrades session and Intercom tables in the selected shared database (or `--db`). Run it as the database owner after joining or upgrading Atomic so runtime-only roles do not need schema-creation privileges (DDL).

`atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]` migrates the snapshot chunk table in a closed local SQLite file using exclusive access, checkpointing after each batch so the write-ahead log does not need space for the entire copy.

`atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]` searches entries of a stored session in a local SQLite database by regex pattern, optionally resuming pagination from `cursor`. See [Recalling earlier work](/sessions#recalling-earlier-work).

`atomic storage export` writes sessions to `<dir>/sessions/<sessionId>.jsonl` (compatible with `atomic --import`). Each file is replaced whole; identical files are skipped and no files are deleted. `--limit <n>` exports at most `n` most recently modified sessions, and `--since <time>` filters by modification date or timestamp. Exporting a shared PostgreSQL database requires `--storage` or `--storage-file` explicitly.

`atomic storage import` validates every file in `<dir>/sessions` before writing, then adds new sessions and newer entries for existing sessions while ignoring other directories. Partial failures list what was and was not written so you can rerun safely. Both `export` and `import` accept `--sessions`, plus `--storage <json>` or `--storage-file <path>` to target a specific store.

`atomic intercom restart` stops the running broker, waits for it to exit, and waits for a reconnecting session to start a new broker (printing its status). Without connected sessions, the next session that uses Intercom starts one.

`atomic intercom upgrade` replaces an older Atomic version's broker when safe. With no connected sessions, it stops the broker so the next session starts the new version. With connected sessions, it leaves the broker running so the next session of this version hands it over smoothly. It exits `1` only if stopping the broker fails. Installers and `atomic update` run it automatically. See [Upgrading Atomic with sessions running](/intercom/operations#upgrading-atomic-with-sessions-running).

See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) and [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

## Blueprint commands

```bash
atomic blueprint cache-key [dir] [--format text|json|github-output]  # Cache keys and paths for a runner's cache action
atomic blueprint prebuild [dir] [--park] [--approve|-a]              # Build the repository ahead of time
```

`atomic blueprint cache-key` prints cache entries for the repository at `dir` (default: current directory). It reports `stores` (lockfile-detected package stores for npm, pnpm, Yarn, Bun, Cargo, uv, pip, Poetry, Go, Gradle, and Maven, plus [`resume.cache`](/settings#resume) store paths), `build` (`resume.cache` build paths and seed manifest), `git` (Atomic's Git object store), and `atomic` (extension transpile cache).

Each entry includes a key, restore prefix, and paths. `--format github-output` (or `--format=github-output`) outputs `<name>-key`, `<name>-restore-prefix`, and `<name>-paths` lines for `$GITHUB_OUTPUT`. Paths that might hold credentials are omitted with a stderr warning. See [Caches for runners](/guides/resume-on-any-machine#caches-for-runners).

`atomic blueprint prebuild` restores the committed `HEAD` of `dir` (only committed files; untracked or ignored files such as `.env` are not copied) into a new restored worktree, runs its `initialize` and `maintenance` blueprints, and leaves the worktree idle for the next resume to claim. `--park` moves `"build"` paths from `resume.cache` into the seed directory saved by the `build` cache entry.

Because `prebuild` executes project code, the project must be trusted or `--approve` (`-a`) must be passed. It prints restore and step timings on stderr, exits `2` on usage errors, and exits `1` if the project is untrusted, the checkout has no remote or has uncommitted changes to tracked files, or a step fails (keeping earlier worktrees and seeds). See [Caches for runners](/guides/resume-on-any-machine#caches-for-runners) and [Prebuilt worktrees](/guides/resume-on-any-machine#prebuilt-worktrees).

## Environment variables

See [Environment variables](/environment-variables) for the complete registry, exact boolean parsing rules, legacy `PI_*` aliases, color controls, and diagnostic knobs. Key CLI variables:

- **Config & storage:** `ATOMIC_CODING_AGENT_DIR`, `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, `ATOMIC_PACKAGE_DIR`.
- **Network & updates:** `ATOMIC_OFFLINE`, `ATOMIC_SKIP_VERSION_CHECK`, `ATOMIC_SELF_UPDATE_COMMAND` ([Custom update command](#custom-update-command)), `ATOMIC_TELEMETRY`, `ATOMIC_CACHE_RETENTION` ([Prompt-cache retention](/environment-variables#prompt-cache-retention)).
- **Interactive & shell:** `NO_COLOR`, `FORCE_COLOR`, `ATOMIC_REDUCED_MOTION`, `ATOMIC_DEBUG`, `ATOMIC_NO_PTY`, `ATOMIC_STDIN_TIMEOUT_MS`, `VISUAL` / `EDITOR`, `AI_AGENT` (set to `atomic` on Atomic and its child processes).

Every `bash` and `powershell` tool call receives an execution-time snapshot of the active session (captured when the command runs, so resumed sessions, subagents, and model changes stay accurate). See [Background tasks](/background-tasks#choose-how-long-to-wait) for observation wait limits.

| Atomic variable | Legacy alias | Value |
| --- | --- | --- |
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active model provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Atomic clears those eight names plus the two retired session-file names before setting the current snapshot; see [Bash and PowerShell session environment](/environment-variables#bash-and-powershell-session-environment).
