# Security

Atomic is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether Atomic loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Atomic considers a project to have trust inputs when it finds any of these from the current working directory:

- `.atomic/` (or legacy `.pi/`) in the current directory
- `AGENTS.md` or `CLAUDE.md` in the current directory or an ancestor directory
- `.agents/skills` in the current directory or an ancestor directory

When an interactive session starts in a project with configs in `.atomic`/`.pi`, project-local context files, or `.agents/skills` and no saved decision for the current directory or a parent directory, Atomic follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.atomic/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows Atomic to load trust-gated project inputs, including:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic`/`.pi` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. Atomic also skips project-local `AGENTS.md` and `CLAUDE.md` context-file discovery while the project is untrusted; global context and explicitly supplied CLI resources remain available. Before trust is resolved, Atomic only loads user/global extensions and explicit CLI `-e` package-level extensions so those trusted extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision. When `-e <dir>` discovers project-local resources borrowed from that directory's `.atomic` or legacy `.pi` config, or from `.agents/skills`, Atomic resolves trust for that extension source before loading those borrowed resources, because borrowed extensions and workflows can execute code with the Atomic process permissions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Atomic does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the Atomic process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Atomic is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

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

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how Atomic grants access that the local user did not already have.
