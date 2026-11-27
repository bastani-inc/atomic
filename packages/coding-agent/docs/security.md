---
title: "Manage security and project trust"
sidebarTitle: "Security & Project Trust"
description: "Configure project trust, restrict tools, understand local security boundaries, and safely export credentials."
---

Atomic is a local coding agent. It runs with the permissions of the OS user account that starts it and treats files writable by that user as inside the same local trust boundary.

## Project trust

Project trust controls whether Atomic loads project-local settings, instructions, resources, packages, and extensions before work begins. It is not a sandbox and does not limit what tools can do once a session starts.

Atomic treats a folder as having trust-gated inputs when it finds any of these from the current working directory:

- Any of these 11 entries inside `.atomic/` or legacy `.pi/` in the current directory: `settings.json`, `extensions`, `skills`, `prompts`, `themes`, `workflows`, `agents`, `mcp.json`, `blueprint.yaml`, `SYSTEM.md`, or `APPEND_SYSTEM.md`. An empty `.atomic/` directory, or one containing only state such as `.atomic/todos`, does not trigger project trust.
- Project instruction files in the current directory or an ancestor directory: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`.
- `.agents/skills` in the current directory or an ancestor directory. `~/.agents/skills` in your home directory is always treated as a trusted user resource and never triggers project trust.
- At the nearest ancestor project root (any ancestor containing `.atomic/`, `.pi/`, or `.agents/`), any `.agents/` directory, `.atomic/agents`, `.pi/agents`, `.atomic/settings.json`, or `.pi/settings.json`. Your home directory is never treated as an ancestor project root for these checks.

### How decisions are stored and prompted

Saved decisions live in `~/.atomic/agent/trust.json`, keyed by canonical directory path mapped to `true` or `false`. Atomic checks `trust.json` from the current directory upward and applies the closest saved decision ahead of global defaults. A saved `false` entry for the current folder or an ancestor still marks the folder untrusted even when no trust-gated files are present right now.

Atomic saves `trust.json` safely across concurrent sessions and follows symlinks. On Windows, saved paths match case-insensitively and saving removes duplicate entries with different casing. If `trust.json` contains malformed JSON or invalid values, Atomic warns once and treats it as empty until the next save; if permissions prevent reading the file, saving fails instead of overwriting it.

When no saved decision matches and the folder has trust-gated inputs, Atomic checks global `defaultProjectTrust` in `~/.atomic/agent/settings.json` (`"ask"`, `"always"`, or `"never"`; default `"ask"`). `defaultProjectTrust` is global-only: Atomic ignores it in project `.atomic/settings.json` and falls back to `"ask"` if the global value is invalid or unreadable.

In an interactive session with `defaultProjectTrust: "ask"`, Atomic opens a trust prompt with five options (four at the filesystem root):

- **Trust**
- **Trust parent folder (`<path>`)**
- **Trust (this session only)**
- **Do not trust**
- **Do not trust (this session only)** (selected by default)

Choosing **Trust parent folder** saves `true` for the parent directory and removes any saved entry for the current directory so it inherits from the parent. Pressing `Escape` cancels the prompt and leaves the folder untrusted for this session only without writing to `trust.json`.

<Note>
Use `Up`/`Down` and `Enter` to confirm. If you typed or pasted text before or while the prompt opened, `Enter` is disarmed so it adds a newline to your draft instead of confirming trust by accident — press `Up` or `Down` once to arm `Enter`.

Run `/trust` at any time to save a persistent choice, then **restart Atomic** for the new choice to take effect (`/reload` does not re-evaluate a newly saved `/trust` decision). To clear a saved entry completely, remove its path from `~/.atomic/agent/trust.json`.
</Note>

If you start an interactive session in a clean folder (no trust-gated inputs at startup and neither `--approve` nor `--no-approve`) and create trust-gated files such as `.atomic/settings.json` or `.atomic/extensions` during that session, running `/reload` automatically saves `true` for that folder in `trust.json` when no decision is saved yet.

### What project trust unlocks

Trusting a project lets Atomic load:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic` and legacy `.pi` extensions, skills, prompt templates, themes, and system prompt files (`SYSTEM.md`, `APPEND_SYSTEM.md`)
- Project-local `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`, plus project `.agents/skills`
- Project subagent definitions and agent overrides (`.atomic/agents`, `.pi/agents`, and `.agents`)
- Earlier workflow files for on-demand [conversion to skills](/orchestration/migrating-workflows) (read as text only, never executed, modified, or deleted)
- Project MCP server config ([`.atomic/mcp.json`](/mcp-servers); reusing Atomic's saved provider credentials via `auth.provider` is forbidden in project configs and package manifests, while `!command` values run shell commands) and blueprint builds ([`.atomic/blueprint.yaml`](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint))
- Project-configured [packages](/packages) (`atomic install -l` requires project trust or `--approve`), automatic installation of missing project packages, and package-managed extensions

Declining trust skips all of these project inputs while keeping global instructions, global skills, global settings, and explicit CLI resources available. Interactive sessions in an untrusted project display a warning; run `/trust` and restart Atomic to enable project inputs.

### Folders, worktrees, non-interactive runs, and extension hooks

- **Per-folder trust.** Trust belongs to the folder a session works in, not the directory you launched Atomic from. Resuming a session (`--resume`, `--continue`, `--session`, or `/resume`) applies that folder's trust decision and prompts if none is saved. Session-only choices last until Atomic exits and never write to `trust.json`.
- **Git worktrees.** A worktree outside its main repository folder has its own trust decision because it can check out different `.atomic` content. Choose **Trust parent folder** (at the prompt or in `/trust`) to trust sibling worktrees under one parent directory.
- **Extension `project_trust` hooks.** Global and explicit CLI `-e` extensions can decide project trust through the [`project_trust`](/extensions/events#project_trust) hook before Atomic checks `trust.json` or prompts you. The first handler returning `{ trusted: "yes" }` or `{ trusted: "no" }` wins (and saves to `trust.json` when `remember: true`), while `{ trusted: "undecided" }` passes to later handlers and built-in trust rules; hooks do not run when `--approve` or `--no-approve` overrides trust. See `project-trust.ts` in [Extension examples](/extensions/examples#events-and-gates).
- **External `-e` directories.** If a directory passed to `-e <dir>` contains resources under its own `.atomic`, legacy `.pi`, or `.agents/skills`, Atomic checks `trust.json` for that directory's canonical path before loading them, because those extensions run with your user permissions. Passing `--approve` (`-a`) or `--no-approve` (`-na`) also overrides trust for those directories.
- **Non-interactive runs.** Print mode (`-p`), `--mode json`, and `--mode rpc` never open a trust prompt. Without a saved decision, `defaultProjectTrust: "ask"` and `"never"` leave the project untrusted and skip project resources, while `"always"` trusts the project. Pass `--approve` (`-a`) or `--no-approve` (`-na`) to override trust for one run.

## No built-in sandbox

<Warning>
Atomic does **not** include a built-in sandbox. Built-in tools read, write, and edit files and execute shell commands with the permissions of the OS user running Atomic, and extensions execute as TypeScript modules with the same permissions. Use OS isolation, a container, or a VM whenever you need a security boundary.
</Warning>

Project trust only prevents an untrusted repository from changing settings or running extensions before you approve it. It does not make untrusted code, prompts, or model output safe. Prompt injection from repository files, comments, docs, context files, or command output is an inherent risk for any local coding agent.

When shell tools are enabled, model-supplied commands run through the configured shell with your user permissions, and Atomic provides no command-level allowlist or denylist. Be careful with shells, interpreters, package managers, `curl`, `git`, `sudo`, `env`, `xargs`, and any other program that can run arbitrary commands.

You can narrow which tools a session exposes:

- **CLI flags:** Pass `--tools` (`-t`) to set an allowlist or apply `+name`/`-name` modifiers, `--exclude-tools` (`-xt`) to remove specific tools, `--no-builtin-tools` (`-nbt`) to omit default coding tools, or `--no-tools` (`-nt`) to disable every tool (including extension tools such as `intercom`).
- **Settings:** Configure `defaultTools` in [Settings](/settings#tools) globally or in a trusted project.
- **SDK:** Pass `tools`, `excludedTools`, or `noTools` when creating a session ([SDK tools reference](/sdk/reference#tools)).

On native Windows, Atomic enables the [`powershell` tool](/windows#powershell-tool) alongside `bash` whenever PowerShell is installed. Excluding `bash` alone leaves `powershell` enabled; exclude both to disable all shell execution:

```bash
atomic --exclude-tools bash,powershell
```

Use a container, VM, remote sandbox, restricted OS account, or custom extension gate when you need command allowlisting or filesystem isolation. Extensions can inspect and block calls in [`tool_call` hooks](/extensions/events#tool_call); see `permission-gate.ts` and `protected-paths.ts` in [Extension examples](/extensions/examples#events-and-gates).

## Built-in data and network protections

Atomic enforces several local guardrails by default:

- **Private-network blocking on URL reads (SSRF protection).** `read` blocks `localhost`, `.localhost`, private IP ranges, cloud metadata endpoints, and redirects to them ([Documents and URLs](/tools#documents-and-urls)). Set `ATOMIC_ALLOW_PRIVATE_URL_READS=1` only when a workflow must read private URLs ([Environment variables](/environment-variables)). Bundled `@bastani/web-access` also keeps local or intranet hosts and credentialed URLs out of remote fallbacks ([Web access](/web-access)).
- **Opt-in browser cookies.** Gemini Web cookie lookup is disabled by default and activates only when you set `allowBrowserCookies: true` in `~/.atomic/web-search.json` or `ATOMIC_ALLOW_BROWSER_COOKIES=1` ([Web access](/web-access)).
- **Worktree snapshot secret deny list.** [Worktree snapshots](/worktree-snapshots) exclude `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials`, `credentials.json`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, and private SSH key files before `.atomic/snapshot-ignore` or Git staging. This deny list cannot be overridden ([What is left out](/worktree-snapshots#what-is-left-out)).
- **Storage credentials and process overrides.** Shared storage rejects credentials embedded in URLs and saves static tokens in mode-`600` files. Process-level storage overrides (`--storage`, `--storage-file`, `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`) come from the launching host and bypass project trust ([Selecting storage per process](/storage#selecting-storage-per-process)).
- **Session sharing and debug snapshots.** `/share` uploads a private GitHub gist and strips worktree snapshots and large tool-output blobs while keeping the rest of the transcript ([Exporting and sharing sessions](/usage#exporting-and-sharing-sessions)). `/debug` writes all current session messages unredacted to `~/.atomic/agent/atomic-debug.log` ([Diagnostics and debugging](/development#debugging)).

## Running untrusted or unattended work

For untrusted repositories, unreviewed generated code, or unattended automation, run Atomic inside an isolated environment with only the files and credentials needed for the task.

See [Run Atomic in containers](/containerization) for common setups:

- Run the whole `atomic` process inside Docker or NVIDIA OpenShell.
- Run Atomic on the host while routing built-in file and shell tools into a Gondolin micro-VM.
- Mount only the workspace paths the agent needs, and avoid mounting host `~/.atomic` or `~/.atomic/agent` unless the container should access host sessions, settings, and credentials.
- Pass only the minimum required API keys or short-lived tokens, and restrict outbound network access when the task does not need it.
- Review diffs and outputs before copying files back to trusted systems.

If you bind-mount a host directory read/write, writes inside the container or VM modify host files directly. Use read-only mounts or copy files in and out when you need to protect host checkouts from unintended writes.

## Credential export

`atomic auth print-api-key`, `atomic auth print-bearer-token`, and `atomic auth check --credentials` export a resolved credential to stdout so external clients can reuse your Atomic authentication without reading `auth.json`. Plain `atomic auth check` (without `--credentials`) stays status-only and never prints a secret.

```bash
TOKEN=$(atomic auth print-bearer-token --provider openai-codex --model gpt-6.2-sol --min-expiry 45m)
KEY=$(atomic auth check --provider openai --credentials)
```

<Warning>
Once a credential reaches stdout, it is ordinary text in your shell or pipeline. Prefer `print-bearer-token` (which emits a short-lived OAuth token) over a long-lived API key, never run credential export inside a script that logs stdout, and discard received bytes whenever the command exits with code `9` (partial write).
</Warning>

Security guarantees to keep in mind when wiring credential export into automation:

- **Stdout carries secrets only on explicit export.** Warnings, refresh notices, and help text go to stderr. Failed raw exports leave stdout empty (except exit code `9` for a partial stream write).
- **Specify `--provider` to avoid ambiguity.** `print-api-key` and `print-bearer-token` require `--model`; omitting `--provider` falls back to fuzzy matching and can inspect (and refresh an expiring OAuth token on) multiple configured candidates before failing as ambiguous. `auth check --credentials` requires `--provider` or an exact `--model`.
- **No file sinks or log leakage.** There is no `--output` or clipboard flag, and Atomic never writes exported credentials to debug logs, session transcripts, error messages, or RPC responses.
- **Read-only probes.** Pass `--no-refresh` to `atomic auth check` when you want a read-only check that never modifies `auth.json`.

See [CLI credential commands](/reference/cli#credential-commands) for all flag rules (`--min-expiry`, `--no-refresh`, `--json`) and the complete exit-code tables (`0`–`9`).

## Reporting security issues

Follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md) to report a security issue. Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, the lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are outside the security boundary unless a report demonstrates a privilege-boundary bypass or shows how Atomic grants access the local user did not already have.
