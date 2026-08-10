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

`PI_CACHE_RETENTION=long` is a provider/upstream prompt-cache option and intentionally has no Atomic-prefixed alias. `VISUAL` and `EDITOR` select the Ctrl+G external editor when `externalEditor` is unset.

## Subprocess attribution

`AI_AGENT=atomic` is set by the CLI, RPC, and compiled binary entry points and forced into every Atomic-owned child-process environment, including bash/tool commands, isolated RPC children, subagent and workflow runners, MCP servers, web-access subprocesses, and the intercom broker. This follows upstream's overwrite policy: a caller-supplied `AI_AGENT` is replaced in the Atomic process and child environment, but the caller's environment object is never mutated.

## Provider credentials

Provider keys include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, AWS/Bedrock credentials, and the variables listed in [Providers](/providers#environment-variables-or-auth-file). `ANTHROPIC_AUTH_TOKEN` is a distinct header-only bearer credential for Anthropic-compatible gateways: Atomic sends `Authorization: Bearer …` without requiring or inventing an API key, including normal turns, isolated execution, branch summaries, and Verbatim Compaction. Custom headers remain independent.

## Bash session environment

Every built-in, factory-created, direct, foreground/background, workflow-stage, and isolated bash execution receives one execution-time snapshot:

| Atomic variable | Exact Pi alias | Value |
|---|---|---|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_SESSION_FILE` | `PI_SESSION_FILE` | Active JSONL file; omitted for unsaved/ephemeral sessions |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

Atomic clears these ten reserved names before overlaying the current snapshot, preventing stale metadata from another session or workflow stage. Unrelated inherited/caller variables remain intact. The snapshot is taken when execution begins, so a resumed session or later model change is reflected. SDK `createBashTool()` exposes it by default; set `exposeSessionEnvironment: false` to opt out.

See [Using Atomic](/usage#environment-variables) and [RPC direct bash](/rpc#bash) for execution and streaming behavior.
