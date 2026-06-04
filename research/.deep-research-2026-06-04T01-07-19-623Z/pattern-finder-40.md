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