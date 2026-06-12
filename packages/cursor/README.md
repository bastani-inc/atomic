# @bastani/cursor

Experimental first-party Atomic provider for Cursor subscription models.

## Status

This package registers `cursor` via Atomic's bundled extension provider API. `/login` shows **Cursor (experimental)** and stores credentials through Atomic OAuth storage only (`~/.atomic/agent/auth.json`). The provider currently ships a native `streamSimple` adapter plus an isolated HTTP/2 Connect transport boundary; no local proxy server or child-process bridge is used.

Cursor's model/agent APIs are private and may change without notice. Atomic identifies as a Cursor CLI-compatible client against private endpoints, which may conflict with Cursor's terms of service, stop working without warning, or affect a user's Cursor account. Maintainers must explicitly accept that risk before enabling or shipping this provider. Live `GetUsableModels` and `Run` request paths, headers, buffered Connect frame helpers, lifecycle cleanup, and injectable client/codec seams are isolated in `src/transport.ts`. Production defaults now use an isolated minimal Cursor protobuf codec in `src/proto/`. Run streaming writes the first Connect frame immediately, uses stable conversation ids when Atomic supplies a session id, advertises Atomic tools with Cursor's `McpTools` wrapper schema, decodes `execServerMessage.mcpArgs` tool calls with protobuf `Value` or raw UTF-8 string arguments, pauses for Atomic tool execution, resumes the same stream with `ExecClientMessage.mcp_result`, cancels paused turns on abort or idle timeout, classifies Connect end-stream errors, accumulates token deltas/checkpoints, and reconstructs per-turn conversation/tool context from Atomic `Context` with historical tool results attached to their original tool calls. See `src/proto/README.md` for the manual smoke-test procedure maintainers should run after Cursor releases.

Live model catalogs are cached without credentials at `~/.atomic/agent/cursor-model-catalog.json` (or the configured `ATOMIC_CODING_AGENT_DIR`). Startup uses a valid cached live catalog before falling back to estimated metadata, and login/refresh/first authenticated stream refreshes the cache best-effort without blocking token rotation. Successful live and cached-live catalogs are registered exactly as Cursor advertised them, filtering malformed cache entries while keeping valid models. Static defaults such as `composer-2` are only present in explicitly estimated fallback catalogs. Fast/thinking model ids stay in separate selector groups, and effort-like suffixes such as `-max` are treated as reasoning variants only when the catalog contains sibling evidence. Cursor is subscription-backed, so Atomic reports zero token cost instead of displaying fabricated per-request dollar estimates.

## Limitations

- Text input only. Vision/image content is rejected with a clear error.
- Tool-call streaming and same-stream tool-result resume are implemented in the adapter contract and covered with fake/protobuf transport tests; Cursor's private protocol may still drift.
- Cursor's private API usage may violate Cursor's terms of service or result in provider-side breakage/account action; use only if the maintainer and user accept that risk.
- Credentials are OAuth-only. Do not pass Cursor tokens via command-line args, environment variables, logs, or local proxy processes.

## Attribution

Small protocol/auth facts and endpoint names were adapted from the MIT-licensed `ndraiman/pi-cursor-provider` project. This package does not copy that provider wholesale and intentionally avoids its localhost OpenAI-compatible proxy and Node child-process bridge architecture.
