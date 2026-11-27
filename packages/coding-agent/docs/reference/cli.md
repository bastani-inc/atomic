---
title: "CLI reference"
sidebarTitle: "CLI"
description: "Commands, flags, option-parsing rules, model matching, file arguments, subcommands, and exit codes for the atomic CLI."
---

```bash
atomic [options] [--] [@files...] [messages...]
```

## Option parsing rules

- **Space-separated values:** Built-in CLI options require space-separated values (`--model gpt-4o`). Passing `--flag=value` (such as `--model=gpt-4o` or `--mode=json`) is not supported for built-in flags and fails with `Error: Unknown option`. Only extension-registered flags, `atomic auth print-bearer-token --min-expiry=...`, and `atomic blueprint cache-key --format=...` accept `=`.
- **End-of-options terminator (`--`):** Use `--` when positional prompt text begins with `-`, `--`, or `@`. Every argument after `--` is treated as literal message text rather than an option or `@file` argument:

```bash
atomic --print -- "- leading-dash prompt"
```

- **Unknown flags:** Unknown `--flags` are forwarded to loaded extensions; if no extension registers them, startup fails with `Error: Unknown option: --<name>`. Unknown single-dash options (such as `-x`) always fail immediately with `Error: Unknown option: -x` and are never forwarded to extensions.
- **Missing option values:** Passing a value-taking flag at the end of the command line without a value fails startup. `--mode`, `--name`, `--fallback-models`, `--use-theme`, `--session-dir`, `--session-store`, `--session-prefix`, `--storage`, and `--storage-file` print an explicit missing-value error; other value-taking built-in flags (such as `--model` or `-t`) fail with `Error: Unknown option`.
- **Validation and help:** Invalid `--mode` values or invalid CLI storage flags print `Error: ...` and exit `1`. Invalid `--thinking` values print a warning and continue with the default thinking level. `atomic --help` loads extensions (including `-e` extensions) so extension-registered CLI flags appear in the help text.

## Modes

| Flag | Description |
| --- | --- |
| *(default)* | Interactive mode (fullscreen TUI) when both stdin and stdout are a TTY |
| `-p`, `--print` | Print response and exit ([Run non-interactively](/guides/non-interactive)) |
| `--mode text\|json\|rpc` | Choose output or protocol mode (`json` streams JSON lines, see [JSON mode](/json); `rpc` runs stdin/stdout RPC, see [RPC mode](/rpc)). For TypeScript hosts, use the [SDK](/sdk) |
| `--export <in> [out]` | Export a session `.jsonl` file to HTML (defaults to `atomic-session-<stem>.html` in the current working directory), print `Exported to: <path>`, and exit `0` |

**`--mode text` vs. automatic print mode:** Passing `--mode text` alone in an interactive terminal still launches interactive mode; it selects plain-text output for print mode (or overrides an earlier `--mode json`). Conversely, if stdin or stdout is not a TTY (such as piping into `atomic` or redirecting `atomic > out.txt`), Atomic automatically switches to print mode even without `-p`. Both print mode and `--mode json` automatically disable interactive question prompts (`ask_user_question`).

**Multiple prompts and piped stdin:** Passing multiple positional prompts (for example `atomic -p "step 1" "step 2"`) runs them sequentially in one session; plain-text print mode prints only the final prompt's answer to stdout, while `--mode json` streams every turn. In print mode, Atomic trims piped stdin and separates it from CLI prompt text or `@file` blocks with a blank line (`\n\n`) when adjacent text has no whitespace boundary:

```bash
cat README.md | atomic -p "Summarize this text"
```

Once piped input starts arriving, Atomic waits until EOF. If a pipe sends nothing within 2 seconds, a run with a prompt argument or `@file` starts without stdin and warns if bytes arrive later. A run with no prompt argument keeps waiting and notes that on stderr. Set `ATOMIC_STDIN_TIMEOUT_MS` to adjust the wait, or `0` to always wait for piped EOF.

**Structured-output termination:** When a tool configured to return a final structured JSON result completes during a print-mode turn (such as `final_decision`), Atomic exits immediately without another assistant turn and writes the JSON payload to stdout. Ordinary tool results are not printed as the final response. See [Structured decisions](/sdk/structured-decisions).

