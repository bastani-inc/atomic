## 1. Established patterns

- **Capability gating is server-scoped, not tool-scoped.**  
  `ConsentManager` caches approval/denial per `serverName`, and `UiServer` enforces it before `/proxy/tools/call` via `ensureApproved()`.

- **UI resources are normalized into one internal shape.**  
  `UiResourceHandler.readUiResource()` converts MCP resource responses into `{ uri, html, mimeType, meta }`, preferring:
  1) exact `ui://` URI match,  
  2) HTML MIME types,  
  3) first returned content.

- **UI metadata is extracted from `_meta.ui`.**  
  `extractUiMeta()` consistently reads `csp`, `permissions`, `domain`, and `prefersBorder` from resource metadata, then `UiServer` feeds that into host HTML / sandbox policy.

- **The UI server is a small HTTP control plane.**  
  `startUiServer()` exposes a local server with:
  - `GET /` host HTML
  - `GET /events` SSE stream
  - `GET /ui-app` raw app HTML
  - `POST /proxy/*` RPC-like actions

- **Session state is event-log based.**  
  `UiServer` keeps an in-memory `eventLog`, replays from the latest checkpoint, and tracks session messages (`prompts`, `intents`, `notifications`) plus an optional `streamSummary`.

- **Streaming is wrapped in a stable envelope.**  
  `ui-session.ts` attaches `pi-mcp-adapter/stream` envelopes to tool results and result patches, with monotonically increasing `sequence` numbers.

- **Sampling is conservative and approval-first.**  
  `handleSamplingRequest()` rejects unsupported MCP sampling features, resolves an allowed model through `modelRegistry`, then asks for interactive approval before and after the model call.

## 2. Variations / exceptions

- **Consent modes vary.**  
  `ConsentManager` supports `"never"`, `"once-per-server"`, and `"always"`:
  - `"never"` disables prompts,
  - `"always"` requires approval every call,
  - `"once-per-server"` caches approval.

- **UI message handling has three distinct buckets.**  
  `ui-server.ts` classifies incoming messages as:
  - prompt,
  - intent,
  - notify,  
  and stores them separately in `UiSessionMessages`.

- **Display mode is mutable at runtime.**  
  `/proxy/ui/request-display-mode` can switch between `inline`, `fullscreen`, and `pip`, but only if the requested mode is in `availableDisplayModes`.

- **Glimpse is optional and macOS-only.**  
  `glimpse-ui.ts` only enables the native viewer on `darwin`; otherwise the server falls back to the browser.

- **Some proxy endpoints are intentionally stubbed.**
  - `/proxy/ui/download-file` always returns error.
  - `/proxy/ui/open-link` only validates URL syntax, not policy.
  - `/proxy/ui/heartbeat` is a no-op health ping.

- **Streaming modes differ in input behavior.**
  - `eager`: tool input is sent normally.
  - `stream-first`: tool input is initially empty, with patches streamed later.

## 3. Anti-patterns or risks

- **Security is mostly runtime-enforced, not type-enforced.**  
  Many paths rely on `Record<string, unknown>`, `as` casts, and ad hoc validation.

- **Consent is coarse-grained.**  
  Approval is tied to the whole server, so a trusted server can still proxy arbitrary tool calls once approved.

- **Local HTTP + token-in-query is security-sensitive.**  
  The UI server uses a `session` query token and `/proxy/*` body token checks; this is fine for localhost, but it is a migration-sensitive trust boundary.

- **The server keeps mutable singleton-ish state.**  
  `completed`, `watchdog`, `eventLog`, `currentDisplayMode`, `activeGlimpseWindow`, and `state.uiServer` all interact, so Rust porting needs careful ownership/lifetime modeling.

- **The UI bridge depends on bundled JS assets.**  
  `app-bridge.bundle.js` is served directly from disk, so a Rust rewrite still needs a JS-compatible frontend or a full replacement.

- **The sampling path is intentionally restrictive.**  
  Unsupported features fail hard (`task`, `tools`, `toolChoice`, `stopSequences`, context inclusion), so parity work should preserve these guardrails.

## 4. Evidence index

- `packages/mcp/ui-resource-handler.ts`
  - `readUiResource()`
  - `selectContent()`
  - `extractUiMeta()`

- `packages/mcp/ui-server.ts`
  - `startUiServer()`
  - `/`, `/events`, `/ui-app`, `/proxy/tools/call`, `/proxy/ui/consent`
  - `/proxy/ui/message`, `/proxy/ui/context`, `/proxy/ui/open-link`
  - `/proxy/ui/download-file`, `/proxy/ui/request-display-mode`, `/proxy/ui/complete`

- `packages/mcp/ui-session.ts`
  - `maybeStartUiSession()`
  - `withStreamEnvelope()`
  - `stream-first` / `eager` handling

- `packages/mcp/sampling-handler.ts`
  - `handleSamplingRequest()`
  - `resolveSamplingModel()`
  - `confirmSampling()`
  - unsupported-feature guards

- `packages/mcp/consent-manager.ts`
  - `requiresPrompt()`
  - `shouldCacheConsent()`
  - `registerDecision()`
  - `ensureApproved()`

- `packages/mcp/glimpse-ui.ts`
  - `isGlimpseAvailable()`
  - macOS-only native viewer fallback

- `packages/mcp/ui-stream-types.ts`
  - stream envelope schemas and `UiStreamSummary`

- `packages/mcp/types.ts`
  - `UiResourceMeta`
  - `UiHostContext`
  - `UiMessageParams`
  - `UiSessionMessages`
  - `UiOpenLinkResult`

- Tests:
  - `test/unit/mcp-security.test.ts`
  - `test/unit/mcp-oauth-startup.test.ts`
  - `test/unit/integrations-mcp.test.ts`