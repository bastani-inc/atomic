---
title: "Security and project trust"
sidebarTitle: "Security"
description: "Configure project trust, restrict tools, understand local security boundaries, and safely export credentials."
---

Atomic is a local coding agent. It runs with the permissions of the user account that starts it and treats files writable by that user as inside the same local trust boundary.

## Project trust

Project trust controls whether Atomic loads project-local settings, instructions, resources, packages, and extensions. It is not a sandbox and does not restrict what tools can do once a session starts.

Atomic treats a folder as having trust-gated inputs when it finds any of these from the current working directory:

- Any of these 11 entries inside `.atomic/` or legacy `.pi/` in the current directory: `settings.json`, `extensions`, `skills`, `prompts`, `themes`, `workflows`, `agents`, `mcp.json`, `blueprint.yaml`, `SYSTEM.md`, or `APPEND_SYSTEM.md`. An empty `.atomic/` directory, or one containing only state such as `.atomic/todos`, does not trigger project trust.
- Project instruction files in the current directory or an ancestor directory: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`.
- `.agents/skills` in the current directory or an ancestor directory. `~/.agents/skills` in your home directory is always treated as a trusted user resource and never triggers project trust.
- At the nearest ancestor project root (any ancestor containing `.atomic/`, `.pi/`, or `.agents/`), any `.agents/` directory, `.atomic/agents`, `.pi/agents`, `.atomic/settings.json`, or `.pi/settings.json`. Your home directory is never treated as an ancestor project root for these checks.

Saved decisions live in `~/.atomic/agent/trust.json`, keyed by canonical directory path mapped to `true` or `false`. Atomic checks `trust.json` from the current directory upward and applies the closest saved decision ahead of global defaults. A saved `false` entry for the current folder or an ancestor still marks the folder untrusted even when no trust-gated files are present right now.

On Windows, saved paths match case-insensitively and saving removes duplicate entries with different casing. Atomic writes `trust.json` atomically through a temporary file while holding `trust.json.lock` (waiting up to 5 seconds, or taking over stale locks older than 10 seconds) and follows symlinks to update the target file. If `trust.json` contains malformed JSON or invalid values, Atomic warns once and treats it as empty until the next save. If the file cannot be read because of permissions, saving fails instead of overwriting it.

When no saved decision matches and the folder has trust-gated inputs, Atomic checks global `defaultProjectTrust` in `~/.atomic/agent/settings.json` (`"ask"`, `"always"`, or `"never"`; default `"ask"`). `defaultProjectTrust` is global-only: Atomic ignores it in project `.atomic/settings.json` and falls back to `"ask"` if the global value is invalid or unreadable (printing a warning on read failure).

In an interactive session with `defaultProjectTrust: "ask"`, Atomic opens a trust prompt with five options (four at the filesystem root):

- **Trust**
- **Trust parent folder (`<path>`)**
- **Trust (this session only)**
- **Do not trust**
- **Do not trust (this session only)** (selected by default)

Choosing **Trust parent folder** saves `true` for the parent directory and removes any saved entry for the current directory so it inherits from the parent. Pressing `Escape` cancels the prompt and leaves the folder untrusted for this session only without writing to `trust.json`.

Use the `Up` and `Down` arrow keys to pick an option, then press `Enter`. If you typed or pasted text before or while the prompt opened, `Enter` is disarmed so pressing `Enter` adds a newline to your draft instead of confirming trust by accident. Press `Up` or `Down` once to arm `Enter`, then confirm. Your draft stays in the editor afterward so you can review and send it.

Run `/trust` at any time to save a persistent choice (**Trust**, **Trust parent folder**, or **Do not trust**). Restart Atomic after saving in `/trust` for the new choice to take effect; `/reload` does not re-evaluate a newly saved `/trust` decision. To clear a saved decision completely, remove its path entry from `~/.atomic/agent/trust.json` (or choose **Trust parent folder** to clear a child override).

If you start an interactive session in a clean folder (no trust-gated inputs at startup and neither `--approve` nor `--no-approve`) and create trust-gated files such as `.atomic/settings.json` or `.atomic/extensions` during that session, running `/reload` automatically saves `true` for that folder in `trust.json` when no decision is saved yet.

### What project trust unlocks

Trusting a project lets Atomic load:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic` and legacy `.pi` extensions, skills, prompt templates, themes, and system prompt files (`SYSTEM.md`, `APPEND_SYSTEM.md`)
- Project-local `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`, plus project `.agents/skills`
- Project subagent definitions and agent overrides (`.atomic/agents`, `.pi/agents`, and `.agents`)
- Earlier workflow files for on-demand [conversion to skills](/orchestration/migrating-workflows) (read as text only, never executed, modified, or deleted)
- Project MCP server config ([`.atomic/mcp.json`](/mcp-servers); `auth.provider` is forbidden in project configs and package manifests, and `!command` values run shell commands) and blueprint builds ([`.atomic/blueprint.yaml`](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint))
- Project-configured [packages](/packages) (`atomic install -l` requires project trust or `--approve`), automatic installation of missing project packages, and package-managed extensions

