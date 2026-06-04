## Partition 39: MCP UI resources, UI server, sampling handler, consent manager, and security model

### Locator
## 1. Must-read paths

- `packages/mcp/ui-server.ts` — core UI HTTP/SSE server. Handles `/ui-app`, `/events`, `/proxy/*`, session tokens, heartbeat, completion, and consent-gated tool calls.
- `packages/mcp/ui-resource-handler.ts` — fetches MCP UI resources, validates `ui://` URIs, HTML/mime handling, and `_meta.ui` extraction.
- `packages/mcp/sampling-handler.ts` — implements `sampling/createMessage` bridging into Pi model completion, including approval flow and message conversion.
- `packages/mcp/consent-manager.ts` — tool-consent state machine (`never` / `once-per-server` / `always`), cache/deny semantics, and `ConsentError` triggers.
- `packages/mcp/host-html-template.ts` — browser-side security model: sandboxed iframe, CSP injection, tool-consent UI, AppBridge wiring, `open-link`, `download-file`, `request-display-mode`.
- `packages/mcp/index.ts` — extension entrypoint; wires session lifecycle, direct tools, commands, UI sessions, and shutdown.
- `packages/mcp/init.ts` — bootstraps `McpServerManager`, `ConsentManager`, `UiResourceHandler`, and sampling config.
- `packages/mcp/server-manager.ts` — registers sampling handler on MCP clients and manages transports/auth.
- `packages/mcp/types.ts` — key contracts for `UiResourceMeta`, `UiHostContext`, `UiSessionMessages`, `McpSettings` (`sampling`, `samplingAutoApprove`, `disableProxyTool`).

## 2. Supporting paths

- `packages/mcp/ui-session.ts` — connects UI server to agent messaging; turns UI prompts/intents into agent turns.
- `packages/mcp/state.ts` — extension state shape tying together consent, UI server, resource handler, lifecycle, and session messages.
- `packages/mcp/README.md` — highest-signal docs for user-facing security model, sampling behavior, UI integration, and consent modes.
- `packages/mcp/CHANGELOG.md` — confirms feature intent/history for UI integration, consent, sampling, and security-related changes.
- `packages/mcp/app-bridge.bundle.js` — bundled browser bridge used by the UI host; relevant if moving browser-side logic to Rust or a new frontend.
- `packages/mcp/commands.ts`, `packages/mcp/glimpse-ui.ts` — extra UI surfaces that may depend on the same security/consent model.
- `packages/mcp/oauth-handler.ts`, `packages/mcp/mcp-auth.ts`, `packages/mcp/mcp-auth-flow.ts` — adjacent trust/auth plumbing if the Rust port folds MCP auth in too.
- `packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.ts` — downstream policy surface if direct-tool exposure changes.
- `packages/workflows/src/extension/mcp.ts` — shows another consumer of the MCP extension contract.

## 3. Entry points / symbols

- `UiResourceHandler.readUiResource(serverName, uri)`
- `startUiServer(options: UiServerOptions)`
- `UiServerHandle` (`sendToolResult`, `sendResultPatch`, `sendHostContext`, `getSessionMessages`)
- `handleSamplingRequest(options, request)`
- `registerSamplingHandler(client, options)`
- `ConsentManager.requiresPrompt(serverName)`
- `ConsentManager.registerDecision(serverName, approved)`
- `ConsentManager.ensureApproved(serverName)`
- `buildHostHtmlTemplate(input)`
- `applyCspMeta(...)` / `buildCspMetaContent(...)` in `host-html-template.ts`
- `initializeMcp(pi, ctx)` in `init.ts`
- `McpServerManager.createClient(...)` and `createHttpTransport(...)`

## 4. Gaps or uncertainty

- I did **not** find a `packages/mcp/test/` tree or obvious MCP-specific test files in this repo search, so the exact regression suite for these paths is unclear.
- `host-html-template.ts` likely contains more security-relevant logic below the first chunk (sandbox/CSP/message filtering); worth reviewing fully before migration.
- The broader Rust migration boundary is still unclear: whether these pieces become native Rust, a Rust host with JS bridge, or a mixed model.
- I couldn’t verify whether any other repo docs define a formal threat model beyond the README/CHANGELOG language.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is an **MCP UI/security bridge** between agent-side tool execution and a browser-like UI surface.

- **`UiResourceHandler`** fetches `ui://...` resources from an MCP server, validates MIME type, and extracts UI metadata from `_meta.ui`.
- **`startUiServer`** spins up a local HTTP server plus SSE channel to host the UI, proxy tool calls, forward UI messages back to the agent, and enforce consent/session lifetime.
- **`ConsentManager`** is the policy gate for whether a server’s UI may call tools, with modes for prompt-every-time vs cached allow/deny.
- **`handleSamplingRequest`** implements MCP `sampling/createMessage` by converting MCP messages into Pi AI messages, resolving a usable model, prompting for approval, and converting the assistant response back to MCP format.
- **`McpServerManager`** is the transport/runtime owner: it connects to MCP servers, discovers tools/resources, and registers sampling handling on clients.
- **`mcp/index.ts` + `init.ts`** wire all of this into session lifecycle, commands, metadata caching, direct tools, and UI session reuse.
- **`ui-session.ts`** reuses an existing UI window for repeated calls to the same server/tool, and streams intermediate patches back through the UI server.

