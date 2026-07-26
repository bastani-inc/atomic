# Copilot removal inventory (pre-derived, 2026-07-26)

User contract: **treat `github-copilot` EXACTLY like upstream pi.** No Atomic-specific
Copilot special-casing anywhere. The provider must flow through the same generic path as
every other upstream provider, sourced from `githubCopilotProvider()` in
`@earendil-works/pi-ai`.

Decisions already made by the user (do not relitigate):
- Remove **all** custom copilot logic: catalog **and** runtime request/response shims.
- Accept upstream `contextWindow` / `maxTokens` values **verbatim**.
- Do **not** keep a local override/fallback table. Issue #1608's CAPI corrections are
  intentionally dropped; `contextWindowOptions` for copilot models is intentionally dropped.

## 1. Source files to DELETE (all of `packages/coding-agent/src/core/copilot-*.ts`)

| File | Lines |
|---|---|
| `copilot-model-catalog.ts` | 498 |
| `copilot-anthropic-sse-repair.ts` | 379 |
| `copilot-gemini-payload-sanitizer.ts` | 357 |
| `copilot-gemini-reasoning.ts` | 331 |
| `copilot-gemini-tool-arguments.ts` | 201 |
| `copilot-model-synthesis.ts` | 100 |
| `copilot-model-static-fallbacks.ts` | 95 |
| `copilot-errors.ts` | 39 |
| `copilot-hosts.ts` | 34 |

Total 2034 lines. After removal, `ls packages/coding-agent/src/core/copilot-*.ts` must be empty.

## 2. Source consumers to REWIRE (imports must go away)

| File | Imports |
|---|---|
| `src/core/agent-session-auto-compaction.ts` | `parseCopilotPromptLimitError` |
| `src/core/agent-session-events.ts` | `formatCopilotProviderError` |
| `src/core/agent-session-retry.ts` | `isCopilotGeminiModel`, `normalizeToolArgumentsForModel` |
| `src/core/agent-session-tool-registry.ts` | `normalizeToolArgumentsForModel` |
| `src/core/compaction/branch-summarization.ts` | `formatCopilotProviderError` |
| `src/core/http-dispatcher.ts` | `installCopilotResponseInterceptor` |
| `src/core/model-registry-builtins.ts` | `copilotApiBaseUrlFromToken`, `copilotTokenFromEnvironment`, `DEFAULT_COPILOT_API_BASE_URL`, `getActiveCopilotModelCatalog`, `copilotTemplateFromModels`, `copilotThinkingLevelMapFor`, `synthesizeCopilotCatalogModels`, `getStaticCopilotModelFallback` |
| `src/core/model-registry.ts` | `copilotApiBaseUrlFromToken`, `copilotCatalogCachePath`, `copilotTokenFromEnvironment`, `seedActiveCopilotModelCatalogFromCache` |
| `src/core/sdk.ts` | `sanitizeCopilotGeminiPayload`, `restoreCopilotGeminiReasoningOpaque`, `normalizeCopilotGeminiReplayToolArguments` |
| `src/modes/interactive/interactive-mode-deps.ts` | re-exports 7 catalog symbols |

Also check (referenced copilot by name, may only need comment/string cleanup):
`src/cli/args.ts`, `src/core/agent-session-methods.ts`, `src/core/agent-session-models.ts`,
`src/core/agent-session-types.ts`, `src/core/context-window.ts`,
`src/core/flattened-tool-arguments.ts`, `src/core/model-registry-auth.ts`,
`src/core/model-resolver-defaults.ts`, `src/core/provider-display-names.ts`,
`src/modes/interactive/components/context-window-selector.ts`,
`src/modes/interactive/components/login-dialog.ts`,
`src/modes/interactive/interactive-mode-base.ts`,
`src/modes/interactive/interactive-mode-surface.ts`,
`src/modes/interactive/interactive-model-catalog-startup.ts`,
`src/modes/interactive/interactive-model-routing.ts`,
`src/modes/interactive/interactive-startup.ts`

## 3. Test files to DELETE (test the deleted modules)

- `test/copilot-anthropic-sse-repair.test.ts`
- `test/copilot-errors.test.ts`
- `test/copilot-gemini-payload-sanitizer.test.ts`
- `test/copilot-gemini-reasoning.test.ts`
- `test/copilot-gemini-tool-arguments.test.ts`
- `test/copilot-model-catalog.test.ts`
- `test/copilot-model-static-fallbacks.test.ts`
- `test/copilot-model-synthesis.test.ts`
- `test/agent-session-copilot-catalog-refresh.test.ts`

## 4. Test files to REWIRE (import deleted modules but test other things)

- `test/agent-session-dynamic-provider.test.ts`
- `test/context-window-session/model-switching.suite.ts`
- `test/context-window-session/session-journaling.suite.ts`
- `test/context-window-session/settings-defaults.suite.ts`
- `test/model-registry-context-window.suite.ts`

## 5. Docs to UPDATE

`packages/coding-agent/docs/{models,providers,rpc,sdk,settings}.md`, plus
`docs/environment-variables.md` and `README.md` if they mention the removed surface.

Remove documentation of Atomic-only Copilot behaviour and env vars:
`COPILOT_GITHUB_TOKEN` (**note:** upstream pi *does* read this one via `envApiKeyAuth`, so keep
it documented as an upstream-provided key), `COPILOT_API_TARGET`, `GITHUB_COPILOT_BASE_URL`,
`GITHUB_SERVER_URL` copilot routing, the live `/models` catalog refresh, the catalog disk
cache, and Copilot long-context tier selection.

## 6. IMPORTANT — what must NOT be removed

Plain references to the `github-copilot` **provider id** or `github-copilot/<model>` model
ids are legitimate and must stay working; upstream ships that provider. Many tests across
`test/unit/` use `github-copilot/...` ids purely as fixtures. Only Atomic's *custom* logic goes.

## 7. Upstream replacement surface

`node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.js` →
`githubCopilotProvider()`, 29 models across `anthropic-messages` (10),
`openai-completions` (7), `openai-responses` (12); static JSON at
`providers/data/github-copilot.json`; `baseUrl` hardcoded
`https://api.individual.githubcopilot.com`; auth = `envApiKeyAuth(["COPILOT_GITHUB_TOKEN"])`
+ `lazyOAuth(loadGitHubCopilotOAuth)`; `filterModels` narrows by
`credential.availableModelIds` for OAuth.

## 8. Verification gates (all must pass)

```
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration
bun run --cwd packages/coding-agent test
bun run check:file-length
bun run check:shrinkwrap
bun run --cwd packages/coding-agent docs:check
```

Plus: `grep -rn "opilot" packages/coding-agent/src/` must return **only** legitimate
`github-copilot` provider-id / model-id references — no custom module, env var, catalog,
cache, interceptor, sanitizer, or shim logic.
