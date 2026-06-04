## 1. Established patterns

- **Ephemeral web-curator lifecycle is centralized in `curator-server.ts`.**  
  It creates a local HTTP server on `127.0.0.1`, gates every route by `sessionToken`, and uses a small state machine (`SEARCHING` → `RESULT_SELECTION` → `COMPLETED`).  
  Examples: `GET /`, `GET /events`, `POST /search`, `POST /summarize`, `POST /submit`, `POST /cancel`.

- **SSE + buffered event delivery is the standard UI sync mechanism.**  
  `curator-server.ts` buffers SSE payloads until `/events` connects, then flushes them and keeps the connection alive with a 15s heartbeat.

- **Summary generation has a two-tier fallback model.**  
  `summary-review.ts` first tries a model-based summary via `complete(...)`; if that fails or yields empty output, `buildDeterministicSummary()` produces a stable fallback with `fallbackUsed: true`.

- **Search-result persistence is in-memory plus session replay.**  
  `storage.ts` keeps `StoredSearchData` in a module-level `Map`, and `restoreFromSession(ctx)` repopulates it from `ctx.sessionManager.getBranch()` entries tagged `customType === "web-search-results"`.

- **Persistence is mirrored into session history for recovery.**  
  In `index.ts`, both search and fetch results call `storeResult(...)` and `pi.appendEntry("web-search-results", data)`, so the UI cache and session log stay aligned.

- **Curator UI is generated as a standalone HTML app.**  
  `generateCuratorPage(...)` in `curator-page.ts` receives all runtime data as inline JSON and powers the whole experience from the browser side.

- **Summary-review is a first-class workflow, not a special case.**  
  The code treats `"summary-review"` as a named workflow across config, UI, and server callbacks (`workflow !== "summary-review"` checks in `curator-page.ts`, `workflow: "summary-review"` in `README.md`, and `WebSearchWorkflow` in `index.ts`).

## 2. Variations / exceptions

- **`/submit` allows two submission shapes.**  
  It can submit curated results with a generated summary, or raw results via `rawResults: true`. That’s a deliberate escape hatch in `curator-server.ts`.

- **Summary model selection is overrideable but constrained.**  
  `summary-review.ts` accepts `provider/model-id`, but falls back to preferred models (`anthropic/claude-haiku-4-5`, `openai-codex/gpt-5.3-codex-spark`) only if available in the model registry.

- **Session storage has TTL-based revival, not durable persistence.**  
  `storage.ts` only restores entries newer than 1 hour (`CACHE_TTL_MS`); older results are ignored even if still present in the session branch.

- **The curator page and server split responsibilities cleanly.**  
  Server handles auth/state/events; page handles UX, markdown rendering, and client-side polling/reconnect. This is a consistent boundary, not a one-off.

- **`index.ts` is the orchestrator, but not the implementation home.**  
  It wires together `curator-server`, `summary-review`, and `storage`, then exposes commands (`/websearch`, `/search`) to the host. The heavy logic lives in the dedicated modules.

## 3. Anti-patterns or risks

- **In-memory `Map` storage is not durable.**  
  `storage.ts` loses everything on process restart except what was appended to the session branch, and even that is filtered by TTL.

- **The web curator depends on tight coupling between browser UI and local server state.**  
  `sessionToken`, SSE state, heartbeat, and server lifecycle must all stay in sync; a Rust port would need to preserve that protocol exactly or replace it wholesale.

- **The summary pipeline mixes UX, policy, and provider selection.**  
  `summary-review.ts` handles prompt construction, model resolution, fallback semantics, and metadata shaping in one module.

- **Recovery semantics are implicit, not schema-driven.**  
  `restoreFromSession()` trusts `customType === "web-search-results"` and a loose `isValidStoredData()` check. This is simple, but fragile for a Rust rewrite unless the schema is formalized.

- **No dedicated tests were found in this partition.**  
  The codebase inventory shows these files, but I didn’t find partition-specific tests under `packages/web-access/`. That raises migration risk for behavior like SSE ordering, submit/cancel races, and fallback summary formatting.

## 4. Evidence index

- `packages/web-access/curator-server.ts`
  - `ServerState = "SEARCHING" | "RESULT_SELECTION" | "COMPLETED"`
  - endpoints: `/events`, `/search`, `/summarize`, `/submit`, `/cancel`
  - session-token auth, SSE buffering, heartbeat watchdog

- `packages/web-access/curator-page.ts`
  - `workflow = "summary-review"`
  - `EventSource("/events?session=" + encodeURIComponent(token))`
  - client posts to `/search`, `/rewrite`, `/summarize`, `/submit`, `/cancel`, `/heartbeat`

- `packages/web-access/summary-review.ts`
  - `buildSummaryPrompt(...)`
  - `buildDeterministicSummary(...)`
  - `generateSummaryDraft(...)`
  - preferred models list and `resolveSummaryModel(...)`

- `packages/web-access/storage.ts`
  - `storedResults = new Map<string, StoredSearchData>()`
  - `storeResult`, `getAllResults`, `deleteResult`, `clearResults`
  - `restoreFromSession(ctx)` with `CACHE_TTL_MS = 60 * 60 * 1000`

- `packages/web-access/index.ts`
  - `restoreFromSession(ctx)` on session change
  - `storeResult(...)` + `pi.appendEntry("web-search-results", data)`
  - `/websearch` command creates `sessionToken` and starts curator server
  - `/search` command browses/deletes stored results

- `packages/web-access/README.md`
  - config fields: `workflow`, `summaryModel`, `curatorTimeoutSeconds`
  - documents `summary-review` as default curator mode
  - file table explicitly names `curator-server.ts`, `curator-page.ts`, `summary-review.ts`, `storage.ts`