**HTML export rendering (`--export`):** When the exported branch contains a single subagent launch, `atomic --export` renders it as an `Agent(...)` card showing its prompt, tool calls, and final answer. Parallel launches and other extension tools keep their normal export format.

For fullscreen interactive display settings, mouse selection, and exit behavior, see [Use interactive mode](/usage), [Interface and display settings](/settings#interface-and-display), and [Keybindings](/keybindings#navigation).

## Model options

Configure provider logins and API keys in [Model providers](/providers), choose models daily in [Choose a model](/models/choose-a-model), or add custom models and overrides in [Configure custom models](/models).

| Option | Description |
| --- | --- |
| `--provider <name>` | Provider to search for `--model`, such as `anthropic`, `openai`, or `google`; requires `--model` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key overriding environment variables for this run. Requires a model to be specified via `--model`, `--provider`/`--model`, or `--models` (otherwise startup fails). Does not disambiguate providers that share a model |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; model capability mapping still governs availability |
| `--models <patterns>` | Comma-separated patterns for scoped model cycling (`Ctrl+P`) and initial model scope |
| `--fallback-models <models>` | Comma-separated fallback models tried in order after retryable failures; replaces [`fallbackModels`](/settings#fallbackmodels) for this run |
| `--no-fallback` | Never fall back to another model in this run; cannot be combined with `--fallback-models` |
| `--list-models [search]` | List authenticated/available models sorted by provider then model ID as tab-separated columns (`model`, `level`, `context`, `max-out`, `images`) and exit. `level` shows the default startup thinking level (blank for non-reasoning models). Optional `[search]` fuzzy-matches provider, model ID, and display name |

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
| `-c`, `--continue` | Continue the most recent session for the current directory, or start a new session if none exists |
| `-r`, `--resume` | Browse and select a session (cancelling prints `No session selected` and exits `0`; renaming is available in interactive `/resume`, not in `atomic -r`) |
| `--session <id\|prefix>` | Open by exact ID or unique 8-hex UUID prefix in its working directory. If it matches only another directory, Atomic offers to fork it here. Exits `75` if another live process holds the session open ([When the session is already open](/guides/resume-on-any-machine#when-the-session-is-already-open)) |
| `--import <file>` | Import an exported JSONL session into session storage |
| `--session-id <id>` | Use an exact project session ID; warns and creates it when missing |
| `--fork <id\|prefix>` | Fork an exact ID or unique 8-hex UUID prefix into a new session in the current directory |
| `--session-dir <dir>` | Select JSONL session storage and lookup directory |
| `--session-store <path>` | Select a SQLite session database; relative paths resolve from the working directory |
| `--session-prefix <prefix>` | Use a non-default table prefix with `--session-store` |
| `--name <name>`, `-n <name>` | Set the session display name (rejects empty or whitespace-only values) |
| `--no-session` | Run without saving a resumable session |
| `--storage <json>` | Select shared storage for this process in the JSON form of the `storage` setting; never saved ([Selecting storage per process](/storage#selecting-storage-per-process)) |
| `--storage-file <path>` | Read the `--storage` selection from a JSON file |

**Resolution, conflict, and validation rules:**

- **Prefix disambiguation:** When an 8-hex prefix passed to `--session` or `--fork` matches both a regular session and internal subagent sessions launched around the same time, Atomic prefers non-internal sessions.
- **Missing recorded directory:** Resuming a session whose recorded working directory no longer exists prompts in interactive mode to continue in the current directory or fork into it, and exits `1` in non-interactive modes.
- **`--fork` with `--session-id`:** `--fork <src>` can be combined with `--session-id <new-id>` to assign an explicit ID to the forked session (exiting `1` if that ID already exists in the current directory). `--no-session` also accepts `--session-id`.
- **Flag conflicts:**
  - `--import` cannot combine with `--session`, `--fork`, `--session-id`, `--continue`, or `--resume` (it can combine with `--no-session` or `--session-dir`).
  - `--fork` cannot combine with `--session`, `--continue`, `--resume`, or `--no-session`.
  - `--session-id` cannot combine with `--session`, `--continue`, or `--resume`. IDs must start and end with an ASCII letter or digit and contain only ASCII letters, digits, `.`, `_`, or `-`.
  - `--session-store` cannot combine with `--session-dir` or `--no-session`; `--session-prefix` requires `--session-store`.
  - `--storage` cannot combine with `--storage-file`, and neither accepts `{ "dir": "..." }`.
  - Combining `--storage` or `--storage-file` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` fails startup with an invalid storage configuration error and exit code `1` (unset the variable or pass an explicit session flag; see [Storage and team variables](/environment-variables#storage-and-team-variables)).

See [Which selection wins](/storage#which-selection-wins) for full storage precedence rules.

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

If both `--approve` and `--no-approve` are passed, the last flag wins. Project trust gates `.atomic` and legacy `.pi` project resources, project package settings, project-local context files, and `.agents` resources discovered from the project tree.

Loading an extension source outside the current project via `-e` / `--extension` can trigger a separate prompt to trust that extension source's own `.atomic`, `.pi`, or `.agents` resources. In non-interactive modes (`-p`, `--mode json`, `--mode rpc`), untrusted projects with local settings do not prompt; Atomic writes a stderr warning advising `--approve` (`-a`) and skips project files. Manage saved trust decisions with `/trust`; see [Security](/security).

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
| `--use-theme <name[/name]>` | Set the interactive theme for this run without saving it ([Themes](/themes#initial-theme)) |
| `--offline` | Disable automatic network activity, including update checks, package updates, telemetry, and model catalog refreshes |
| `--debug` | Turn on [debug mode](/development#debugging) for this run, the same as `ATOMIC_DEBUG=1` |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help (loads extensions, including `-e`, so extension CLI flags appear) |
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
atomic install <source> [-l|--local] [-a|-na]     # Install package (-l/--local for project-local)
atomic remove <source> [-l|--local] [-a|-na]      # Remove package
atomic uninstall <source> [-l|--local] [-a|-na]   # Alias for remove
atomic update [source|self|atomic] [-a|-na]       # Update Atomic only, or one package source
atomic update --all                               # Update Atomic and packages; reconcile pinned git refs
atomic update --extensions                        # Update packages only; reconcile pinned git refs
atomic update --models                            # Force-refresh authenticated provider model catalogs (15s timeout)
atomic update --self                              # Update Atomic only
atomic update --force                             # Reinstall Atomic even if the current version is latest
atomic update --extension <src>                   # Update one package (can be passed only once)
atomic list [-a|-na]                              # List installed packages
atomic config [-l|--local] [-a|-na]               # Open resource TUI (-l/--local starts in project settings)
```

These commands manage Atomic packages, and `atomic update` updates the Atomic CLI installation. To uninstall Atomic itself, see [Uninstall](/getting-started/installation#uninstall).

- **Project trust:** All package commands (including `atomic update`, `atomic list`, and `atomic config`) resolve project trust and accept `--approve` (`-a`) and `--no-approve` (`-na`). On an interactive TTY in an untrusted project with local trust inputs, they prompt for project trust. `atomic config -l`, `atomic install <src> -l`, and `atomic remove <src> -l` exit `1` in untrusted projects unless `--approve` is passed or the project is already trusted.
- **Update targets and constraints:**
  - Running bare `atomic update` updates Atomic only and prints a note that extensions were skipped (`Run atomic update --extensions to update extensions`).
  - Passing both `--self` and `--extensions` behaves like `--all`.
  - `--all` and `--models` cannot be combined with other update targets or a positional source, and `--extension` can be passed only once.
  - On Windows, built-in self-update supports only `npm` and `pnpm` installs; other install methods exit `1` unless [`ATOMIC_SELF_UPDATE_COMMAND` or global `selfUpdateCommand`](#custom-update-command) is configured.
- **Intercom broker upgrade:** After updating the Atomic CLI, `atomic update` runs the new version's [`atomic intercom upgrade`](#intercom-commands) when `atomic` on `PATH` reports the installed version and lists that command. Otherwise it prints a note and leaves the broker alone. A failed broker upgrade prints a warning and keeps exit code `0`. If you upgrade Atomic in place while a session is running and see a restart notice, restart that session (for example with `atomic -r`).
- **Model catalog refresh (`atomic update --models`):** Refreshes configured provider catalogs (15-second total timeout) without updating packages. Built-in catalogs do not refresh your provider login. Account-specific catalogs still need valid credentials; if an OAuth refresh fails, the command warns with `atomic auth login <provider>` and continues refreshing other catalogs. Other failures, such as a network error, exit nonzero.

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

Passing `--help` or `-h` to `atomic auth` or any `auth` subcommand (before `--` and not as the value of a value-taking flag), or running bare `atomic auth` / `atomic auth help`, prints auth help to **stderr** and exits `0`. Any unknown subcommand exits `1` and lists all five valid commands. Help never writes to stdout, so raw credential export stdout is always a credential or empty.

### auth login and auth logout

`atomic auth login <provider>` signs in to a provider in an interactive terminal and exits without starting a session. It opens the browser for account sign-in like `/login <provider>`, or prints instructions for another sign-in method when available. Providers without account sign-in prompt for an API key. See [Subscriptions](/providers#subscriptions) and [Credential resolution order](/providers/reference#resolution-order).

`atomic auth login` does not load extensions. For extension-registered providers (including bundled [`llama.cpp`](/llama-cpp)), sign in inside an interactive session with `/login <provider>`.

`<provider>` accepts a provider ID or display name such as `openai` or `OpenAI`. An ambiguous name is rejected with the matching IDs; an exact provider ID always matches. After sign-in, Atomic refreshes that provider's model catalog (15-second timeout; if it fails or is interrupted with `Ctrl+C`, the login stays saved and refreshes on next start). `atomic auth login` exits `1` when run without an interactive terminal, when `--api-key` is passed for an OAuth-only provider, or when the provider uses ambient credentials configured outside Atomic (such as Bedrock or Vertex).

| Option | Description |
| --- | --- |
| `--api-key` | Save an API key instead of signing in with an account; input is not echoed |
| `--no-browser` | Skip opening a browser and use another sign-in method such as a device code, for example over SSH. Prompts if several methods exist. Cannot be combined with `--api-key` |

`atomic auth logout <provider>` removes credentials saved by `atomic auth login` or `/login` while leaving environment variables and `models.json` unchanged. For built-in or `models.json` providers, it exits `0` even when nothing is stored. Extensions are not loaded; remove an extension provider's credentials by its provider ID (once none remain stored, that ID exits `1` as an unknown provider).

### auth check

`atomic auth check` verifies the effective credential for a provider or model before starting a session ([Verify readiness before a session](/providers#verify-readiness-before-a-session)). Pass at least one of `--provider` or `--model`. It prints `ready`, `not_ready`, or `invalid` to stdout and exits `0`, `1`, or `2`. By default, checks never print credential material.

**`--json` output schema:**

| Status | JSON fields |
| --- | --- |
| `ready` | `{"status": "ready", "provider": "<id>", "authType": "api_key" \| "oauth"}` (adds `"credentials": "<value>"` only when `--credentials` is passed) |
| `not_ready` | `{"status": "not_ready", "provider": "<id>", "reason": "<reason>"}` |
| `invalid` | `{"status": "invalid", "provider": "<id>", "reason": "invalid_state"}` (`provider` is omitted if resolution failed before identifying a provider) |

Valid `reason` values:

- `provider_not_found`: The requested provider is not registered.
- `credentials_not_configured`: No stored, environment, or config credential exists for the provider.
- `credential_expired`: A stored OAuth token is expired and `--no-refresh` was passed.
- `credential_not_available`: OAuth refresh or token derivation failed.
- `invalid_state`: Malformed `auth.json`, broken `models.json`, fuzzy model export rejection, or invalid CLI arguments.

**Exporting credentials and read-only checks:**

- `--credentials` opts in to exporting the resolved credential. It requires `--provider` or an exact `--model` target: a fuzzy model match on a ready provider returns `invalid` (exit `2`), while on a non-ready provider it stays `not_ready` (exit `1`). On a ready check, plain stdout contains only the credential and `--json` adds the `credentials` field. On a non-ready check, plain stdout stays empty while stderr reports the status, and `--json` omits `credentials`.
- Checks refresh expired OAuth credentials by default through Atomic's locked `auth.json` update path. Pass `--no-refresh` for a read-only check that never creates, locks, or modifies `auth.json` (still resolving primary/legacy paths and `!command` API keys, while treating malformed `auth.json` as `invalid`). OAuth credential exports require at least 30 minutes of remaining lifetime; normal mode can refresh, while `--no-refresh` refuses shorter-lived tokens.

### auth print-api-key and auth print-bearer-token

The credential print commands emit one configured credential for an external client such as a proxy or script. The credential goes to **stdout and nothing else**; warnings, refresh notices, and help go to stderr, so `KEY=$(atomic auth print-api-key --model gpt-5.5)` never captures diagnostics.

- `--model` is required for both commands. Pass `--provider` when several configured providers offer the same model. Any flag outside `--provider` and `--model` (plus `--min-expiry` on `print-bearer-token`) is a usage error rather than an ignored flag.
- `print-bearer-token` works only on OAuth providers and `print-api-key` only on API-key providers; requesting the wrong kind fails instead of falling back. When `--provider` is explicitly specified, requesting the wrong credential kind exits `4`; without `--provider`, it exits `2`.
- When `--model` matches several eligible providers without `--provider`, Atomic resolves each candidate before detecting ambiguity, so an OAuth candidate may refresh and persist a rotated token before exiting `3`. Pass `--provider` when you want to avoid probing unrelated providers.
- A bearer token with less than `--min-expiry` remaining (default `30m`, accepting `ms`, `s`, `m`, or `h`) is refreshed first. Both `--min-expiry 30m` and `--min-expiry=30m` work. Passing `--min-expiry` to `print-api-key` is a usage error, even after `--`.

### Credential exit codes

**`print-api-key`, `print-bearer-token`, and `--credentials` writes:**

| Exit | Meaning |
| --- | --- |
| `0` | Credential written to stdout with one trailing newline |
| `1` | Usage error |
| `2` | No usable credential configured for that model or provider (including wrong kind when `--provider` is omitted) |
| `3` | Several configured providers match; pass `--provider` |
| `4` | That credential kind is unsupported for the explicitly specified `--provider` |
| `5` | OAuth refresh failed before local persistence (stored credentials change only if the provider completes that refresh later) |
| `6` | The provider cannot mint a token that lives as long as `--min-expiry` |
| `7` | The provider's OAuth credential could not be used; stored state is not guaranteed unchanged |
| `8` | The credential could not be written; nothing was emitted |
| `9` | Only part of the credential was written; discard the output |

**`atomic auth check`:**

| Exit | Meaning |
| --- | --- |
| `0` | `ready` |
| `1` | `not_ready`, including a fuzzy `--model` with `--credentials` when its resolved provider is not ready |
| `2` | `invalid`, including check usage errors or a fuzzy `--model` with `--credentials` when its resolved provider is otherwise ready |
| `8` | With `--credentials`, the credential could not be written; nothing was emitted |
| `9` | With `--credentials`, only part of the credential was written; discard the output |

<Warning>
**Exit code `9` (partial credential output):** Raw credential exports leave stdout empty on every nonzero exit *except* exit `9`. Exit `9` means the output stream failed partway through writing the secret—always discard stdout when a command exits `9`. Once the full credential reaches stdout, the exit code stays `0` even if draining fails later, with a diagnostic on stderr.
</Warning>

`auth check --credentials --json` may write a credential-free JSON status object on a nonzero check result. Review [Credential export security](/security#credential-export) before wiring credential export into scripts.

## MCP commands

```bash
atomic mcp add <server> [options] [--] <command> [args...]
atomic mcp add <server> [options] --url <url>
atomic mcp remove <server> [-l|--local]
atomic mcp list [--json]
atomic mcp login <server> [-l|--local] [--timeout <seconds>]
atomic mcp logout <server> [-l|--local]
```

Configure and check MCP servers and sign in to OAuth servers without starting a session. These commands read `~/.atomic/agent/mcp.json` and, in trusted projects, `.atomic/mcp.json`, without loading extensions. `atomic mcp` commands have no `--approve` flag; in an untrusted project, `.atomic/mcp.json` is ignored with a note advising you to start `atomic` in the project to trust it.

| Command | Description |
| --- | --- |
| `add <server>` | Add or replace a server entry in `mcp.json`. `--` before `<command>` is optional (option parsing stops after `<server>` and `<command>`, forwarding later flags to the command). Mixing `--url` with a stdio command, or mixing HTTP-only and stdio-only options, exits `1` |
| `remove <server>` | Remove a server entry from `mcp.json` |
| `list` | Connect to enabled servers and print state, tools, and errors (exits `1` on config or connection failure) |
| `login <server>` | Sign in to an OAuth HTTP server through the browser (or paste the final redirect URL in an interactive terminal when the browser cannot reach the local callback port). Refuses servers backed by `auth.provider` (use `atomic auth login <provider>` instead) and rejects `-l`/`--local` if the server is defined globally |
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
atomic storage join <postgres-url> --password-file <path>|--token-file <path>|--auth azure|aws|gcp [--prefix <prefix>]
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

### Storage commands

- **`atomic storage status [--json]`:** Reports the selected storage for sessions and Intercom, where each selection came from (environment variable, project settings, global settings, or default), any outranked selections, whether each adapter loads, and whether each database answers `SELECT 1`. Also shows the running Intercom broker, its multi-node state, and peer brokers live in the shared database. Modifies nothing and exits `1` if a selection is invalid, an adapter fails to load, or a database does not answer.
- **`atomic storage join <postgres-url> ...`:** Verifies the credential and connection (`SELECT 1` with a 15-second timeout) using `@bastani/atomic-storage-postgres` (for `postgres://` or `postgresql://` URLs), writes only the global `storage` setting, and reports any environment variables or settings that override it. Creates no tables and prints the install command if the adapter package is missing. Pass exactly one of `--password-file` (copied to a mode `600` `storage-token.<id>` file), `--token-file` (referenced in place and re-read on every new connection), or `--auth azure|aws|gcp`. Passwords in the URL are rejected.
- **`atomic storage migrate ...`:** Creates or upgrades session and Intercom tables in the selected shared database (or `--db`). Run it as the database owner after joining or upgrading Atomic so runtime roles do not need schema-creation privileges (DDL).
  - `--password-file`, `--token-file`, `--auth`, and `--prefix` are rejected unless `--db` is also passed.
  - When no shared adapter storage is configured (or local SQLite/JSONL is selected), `migrate` exits `0` with a no-op message.
  - On PostgreSQL (when no explicit `schema` option is set), `migrate` moves legacy tables from `public` into schema `atomic` (older Atomic processes still using `public` are refused until upgraded), rebuilds the worktree snapshot-links index concurrently without blocking writes (6-hour statement timeout), creates lazy fork/chat/Intercom tables, tunes autovacuum and `lz4` compression, warns if `pg_trgm` is unavailable, and **exits `1`** if stray Atomic tables are found in `public` after the move.
- **`atomic storage move-snapshot-chunks <sqlite-file> [--prefix <prefix>]`:** Migrates the snapshot chunk table in a closed local SQLite file using exclusive access, checkpointing after each batch so the write-ahead log does not need space for the entire copy.
- **`atomic storage search-session <sqlite-file> <session-id> <pattern> [cursor]`:** Searches entries of a stored session in an existing local SQLite database by regex pattern. Rejects `:memory:` and URLs, restricts `<session-id>` to ASCII letters, digits, `-`, and `_`, accepts a numeric entry cursor (`seq`, `seq.match`, or `seq.match.line`), and fails if the session changes during the search. See [Recalling earlier work](/sessions#recalling-earlier-work).
- **`atomic storage export <dir>` and `atomic storage import <dir>`:** Export writes sessions to `<dir>/sessions/<sessionId>.jsonl` (compatible with `atomic --import`), skipping identical files and deleting nothing; `--limit <n>` requires a positive integer (`>= 1`) and exports the `n` most recently modified sessions, while `--since <time>` requires a parseable date or timestamp (such as `2026-11-01` or `2026-11-01T09:30:00Z`). Import validates every file in `<dir>/sessions` before writing, then adds new sessions and newer entries for existing sessions; partial failures list what was and was not written so you can rerun safely.
  - `--sessions` is an optional no-op compatibility flag (both commands always transfer sessions).
  - **Both** `export` and `import` refuse in-memory storage, and **both** refuse a selected shared PostgreSQL database unless you explicitly target it with `--storage <json>` or `--storage-file <path>`.

<Note>
**libSQL removal:** Atomic no longer supports libSQL (`libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:` URLs in `storage join`). Passing a libSQL URL or running the retired `atomic team join` / `atomic team leave` commands exits `1`. See [Moving off libSQL](/storage#moving-off-libsql).
</Note>

### Team status

`atomic team status [--json]` prints the active profile (`individual`, `team`, `ci`, or `custom`), project Intercom group, and the full storage status report. See [Team and CI setup](/guides/team-setup).

### Intercom commands

- **`atomic intercom status`:** Shows this machine's Intercom broker status and multi-node routing state.
- **`atomic intercom restart`:** Stops the running broker, waits for it to exit, and waits for a reconnecting session to start a new broker. Without connected sessions, the next session that uses Intercom starts one.
- **`atomic intercom upgrade`:** Replaces an older Atomic version's broker when safe. With no connected sessions, it stops the broker so the next session starts the new version. With connected sessions, it leaves the broker running so the next session of this version hands it over smoothly. Exits `1` only if stopping the broker fails. Installers and `atomic update` run it automatically. See [Upgrading Atomic with sessions running](/intercom/operations#upgrading-atomic-with-sessions-running).

See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) and [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

## Blueprint commands

```bash
atomic blueprint cache-key [dir] [--format text|json|github-output]  # Cache keys and paths for a runner's cache action
atomic blueprint prebuild [dir] [--park] [--approve|-a]              # Build the repository ahead of time
```

`atomic blueprint cache-key` prints cache entries for the repository at `dir` (default: current directory). It reports `stores` (lockfile-detected package stores for npm, pnpm, Yarn, Bun, Cargo, uv, pip, Poetry, Go, Gradle, and Maven, plus [`resume.cache`](/settings#resume) store paths), `build` (`resume.cache` build paths and seed manifest), `git` (Atomic's Git object store), and `atomic` (extension transpile cache).

Each entry includes a key, restore prefix, and paths. `--format github-output` (or `--format=github-output`) outputs `<name>-key`, `<name>-restore-prefix`, and `<name>-paths` lines for `$GITHUB_OUTPUT`. Paths that might hold credentials are omitted with a stderr warning. Exits `2` on usage errors and `1` when cache keys cannot be computed. See [Caches for runners](/guides/resume-on-any-machine#caches-for-runners).

`atomic blueprint prebuild` restores the committed `HEAD` of `dir` (only committed files; untracked or ignored files such as `.env` are not copied) into a new restored worktree, runs its `initialize` and `maintenance` blueprints, and leaves the worktree idle for the next resume to claim. `--park` moves `"build"` paths from `resume.cache` into the seed directory saved by the `build` cache entry.

Because `prebuild` executes project code, the project must be trusted or `--approve` (`-a`) must be passed (`--no-approve` / `-na` is not accepted). It prints restore and step timings on stderr, exits `2` on usage errors, and exits `1` if the project is untrusted, the checkout has no remote or has uncommitted changes to tracked files, or a step fails (keeping earlier worktrees and seeds). See [Prebuilt worktrees](/guides/resume-on-any-machine#prebuilt-worktrees).

## Environment variables

See [Environment variables](/environment-variables) for the complete registry, exact boolean parsing rules, legacy `PI_*` aliases, color controls, and diagnostic knobs. Key CLI variables:

- **Config & storage:** `ATOMIC_CODING_AGENT_DIR`, `ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, `ATOMIC_PACKAGE_DIR`.
- **Network & updates:** `ATOMIC_OFFLINE`, `ATOMIC_SKIP_VERSION_CHECK`, `ATOMIC_SELF_UPDATE_COMMAND` ([Custom update command](#custom-update-command)), `ATOMIC_TELEMETRY`, `ATOMIC_CACHE_RETENTION` ([Prompt-cache retention](/environment-variables#prompt-cache-retention)).
- **Interactive & shell:** `NO_COLOR`, `FORCE_COLOR`, `ATOMIC_REDUCED_MOTION`, `ATOMIC_DEBUG`, `ATOMIC_NO_PTY`, `ATOMIC_STDIN_TIMEOUT_MS`, `VISUAL` / `EDITOR`, `AI_AGENT` (set to `atomic` on Atomic and its child processes).

Every `bash` and `powershell` tool call receives an execution-time snapshot of the active session (captured when the command runs, so resumed sessions, subagents, and model changes stay accurate). See [Background tasks reference](/background-tasks/reference) for observation wait limits.

| Atomic variable | Legacy alias | Value |
| --- | --- | --- |
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active model provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Atomic clears those eight names plus the two retired session-file names before setting the current snapshot; see [Bash and PowerShell session environment](/environment-variables#bash-and-powershell-session-environment).
