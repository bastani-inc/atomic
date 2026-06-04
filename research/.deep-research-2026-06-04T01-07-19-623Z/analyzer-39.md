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