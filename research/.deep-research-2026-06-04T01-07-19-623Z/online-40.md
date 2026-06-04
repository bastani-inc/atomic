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