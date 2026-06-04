## Partition 40: Web search providers, code search, provider fallback, and API key handling

### Locator
## 1. Must-read paths

- `packages/web-access/index.ts` — main entrypoint that registers web/search/fetch tools; best first stop for provider wiring and fallback behavior.
- `packages/web-access/exa.ts` / `packages/web-access/perplexity.ts` / `packages/web-access/gemini-*.ts` — provider-specific implementations; these are the likely API-key and request/response boundaries.
- `packages/web-access/code-search.ts` — separate “code search” path; important because it may use a different backend than general web search.
- `packages/web-access/config.ts` — provider selection, defaults, and env/config parsing likely live here.
- `packages/web-access/storage.ts` — likely where saved settings, tokens, or session-scoped auth state are persisted.
- `packages/web-access/curator-server.ts` / `packages/web-access/summary-review.ts` — fallback/review workflow around search results and content curation.
- `packages/coding-agent/src/core/model-registry.ts` — shared model/provider/auth registry; may define how API keys and provider names are normalized across the app.
- `packages/coding-agent/src/core/sdk.ts` — central agent-session boundary; relevant if search providers are exposed as tools or routed through model/session plumbing.
- `packages/coding-agent/docs/models.md` and `packages/coding-agent/docs/custom-provider.md` — likely document provider naming, auth, and config contracts you’ll need to preserve in Rust.
- `packages/coding-agent/docs/extensions.md` — if search tools are exposed as extension APIs, this is the compatibility surface.

## 2. Supporting paths

- `packages/web-access/extract.ts` — shared content extraction path after search results are fetched.
- `packages/web-access/github-extract.ts`, `packages/web-access/video-extract.ts`, `packages/web-access/pdf-extract.ts` — specialized fetchers that may share retry/fallback logic with search providers.
- `packages/web-access/youtube-extract.ts` — useful if search results can target video content.
- `packages/coding-agent/src/core/extensions/types.ts` — if web search is delivered as an extension tool, this defines the ABI to keep stable.
- `packages/coding-agent/src/core/extensions/loader.ts` — relevant only if provider implementations are dynamically loaded or pluginized.
- `packages/coding-agent/src/main.ts` — may wire CLI flags/env into provider selection and tool registration.
- `packages/coding-agent/src/config.ts` — app/env naming (`ATOMIC_*`, legacy compatibility) likely affects API key resolution.
- `docs/settings.md` / `docs/models.md` / `docs/development.md` — likely describe user-facing config knobs for providers and keys.
- `test/unit` and `packages/coding-agent/test` — look for tests covering provider fallback, env handling, or tool registration.

## 3. Entry points / symbols

- `packages/web-access/index.ts`
  - likely exports/registers the search tools.
- `packages/web-access/code-search.ts`
  - code-search implementation entrypoint.
- `packages/web-access/perplexity.ts`
  - provider client and API-key handling.
- `packages/web-access/exa.ts`
  - provider client and API-key handling.
- `packages/web-access/gemini-*.ts`
  - Gemini-backed search/fallback implementations.
- `packages/web-access/config.ts`
  - provider selection / env parsing.
- `packages/web-access/storage.ts`
  - persisted auth/settings.
- `packages/coding-agent/src/core/model-registry.ts`
  - provider registry, auth mapping, model/provider normalization.
- `packages/coding-agent/src/core/sdk.ts`
  - tool/provider/session integration point.

## 4. Gaps or uncertainty

- I could not directly verify the exact env var names or fallback order from source in this pass; `packages/web-access/config.ts` and provider files are the first files to confirm.
- The scout indicates provider fallback exists, but the precise decision tree (e.g. Exa → Perplexity → Gemini, or per-feature differences) is not yet verified.
- It’s unclear whether code search shares the same provider stack as general web search or has its own auth path.
- API key persistence may be in `storage.ts`, but that needs confirmation.
- Rust-migration relevance depends on whether you want:
  - a Rust replacement for the provider clients,
  - a Rust host that still shells out to JS for search,
  - or an adapter layer preserving the current tool API.

