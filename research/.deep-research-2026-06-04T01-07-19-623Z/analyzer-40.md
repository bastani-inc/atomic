## 1. Behavioral model

This partition is the repo’s **search/extraction provider layer**.

- `web-access/index.ts` exposes the user-facing tools, including `web_search` and `code_search`.
- Search is routed through `gemini-search.ts`, which resolves providers in this order:
  - explicit `perplexity`
  - explicit `gemini`
  - explicit `exa`
  - `auto` fallback: **Exa → Perplexity → Gemini**
- Provider availability is determined by API key presence and/or browser cookie access:
  - Perplexity: `PERPLEXITY_API_KEY` or config file
  - Gemini API: `GEMINI_API_KEY` or config file
  - Gemini Web: Chrome cookies, gated by `allowBrowserCookies` / env opt-in
  - Exa: `EXA_API_KEY` or config file; if absent, it falls back to Exa MCP

`code_search.ts` is separate from general web search:
- It first tries Exa’s code-context MCP tool (`get_code_context_exa`)
- If that tool is missing, it falls back to Exa’s normal web search tool with code-focused query expansion

## 2. Key flows and invariants

### General search flow
1. `web_search` comes in through `index.ts`
2. Config is read from `~/.atomic/web-search.json` (legacy-compatible path logic exists elsewhere)
3. Provider availability is checked
4. Search executes through `gemini-search.ts`
5. Results are attributed with the resolved provider

### Fallback behavior
- Explicit provider mode is sticky unless that provider is unavailable.
- `auto` mode always prefers Exa when available.
- If Exa is selected explicitly and no API key exists, it does **not** fail immediately; it can fall through to Exa MCP.
- If a provider throws due to abort, abort is rethrown and not converted into a fallback error.
- If auto fallback fails across multiple providers, the thrown error aggregates provider-specific failures.

### API key handling
- Blank/whitespace keys are treated as absent.
- Env vars override config.
- Config parse failures are surfaced as hard errors.
- Exa has a special split:
  - with key: direct REST API + monthly quota tracking
  - without key: MCP proxy path

### Code search invariants
- Empty query is rejected up front.
- `maxTokens` defaults to 5000.
- Result text is truncated heuristically to approximate token budget.
- Once the code-context MCP tool is proven missing, later calls skip it and go straight to fallback search.

### Gemini Web invariants
- Browser cookie access must be explicitly enabled.
- Cookie lookup requires specific Google auth cookies.
- Model fallback inside Gemini Web downgrades to `gemini-2.5-flash` if the requested model is unavailable.

## 3. Tests / validation

I did not find dedicated tests in the obvious root search for this partition.

What is indirectly covered:
- Broad integration and unit tests exist elsewhere in the repo, but this partition’s exact fallback matrix is not clearly isolated.
- The code itself contains substantial guard logic for:
  - abort handling
  - invalid config parsing
  - missing API keys
  - missing Exa MCP tool
  - empty search responses

So the current validation story appears to be **implementation-driven**, not strongly test-driven for provider routing.

## 4. Risks, unknowns, and verification steps

### Risks for a TS → Rust migration
- This partition depends on **three external execution modes**:
  1. direct HTTP APIs
  2. browser-cookie-backed Gemini Web
  3. Exa MCP bridge
- A Rust rewrite must decide whether to:
  - reimplement all provider clients in Rust
  - keep JS shims for browser-cookie/MCP flows
  - or replace the whole provider stack with new Rust-compatible services

### Unknowns
- Exact test coverage for provider fallback is unclear.
- It’s unclear whether any hidden UI behavior depends on `curator-server.ts` and `summary-review.ts` metadata shape.
- The code search fallback may rely on Exa MCP response formatting staying stable.

### Verify next
- Inspect:
  - `web-access/README.md`
  - `curator-server.ts`
  - `summary-review.ts`
  - any integration tests around `web_search` / `code_search`
- Confirm:
  - whether Exa MCP is an external contractual dependency or replaceable implementation detail
  - whether browser-cookie Gemini Web is required for feature parity
  - whether “auto” provider order is a user-visible compatibility promise