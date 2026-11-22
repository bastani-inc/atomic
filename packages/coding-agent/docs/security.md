---
title: "Security"
description: "Atomic's local trust model, project trust prompts, sandbox boundaries, and credential export guarantees."
---

# Security

Atomic is a local coding agent. It runs with the permissions of the user account that starts it and treats files writable by that user as inside the same local trust boundary.

## Project trust

Project trust controls whether Atomic loads project-local settings, resources, packages, and extensions. It is not a sandbox and does not restrict what the model can ask tools to do once a session starts.

Atomic treats a project as having trust inputs when it finds any of these from the current working directory:

- `.atomic/` (or legacy `.pi/`) in the current directory
- `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` in the current directory or an ancestor directory
- `.agents/skills` in the current directory or an ancestor directory
- Agent definitions (`.atomic/agents`, legacy `.pi/agents`, or `.agents`) or a settings file at the nearest ancestor project root, which subagents read

When an interactive session starts in a project with trust inputs and no saved decision for that directory or a parent, Atomic checks `defaultProjectTrust` from global settings. The default is `"ask"`, which opens a trust prompt when UI is available. Saved decisions live in `~/.atomic/agent/trust.json` by canonical directory path, and the closest saved decision on the current or parent path takes precedence over the global default.

The trust prompt defaults to **Do not trust (this session only)**. Use the up and down arrow keys to choose, then press Enter. Any text you typed before or during the prompt stays in the editor as a draft; review the draft and press Enter after answering to send it.

### What project trust allows

