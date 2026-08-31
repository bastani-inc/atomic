# Environment Variables

Atomic accepts environment variables for configuration, provider credentials, and subprocess context. Atomic-prefixed application variables take precedence over their legacy Pi aliases when both are set.

## Application configuration

| Atomic variable | Legacy alias | Purpose |
|---|---|---|
| `ATOMIC_CODING_AGENT_DIR` | `PI_CODING_AGENT_DIR` | Agent/config directory; default `~/.atomic/agent` |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | `PI_CODING_AGENT_SESSION_DIR` | Session directory; `--session-dir` takes precedence |
| `ATOMIC_PACKAGE_DIR` | `PI_PACKAGE_DIR` | Package directory override |
| `ATOMIC_OFFLINE` | `PI_OFFLINE` | Disable startup network operations |
| `ATOMIC_SKIP_VERSION_CHECK` | `PI_SKIP_VERSION_CHECK` | Skip automatic startup version checks; explicit self-update still checks |
| `ATOMIC_TELEMETRY` | `PI_TELEMETRY` | Enable/disable install/update telemetry |
| `ATOMIC_REDUCED_MOTION` | `PI_REDUCED_MOTION` | Use static reduced-motion presentation |
| `ATOMIC_EXPERIMENTAL` | `PI_EXPERIMENTAL` | Set to `1` to enable experimental features: built-in tool definitions request strict JSON-schema constrained sampling (`prefer`), and the footer shows an `xp` badge |

`PI_CACHE_RETENTION=long` is a provider/upstream prompt-cache option and intentionally has no Atomic-prefixed alias. `VISUAL` and `EDITOR` select the Ctrl+G external editor when `externalEditor` is unset.

`PI_TUI_ESC_TIMEOUT` belongs to the installed pi-tui renderer and also keeps its upstream name: it sets how long the renderer waits after a lone `ESC` before treating it as the Escape key, in milliseconds. The default is `100` over SSH and `10` otherwise; increase it if Alt-key input is misread as Escape.

The renderer also owns `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, and `PI_TRUE_COLOR`. `PI_HYPERLINKS=1|0|auto` and `PI_TRUE_COLOR=1|0|auto` override or preserve detection; `PI_IMAGE_PROTOCOL=kitty|iterm2|none|auto` selects, disables, or preserves image-protocol detection. Explicit JSON values under `terminal.hyperlinks`, `terminal.images`, and `terminal.trueColor` take precedence. These renderer-owned names intentionally have no `ATOMIC_*` aliases.

## Subprocess attribution

`AI_AGENT=atomic` is set by the CLI, RPC, and compiled binary entry points and forced into every Atomic-owned child-process environment, including bash/tool commands, isolated RPC children, subagent and workflow runners, MCP servers, web-access subprocesses, and the intercom broker. This follows upstream's overwrite policy: a caller-supplied `AI_AGENT` is replaced in the Atomic process and child environment, but the caller's environment object is never mutated.

## Provider credentials

Provider keys include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, AWS/Bedrock credentials, and the variables listed in [Providers](/providers#environment-variables-or-auth-file). `ANTHROPIC_AUTH_TOKEN` is a distinct header-only bearer credential for Anthropic-compatible gateways: Atomic sends `Authorization: Bearer …` without requiring or inventing an API key, including normal turns, isolated execution, branch summaries, and Verbatim Compaction. Custom headers remain independent.

## Bash and PowerShell session environment

Every built-in, factory-created, direct, workflow-stage, and isolated bash or PowerShell execution receives one execution-time snapshot:

| Atomic variable | Exact Pi alias | Value |
|---|---|---|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_SESSION_FILE` | `PI_SESSION_FILE` | Active JSONL file; omitted for unsaved/ephemeral sessions |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Atomic clears these ten reserved names before overlaying the current snapshot, preventing stale metadata from another session or workflow stage. Unrelated inherited/caller variables remain intact. The snapshot is taken when execution begins, so a resumed session or later model change is reflected. SDK `createBashTool()` and `createPowerShellTool()` expose it by default; set `exposeSessionEnvironment: false` to opt out.

See [Using Atomic](/usage#environment-variables) and [RPC direct bash](/rpc#bash) for execution and streaming behavior.