For a Rust migration, this partition is the **highest-risk trust boundary** because it combines:
1. browser-hosted UI,
2. local loopback HTTP/SSE,
3. server tool proxying,
4. consent enforcement,
5. model sampling with human approval.

## 2. Key flows and invariants

### UI resource loading
1. `readUiResource(serverName, uri)` requires `ui://` URIs.
2. It calls `manager.readResource(...)`.
3. It selects the best content by URI, then HTML MIME, then first entry.
4. It accepts only HTML-ish MIME types.
5. It extracts `_meta.ui` from both returned content and the registered resource list entry, then merges metadata.

**Invariant:** UI resources must produce non-empty HTML, or the session fails early.

### UI server startup and lifecycle
1. `startUiServer` creates a unique session token and in-memory event log.
2. It serves:
   - `/` → wrapper host HTML,
   - `/ui-app` → raw UI HTML with CSP injected,
   - `/events` → SSE stream,
   - `/proxy/*` → consent/tool/message/context/display-mode endpoints.
3. It keeps a heartbeat and auto-closes stale sessions after ~60s without activity.
4. It replays SSE events using checkpoint-aware pruning so reconnecting clients can catch up.

**Invariant:** all browser requests require the correct session token.

### Tool-call proxying
1. UI requests `/proxy/tools/call`.
2. `ConsentManager.ensureApproved(serverName)` must pass first.
3. The manager must have an active connected server.
4. Tool calls are executed through the MCP client, with in-flight counters updated around the call.

**Invariant:** tool execution is blocked unless consent is approved for that server.

### Consent state machine
- `never`: no prompt required.
- `once-per-server`: prompt once, then cache approval/denial per server.
- `always`: prompt every time; approvals are not cached.

Denials are sticky until changed by `registerDecision()` or cleared.

### Sampling flow
1. Validate unsupported MCP sampling features:
   - task,
   - context inclusion,
   - tool use,
   - tool choice,
   - stop sequences.
2. Convert MCP messages into Pi AI message structures.
3. Resolve a model using:
   - `modelPreferences.hints`,
   - current model,
   - available models.
4. Require interactive approval unless `autoApprove` is enabled.
5. Call Pi AI `complete(...)`.
6. Convert result back to MCP `CreateMessageResult`.

**Invariant:** sampling is intentionally conservative; unsupported features fail fast.

### Host HTML / security model
- The host page uses a sandboxed iframe and injects CSP from resource metadata.
- `safeInlineJSON()` escapes dangerous characters before embedding values into the page.
- UI actions are mediated through a local proxy API, not direct server access.
- `open-link` validates URL syntax before allowing browser navigation.

**Invariant:** UI code is not trusted; it is fenced by CSP, iframe isolation, and local proxy endpoints.

## 3. Tests / validation

I did **not find dedicated tests** for this partition in the repo search.

What exists indirectly:
- The README/changelog document expected behavior for:
  - UI integration,
  - consent modes,
  - MCP sampling,
  - session reuse,
  - security-related fixes.
- The code itself contains defensive checks and explicit error paths, but no visible `packages/mcp/test/*` coverage in the search results.

**Practical validation to add before/after Rust migration:**
- UI resource parsing:
  - `ui://` enforcement,
  - MIME rejection,
  - empty content rejection,
  - `_meta.ui` merge behavior.
- Consent manager:
  - all three modes,
  - sticky deny semantics,
  - `always` re-prompt behavior.
- UI server:
  - token validation,
  - `/proxy/tools/call` authorization,
  - `/proxy/ui/complete` shutdown,
  - SSE replay after reconnect,
  - stale-session timeout.
- Sampling handler:
  - unsupported feature rejection,
  - hint ordering,
  - approval-required behavior,
  - response conversion edge cases.
- Security:
  - CSP injection correctness,
  - script escaping in inline JSON,
  - invalid URL handling for `open-link`.

## 4. Risks, unknowns, and verification steps

### Main risks for TS → Rust migration
- **The browser/UI protocol is bespoke.** Rust would need to preserve:
  - local HTTP routes,
  - SSE replay semantics,
  - consent UI behavior,
  - AppBridge event shapes.
- **Sampling depends on Pi AI types/behavior.** You’ll need either:
  - a Rust-native model layer, or
  - a bridge to the existing JS runtime.
