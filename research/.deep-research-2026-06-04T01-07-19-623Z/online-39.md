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