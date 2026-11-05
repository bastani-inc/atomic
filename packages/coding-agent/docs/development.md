# Development

For extensions and SDK integrations, start with [Build with Atomic](/build).

## Setup

To install the released CLI, follow [Installation](/getting-started/installation).

<a id="forking--rebranding"></a>

## Path Resolution

Atomic supports package-manager installs and standalone archives. Keep an archive's complete payload together.

## Debugging

Turn on debug mode with **Debug mode** in `/settings` (the [`debug` setting](/settings#debug-mode)), with `--debug`, or with `ATOMIC_DEBUG=1`. The footer shows a `debug` badge while it is on.

In debug mode, every area below appends one JSON line per event to `~/.atomic/agent/atomic-debug.log`, the file `/debug` shows: `{"at", "pid", "area", "event", "data"}`. Each area's own variable still turns on just that area, and still writes where it always has, not to the debug log.

| Area | Own variable | What it shows | Own variable writes to |
|------|--------------|---------------|------------------------|
| `workflow` | `ATOMIC_WORKFLOW_DEBUG=1` | Failed background workflow discovery, failed workflow lifecycle, HiL-answer and heartbeat notices, and heartbeat intervals too large to schedule | stderr |
| `model-routing` | `ATOMIC_MODEL_ROUTING_DEBUG=1` | `model: "auto"` routing decisions and fallbacks, including a workflow stage that falls back to the current chat model | stderr, or a workflow warning for a stage |
| `pooled-watch` | `ATOMIC_DEBUG_POOLED_WATCH=1`, or a file path | Each step of watching a pooled stage: watches opening and ending, reconnects, rebinds, delivered messages and their outcomes, admissions and refusals | `pooled-watch-trace.jsonl` next to the pool journal, or the named file |
| `pool` | None | Worker pool coordination counters: requests and journal writes per second, by kind. Debug mode also shows them as the `pool:` line in workflow status | — |

Debug output holds only what each area already reports, such as ids, names, counts and error messages. It never includes prompts or message text. Credentials in common forms are replaced with `[redacted]`: bearer tokens, JWTs, GitHub tokens, private key blocks, `sk-…` style API keys, and `key: value` or `key=value` pairs whose name is a key, token, secret or password. Other credential formats can pass through, so review the log before sharing it. Long text is cut to 2,000 characters.

Pool workers, pool coordinators, the Intercom broker and other child processes started while debug mode is on inherit it, and subagents follow it at once. A pool that is already running passes a change on to the workers it starts next. Processes that are already running keep the state they started with until their next start. If the debug log cannot be written, Atomic shows one warning and keeps running.

Extensions and SDK code can check and write debug output with the [debug output API](/sdk/reference#debug-output).

### Debug command

`/debug` (hidden) appends a snapshot to the same `~/.atomic/agent/atomic-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

Unlike debug mode, this snapshot includes conversation content. Review the log before sharing it.

## PDF and engine diagnostics

PDF conversion and engine diagnostics appear as status messages in interactive sessions
and console output otherwise. Conversion failures also include diagnostic details in
their error result. Long or noisy diagnostics may be truncated. Interactive sessions keep
only recent diagnostics; older diagnostics are discarded without removing normal chat.

Diagnostics are displayed as text, not terminal commands. RPC clients receive diagnostics
separately from JSON responses. No `atomic-engine-stderr.log` file is written; include the
displayed diagnostic and conversion error when reporting a PDF problem.

## Startup timing probes

For a startup problem, report your OS, terminal, installation method, and Atomic version.

<a id="testing"></a>
<a id="installed-package-smoke-test"></a>

## Deterministic installs

Package-manager installs use Atomic's published shrinkwrap.

## Release security boundary

Download official releases through the [installation instructions](/getting-started/installation). Maintainers should follow the [release pipeline](https://github.com/bastani-inc/atomic/blob/main/docs/ci.md#direct-release-trigger-and-recovery).

<a id="project-structure"></a>

For source setup and repository checks, see [DEV_SETUP.md](https://github.com/bastani-inc/atomic/blob/main/DEV_SETUP.md).