- **Consent semantics are subtle.** `never`, `once-per-server`, and `always` behave differently, especially for caching/denial.
- **Host HTML security is part of correctness.** CSP injection and JSON escaping are not optional details.
- **Session reuse/streaming is stateful.** Reusing an existing UI window and replaying patches is easy to break in a rewrite.

### Unknowns
- Exact coverage of UI/sampling/security regression tests is unclear.
- `host-html-template.ts` may have additional security-relevant logic beyond the excerpt.
- It’s unclear whether UI sessions are ever exercised outside desktop/browser environments.

### Verify next
1. Trace all callers of:
   - `startUiServer`
   - `handleSamplingRequest`
   - `ConsentManager.ensureApproved`
   - `UiResourceHandler.readUiResource`
2. Add/locate tests for:
   - consent transitions,
   - UI proxy endpoints,
   - SSE replay,
   - CSP injection.
3. Decide the Rust boundary:
   - native Rust host with JS plugin bridge, or
   - Rust wrapper around existing JS MCP UI logic.
4. Confirm which pieces must stay wire-compatible:
   - SSE event names,
   - `/proxy/*` JSON shapes,
   - UI metadata contract,
   - sampling result format.

### Online Researcher
## 1. Relevant external facts

- **MCP Apps UI runs in a sandboxed iframe** and is served as an MCP resource, not a normal same-origin web app. That means the host must enforce **CSP**, and the app cannot assume parent-page access. Sources: *MCP Apps* docs, *CSP and CORS | MCP Apps*, `McpUiResourceMeta`, `McpUiResourceCsp`.
- **UI resource metadata** can declare:
  - `csp` (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`)
  - `permissions` (camera, microphone, clipboardWrite, geolocation)
  - `domain` for a stable origin when needed. Source: `McpUiResourceMeta`.
- **AppBridge** is the host-side bridge between the host and iframe view; it forwards tools/resources/prompts and handles initialization plus host notifications like tool input/result. Source: `AppBridge | MCP Apps`.
- **`sampling/createMessage` is host-mediated and human-in-the-loop is recommended/expected**. The MCP sampling spec says clients SHOULD provide approval controls, rate limiting, and validation; tool-enabled sampling requires the `sampling.tools` capability and strict tool-result/message-shape rules. Source: *Sampling - Model Context Protocol*.
- **UI download/open-link flows are host-mediated** because sandboxed iframes can’t directly perform those actions safely. Source: `McpUiDownloadFileRequest`, MCP Apps overview/docs.

## 2. Local implications

- `packages/mcp/ui-server.ts` is not just HTTP plumbing; it is the **security boundary** for the UI flow:
  - session token validation
  - SSE replay/event log
  - consent-gated tool calls
  - host-context propagation
  - completion/watchdog behavior
- `packages/mcp/consent-manager.ts` encodes the **policy state machine** (`never`, `once-per-server`, `always`) that decides whether the host must prompt before tools run. A Rust port must preserve the same default/deny/cache semantics or you’ll change trust behavior.
- `packages/mcp/host-html-template.ts` is effectively the **browser security policy generator** (sandbox + CSP + bridge wiring). In Rust, this likely becomes either:
  - a server-rendered template with the same injected policy data, or
  - a separate frontend bundle with a Rust host emitting the policy envelope.
- `packages/mcp/sampling-handler.ts` must preserve MCP’s **message-shape constraints** for tool-use loops and approvals; this is protocol-sensitive, not just model-call logic.
- `ui://` resource handling in `ui-resource-handler.ts` means the Rust migration must still support:
  - validating UI resource URIs
  - extracting `_meta.ui`
  - converting resource metadata into host-enforced CSP/permissions
- Net: the Rust migration boundary is probably **core protocol/security logic in Rust**, while the **HTML/iframe UI may stay browser-side** unless you also replace the frontend.

## 3. Version/API assumptions

- I assumed the current MCP Apps/API shape reflected by the docs above:
  - `McpUiResourceMeta`
  - `McpUiResourceCsp`
  - `AppBridge`
  - `sampling/createMessage`
- I did **not** verify exact package versions in this repo beyond the docs references; if you pin `@modelcontextprotocol/ext-apps` or SDK versions, the Rust port should match those exact semantics.
- The sampled docs indicate the current behavior is aligned with the **2025 MCP Apps / Sampling docs**, so if your repo targets an older/newer MCP SDK, re-check compatibility before porting.

## 4. Unverified or unnecessary research

- I did not need deeper Rust-specific ecosystem research yet; the key issue here is **preserving MCP protocol/security semantics**, not which Rust framework to use.
- I did not fully inspect `host-html-template.ts` or `sampling-handler.ts`; those are the next files to read if you want a precise Rust migration map.
- I did not confirm whether every UI feature (`open-link`, `download-file`, display mode changes) is used by your downstream consumers; if not, those can be simplified during migration.