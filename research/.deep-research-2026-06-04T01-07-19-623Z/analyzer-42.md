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