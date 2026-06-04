## Partition 42: Web curator server, curator page, storage, summary review, and search session persistence

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This subsystem is a **local browser-curator workflow** for web search results.

- `index.ts` orchestrates everything:
  - loads config (`~/.atomic/web-search.json` / legacy paths),
  - resolves provider availability,
  - starts searches,
  - opens the curator UI,
  - persists results into session history,
  - restores them on new sessions.
- `curator-server.ts` is the runtime server:
  - serves the HTML page at `/`,
  - streams live updates over SSE at `/events`,
  - accepts heartbeats, provider changes, new searches, rewrites, summary generation, submit, and cancel.
- `curator-page.ts` is the browser app shell:
  - renders the UI, embeds initial state, and drives the client-side state machine.
- `storage.ts` is the in-memory cache plus session rehydration layer:
  - stores `search` and `fetch` results by ID,
  - restores only recent entries from session branch history.
- `summary-review.ts` builds and optionally generates the summary draft:
  - prefers configured/available models,
  - falls back to deterministic summaries when needed.

For Rust migration, this partition is mostly about preserving a **contract**, not a specific implementation: server endpoints, event flow, session persistence format, and summary-review semantics.

## 2. Key flows and invariants

### Curator session lifecycle
1. `index.ts` creates a session token and starts `startCuratorServer(...)`.
2. The server only accepts requests with the matching `session` token.
3. Browser connects via `/events`; SSE carries:
   - `result`
   - `search-error`
   - `done`
4. User can:
   - add searches,
   - rewrite queries,
   - choose provider,
   - generate/edit/approve summary,
   - submit raw results or summarized output,
   - cancel.

### Submission invariants
- `/submit` accepts a `selectedQueryIndices` array.
- Indices are validated:
  - integers,
  - non-negative,
  - in-bounds,
  - deduplicated.
- Empty selection is allowed for submit, but not for summarize.
- Submit only works in `SEARCHING` or `RESULT_SELECTION`.
- After submit/cancel, the server is completed and rejects further stateful actions.

### Summary-review invariants
- Summary generation is model-backed when possible.
- If the model path fails or no model is available, deterministic fallback is used.
- `SummaryMeta` is normalized before returning/accepting:
  - `model` string or null,
  - finite non-negative duration/token counts,
  - boolean `fallbackUsed`,
  - optional `fallbackReason`, `edited`.
- On timeout, the system auto-submits using all results and a deterministic/approved summary path.

### Persistence invariants
- `storage.ts` keeps an in-memory map only.
- Restoration pulls from `ctx.sessionManager.getBranch()`.
- Only `customType === "web-search-results"` entries are restored.
- Entries older than 1 hour are ignored.
- Search entries require `queries`; fetch entries require `urls`.

### Coupling points
- Strong coupling to session manager / branch entries.
- Strong coupling to `modelRegistry` and `pi-ai` for summary/rewrite.
- Strong coupling to UI semantics in `curator-page.ts`.
- Strong coupling to `pi.appendEntry("web-search-results", ...)` for persistence.

## 3. Tests / validation

I did **not** find dedicated tests under `packages/web-access/*test*`.

What exists is indirect coverage:
- root/unit tests reference `packages/web-access` packaging and wiring,
- changelog/docs describe intended behavior,
- no obvious direct validation for:
  - curator server endpoints,
  - session restore rules,
  - summary fallback,
  - submit/cancel state machine.

For Rust migration, you’ll want explicit tests for:
- token rejection / wrong session,
- SSE buffering and reconnect,
- submit/cancel/summarize state transitions,
- timeout behavior,
- restore-from-session TTL,
- summary fallback vs model-backed generation.

## 4. Risks, unknowns, and verification steps

