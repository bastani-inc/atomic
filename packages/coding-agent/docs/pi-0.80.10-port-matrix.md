---
title: "Pi v0.80.10 port matrix"
description: "Disposition and evidence for Atomic's Pi v0.80.10 compatibility migration"
---

# Pi v0.80.10 port matrix

Atomic consumes Pi's `v0.80.10` libraries while preserving the public Atomic SDK, extension APIs, branding, configuration paths, and first-party bundles. This matrix records the deliberate audit of `earendil-works/pi` from `v0.80.7` through `v0.80.10` for issue [#1875](https://github.com/bastani-inc/atomic/issues/1875).

Disposition meanings:

- **Ported**: adapted into Atomic-owned coding-agent source.
- **Equivalent**: Atomic already had the required behavior.
- **Dependency-inherited**: supplied by `pi-ai`, `pi-agent-core`, or `pi-tui`; no upstream package source was copied.
- **Intentionally excluded**: unrelated product, release, CI, generated-catalog, or repository infrastructure.
- **Not applicable**: the upstream path does not exist in Atomic.

## Required coding-agent behavior

| Upstream change | Disposition | Atomic evidence |
| --- | --- | --- |
| Provider-owned authentication and model discovery | **Ported with compatibility bridge.** Atomic's synchronous `AuthStorage` and existing SDK options remain supported through a private async credential adapter. Runtime-only API keys participate in provider auth/catalog discovery without persistence; serialized refresh/login/delete operations remain transactional on persistence failure. Legacy extension OAuth definitions and the `@earendil-works/pi-ai/oauth` / `@mariozechner/pi-ai/oauth` runtime aliases retain registration, discovery, refresh, and API-key helpers. | `src/core/auth-storage.ts`, `src/core/oauth-provider-bridge.ts`, `src/core/oauth-compat.ts`, `src/core/extensions/loader-virtual-modules.ts`, `test/model-auth-compatibility.test.ts`, `test/auth-storage-persistence.test.ts`, `test/extensions-loader-virtual-modules.test.ts` |
| Complete request `ModelAuth` (`apiKey`, `headers`, credential `baseUrl`) | **Ported.** Provider-owned headers and endpoints are retained even when a runtime API key overrides stored OAuth. Null header removals and credential-specific endpoints reach main chat, compaction, bundled MCP sampling, and bundled web-search summary/rewrite requests without bypassing Atomic retries, attribution, request hooks, or fast mode. | `src/core/model-registry-auth.ts`, `src/core/sdk.ts`, `src/core/agent-session-compaction.ts`, `packages/mcp/sampling-handler.ts`, `packages/web-access/summary-review.ts`, `packages/web-access/web-search-summary.ts`, `test/model-auth-compatibility.test.ts`, `test/sdk-stream-options.test.ts` |
| Async configured-provider catalog refresh | **Ported.** Atomic's registry composes Pi's provider-owned `Models` facade with persisted `pi.dev` overlays and legacy extension `refreshModels` hooks. Refreshes run concurrently, retain stale/successful snapshots on partial failure, enforce generation and per-provider identity guards, and support force plus hard abort/timeout bounds. Registry-owned API/OAuth registrations are source-scoped, so refresh/session startup cannot erase external or sibling-registry providers. Existing synchronous reads remain available after callers await refresh. | `src/core/model-registry.ts`, `src/core/models-store.ts`, `src/core/remote-catalog-provider.ts`, `src/modes/interactive/components/model-selector.ts`, `test/model-registry-dynamic-providers.suite.ts`, `test/suite/regressions/2860-replaced-session-context.test.ts`, `test/remote-catalog-provider.test.ts`, `test/model-selector-refresh-status.test.ts` |
| Forced model-catalog refresh | **Ported as Atomic CLI behavior.** `atomic update --models` force-refreshes authenticated provider-owned catalogs with a 15-second bound and persists provider-scoped snapshots. | `src/package-manager-cli.ts`, `src/package-manager-cli-parser.ts`, `test/package-command-model-refresh.test.ts` |
| Adjacent assistant thinking blocks render as one section | **Ported.** Runs coalesce without crossing text or tool-call boundaries; hidden thinking produces one label per run. | `src/modes/interactive/components/assistant-message.ts`, `test/assistant-message.test.ts` |
| OpenAI Codex inherited session IDs are clamped to 64 characters | **Dependency-inherited** from `pi-ai` v0.80.10. Atomic continues passing its session ID to the Pi transport and does not replace that transport behavior. | `src/core/sdk.ts`, `test/codex-session-id-clamp.test.ts` |
| Restore Windows terminal title after npm package checks | **Ported.** Restoration runs after both fulfillment and rejection, only for an initialized Windows UI. | `src/modes/interactive/interactive-startup.ts`, `test/interactive-windows-title-restore.test.ts` |
| Bundle login OAuth adapters in Bun standalone binaries | **Ported.** Registration occurs before application startup; the bundle regression proves Anthropic/Codex/Copilot/xAI/device-flow code is statically present. | `src/bun/cli.ts`, `test/bun-cli-oauth-bundle.test.ts` |
| Provider-owned login labels and discovery | **Ported.** Interactive login enumerates built-in provider auth plus legacy extension bridges without using the removed global OAuth runtime. | `src/modes/interactive/components/login-dialog.ts`, `src/modes/interactive/interactive-auth-login.ts`, `test/model-auth-compatibility.test.ts` |
| Explain clone/fork before the first assistant response | **Ported** with the upstream message verbatim in the shared runtime path. | `src/core/agent-session-runtime.ts`, `test/suite/agent-session-runtime.test.ts` |

