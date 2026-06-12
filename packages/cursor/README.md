# @bastani/cursor

Experimental first-party Atomic provider for Cursor subscription models.

## Status

This package registers `cursor` via Atomic's bundled extension provider API. `/login` shows **Cursor (experimental)** and stores credentials through Atomic OAuth storage only (`~/.atomic/agent/auth.json`). The provider currently ships a native `streamSimple` adapter plus an isolated HTTP/2 Connect transport boundary; no local proxy server or child-process bridge is used.

Cursor's model/agent APIs are private and may change without notice. Live `GetUsableModels` and `Run` request paths, headers, buffered Connect frame helpers, lifecycle cleanup, and injectable client/codec seams are isolated in `src/transport.ts`. Production defaults now use an isolated minimal Cursor protobuf codec in `src/proto/`; JSON framing remains available only as an explicitly injected test fixture. Run streaming writes the first Connect frame immediately, decodes `execServerMessage.mcpArgs` tool calls, classifies Connect end-stream errors, accumulates token deltas/checkpoints, and reconstructs per-turn conversation/tool context from Atomic `Context`.

Live model catalogs are cached without credentials at `~/.atomic/agent/cursor-models.json` (or the configured `ATOMIC_CODING_AGENT_DIR`). Startup uses a valid cached live catalog before falling back to estimated metadata, and login/refresh/first authenticated stream refreshes the cache best-effort without blocking token rotation.

## Limitations

- Text input only. Vision/image content is rejected with a clear error.
- Tool-call streaming is implemented in the adapter contract and covered with fake/protobuf transport tests; full native Cursor protobuf tool-result resume remains deferred.
- Credentials are OAuth-only. Do not pass Cursor tokens via command-line args, environment variables, logs, or local proxy processes.

## Attribution

Small protocol/auth facts and endpoint names were adapted from the MIT-licensed `ndraiman/pi-cursor-provider` project. This package does not copy that provider wholesale and intentionally avoids its localhost OpenAI-compatible proxy and Node child-process bridge architecture.
