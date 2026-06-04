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