### Pattern Finder
## 1. Established patterns

- **Provider selection is centralized and normalized.**  
  `packages/web-access/gemini-search.ts` defines the canonical provider union: `auto | perplexity | gemini | exa`, with `normalizeSearchProvider()` and config-backed `searchProvider`/`provider` parsing.

- **“Auto” means ordered fallback, not round-robin.**  
  In `search()` (`packages/web-access/gemini-search.ts`), provider order is:
  1. Exa
  2. Perplexity
  3. Gemini API
  4. Gemini Web  
  This is the main compatibility contract to preserve in Rust.

- **Provider availability is checked separately from provider execution.**  
  `isExaAvailable()`, `isPerplexityAvailable()`, and `isGeminiApiAvailable()` are used as feature gates, while `searchWithExa/searchWithPerplexity/searchWithGemini*` do the actual work.

- **API keys come from env first, then `~/.atomic/web-search.json`.**  
  Patterns repeat across providers:
  - `PERPLEXITY_API_KEY` or `perplexityApiKey`
  - `EXA_API_KEY` or `exaApiKey`
  - `GEMINI_API_KEY` or `geminiApiKey`

- **Code search is a thin Exa-backed adapter with fallback.**  
  `packages/web-access/code-search.ts` tries `get_code_context_exa`; if missing, it falls back to `web_search_exa` with a code-oriented query rewrite.

- **Exa has dual transport modes.**  
  `packages/web-access/exa.ts` uses:
  - direct HTTP if API key exists
  - MCP fallback (`https://mcp.exa.ai/mcp`) when no key is configured

- **Search results are normalized to a shared shape.**  
  All providers converge on:
  - `answer`
  - `results: [{ title, url, snippet }]`
  - optional `inlineContent`

- **UI/curation is downstream of search, not coupled to provider choice.**  
  `packages/web-access/index.ts` passes the selected provider into curator flows, but the browser/curator pipeline is separate from provider resolution.

## 2. Variations / exceptions

- **Exa is the only provider with usage limiting.**  
  `packages/web-access/exa.ts` tracks monthly usage in a local JSON file and can return `{ exhausted: true }`.

- **Gemini has two distinct implementations.**  
  `packages/web-access/gemini-search.ts` tries:
  1. Gemini API
  2. Gemini Web (browser cookies / logged-in Chromium)  
  This is a nontrivial split you’ll likely need to model explicitly in Rust.

- **Gemini provider fallback is intentionally permissive.**  
  If the configured provider is `gemini` but the API path fails, it may still try browser-based Gemini depending on availability.

- **Exa fallback behavior depends on whether an API key exists.**  
  If key is missing, fallback to MCP is allowed.  
  If key exists and the direct API path fails, errors are surfaced instead of silently falling back.

- **Search config supports both `provider` and `searchProvider`.**  
  `gemini-search.ts` accepts either key when reading config.

- **Code search uses a separate MCP tool namespace.**  
  `code-search.ts` prefers `get_code_context_exa`, but it does not implement its own provider model.

## 3. Anti-patterns or risks

- **Implicit fallback can hide missing provider support.**  
  Auto mode may make a half-working Rust port look fine until a provider is unavailable in a user environment.

- **Config/error messages are user-facing contracts.**  
  The exact text around missing keys (`Perplexity API key not found`, `GEMINI_API_KEY not configured`, etc.) is part of UX and may be relied on in tests/docs.

- **Environment + config duplication is everywhere.**  
  Each provider has its own key loader and config schema. This is easy to drift if rewritten piecemeal.

- **Gemini Web is tightly coupled to browser-cookie access.**  
  `gemini-search.ts` depends on browser availability and cookie extraction; in Rust this is likely a subprocess/webview bridge, not a pure library port.

