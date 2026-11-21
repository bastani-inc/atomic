# Security

Atomic is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether Atomic loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Atomic considers a project to have trust inputs when it finds any of these from the current working directory:

- `.atomic/` (or legacy `.pi/`) in the current directory
- `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` in the current directory or an ancestor directory
- `.agents/skills` in the current directory or an ancestor directory
- agent definitions (`.atomic/agents`, legacy `.pi/agents`, or `.agents`) or a settings file at the nearest ancestor project root, which subagents read

When an interactive session starts in a project with configs in `.atomic`/`.pi`, project-local context files, or `.agents/skills` and no saved decision for the current directory or a parent directory, Atomic follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.atomic/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

The trust question starts on **Do not trust (this session only)**. Use the arrow keys to choose, then press Enter. If you were already typing an unfinished prompt when the question appeared, or type prompt text while it is open, Atomic keeps it as a draft and ignores Enter until you navigate with ↑ or ↓. Text typed before the question also waits in the prompt as a draft. After answering, review the draft and press Enter to send it. Without a startup question, Enter during startup still submits your prompt.

Trusting a project allows Atomic to load trust-gated project inputs, including:

- `.atomic/settings.json` (or legacy `.pi/settings.json`)
- `.atomic`/`.pi` resources such as extensions, skills, prompt templates, themes, and system prompt files
- project subagent definitions and agent overrides
- paths to earlier workflow files, which the agent may read as text to [convert them to skills](/orchestration/migrating-workflows) on request; it never imports, executes, modifies, or deletes the old files
- the project MCP server config (`.atomic/mcp.json`) and blueprint builds (`.atomic/blueprint.yaml`)
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources, including project-local discovery of `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md`. No project or borrowed workflow files are listed or converted in an untrusted project. Global workflow files remain available for conversion to global skills. Global context and explicitly supplied CLI resources remain available. Interactive sessions in an untrusted project show a warning that project resources are ignored; use `/trust` to save a decision, then restart Atomic.

Trust belongs to the folder a session works in, not the one Atomic was started from. Resuming a session in interactive mode (`--resume`, `--continue`, `--session` or `/resume`) applies the decision for the folder the session continues in and asks about it when it has none. An answer for this session only lasts until Atomic exits: switching back to that folder with `/resume` uses it again, Atomic keeps it when it restarts its engine, and it is never saved to `trust.json`. The same holds for each `-e` extension source: if the engine restarts while you are answering several trust questions, it asks only about paths that still need a decision. A Git worktree outside its repository's folder is a separate folder with its own decision, because it can check out different `.atomic` content; to cover several worktrees kept in one directory, choose **Trust parent folder** for one of them, when asked or in `/trust`.

Atomic loads user/global extensions and explicit CLI `-e` package-level extensions to resolve trust. They can handle the `project_trust` event; the first to return a yes/no decision owns it, ahead of a saved decision. So in an interactive session, when such extensions are installed (any user or global extension or package, or an `-e` extension), a saved **Trust** or `defaultProjectTrust: "always"` is not a decision until the handlers have answered. Until then Atomic uses only global settings and resources: the first screen, migrating the folder's settings, the session store that `--continue`, `--resume` and `--session` read, and the build of restored worktrees wait for the decision. It does not show an untrusted warning for a pending check. Without such extensions, or with `--approve`, a saved **Trust** applies at once, and the decision is made with the extensions Atomic found when it started: an extension you install while Atomic starts loads after the decision and does not take part in it. When the folder's own settings choose another session store than the global ones (`sessions.storage` or `storage`), Atomic decides the folder's trust before it opens a session, so `--continue` waits for the extensions to load; a new session starts in the global store and moves to the folder's store once it is trusted. Such a session's interface runs in the same process as its extensions. If the session you pick belongs to another folder, the extensions that decided the first folder shut down (`session_shutdown` with reason `"resume"`) before the session's own extensions load, so a user extension's factory runs once for each folder, as when you switch to another folder's session. A shutdown that takes longer than about five seconds no longer holds the session back, and a warning says so, naming the extension that was shutting down when it can.

Approval makes the folder's resources available without waiting for a separate `-e` source's decision. The resource list at the top of the chat lists the approved resources and keeps each section expanded or folded; it waits while text is selected, a click or drag is in progress, you search, or you have scrolled the chat away from its start and end, and updates as soon as that ends. An open menu of command names in which you have not chosen a row shows the approved commands, with an exact match selected; a menu in which you moved the selection or pressed a row keeps its rows, and so does one whose new lookup fails. Other completion menus, pickers, the theme picker and Settings pages keep their choices, so a setting you are editing is saved where it was going to be saved; the next completion or a picker you open again offers the folder's resources. Extension-provided editors receive the approved provider as a normal replacement and manage their own menus.

If an extension adds a handler while it can still take part in the folder's decision, the interface withdraws even previously listed project resources without showing an untrusted warning. Once the engine starts calling the handlers, that set is fixed: adding or removing a handler does not change who gets to decide this time. Approval reads the current folder resources from disk. Because resource discovery refreshes the combined catalog, a global prompt renamed during the check can also appear under its new name before `/reload`.

If `-e <dir>` discovers resources borrowed from that directory's `.atomic`, legacy `.pi`, or `.agents/skills`, Atomic resolves trust for that source before loading them. Borrowed extensions can execute code with the Atomic process permissions.

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
