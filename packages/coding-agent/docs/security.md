# Security

Atomic is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether Atomic loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Atomic considers a project to have trust inputs when it finds any of these from the current working directory:

- `.atomic/` (or legacy `.pi/`) in the current directory
- `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` in the current directory or an ancestor directory
- `.agents/skills` in the current directory or an ancestor directory

When an interactive session starts in a project with configs in `.atomic`/`.pi`, project-local context files, or `.agents/skills` and no saved decision for the current directory or a parent directory, Atomic follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.atomic/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows Atomic to load trust-gated project inputs, including:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic`/`.pi` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources, including project-local discovery of `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md`. Global context and explicitly supplied CLI resources remain available. Interactive sessions in an untrusted project show a warning that project resources are ignored; use `/trust` to save a decision, then restart Atomic.

Before resolving trust, Atomic loads only user/global extensions and explicit CLI `-e` package-level extensions. Those trusted extensions can handle the `project_trust` event; the first to return a yes/no decision owns it.

If `-e <dir>` discovers resources borrowed from that directory's `.atomic`, legacy `.pi`, or `.agents/skills`, Atomic resolves trust for that source before loading them. Borrowed extensions and workflows can execute code with the Atomic process permissions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Atomic does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the Atomic process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

Use operating-system isolation or a container when you need a security boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing Atomic's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by Atomic.

The built-in `bash` tool follows upstream pi behavior: if the tool is enabled, model-supplied commands run through the configured shell with the same permissions as the Atomic process. Atomic does not provide command-level allow/deny policy for `bash`. Use `tools`, `excludedTools`, or `noTools` to decide whether a session exposes shell access at all, and use a container, VM, remote sandbox, restricted OS account, or custom extension/tool when you need command allowlisting or stronger isolation. Be especially careful with interpreters, shells, package managers, `curl`, `git`, `sudo`, `env`, `xargs`, or other programs that can delegate arbitrary work.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run Atomic in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](/containerization):

- run the whole `atomic` process inside OpenShell or Docker
- run host Atomic while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.atomic/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Credential Export

`atomic auth print-api-key`, `atomic auth print-bearer-token`, and the explicit `atomic auth check --credentials` form can emit a stored or resolved credential. They let an external client reuse authentication you already configured instead of making you copy a value from `auth.json`. `atomic auth check` without `--credentials` stays status-only.

What credential-export forms guarantee:

- **A credential reaches stdout only through an explicit export.** Warnings, provider selection, refresh notices, and even `atomic auth --help` go to stderr. A plain `KEY=$(atomic auth check --provider openai --credentials)` gets a credential only on success; a non-ready or invalid check leaves stdout empty and reports status on stderr. With `--json`, a failed check returns JSON status without a credential. Once the credential reaches stdout the command has succeeded, so a stream that then fails to drain is reported on stderr and the exit code stays `0`. The single exception is exit `9`: if the stream failed part-way through the payload, those bytes are already gone and stdout cannot be made empty, so the command says so rather than reporting a truncated secret as a whole one. Other **raw** credential-export failures leave stdout empty; a non-zero JSON check result carries status only, never a credential.
- **No file or clipboard sink.** There is no `--output` flag. The print subcommands allow only `--provider` and `--model`; an auth check must name a provider or exact model before `--credentials` can emit anything. A fuzzy model match cannot select a credential for export. If you want the value in a file, you redirect it yourself and own that decision.
- **No ambient target.** The print subcommands require `--model`; an exporting auth check requires `--provider` or an exact `--model`, so no export can use an unnamed current session model.
- **Useful OAuth lifetime.** An auth-check export needs an OAuth token with at least 30 minutes remaining. Its normal path can refresh the token; `--no-refresh` makes no auth-file mutation and refuses a shorter-lived token. `print-bearer-token` applies the same floor and uses exit `5` only for a refresh failure that leaves the stored credential untouched.
- Atomic does not include exported credentials in its logs, session transcripts, error messages, or RPC responses. This does not protect text after it reaches your shell or another program.

What they do **not** do: once the credential is on stdout it is ordinary text in your shell, your pipeline, and possibly your shell history and process listing. Prefer `print-bearer-token`, whose output expires, over a long-lived API key. Do not embed any credential-export form in a script that logs its own output.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how Atomic grants access that the local user did not already have.