### Risks
- **No durable storage**: cache is in-memory; persistence depends on session entries elsewhere.
- **UI protocol is implicit**: browser JS and HTTP endpoints must stay in sync.
- **Model dependencies are external**: summary/rewrite depend on `pi-ai` and model registry behavior.
- **Timeout semantics are subtle**: browser connection, heartbeat, and stale watchdog interact.
- **Submit/cancel side effects are asynchronous**: callbacks are `setImmediate`-scheduled.
- **Edge-case compatibility**: selected indices, empty summary, aborted rewrite, superseded summarize request.

### Unknowns
- Exact browser-side expectations in `curator-page.ts` beyond the bootstrap payload and endpoints.
- Whether session-entry schema is formally enforced elsewhere.
- Whether any hidden tests or integration harnesses cover this behavior.

### Verify by
- capturing HTTP contract tests for `/`, `/events`, `/search`, `/summarize`, `/submit`, `/cancel`, `/provider`, `/heartbeat`, `/rewrite`;
- tracing the browser JS requests in `curator-page.ts`;
- adding session-restore tests against mocked `ExtensionContext`;
- checking timeout + stale-watchdog behavior with fake timers.

### Online Researcher
## 1. Relevant external facts

- **Server-Sent Events (SSE)** use the `text/event-stream` MIME type, and each event is terminated by a **blank line**. MDN also notes that `EventSource` clients **reconnect automatically** if the connection closes. This matters because your curator server’s `/events` stream must preserve that wire format and reconnect-friendly behavior.  
  Sources: MDN *Using server-sent events*, WHATWG HTML Standard SSE section.

- In Rust, the common SSE abstractions are already modeled in web frameworks like **`axum::response::sse`** (`Sse`, `Event`, `KeepAlive`) and **`warp::sse`**. These are the closest equivalents to your current manual `http.Server` + `res.write(...)` implementation.  
  Source: `axum::response::sse` docs.

## 2. Local implications

- `packages/web-access/curator-server.ts` is the real **runtime contract** you’d need to preserve in Rust:
  - `/` serves the curator UI with a `session` token gate.
  - `/events` is an SSE channel with buffering + keepalive.
  - `/search`, `/summarize`, `/rewrite`, `/submit`, `/cancel`, `/provider`, `/heartbeat` all enforce the same session token and state machine.
- The server tracks:
  - **browser liveness** (`heartbeat`, stale watchdog)
  - **session state** (`SEARCHING → RESULT_SELECTION → COMPLETED`)
  - **in-flight summarize aborts** and request supersession
  - **body size limit** (`64 KiB`)
- `packages/web-access/storage.ts` is only **in-memory cache + session restore**, not durable persistence. The Rust port only needs a persistent store if you want to go beyond current behavior.
- `packages/web-access/summary-review.ts` defines the summary semantics you’d want to keep:
  - preferred model fallback order
  - deterministic fallback summary
  - summary metadata shape (`model`, `durationMs`, `tokenEstimate`, `fallbackUsed`, etc.)
- `packages/web-access/curator-page.ts` is a **browser-side state machine** embedded as HTML/CSS/JS. A Rust backend can replace the server, but the page behavior and payloads must stay compatible unless you rewrite the client too.

## 3. Version/API assumptions

- Current implementation assumes **Node `http`** semantics (`IncomingMessage`, `ServerResponse`) and **manual SSE writes**.
- A Rust migration should assume:
  - an async runtime like **Tokio**
  - an HTTP framework with **streaming SSE support** (e.g. Axum 0.7+)
  - equivalent request-body limits, abort handling, and keepalive timers
- No Rust crate/version is required yet to understand the migration; the key is preserving the wire protocol and session/state behavior.

## 4. Unverified or unnecessary research

- I did **not** verify the full `curator-page.ts` client logic line-by-line; for backend migration, the important part is the server API contract, not every UI detail.
- I did **not** inspect test coverage for these modules; that’s useful for implementation, but not required to understand the migration surface.
- I did **not** research durable storage options because the current code is ephemeral/in-memory plus session restore.