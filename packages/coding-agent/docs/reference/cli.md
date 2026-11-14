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

These commands manage Atomic packages and `atomic update` can update the Atomic CLI installation. To uninstall Atomic itself, see [Quickstart](/getting-started/installation#uninstall). `atomic config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `atomic update` never prompts for project trust. After it updates the Atomic CLI, `atomic update` runs the new version's [`atomic intercom upgrade`](#storage-and-intercom-commands) when the `atomic` on PATH reports the version just installed and lists the command; otherwise it prints a note and leaves the broker alone. A failure of the upgrade prints a warning and does not change the exit code.

`atomic update --models` refreshes configured providers without updating packages. Built-in catalogs served by pi.dev do not refresh your provider login. Account-specific catalogs still need valid credentials; if an OAuth refresh fails, the command warns with `atomic auth login <provider>` and continues refreshing other catalogs. Other failures, such as a catalog network error, still make the command exit nonzero.

See [Atomic Packages](/packages) for package sources and security notes.

### Custom update command

If a wrapper or another package manager provides Atomic, set `ATOMIC_SELF_UPDATE_COMMAND` so `atomic update` runs its update command:

```sh
export ATOMIC_SELF_UPDATE_COMMAND="mise use -g npm:{packageName}@{version}"
```

`atomic update` runs it only when a newer release exists, replacing `{packageName}`, `{version}`, and `{installSpec}` (`{packageName}@{version}`) with that release. It replaces install-method detection, so it also works for installs Atomic cannot update itself. The value is split on spaces; `PI_SELF_UPDATE_COMMAND` is accepted as an alias. For arguments with spaces, use the `selfUpdateCommand` setting in `~/.atomic/agent/settings.json` instead, an argv array such as `["nix", "profile", "upgrade", "atomic"]`. Project settings are ignored for it.

Afterwards Atomic reports the version it finds installed: the one on disk, or what `atomic --version` prints on `PATH`. A wrapper that installs each version into a new directory therefore still reports success, and a command that exits `0` without installing the new version prints a warning instead.

## Credential Commands

```bash
atomic auth login <provider> [--api-key] [--no-browser]
atomic auth logout <provider>
atomic auth check [--provider <p>] [--model <model>] [--json] [--credentials] [--no-refresh]
atomic auth print-api-key --model <model> [--provider <p>]
atomic auth print-bearer-token --model <model> [--provider <p>] [--min-expiry <dur>]
```

`atomic auth login <provider>` signs in to a provider in the terminal and exits, without starting a session. It signs in with an account and opens the browser, like `/login <provider>`; when the provider offers another sign-in method, it prints how to use it instead. Providers without account sign-in ask for an API key. `<provider>` is a provider ID or display name, such as `openai` or `OpenAI`. A name that matches more than one provider, such as a `models.json` provider named like a built-in one, is rejected with the matching provider IDs; the exact provider ID always selects that provider. After signing in, it refreshes that provider's model catalog; if the refresh fails, times out after 15 seconds, or you press Ctrl+C, the login is kept and the catalog refreshes on the next start. It requires an interactive terminal.

| Option | Description |
|---|---|
| `--api-key` | Save an API key instead of signing in with an account; the key is read without echoing it |
| `--no-browser` | Do not open a browser; use the provider's other sign-in method, such as a device code, for example over SSH. Asks when there are several. Not allowed with `--api-key` |

`atomic auth logout <provider>` removes the credentials that `atomic auth login` or `/login` stored, like `/logout`, and takes `<provider>` the same way. Environment variables and `models.json` config are unchanged. For a built-in or `models.json` provider it exits with status `0` when nothing is stored, so it is safe to repeat. Extensions are not loaded, so an extension provider's credentials are removed by its provider ID; once none are stored, that ID is reported as an unknown provider with exit status `1`, like a mistyped name.

`atomic auth check` verifies the effective credential a provider or model would use before a session starts. It requires at least one of `--provider` or `--model`, prints `ready`, `not_ready`, or `invalid` to stdout, and exits `0`, `1`, or `2` for those states. `--json` adds the resolved provider when one is found, credential kind, and any reason. By default, a check never emits credential material.

`--credentials` is an explicit export opt-in. It requires `--provider` or an exact `--model` target; a fuzzy model match on an otherwise-ready provider is refused as `invalid` (exit `2`) rather than exporting a credential for a provider you did not name. If that provider is not ready, the check remains `not_ready` (exit `1`). On a ready check, plain stdout becomes the resolved credential alone and JSON adds it only in the `credentials` field. A non-ready raw export leaves stdout empty and reports its status on stderr; a JSON export returns the status object without a credential. Credential writes can also exit `8` (nothing written) or `9` (only a fragment written). Treat the stream like `print-api-key` or `print-bearer-token` output.

Checks refresh expired OAuth credentials by default, using Atomic's normal locked `auth.json` update path. Pass `--no-refresh` to read credentials without creating, locking, or mutating `auth.json`; this is useful when a probe must not change stored auth state. It still reads Atomic's primary and legacy credential paths and resolves configured API-key values, including `!command`, through the normal provider configuration. In this read-only mode, malformed `auth.json` is `invalid` (exit `2`) rather than an unavailable credential. An OAuth credential export requires at least 30 minutes of life: the normal path can refresh it, while `--no-refresh` refuses a shorter-lived token.

The credential print commands print one configured credential for an external client — a proxy, a script, or another tool that needs the same key Atomic already holds. The credential goes to **stdout and nothing else**; warnings, provider selection, refresh notices, and help all go to stderr, so `KEY=$(atomic auth print-api-key --model gpt-5.5)` can never capture a diagnostic.

`--model` is required for the two `print-*` exports. An exporting auth check needs `--provider` or an exact `--model` target. When several configured providers offer a model, pass `--provider` to choose one. The two `print-*` subcommands accept only `--provider` and `--model`: any other flag — including `--export`, `--session-dir`, `--print`, and `--help` — is a usage error rather than a flag this path happens to ignore.

`atomic auth` on its own — and `atomic auth help`, `--help`, or `-h` — prints this usage on stderr and exits `0`. `atomic auth check --help` (or `-h`) does the same until a `--` terminator; after it, the flag is not help. Any other subcommand exits `1` and names all five valid commands. Help never uses stdout, so raw credential export stdout is a credential or empty; a JSON export writes an object that carries a credential only in its `credentials` field.

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

## Storage and Intercom Commands

```bash
atomic storage status [--json]                                       # Selection, source, adapter and connection per domain
atomic storage join <url> [--token-file <path>] [--prefix <prefix>]  # Use a shared libSQL / Turso database
atomic team join <url> [--token-file <path>] [--prefix <prefix>]     # Share workflow runs and Intercom; sessions stay local
atomic team status [--json]                                          # Profile in effect plus the storage report
atomic team leave                                                    # Remove what team join wrote
atomic storage adopt <path>... [--no-discover]                       # Register existing journal files in place
atomic storage consolidate                                           # Move finished runs of adopted files into the store
atomic storage export <dir> [--sessions] [--workflows] [--run <id>]... [--unfinished] [--limit <n>] [--since <time>]
                                                                     # Write sessions and workflow runs as JSONL files
atomic storage import <dir> [--sessions] [--workflows]               # Restore sessions and workflow runs from them
atomic intercom status                                               # This machine's Intercom broker and multi-node state
atomic intercom restart                                              # Replace the broker so it reads the current selection
atomic intercom upgrade                                              # Replace a broker an older Atomic started, when safe
```

`atomic storage status` reports, for sessions, workflow runs, and Intercom, the selected storage, where the selection comes from (an environment variable, project or global settings, or the default) and the outranked selections, whether the adapter loads, and whether the database answers a `SELECT 1`. It also shows the running Intercom broker: whether it uses the current selection, its multi-node routing state, and the other brokers live in the shared database. It creates and changes nothing, and exits `1` when a selection is invalid, an adapter cannot load, a database does not answer, or the journal store has a shard file that is missing or cannot be opened.

`atomic storage join` checks the token and the connection with `@bastani/atomic-storage-libsql`, stores the trimmed token in a new `storage-token.<id>` file in the agent directory with mode 600, writes only the global `storage` setting, and lists the environment variables and settings that override it. Previous token files are never overwritten; a settings-write failure removes only the new token. It creates no tables. `--token-file` is required except for absolute `file:` URLs; relative file URLs and URLs that contain the token itself (a user name, a password, or an `authToken` parameter) are refused. When the package is not installed, it prints the install command. See [Storage](/storage#joining-a-machine-to-a-shared-database).

`atomic team join` runs the same checks and token handling as `atomic storage join`, then writes the global `storage` setting (the team database) and `sessions.storage` (the local default store) in one update, restarts the Intercom broker, and prints the profile and the `atomic storage status` report. Nothing is written when a check fails. `atomic team status` adds the profile in effect (`individual`, `team`, `ci`, or `custom`) and the current project's Intercom group to that report. `atomic team leave` removes only the values `team join` wrote, deletes their token file unless another setting references it, and restarts the broker. See [Team and CI setup](/guides/team-setup).

`atomic storage adopt` registers journal files in the workflow journal store in place, without copying them, so their runs resolve by ID and resume where they are. Each path is a journal `.sqlite` file or a directory holding `journal.sqlite`; every path is checked before the first is registered. It also adopts the journal files the adopted runs were written to, unless `--no-discover` is given. `atomic storage consolidate` moves finished runs from adopted files into the store's own shards and reports the runs it left in place with the reason, and exits `1`, printing each distinct error's message and hint, when a run was left because of an error (a missing shard file, a different copy in the destination). Both also exit `1` with the error's message and hint when they cannot proceed. See [The workflow journal store](/storage#the-workflow-journal-store).

`atomic storage export` writes sessions to `<dir>/sessions/<sessionId>.jsonl` (format-4 session files, the format `atomic --import` reads) and workflow runs to `<dir>/workflows/<runId>.jsonl`, each written whole through a temporary file; it never deletes files. Both kinds are exported by default, and `--sessions` or `--workflows` limits it to one. `--run`, `--unfinished` and `--limit` select workflow runs; `--limit` also keeps the most recently modified sessions, and `--since <time>` keeps sessions modified at or after a date or date and time. `atomic storage import` reads only `<dir>/sessions` and `<dir>/workflows`, checks every file of both kinds before it writes anything, then adds new sessions and runs and the later entries of ones this machine has an earlier part of; importing again changes nothing. Both exit `1` with the file and line when they cannot proceed. An import that fails after writing part of its files exits `1` and lists what it imported and what it did not; running it again finishes it. A kind kept in a shared libSQL or Turso database is refused, or skipped with a note when neither `--sessions` nor `--workflows` was given. See [Exporting and importing sessions and workflow runs](/storage#exporting-and-importing-sessions-and-workflow-runs).

The help text:

```text
  export   Write sessions to <dir>/sessions/<sessionId>.jsonl (session format version
           4, the format `atomic --import` reads) and workflow runs to
           <dir>/workflows/<runId>.jsonl (workflow run export version 1), one file per
           session or run. Both kinds by default; --sessions or --workflows limits it to one. Each
           file is replaced whole, one that already holds the same bytes is not rewritten, and no
           file is deleted. A kind kept in a shared libSQL / Turso database is skipped (an error
           when --sessions or --workflows asks for it): every machine joined to it reads it already.
  import   Restore the sessions in <dir>/sessions and the workflow runs in <dir>/workflows into
           this directory's storage; other files are ignored. Every file of both kinds is checked
           first, so a malformed or unsupported file changes nothing. Importing again adds
           nothing; a newer export of a session or run adds its later entries. Imported runs are
           not owned by any process: an interrupted one can be resumed here. If the import fails
           after writing part of it, it names what was and was not written; run it again to finish.

  --sessions            export, import: sessions only (with --workflows too: both)
  --workflows           export, import: workflow runs only (with --sessions too: both)
  --run <id>            export: only this workflow run; repeat for more
  --unfinished          export: only workflow runs that are not completed, failed or cancelled
  --limit <n>           export: at most n workflow runs, newest first, and at most n sessions,
                        most recently modified first
  --since <time>        export: only sessions modified at or after <time>, a date such as
                        2026-11-01 or a date and time such as 2026-11-01T09:30:00Z
```

`atomic intercom restart` asks the broker to shut down (an older broker gets SIGTERM), waits for it to exit, and then for a reconnecting session to start a new broker, whose state it prints. Without connected sessions, the next session that uses Intercom starts one.

`atomic intercom upgrade` replaces a broker that an older Atomic started, when that is safe. With no session connected it stops the broker, and the next session starts this version's. With sessions connected it leaves the broker running, and the next session of this version hands it over without disconnecting them for longer than a reconnect. It does nothing when no broker runs or the broker is already this version's, leaves a broker too old to report its sessions running, and exits `1` only when stopping the broker fails. The installers and `atomic update` run it after a successful install when the installed version has the command, without passing it any input. See [Upgrading Atomic with sessions running](/intercom/operations#upgrading-atomic-with-sessions-running).

See [Joining a machine to a shared database](/storage#joining-a-machine-to-a-shared-database) and [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

## Worker Commands

```bash
atomic worker start [--db <url>] [--token-file <path>] [--prefix <prefix>] [--slots <n>]
                    [--label <key=value>]... [--host-id <id>] [--no-restore] [--idle-exit <ms>] [--json]
atomic worker status [--db <url>] [--token-file <path>] [--prefix <prefix>] [--json]
atomic worker controller --provisioner <module> [--db <url>] [--token-file <path>] [--prefix <prefix>]
                    [--min-hosts <n>] [--max-hosts <n>] [--workers-per-host <n>] [--scale-up-queue-depth <n>]
                    [--scale-up-delay <ms>] [--idle-drain <ms>] [--boot-timeout <ms>] [--json]
```

`atomic worker start` runs this machine as a worker host of a shared workflow database. It runs the pooled children of every root that started with shared placement on that database, at most `--slots` at once. `--db` names a libSQL or Turso database (`libsql://`, `https://`, `wss://`, or an absolute `file:` URL) for this process only and writes nothing to settings. Without `--db`, it uses the journal this machine already selects, for example after `atomic team join`. `--token-file` names the file that holds the database token. Only the file's path is passed on: the token is never printed, logged, or put on a child process's command line. A token file that other users can read gets a warning. URLs that carry the token themselves are refused. `--slots` defaults to half the CPUs, from 1 to 16. `--label` adds a label that `atomic worker status` shows, and can be repeated. `--host-id` sets the host's id; by default the machine keeps one in its agent directory. `--no-restore` takes only work whose repository tree is already on this machine. `--idle-exit <ms>` drains and exits once no child has run for that long.

It prints one line per event: `ready host=… slots=… journal=…`, `claimed child=… root=… attempt=…`, `released …` when a child finished or went back to the queue, `degraded failures=… retry_in_ms=… error=…` when a poll of the database failed, `recovered failures=…`, `idle-exit`, `drain-requested` when a fleet controller asked it to drain, `draining`, `stopping`, and `drained` or `stopped`. `--json` prints the same events as one JSON object per line, each with `event` and `time`.

SIGTERM or SIGINT drains the host: it takes no more children, lets the running ones finish, and exits `0`. A second signal stops the host at once. The children it held go back to the queue for other hosts, and the command exits `2`. It exits `1` when setup is incomplete (it lists every missing piece, such as the adapter, the token file, or process containment) or when the host fails. If the database becomes unreachable, the host keeps its running children, prints `degraded`, and polls again after 1 second, then twice as long after each further failure, up to 30 seconds.

`atomic worker status` lists the worker hosts registered in the database, with their workers, labels, and when each last reported, and the queue of each running root they serve. See [Running workers on many machines](/guides/worker-hosts).

`atomic worker controller` runs a fleet controller on the database: it adds worker hosts through the provisioner that `--provisioner` names when the queues of the database's shared roots grow, and drains and removes hosts that held no child for `--idle-drain` milliseconds. The module's default export is a provisioner, or a function that returns one. The policy options default to 0 minimum hosts, 10 maximum hosts, 4 workers per host, a queue depth of `--workers-per-host`, a 20000 ms scale-up delay, a 300000 ms idle drain, and a 600000 ms boot timeout. Several controllers can run on one database; one is active at a time and another takes over within 30 seconds when it stops. It prints `controller holder=… journal=…` and then `active`, `standby`, `scale-up target=… desired=… live=…`, `drain-requested id=… host=…`, `removed id=… reason=…`, `degraded …` and `recovered …` lines. SIGTERM or SIGINT stops it and exits `0`; a setup error exits `1`. See [Scale the fleet automatically](/guides/worker-hosts#scale-the-fleet-automatically).

## Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode (fullscreen TUI) |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](/json) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](/rpc) |
| `--export <in> [out]` | Export a session to HTML |

Interactive sessions use fullscreen, with a scrolling transcript above the docked editor and status area. Wheel and trackpad input goes to a focused workflow graph or stage chat first, then the transcript when not consumed. Scrolling, scrollbar dragging, and selection remain available outside overlays.

Adjust **Fullscreen wheel scroll lines** in `/settings`, or set `fullscreenWheelScrollLines` to `"auto"` or a number from 1 to 100. This also applies to fullscreen tool detail views, attached workflow chats, and `/tasks` transcripts.

Selection copies automatically unless `fullscreenCopyOnSelect` is false. Ctrl+X returns tool detail or stage chat to the graph, returns the graph to main chat, or clears a scoped-model selection. It does not copy; `/copy` copies the last assistant message.

On exit, `fullscreenExitOutput: "transcript"` prints the final transcript and resume hint. `"resume-hint"` restores the previous screen and prints only the hint. See [Settings](/settings) and [Terminal setup](/terminal-setup).

In print mode, Atomic also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | atomic -p "Summarize this text"
```

Atomic waits for piped input to end, however slowly it arrives once it has started. A pipe that sends nothing at all, not even its end, is a different case: a script, an agent's shell tool, or another program often starts Atomic with stdin open and never writes to it. If nothing arrives on such a pipe within 2 seconds, a run with a prompt argument (or `@file`) starts without stdin. If input arrives after that, Atomic warns that it was ignored. A run with no prompt argument keeps waiting for stdin, and says so on stderr. Set `ATOMIC_STDIN_TIMEOUT_MS` to change the wait, or to `0` to always wait for the end of piped input.

When a print-mode turn correctly finishes by calling an opt-in terminating structured-output tool created with `createStructuredOutputTool` (for example from an extension, SDK caller, or workflow item with a schema), Atomic ends after that tool result without an extra follow-up assistant turn. Print-mode stdout contains the terminating structured JSON payload, so `atomic -p` remains script-friendly while the same value is also available through the SDK `capture` sink, tool `details`, a configured file sink, or workflow `result.structured`. This also works for custom factory names such as `final_decision`. Non-terminating or unrelated tool results are not printed as the final response.

## Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider to search for `--model`, such as `anthropic`, `openai`, or `google`; requires `--model` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>`. If several providers match, Atomic prefers the one with credentials; otherwise it asks for `--provider` |
| `--api-key <key>` | API key, overriding environment variables. It does not choose between providers that offer the same model |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; model capability mapping still governs availability |
| `--models <patterns>` | Comma-separated patterns for CTRL+P cycling. A model offered by several providers is added for each, with a warning |
| `--fallback-models <models>` | Comma-separated `provider/model[:thinking]` IDs this run may fall back to, in order, after a failure the [`fallbackModels`](/settings#fallbackmodels) setting would fall back on. Replaces that setting for this run |
| `--no-fallback` | Never fall back to another model in this run. Cannot be combined with `--fallback-models` |
| `--list-models [search]` | List available models |

A model named with `--model` runs as named. It falls back only to the models `--fallback-models` names, never to the `fallbackModels` setting, user or project. In an interactive session this holds for the whole process: after you switch models with `/model` or Ctrl+P, and in sessions you start with `/new` or `/resume`, the session still uses only `--fallback-models`. Start Atomic without `--model` to use the setting. Child sessions that run on the main session's model, such as a subagent that names no model, inherit the same chain. In print mode, a fallback prints `Model fallback: <model> failed, continuing on <fallback>: <reason>` to stderr. If the run's answer came from the fallback, it ends with `Model: ran on <fallback>, not the requested <model>.` A run that fails prints `Model <model> failed: <reason>`.

## Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session for the current directory |
| `-r`, `--resume` | Browse and select a session |
| `--session <id\|prefix>` | Use an exact ID or unique 8-hex UUID prefix, and run it in its working directory. If it only matches a session from another directory, Atomic offers to fork it into the current directory |
| `--import <file>` | Import a format-4 JSONL export into session storage |
| `--session-id <id>` | Use an exact project session ID; warn and create it when missing |
| `--fork <id\|prefix>` | Fork an exact ID or unique 8-hex UUID prefix into a new session in the current directory |
| `--session-dir <dir>` | Custom session storage directory |
| `--session-store <path>` | Select a SQLite session database; relative paths resolve from the working directory |
| `--session-prefix <prefix>` | Use a non-default table prefix with `--session-store` |
| `--name <name>`, `-n <name>` | Set the session display name |
| `--no-session` | No resumable session; [released history may use disk](/sessions) |
| `--storage <json>` | Select storage for this process's sessions and workflow runs, in the same JSON form as the shared `storage` setting; never saved. See [Selecting storage per process](/storage#selecting-storage-per-process) |
| `--storage-file <path>` | Read the `--storage` selection from a JSON file; cannot be combined with `--storage` |

See [Choosing a store](/sessions#choosing-a-store) for precedence, prefix rules, and conflicts.

## Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist tool names or `*` patterns, or modify defaults with only `+name`/`-name` entries; an allowlist keeps MCP tools unless an entry starts with `mcp__` |
| `--exclude-tools <list>`, `-xt <list>` | Exclude tool names or `*` patterns, including MCP tools and Intercom |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable every tool, including Intercom, even with `--tools` |

Default built-in tools: `read`, `bash`, `kill`, `edit`, `write`, `find`, `search`, `ask_user_question`, `todo`, plus `powershell` on native Windows when a PowerShell executable is available. `ls` remains available but is not a default. `defaultTools` selects initial coding tools without narrowing extension/custom tools. `--tools` selects an explicit allowlist; `--exclude-tools` subtracts from it. `--no-builtin-tools` suppresses coding defaults when no allowlist is given. The bundled Intercom extension remains loaded with `--no-extensions`, but its tool follows the allowlist, exclusions, and `--no-tools` like other extension tools.

To add opt-in [codemode](/tools#codemode) or [tool search](/tools#tool_search) alongside defaults, use `atomic --tools +codemode,+tool_search` for one invocation, or `"defaultTools": ["+codemode", "+tool_search"]` in settings. `atomic --tools +codemode,-write` keeps the other defaults and disables `write`. Modifier entries take exact names, not `*` patterns, and cannot be mixed with plain allowlist entries. Use `--exclude-tools` for pattern exclusions. On `/reload`, modifiers apply to the reloaded `defaultTools` setting too, so tools removed with `-name` stay removed. Modifiers do not narrow extension/custom tools or filter MCP exposure; `--no-tools` still disables every tool.

### MCP tools

`--tools read,codemode` keeps non-hidden MCP tools with codemode or deferred exposure callable from codemode scripts. MCP tools unmatched by the allowlist are not declared directly, regardless of exposure. Unmatched direct-exposure tools remain registered but inactive. Only an enabled `tool_search` can load unmatched tools with non-direct exposure.

An entry starting with `mcp__` filters MCP tools too. For example, `atomic --tools read,codemode,'mcp__docs__*'` keeps only tools from the `docs` server. MCP resource tools also count as MCP tools. Exclusions apply to both server and resource tools. Use `--no-mcp` to disable built-in MCP connections and resources entirely.

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
| `--no-mcp` | Disable built-in MCP support for this run, even when explicitly enabled; replacement extensions are unaffected |
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
| `--debug` | Turn on [debug mode](/development#debugging) for this run, the same as `ATOMIC_DEBUG=1` |
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
| `ATOMIC_STORAGE` | Storage selection JSON for this process's sessions and workflow runs; overridden by `--storage` and the domain variables |
| `ATOMIC_SESSIONS_STORAGE` | Session-only storage selection JSON; cannot be combined with `ATOMIC_CODING_AGENT_SESSION_DIR` |
| `ATOMIC_WORKFLOWS_JOURNAL` | Workflow-run-only storage selection JSON; cannot be combined with `ATOMIC_WORKFLOW_JOURNAL_PATH` |
| `ATOMIC_PROFILE` | `ci`: sessions, workflow runs, and Intercom use the team database from the variables below, without settings. See [Team and CI setup](/guides/team-setup#ci-and-swarms) |
| `ATOMIC_TEAM_URL` | Team database URL for `ATOMIC_PROFILE=ci` |
| `ATOMIC_TEAM_TOKEN` | Team database token for `ATOMIC_PROFILE=ci`; cannot be combined with `ATOMIC_TEAM_TOKEN_FILE` |
| `ATOMIC_TEAM_TOKEN_FILE` | File holding the team database token for `ATOMIC_PROFILE=ci` |
| `ATOMIC_TEAM_PREFIX` | Team table prefix for `ATOMIC_PROFILE=ci` |
| `ATOMIC_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `ATOMIC_REDUCED_MOTION` | Set to `1` to skip startup choreography and render the ordinary working identity as a static regular accent `∀` without a timer |
| `ATOMIC_OFFLINE` | Disable automatic network activity, including update checks, package update checks, install/update telemetry, and model catalog refreshes |
| `ATOMIC_DEBUG` | Set to `1` to turn on [debug mode](/development#debugging), the same as `--debug` (`PI_DEBUG` is a legacy alias) |
| `ATOMIC_SKIP_VERSION_CHECK` | Skip the Atomic version update check at startup. This prevents the latest-version request |
| `ATOMIC_STDIN_TIMEOUT_MS` | How long a print-mode run waits, in milliseconds, for anything on a piped stdin before a run with a prompt argument starts without it; default `2000`, at most `2147483647`, `0` waits for the end of piped input (`PI_STDIN_TIMEOUT_MS` is a legacy alias) |
| `ATOMIC_TELEMETRY` | Override version-adoption pings: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks (`PI_TELEMETRY` is a legacy alias) |
| `NODE_COMPILE_CACHE` | Override the directory for Node's persistent compile cache, which Atomic enables automatically on Node >= 22.8 to speed up startup (most noticeable on Windows). Set `NODE_DISABLE_COMPILE_CACHE=1` to opt out |
| `PI_CACHE_RETENTION` | Prompt-cache retention: `long` (default), `short`, or `none`, subject to provider/model support |
| `ATOMIC_NO_PTY` | Set to `1` to disable PTY use for bash commands (`PI_NO_PTY` is a legacy alias) |
| `VISUAL`, `EDITOR` | External editor for CTRL+G |

Every bash execution receives one execution-time snapshot of the active session. Foreground/background observation controls how long the caller waits, not the command's execution timeout. Omitted `wait` uses the owner's policy, normally yielding after 10 seconds; explicit background observation requires a supported task owner. Without one, foreground execution waits until completion. See [Background tasks](/background-tasks#choose-how-long-to-wait).

| Atomic variable | Exact compatibility alias | Value |
|-----------------|---------------------------|-------|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active model provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

The snapshot is taken when the command executes, not when the tool is created, so resumed sessions, workflow stages, isolated sessions, model changes, and concurrent sessions cannot reuse stale metadata. Atomic preserves all unrelated inherited and caller-supplied environment variables; only the ten names above are cleared and overlaid. Factory-created bash tools expose the same metadata by default and can set `exposeSessionEnvironment: false` to omit it.

`PI_*` aliases are also supported for app-specific `ATOMIC_*` variables for legacy compatibility. For example, [Intercom](/intercom) honors `PI_CODING_AGENT_DIR` when `ATOMIC_CODING_AGENT_DIR` is unset and still reads legacy `~/.pi/agent/intercom/config.json` when the Atomic config is absent. `PI_CACHE_RETENTION` is not one of those aliases and has no `ATOMIC_*` equivalent. Long retention is the default for main chat, workflow stages, and subagents where supported; use `PI_CACHE_RETENTION=short atomic` to opt back into shorter caching. See [Prompt-cache retention](/environment-variables#prompt-cache-retention) for overrides and pricing tradeoffs. Intercom's default broker starter works across Node-based installs, Bun source checkouts, and standalone Atomic binaries without requiring `npx`, `tsx`, or `bun` to be present on `PATH`; custom broker commands remain explicit opt-in overrides.
