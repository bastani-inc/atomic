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