Declining trust skips all of these project inputs. Global instructions, global skills, global settings, and explicit CLI resources remain available. Interactive sessions in an untrusted project display a warning; run `/trust` to save a decision, then restart Atomic.

### Folders, worktrees, non-interactive runs, and extension hooks

- **Per-folder trust:** Trust belongs to the folder a session works in, not the directory you started Atomic from. Resuming a session (`--resume`, `--continue`, `--session`, or `/resume`) applies that folder's trust decision and prompts if none is saved. Session-only choices last until Atomic exits and are never written to `trust.json`.
- **Git worktrees:** A worktree outside its main repository folder has its own trust decision because it can check out different `.atomic` content. Choose **Trust parent folder** (at the prompt or in `/trust`) to trust sibling worktrees under one parent directory.
- **Extension `project_trust` hooks:** Global extensions and explicit CLI `-e` extensions can handle the [`project_trust`](/extensions/events#project_trust) event ahead of `trust.json` and `defaultProjectTrust` (see `project-trust.ts` in [Extension examples](/extensions/examples#events-and-gates)). When such extensions are installed, Atomic waits for them before applying project settings, resources, or a project-configured session store. Handlers run in extension load order: returning `{ trusted: "undecided" }` passes to the next handler, and the first `{ trusted: "yes" }` or `{ trusted: "no" }` wins (and writes to `trust.json` when `remember: true`). If a handler throws an error, Atomic logs a warning and continues to the next handler, or falls back to `trust.json`, `defaultProjectTrust`, and the prompt. Hooks do not run when a folder has no trust-gated inputs or when `--approve` or `--no-approve` overrides trust. Switching to a resumed session in another folder shuts down the previous folder's extensions (waiting up to 5 seconds before continuing) before loading the resumed folder's extensions.
- **Borrowed `-e` sources:** If `-e <dir>` discovers resources from that directory's `.atomic`, legacy `.pi`, or `.agents/skills`, Atomic checks `trust.json` under that source's canonical path (cached for the session) before loading them, because borrowed extensions run with your user permissions. Passing `--approve` (`-a`) or `--no-approve` (`-na`) also overrides trust for borrowed `-e` sources.
- **Non-interactive runs:** Print mode (`-p`), `--mode json`, and `--mode rpc` never open a trust prompt. Without a saved decision, `defaultProjectTrust: "ask"` and `"never"` leave the project untrusted and skip project resources, while `"always"` trusts the project. Pass `--approve` (`-a`) or `--no-approve` (`-na`) to override trust for one run.

## No built-in sandbox

Atomic does not include a built-in sandbox. Built-in tools read, write, and edit files and run shell commands with the permissions of the Atomic process. Extensions run as TypeScript modules with the same permissions.

Use OS isolation, a container, or a VM when you need a security boundary.

Project trust only guards project input loading so a repository cannot change settings or run extensions before you approve it. It does not make untrusted code, prompts, or model output safe. Prompt injection from repository files, comments, docs, context files, or command output is an inherent risk for any local coding agent.

When shell tools are enabled, model-supplied commands run through the configured shell with your user permissions, and Atomic provides no command-level allowlist or denylist. Be careful with shells, interpreters, package managers, `curl`, `git`, `sudo`, `env`, `xargs`, and any other program that can run arbitrary commands.

You can narrow which tools a session exposes:

- **CLI flags:** Pass `--tools` (`-t`) to set an allowlist or apply `+name`/`-name` modifiers, `--exclude-tools` (`-xt`) to remove specific tools, `--no-builtin-tools` (`-nbt`) to omit default coding tools, or `--no-tools` (`-nt`) to disable every tool (including extension tools such as `intercom`).
- **Settings:** Configure `defaultTools` in [Settings](/settings#tools) globally or in a trusted project.
- **SDK:** Pass `tools`, `excludedTools`, or `noTools` when creating a session ([SDK tools reference](/sdk/reference#tools)).

On native Windows, Atomic enables the [`powershell` tool](/windows#powershell-tool) alongside `bash` whenever PowerShell is installed. Excluding `bash` alone still leaves `powershell` enabled. Exclude both when you want no shell execution:

```bash
atomic --exclude-tools bash,powershell
```

Use a container, VM, remote sandbox, restricted OS account, or custom extension gate when you need command allowlisting or filesystem isolation. Extensions can inspect and block calls in [`tool_call` hooks](/extensions/events#tool_call); see `permission-gate.ts` and `protected-paths.ts` in [Extension examples](/extensions/examples#events-and-gates).

## Built-in data and network protections

Atomic enforces several local guardrails by default:

- **SSRF blocking on URL reads.** `read` blocks `localhost`, `.localhost`, private IP ranges, cloud metadata endpoints, and redirects to them ([Documents and URLs](/tools#documents-and-urls)). Set `ATOMIC_ALLOW_PRIVATE_URL_READS=1` only when a workflow must read private URLs ([Environment variables](/environment-variables)). Bundled `@bastani/web-access` also keeps local or intranet hosts and credentialed URLs out of remote fallbacks ([Web access](/web-access)).
- **Opt-in browser cookies.** Gemini Web cookie lookup is disabled by default and activates only when you set `allowBrowserCookies: true` in `~/.atomic/web-search.json` or `ATOMIC_ALLOW_BROWSER_COOKIES=1` ([Web access](/web-access)).
- **Worktree snapshot secret deny list.** [Worktree snapshots](/worktree-snapshots) exclude `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials`, `credentials.json`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, and private SSH key files before `.atomic/snapshot-ignore` or Git staging. This deny list cannot be overridden ([What is left out](/worktree-snapshots#what-is-left-out)).
- **Storage credentials and process overrides.** Shared storage rejects credentials embedded in URLs and saves static tokens in mode-`600` files. Process-level storage overrides (`--storage`, `--storage-file`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`) come from the launching host and bypass project trust ([Selecting storage per process](/storage#selecting-storage-per-process)).
- **Session sharing and debug snapshots.** `/share` uploads a private GitHub gist and strips worktree snapshots and large tool-output blobs, while keeping the rest of the transcript ([Exporting and sharing sessions](/usage#exporting-and-sharing-sessions)). `/debug` writes all current session messages unredacted to `~/.atomic/agent/atomic-debug.log` ([Diagnostics and debugging](/development#debugging)).

## Running untrusted or unattended work

For untrusted repositories, unreviewed generated code, or unattended automation, run Atomic inside an isolated environment with only the files and credentials needed for the task.

See [Run Atomic in containers](/containerization) for common setups:

- Run the whole `atomic` process inside Docker or NVIDIA OpenShell.
- Run Atomic on the host while routing built-in file and shell tools into a Gondolin micro-VM.
- Mount only the workspace paths the agent needs.
- Avoid mounting host `~/.atomic` or `~/.atomic/agent` unless the container should access host sessions, settings, and credentials.
- Pass only the minimum required API keys or short-lived tokens.
- Restrict outbound network access when the task does not need it.
- Review diffs and outputs before copying files back to trusted systems.

If you bind-mount a host directory read/write, writes inside the container or VM modify host files directly. Use read-only mounts or copy files in and out when you need to protect host checkouts from unintended writes.

## Credential export

`atomic auth print-api-key`, `atomic auth print-bearer-token`, and `atomic auth check --credentials` export a resolved credential to stdout so external clients can reuse your Atomic authentication without reading `auth.json`. `atomic auth check` without `--credentials` stays status-only and never prints a secret. See [CLI credential commands](/reference/cli#credential-commands) and [Providers](/providers) for full command flags and provider auth setup.

```bash
TOKEN=$(atomic auth print-bearer-token --provider openai-codex --model gpt-5.4 --min-expiry 45m)
KEY=$(atomic auth check --provider openai --credentials)
```

Credential-export guarantees and exact flag rules:

- **Stdout carries credentials only on explicit export.** Warnings, provider selection, refresh notices, and `atomic auth --help` go to stderr. Failed exports leave stdout empty (except partial write exit code `9`) and report status on stderr, or emit status-only JSON under `auth check --json --credentials`.
- **Explicit targets and matching rules.** `print-api-key` and `print-bearer-token` always require `--model` (never an unnamed session model). Without `--provider`, both print subcommands use fuzzy model matching to infer the provider. If `--model` matches multiple configured providers, Atomic queries each candidate before exiting with code `3`, which can refresh and persist an expiring OAuth token on a candidate provider before reporting ambiguity. Pass `--provider` to avoid ambiguity and extra token checks. `auth check --credentials` requires `--provider` or an exact `--model` (never fuzzy matching).
- **Flag scope and OAuth lifetime.** `print-bearer-token` and `auth check --credentials` require at least 30 minutes of remaining OAuth lifetime by default and refresh expiring tokens automatically. `--min-expiry <duration>` accepts `<integer><ms|s|m|h>` (case-insensitive, default `30m`), works only on `print-bearer-token`, and is rejected on `print-api-key` (even after `--`) and `auth check`. `--no-refresh` works only on `auth check` (rejected with exit code `1` on `print-bearer-token`) and refuses short-lived tokens without modifying `auth.json`.
- **No file or clipboard sink.** There is no `--output` flag or clipboard option; redirect stdout yourself if you choose to save the output.
- **JSON output on `auth check --json --credentials`.** A ready check emits `{"status":"ready","provider":"...","authType":"...","credentials":"..."}`. A non-ready check emits the status JSON object without a `credentials` field.
- **Stream failure handling.** If a stream error occurs after the complete credential is written, Atomic reports the error on stderr and exits `0`. If writing fails partway through, Atomic exits with code `9` so callers discard the partial stdout bytes.
- **No log leakage.** Atomic never writes exported credentials to debug logs, session transcripts, error messages, or RPC responses.

### Exit codes for `print-api-key` and `print-bearer-token`

| Exit code | Meaning |
| --- | --- |
| `0` | Credential written to stdout |
| `1` | Usage error (invalid flag or missing `--model`) |
| `2` | No credential configured for the resolved provider |
| `3` | Provider ambiguous (multiple configured providers matched `--model`) |
| `4` | Wrong credential kind (provider uses OAuth when API key was requested, or vice versa) |
| `5` | OAuth refresh failed (stored credential left untouched) |
| `6` | Refreshed token still expires sooner than `--min-expiry` |
| `7` | OAuth credential derivation failed (a refresh may already have persisted) |
| `8` | Output write failed before any bytes were emitted |
| `9` | Partial write to stdout; discard the received bytes |

### Exit codes for `auth check`

| Exit code | Meaning |
| --- | --- |
| `0` | Provider is ready |
| `1` | Provider is not ready |
| `2` | Auth state or command is invalid |
| `8` | With `--credentials`, output write failed before any bytes were emitted |
| `9` | With `--credentials`, partial write to stdout; discard the received bytes |

Once a credential reaches stdout, it is ordinary text in your shell or pipeline. Prefer `print-bearer-token`, which emits an expiring token, over a long-lived API key, and never call credential export inside a script that logs its own stdout.

## Reporting security issues

Follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md) to report a security issue. Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, the lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are outside the security boundary unless a report demonstrates a privilege-boundary bypass or shows how Atomic grants access the local user did not already have.