- **Exa MCP parsing is brittle.**  
  `callExaMcp()` parses SSE/JSON-ish payloads manually; this is a likely migration hotspot if you want stability.

- **Provider fallback semantics are asymmetric.**  
  Exa fallback works differently from Gemini fallback, so “one generic search provider interface” would lose current behavior unless carefully modeled.

## 4. Evidence index

- `packages/web-access/gemini-search.ts`
  - `SearchProvider = "auto" | "perplexity" | "gemini" | "exa"`
  - `search()` fallback chain
  - `getSearchConfig()`, `normalizeSearchProvider()`
  - `searchWithGeminiApi()`, `searchWithGeminiWeb()`

- `packages/web-access/perplexity.ts`
  - `getApiKey()`
  - `isPerplexityAvailable()`
  - `searchWithPerplexity()`

- `packages/web-access/exa.ts`
  - `getApiKey()`, `hasExaApiKey()`
  - `isExaAvailable()`
  - `searchWithExa()`
  - `searchWithExaMcp()`
  - local monthly usage file

- `packages/web-access/code-search.ts`
  - `CODE_CONTEXT_TOOL = "get_code_context_exa"`
  - fallback to `web_search_exa`
  - query rewrite for code/docs/search intent

- `packages/web-access/gemini-api.ts`
  - `getApiKey()`
  - `isGeminiApiAvailable()`
  - `GEMINI_API_KEY` handling

- `packages/web-access/index.ts`
  - tool registration for `web_search`
  - provider selection saved from UI
  - curator flows pass `provider` through to `search()`

### Analyzer
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

### Online Researcher
## 1. Relevant external facts

No external docs were verified in this partition yet.

What *does* matter externally for a Rust migration is the behavior of the underlying providers/APIs used by:

- Exa
- Perplexity
- Gemini
- any shared model/provider registry in `@bastani/atomic`

Those APIs will determine:
- auth format / API-key handling
- fallback ordering
- response shape normalization
- rate-limit/error handling

## 2. Local implications

This repo’s migration surface for “web search providers, code search, fallback, and API keys” is centered on:

- `packages/web-access/index.ts` — tool registration and entry wiring
- `packages/web-access/config.ts` — provider selection/defaults/env parsing
- `packages/web-access/exa.ts`
- `packages/web-access/perplexity.ts`
- `packages/web-access/gemini-*.ts`
- `packages/web-access/code-search.ts` — may have a separate backend/auth path
- `packages/web-access/storage.ts` — likely persisted auth/settings
- `packages/web-access/curator-server.ts` and `summary-review.ts` — fallback/review flow after search
- `packages/coding-agent/src/core/model-registry.ts` — shared provider normalization/auth mapping
- `packages/coding-agent/src/core/sdk.ts` — tool/session integration boundary

Migration implication:
- If you want a true Rust port, these files define the JS/TS contract you must preserve.
- If you want a hybrid migration, keep the current tool API stable and replace provider internals first.
- Code search may not share the same provider stack as general web search, so treat it as a separate migration path until confirmed.

## 3. Version/API assumptions

Assumptions not yet verified from source/docs:

- exact env var names for API keys
- exact fallback order between Exa / Perplexity / Gemini
- whether code search reuses the same auth/config path
- whether keys are persisted in `storage.ts` or only read from env
- whether provider normalization is centralized in `model-registry.ts` or duplicated

## 4. Unverified or unnecessary research

Not enough source was inspected here to claim exact provider behavior.

Next verification targets should be:
1. `packages/web-access/config.ts`
2. `packages/web-access/exa.ts`
3. `packages/web-access/perplexity.ts`
4. `packages/web-access/code-search.ts`
5. `packages/web-access/storage.ts`
6. `packages/coding-agent/src/core/model-registry.ts`

If you want, I can do the next pass and turn this into a concrete Rust migration plan.