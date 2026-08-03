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

## Credential Export

`atomic auth print-api-key` and `atomic auth print-bearer-token` are the only commands that emit a stored credential. They exist so an external client can reuse the credential you already configured, rather than making you copy it out of `auth.json` by hand.

What the commands guarantee:

- **stdout carries the credential or nothing.** Warnings, provider selection, refresh notices, and even `atomic auth --help` go to stderr, and stdout is empty on every non-zero exit but one. `KEY=$(atomic auth print-api-key --model gpt-5.5)` cannot capture a diagnostic instead of a key. The rule runs both ways: once the credential is on stdout the command has succeeded, so a stream that then fails to drain is reported on stderr and the exit code stays `0`. The single exception is exit `9`: if the stream failed part-way through the payload, those bytes are already gone and stdout cannot be made empty, so the command says so rather than reporting a truncated secret as a whole one. Every other non-zero exit leaves stdout empty, which is what makes the exit code safe to branch on.
- **No file or clipboard sink.** There is no `--output` flag. `--provider` and `--model` are the only options either subcommand accepts, checked as an allowlist: any other parsed flag, including `--export <path>` and `--session-dir <path>`, is a usage error. If you want the value in a file, you redirect it yourself and own that decision.
- **No ambient model.** `--model` is required, so the command cannot emit a credential for a model you did not name.
- **A failed refresh never strands you.** If the OAuth refresh itself fails, the command exits `5` and leaves the stored credential exactly as it was. Other OAuth failures — a token that still expires too soon after a successful refresh, or an auth derivation failure that may follow a rotation — exit `6` and `7` and make no claim about the stored credential, rather than asserting a rollback nothing verified.
- **The value is not loggable in transit.** Internally the credential is carried in a wrapper that throws if anything tries to interpolate, serialize, or inspect it, so it cannot reach a log line, a session transcript, or an error message. The wrapper is tested under both Node and Bun, since the published binary is Bun-compiled and `Bun.inspect` is a different formatter.
- **One egress, enumerated.** A single function in `src/cli/credential-print.ts` opens the wrapper and writes to stdout; nothing else in the source tree can read a credential out of it. A test walks every file under `packages/coding-agent/src` and lists *every* call that puts a non-literal value on the real stdout, so a new one has to be added to that list and reviewed. The test carries its own negative control: it feeds the scanner two planted egress modules and fails if either goes unreported. No RPC response type carries a credential either — that is asserted against `src/modes/rpc/rpc-types.ts` directly, because the RPC login reply once echoed the API key the host had just typed in.

What they do **not** do: once the credential is on stdout it is ordinary text in your shell, your pipeline, and possibly your shell history and process listing. Prefer `print-bearer-token`, whose output expires, over a long-lived API key. Do not embed either command in a script that logs its own output.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/bastani-inc/atomic/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how Atomic grants access that the local user did not already have.
