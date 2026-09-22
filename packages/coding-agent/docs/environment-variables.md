# Environment Variables

Atomic accepts environment variables for configuration, provider credentials, and subprocess context. Atomic-prefixed application variables take precedence over their legacy Pi aliases when both are set.

## Application configuration

| Atomic variable | Legacy alias | Purpose |
|---|---|---|
| `ATOMIC_CODING_AGENT_DIR` | `PI_CODING_AGENT_DIR` | Agent/config directory; default `~/.atomic/agent` |
| `ATOMIC_CODING_AGENT_SESSION_DIR` | `PI_CODING_AGENT_SESSION_DIR` | Session directory; `--session-dir` takes precedence |
| `ATOMIC_PACKAGE_DIR` | `PI_PACKAGE_DIR` | Package directory override |
| `ATOMIC_OFFLINE` | `PI_OFFLINE` | Disable automatic network activity, including update checks, package updates, telemetry, and model catalog refreshes |
| `ATOMIC_SKIP_VERSION_CHECK` | `PI_SKIP_VERSION_CHECK` | Skip automatic startup version checks; explicit self-update still checks |
| `ATOMIC_TELEMETRY` | `PI_TELEMETRY` | Override version-adoption / first-interactive-launch pings (`1`/`true`/`yes` or `0`/`false`/`no`). Does not disable update checks. The Atomic-prefixed value wins when both are set |
| `ATOMIC_REDUCED_MOTION` | `PI_REDUCED_MOTION` | Use static reduced-motion presentation |
| `ATOMIC_EXPERIMENTAL` | `PI_EXPERIMENTAL` | Set to `1` to enable experimental features and preferred strict JSON-schema constrained sampling for additional built-in tools; `read`, `edit`, `write`, `bash`, and PowerShell already prefer strict sampling by default. The footer shows an `xp` badge |

`VISUAL` and `EDITOR` select the Ctrl+G external editor when `externalEditor` is unset.

`PI_TUI_ESC_TIMEOUT` sets how many milliseconds the renderer waits after a lone `ESC` before treating it as Escape. It belongs to the installed pi-tui renderer and keeps its upstream name. The default is `100` over SSH and `10` otherwise. Increase it if Alt-key input is misread as Escape.

The renderer also owns `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, and `PI_TRUE_COLOR`. `PI_HYPERLINKS=1|0|auto` and `PI_TRUE_COLOR=1|0|auto` override or preserve detection; `PI_IMAGE_PROTOCOL=kitty|iterm2|none|auto` selects, disables, or preserves image-protocol detection. Explicit JSON values under `terminal.hyperlinks`, `terminal.images`, and `terminal.trueColor` take precedence. These renderer-owned names intentionally have no `ATOMIC_*` aliases.

## Prompt-cache retention

Atomic defaults to **long** prompt-cache retention in main chat, workflow stages, and subagents wherever the provider/model supports it. `PI_CACHE_RETENTION` intentionally has no `ATOMIC_*` alias. Set it before launching Atomic to choose `short`, `none`, or `long`:

```bash
PI_CACHE_RETENTION=short atomic
```

Use `short` to opt back into shorter caching (five minutes on Anthropic), `none` to disable Atomic's optional cache controls where supported, or `long` to explicitly request extended retention (one hour on Anthropic). Providers can still perform automatic caching; supported durations and cache eligibility vary by provider/model.

With retention unset, OpenAI models without a known extended-retention capability (including GPT-4o) use ordinary caching, and Bedrock Claude models without known one-hour support (including Claude 3.7) use five-minute caching. Supported OpenAI models and Bedrock Claude 4.5+ models keep extended caching. For Bedrock application inference profiles, give the profile an accurate model name in `models.json` so Atomic can recognize its capability. Explicit `long` remains an opt-in request, not a guarantee of provider support; check the [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) or [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) model limits before forcing it. Custom OpenAI-compatible models can declare `compat.supportsLongCacheRetention` in `models.json`.

For SDK session requests, explicit `cacheRetention` takes precedence over `PI_CACHE_RETENTION`. Request-scoped `env` overrides credential-scoped environment, then the process environment is used. Requests that explicitly disable caching, such as compaction summaries, remain uncached by Atomic.

[Anthropic's prompt-caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) charges **2× base input price for one-hour writes**, versus **1.25× for five-minute writes**. Long retention can avoid rewrites when reusable prefixes are revisited after five minutes, but savings are not guaranteed. Short retention can be preferable when requests consistently reuse the cache within five minutes (hits refresh its lifetime without another write charge), or when prompts are unlikely to be reused. Compare your cache reads, writes, and billed usage before choosing.

## Subprocess attribution

Atomic sets `AI_AGENT=atomic` for itself and every subprocess it launches, replacing a caller-supplied value. Scripts can use it to identify an Atomic-owned invocation. The caller's environment object is not mutated.

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

See [Using Atomic](/reference/cli#environment-variables) and [RPC direct bash](/rpc/protocol#bash) for execution and streaming behavior.
