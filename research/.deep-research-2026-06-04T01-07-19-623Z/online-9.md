# 1. Relevant external facts

- **`models.json` is a user-facing contract**, documented in `packages/coding-agent/docs/models.md`. It supports:
  - provider-level `baseUrl`, `api`, `apiKey`, `headers`, `authHeader`, `compat`
  - model-level `thinkingLevelMap`, `compat`, `cost`, `contextWindow`, `maxTokens`, `input`
  - shell/env/literal resolution for auth/header values
- **Custom providers are an extension ABI**, documented in `packages/coding-agent/docs/custom-provider.md`, via `pi.registerProvider()` / `pi.unregisterProvider()`.
- **Provider/API compatibility is semantic, not just structural**:
  - `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, etc. are distinct APIs
  - `compat` flags control wire-format differences like developer-role handling, reasoning effort, tool-result naming, and routing preferences
- **Auth is multi-source and prioritized**:
  - stored `auth.json`
  - runtime `--api-key`
  - env vars
  - models.json fallback key/command
  - OAuth refresh with locking

# 2. Local implications

For a Rust migration, these pieces are the highest-risk compatibility surface:

- **Model registry must preserve merge rules**
  - built-ins + `models.json` + dynamic registrations all interact
  - provider overrides can be “override-only” (`baseUrl`/`headers`) or “replacement” (`models`)
  - unregister must restore built-ins cleanly

- **Model resolution must stay byte-for-byte compatible**
  - bare model IDs, `provider/model`, alias-vs-dated version matching, and `:thinking` suffix parsing all affect `/model`, `--model`, and resume flows

- **Auth storage behavior must remain stable**
  - file layout, read/merge rules, lock behavior, and OAuth refresh semantics are part of user-visible state
  - `getAuthStatus()` intentionally does **not** execute shell commands
  - `getApiKey()` **does** resolve command/env/literal values and may refresh OAuth

- **Custom provider compatibility is not optional**
  - extensions can register new providers, override built-ins, add OAuth, and replace stream handlers
  - Rust needs a replacement for dynamic extension-time registration or a compatibility layer if JS extensions remain

- **Request-time resolution must be preserved**
  - `apiKey`/headers from `models.json` are resolved at request time, not eagerly
  - this matters for shell commands, env vars, and caching behavior

# 3. Version/API assumptions

- I’m assuming the current contract is the one in `packages/coding-agent/docs/*.md` and `src/core/*.ts`.
- I’m also assuming Rust should keep:
  - the same `models.json`/`auth.json` file formats
  - the same provider IDs and API names
  - the same precedence rules for auth and model overrides
- If the Rust port intentionally changes extension loading or provider APIs, then `pi.registerProvider()` compatibility becomes the main breaking point.

# 4. Unverified or unnecessary research

- I did **not** research upstream Rust ecosystem equivalents yet, because the immediate migration risk is the repo’s own documented behavior.
- I also did not verify external library internals (`proper-lockfile`, `typebox`, `@earendil-works/pi-ai`) beyond what the local code already depends on.
- Next useful step would be a Rust-side design mapping for:
  - model registry data structures
  - auth persistence + locking
  - provider/plugin abstraction
  - model resolution parser/matcher