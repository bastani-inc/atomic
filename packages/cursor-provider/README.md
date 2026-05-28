# @bastani/cursor-provider

Experimental, private Atomic/pi provider extension for Cursor.

> **Unofficial/private API warning:** this package talks to Cursor private endpoints and is not affiliated with or endorsed by Cursor. It may break without notice and requires a Cursor account/subscription that has access to the requested models.

## Usage

This workspace package is bundled as a built-in Atomic extension. In interactive mode:

```text
/login cursor
/model cursor/<model-id>
```

Credentials are stored through Atomic's normal auth storage under provider id `cursor` (`~/.atomic/agent/auth.json`). Run with `--no-extensions` to disable built-in extension loading, which also disables this provider.

## Runtime behavior

- Atomic development and tests use Bun, but published Atomic npm installs load this built-in extension under the Node CLI. This provider is expected to be importable under Node >=20.6.0 as well as Bun >=1.3.14.
- Startup registers Cursor authentication only; no fake fallback model is selectable before discovery.
- On session start, stored Cursor OAuth credentials are rehydrated from Atomic auth storage so saved accounts can rediscover/register models without rerunning `/login cursor`.
- After `/login cursor`, token refresh, or startup hydration, the extension calls Cursor's private `AgentService/GetUsableModels` endpoint through a package-local Node HTTP/2 bridge and registers the live/cached `cursor/<model-id>` models it discovers.
- Chat requests use a localhost-only OpenAI-compatible proxy bound to `127.0.0.1` and backed by `h2-bridge.mjs` for Cursor's private protobuf/HTTP/2 stream. Every proxy route, including `GET /v1/models`, requires the per-process bearer secret returned by Cursor OAuth auth.
- Atomic remains the tool authority: Cursor-native filesystem/shell tools are rejected, while Cursor MCP tool-call events are translated to OpenAI `delta.tool_calls` for Atomic to execute.
- `before_provider_request` injects the current Atomic session id so bridge state is session-scoped.
- Debug logging is opt-in with `ATOMIC_CURSOR_PROVIDER_DEBUG=1` and redacts token-like values.
- The local proxy normally binds an ephemeral loopback port; set `ATOMIC_CURSOR_PROVIDER_PORT=<port>` only for local diagnostics/tests.

Because this relies on private Cursor API shapes, a `node` executable must be available for the HTTP/2 child bridge and the integration may require maintenance when Cursor changes its protocol.