## Dependency-inherited fixes

These behaviors are taken only through the installed v0.80.10 packages, as required; Atomic does not copy their source.

| Package behavior | Disposition and integration check |
| --- | --- |
| `pi-tui` terminal tab normalization | **Dependency-inherited.** All Atomic terminal rendering uses the installed `pi-tui`. |
| xAI device OAuth, Grok Responses routing, and corrected catalog restoration | **Dependency-inherited.** Atomic's provider-owned login bridge discovers xAI auth, and full request auth is preserved. |
| Kimi K3 output limits and Moonshot pricing | **Dependency-inherited.** Atomic consumes installed model metadata without a competing generated catalog. |
| Kimi adaptive thinking, empty-signature handling, and supported thinking-level metadata | **Dependency-inherited.** Atomic retains Pi model metadata and request streaming rather than copying provider transforms. |
| OpenAI Codex 64-character session-ID clamp | **Dependency-inherited.** `test/codex-session-id-clamp.test.ts` drives Atomic's installed Pi transport and verifies the exact 64-character request header. |

## Full comparison audit

| Comparison item | Disposition |
| --- | --- |
| Remote model-catalog protocol and extension `refreshModels` | **Ported where compatible** through provider-scoped storage, persisted `pi.dev` overlays, the provider-owned `Models` facade, and the preserved Atomic extension contract. |
| xAI login label/default integration | **Ported where exposed** through provider-owned descriptors; catalog/default data remains dependency-inherited. |
| Kimi deferred-tools example/schema | **Intentionally excluded** as an unrelated product feature not selected by #1875. |
| Generated catalog publication and R2 scripts | **Intentionally excluded** repository infrastructure. |
| Upstream CI, release scripts, version stamps, changelog bookkeeping | **Intentionally excluded**. Atomic keeps its own release flow and `0.0.0` source manifests. |
| Upstream branding, package names, CLI/path changes | **Not applicable / intentionally excluded**. Atomic retains `@bastani/*`, `atomic`, `.atomic`, and `~/.atomic`. |
| Upstream wholesale coding-agent replacement | **Intentionally excluded**. Ports above are narrow adaptations that preserve Atomic-specific Copilot/Cursor/Gemini behavior, retries, persistence, compaction, loader aliases, and bundled extensions. |

## Compatibility notes

The removed `@earendil-works/pi-ai/oauth` runtime is type-only in v0.80.10. Atomic extensions should continue using `pi.registerProvider(...)`; existing `oauth` definitions remain supported, while new dynamic providers may add async `refreshModels(context)`. SDK consumers may continue supplying `authStorage` and `modelRegistry`. Await `modelRegistry.refresh()` before dependent reads. See [Custom providers](/custom-provider) and [SDK](/sdk).
