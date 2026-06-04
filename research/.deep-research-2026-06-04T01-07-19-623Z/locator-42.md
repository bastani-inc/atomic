## 1. Must-read paths

- `packages/web-access/curator-server.ts`  
  HTTP + SSE server for the browser curator. This is the runtime contract you’d reimplement in Rust if you want the same “open a local curator page, stream results, accept submit/summarize/rewrite” behavior.

- `packages/web-access/curator-page.ts`  
  The full HTML/CSS/JS curator UI. Matters because it defines the browser-side state machine and form payloads Rust must keep compatible with.

- `packages/web-access/index.ts`  
  Main extension entrypoint. This wires web search, curator startup, provider selection, session hooks, and result persistence together. It’s the best map of end-to-end behavior.

- `packages/web-access/storage.ts`  
  In-memory result cache plus session restore logic. This is the key “search session persistence” layer.

- `packages/web-access/summary-review.ts`  
  Summary draft generation, deterministic fallback, model selection, and metadata shape. Critical if Rust is expected to preserve summary-review behavior.

## 2. Supporting paths

- `packages/web-access/activity.ts`  
  UI activity tracking for the web-search widget; relevant if the Rust port needs the same live status UX.

- `packages/web-access/extract.ts`  
  Background content fetching used by web search results and curator flows.

- `packages/web-access/gemini-search.ts`, `perplexity.ts`, `exa.ts`, `gemini-api.ts`, `gemini-web.ts`  
  Provider backends. These define the search-side inputs that feed the curator.

- `packages/web-access/github-extract.ts`, `pdf-extract.ts`, `video-extract.ts`, `youtube-extract.ts`  
  Content extraction helpers that affect what the curator receives and stores.

- `packages/web-access/config-paths.ts`  
  Config file discovery; relevant if session/provider settings are moved to Rust.

- `packages/web-access/README.md`  
  Likely documents user-facing curator behavior and config knobs.

## 3. Entry points / symbols

- `startCuratorServer(...)` in `packages/web-access/curator-server.ts`  
  Creates the local server, session token gate, `/events` SSE stream, and `/search`, `/summarize`, `/rewrite`, `/submit` endpoints.

- `generateCuratorPage(...)` in `packages/web-access/curator-page.ts`  
  Renders the curator app shell and injects inline bootstrap data.

- `storeResult(...)`, `getResult(...)`, `restoreFromSession(...)` in `packages/web-access/storage.ts`  
  The persistence boundary for cached searches/fetches and rehydration from session entries.

- `generateSummaryDraft(...)`, `buildDeterministicSummary(...)` in `packages/web-access/summary-review.ts`  
  The “review summary” path and fallback semantics.

- `handleSessionChange(ctx)` in `packages/web-access/index.ts`  
  Resets state on session changes and restores stored web results.

- `storeAndPublishSearch(...)`, `startBackgroundFetch(...)` in `packages/web-access/index.ts`  
  Where results are persisted into session entries via `pi.appendEntry("web-search-results", ...)`.

- `pi.registerCommand("websearch", ...)` and `pi.registerCommand("curator", ...)` in `packages/web-access/index.ts`  
  User-facing commands that open the curator and control workflow settings.

## 4. Gaps or uncertainty

- I verified the core files above, but I did **not** confirm dedicated tests for `curator-server`, `curator-page`, or `storage`. The repo search didn’t surface obvious `packages/web-access/*test*` coverage.
- `curator-page.ts` is very large; I only confirmed the bootstrap, summary-review, event-source, and submit-related areas, not every UI action handler.
- `storage.ts` currently appears to be **in-memory + session-branch restore**, not durable disk persistence by itself. If your Rust migration needs persistence across process restarts, that contract may be elsewhere.
- The exact session-entry schema for `web-search-results` is inferred from `index.ts`/`storage.ts`; I didn’t verify a formal schema doc for it.