Trusting a project allows Atomic to load:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic`/`.pi` extensions, skills, prompt templates, themes, and system prompt files
- Project subagent definitions and agent overrides
- Earlier workflow files for on-demand [conversion to skills](/orchestration/migrating-workflows) (read as text only, never executed, modified, or deleted)
- Project MCP server config (`.atomic/mcp.json`) and blueprint builds (`.atomic/blueprint.yaml`)
- Project-configured packages and package-managed extensions

Declining trust skips those project inputs, including project-local `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md`. Global context, global workflow conversions, and explicit CLI resources remain available. Interactive sessions in an untrusted project show a warning; run `/trust` to save a decision, then restart Atomic.

### Resumed folders, worktrees, and extension hooks

- **Per-folder trust:** Trust belongs to the folder a session works in, not the directory you started Atomic from. Resuming a session (`--resume`, `--continue`, `--session`, or `/resume`) applies that folder's trust decision and prompts if none is saved. Session-only choices last until Atomic exits and are never written to `trust.json`.
- **Git worktrees:** A worktree outside its main repository folder has its own trust decision because it can check out different `.atomic` content. Choose **Trust parent folder** (at the prompt or in `/trust`) to trust sibling worktrees stored under one directory.
- **Extension `project_trust` hooks:** User/global extensions and explicit CLI `-e` extensions can handle the `project_trust` event ahead of saved trust decisions. When such extensions are installed, Atomic waits for them before applying project settings, resources, or a project-configured session store (unless `--approve` or `--no-approve` overrides trust for that run). Switching to a resumed session in another folder shuts down the previous folder's extensions (with a 5-second limit) before loading the resumed folder's extensions.
- **Borrowed `-e` sources:** If `-e <dir>` discovers resources from that directory's `.atomic`, legacy `.pi`, or `.agents/skills`, Atomic checks trust for that source before loading them, because borrowed extensions run with the Atomic process's permissions.
- **Non-interactive runs:** Print mode (`-p`), `--mode json`, and `--mode rpc` do not show a trust prompt. Without a saved decision, `defaultProjectTrust: "ask"` and `"never"` ignore project resources, while `"always"` loads them. Pass `--approve` (`-a`) or `--no-approve` (`-na`) to override trust for one run.

## No built-in sandbox

Atomic does not include a built-in sandbox. Built-in tools read, write, and edit files and run shell commands with the permissions of the Atomic process. Extensions run as TypeScript modules with the same permissions.

Use OS isolation or a container when you need a security boundary.

Project trust only guards input loading so a repository cannot silently change settings or run extensions before you approve it. It does not make untrusted code, prompts, or model output safe. Prompt injection from repository files, comments, docs, context files, or command output is an inherent risk for local coding agents.

When the built-in `bash` tool is enabled, model-supplied commands run through the configured shell with the Atomic process's permissions. Atomic provides no command-level allowlist or denylist for `bash`. Use `tools`, `excludedTools`, or `noTools` to decide whether a session has shell access, and use a container, VM, remote sandbox, restricted OS account, or custom tool when you need command allowlisting or stronger isolation. Be careful with interpreters, shells, package managers, `curl`, `git`, `sudo`, `env`, `xargs`, and other programs that can run arbitrary commands.

## Running untrusted or unmonitored work

For untrusted repositories, unreviewed generated code, or unattended automation, run Atomic inside an isolated environment with only the files and credentials required for the task.

See [Containerization](/containerization) for common setups:

- Run the whole `atomic` process inside OpenShell or Docker.
- Run Atomic on the host while routing built-in file and shell tools into a Gondolin micro-VM.
- Mount only the workspace paths the agent needs.
- Avoid mounting host `~/.atomic` or `~/.atomic/agent` unless the container should access host sessions, settings, and credentials.
- Pass only the minimum required API keys or short-lived tokens.
- Restrict network access when the task does not need it.
- Review diffs and outputs before copying files back to trusted systems.

If you bind-mount a host directory read/write, writes inside the container or VM modify host files directly. Use read-only mounts or copy files in and out when you need to protect host checkouts from unintended writes.

## Credential export

`atomic auth print-api-key`, `atomic auth print-bearer-token`, and `atomic auth check --credentials` export a stored or resolved credential so external clients can reuse your Atomic authentication without reading `auth.json`. `atomic auth check` without `--credentials` stays status-only.

Credential-export guarantees:

- **Stdout carries credentials only on explicit export.** Warnings, provider selection, refresh notices, and `atomic auth --help` go to stderr. In `KEY=$(atomic auth check --provider openai --credentials)`, stdout receives a credential only on success; failed checks leave stdout empty and write status to stderr (or return status-only JSON under `--json`).
- **Clear failure exit codes.** If a stream fails after the full credential is written, Atomic reports the error on stderr and keeps exit code `0`. If writing fails partway through the credential, Atomic exits with code `9` so callers discard the partial stdout bytes. All other raw export failures leave stdout empty.
- **No file or clipboard sink.** There is no `--output` flag; redirect stdout yourself if you choose to save the output. The print subcommands accept only `--provider` and `--model` (plus `--min-expiry` on `print-bearer-token`).
- **No ambient target.** Print subcommands require `--model`, and `auth check --credentials` requires `--provider` or an exact `--model` (never a fuzzy match or an unnamed current session model).
- **Minimum OAuth lifetime.** `auth check --credentials` and `print-bearer-token` require at least 30 minutes of remaining OAuth lifetime by default (configurable with `--min-expiry` on `print-bearer-token`). Normal runs refresh expiring tokens automatically; `--no-refresh` refuses short-lived tokens without modifying `auth.json`. `print-bearer-token` exits with code `5` when refresh fails while leaving stored credentials untouched.
- **No log leakage.** Atomic never writes exported credentials to its logs, session transcripts, error messages, or RPC responses.

Once a credential reaches stdout, it is ordinary text in your shell or pipeline. Prefer `print-bearer-token`, which emits an expiring token, over a long-lived API key, and never call credential export inside a script that logs its own output.

## Reporting security issues

Follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md) to report a security issue. Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, the lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are outside the security boundary unless a report demonstrates a privilege-boundary bypass or shows how Atomic grants access the local user did not already have.
