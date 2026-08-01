---
date: 2026-07-31
researcher: Claude Opus 5
git_commit: a2dfa210d14f1f80f833af83b7b7a9b084839c18
branch: pi-0.83.0/port-coding-agent
repository: atomic-monorepo (linked worktree atomic-pi-0.83.0)
topic: Pi v0.82.1..v0.83.0 upstream commit and file port matrix
tags: [implementation, evidence, pi-0.83.0, port-matrix]
status: complete
last_updated: 2026-07-31
last_updated_by: Claude Opus 5
breaking_changes_allowed: false
compatibility_context: Preserve Atomic public SDK, branding, CLI, paths, legacy PI_*/.pi aliases, providers, isolated runtime, Verbatim Compaction, and versionless manifests.
---

# Pi v0.83.0 Port Matrix

This matrix classifies **every one of the 63 commits** in upstream `v0.82.1..v0.83.0` against
Atomic's own `packages/coding-agent/src`. Each row carries the upstream SHA so the
classification is checkable against the recorded evidence files, plus the Atomic file and line
evidence for the outcome.

Classification vocabulary — exactly one per commit:

| Classification | Meaning |
| --- | --- |
| **ported** | Upstream behaviour now present in Atomic-owned source, adapted only where Atomic's file split requires it. |
| **intentionally adapted** | Upstream behaviour is present, but the mechanism differs because Atomic's architecture differs. The difference is deliberate and stated. |
| **inherited dependency** | The change lives in `packages/ai`, `packages/tui`, or `packages/agent`, which Atomic consumes as exact-resolved `@earendil-works/pi-*` `0.83.0`. Atomic vendors no copy. |
| **equivalent** | Atomic already had the behaviour before this range; nothing to do. |
| **not applicable** | No Atomic counterpart exists: upstream release stamps, upstream-only packages, repository governance, upstream test-harness maintenance, or bookkeeping commits. |

## Source and counting basis

- Commit inventory (63 rows): [`research/upstream-v0.82.1-v0.83.0-commits.txt:1-63`](upstream-v0.82.1-v0.83.0-commits.txt).
- Per-commit changed paths: [`research/upstream-v0.82.1-v0.83.0-commit-paths.txt:1-352`](upstream-v0.82.1-v0.83.0-commit-paths.txt).
- File inventory (124 rows): [`research/upstream-v0.82.1-v0.83.0-name-status.txt:1-124`](upstream-v0.82.1-v0.83.0-name-status.txt).
- Range summary: [`research/upstream-v0.82.1-v0.83.0-log-stat.txt:1-937`](upstream-v0.82.1-v0.83.0-log-stat.txt).
- Full upstream coding-agent patch: [`research/upstream-v0.82.1-v0.83.0-coding-agent.diff:1-2918`](upstream-v0.82.1-v0.83.0-coding-agent.diff).

Atomic declares and resolves exact pi `0.83.0` for agent-core, AI, and TUI
(`packages/coding-agent/package.json:83-85`; `package-lock.json:742-745`), adopted on the
branch below this one (`pi-0.83.0/adopt-upstream`, commit `fb2025ea7`). Every
**inherited dependency** row below rests on that resolution; this branch adds no copy of those
packages.

## Scope boundary of this change

Upstream `99e34013` (`feat: auth print`) adds a door that emits a live credential to stdout. The
design (§5.6) carved it into its own layer, `pi-0.83.0/credential-export`, so that a reviewer
would see the secret-emitting door on its own rather than inside a large upstream port.

**That split was overridden by the repository owner, and the door is implemented on this
branch.** It lands as its own commit rather than its own branch, so the diff a security reviewer
needs is still one self-contained changeset. The earlier commit on this branch recorded the
opposite scope; this section is the current state, and the row for `99e34013` below is
classified **ported** accordingly.

The door is the negotiated contract from design §5.1–5.2 and §7.1, which is stricter than
upstream's implementation, not a copy of it. Upstream raises one undifferentiated
`CredentialPrintError` and always exits `1`; the negotiated door adds a typed `Secret`, one exit
code per failure, and an enforced stdout discipline. See the `99e34013` row for the file and
line evidence, and "Credential-export deviations from upstream" below for each difference.

`ModelRuntimeAuthOverrides.minOAuthValidityMs` was already declared in Atomic before this
branch — it arrived with the `ModelRuntime` adoption (`5ef323e3f`) at
`packages/coding-agent/src/core/model-runtime-types.ts:21` and had no reader. This change is
what gives it one; the declaration itself is untouched.

## Commit matrix (63/63)

| # | Commit | Subject | Classification | Evidence |
|---:|---|---|---|---|
| 1 | `845d6ff1` | Release v0.83.0 | **not applicable** | Version stamps across upstream manifests, changelogs, and locks (`…commit-paths.txt:1-28`). Atomic keeps every `packages/*/package.json` at the `0.0.0` versionless placeholder (`packages/coding-agent/package.json:3`) and its own release identity. |
| 2 | `44b26c9b` | fix(tui): format image fallback changes | **inherited dependency** | `packages/tui/src/terminal-image.ts` + its test (`…commit-paths.txt:29-32`). TUI is consumed as exact `@earendil-works/pi-tui@0.83.0` (`package-lock.json` `node_modules/@earendil-works/pi-tui`); Atomic vendors no TUI source. |
| 3 | `f0499a63` | docs: audit changelogs since v0.82.1 | **not applicable** | Upstream `packages/{ai,coding-agent,tui}/CHANGELOG.md` only (`…commit-paths.txt:33-37`). Atomic maintains its own `[Unreleased]` history (`packages/coding-agent/CHANGELOG.md:3`). |
| 4 | `34239180` | fix(ai): preserve function arguments with empty custom payloads | **inherited dependency** | `packages/ai/src/api/openai-completions.ts` (`…commit-paths.txt:38-41`). Tool-argument serialization is owned by `pi-ai`. |
| 5 | `21f579a9` | chore: approve contributors from issue #7160 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` only (`…commit-paths.txt:42-44`). Repository governance; no runtime symbol. |
| 6 | `d7b02636` | Merge pull request #7272 (preserve-original-stop-reason) | **not applicable** | Merge bookkeeping; no independently listed paths (`…commit-paths.txt:45`). The merged behaviour is classified under rows 11–16. |
| 7 | `5a2539a7` | update error messages copy to be more generic | **inherited dependency** | `packages/ai/src/api/{anthropic-messages,bedrock-converse-stream,google-generative-ai,google-vertex,mistral-conversations}.ts` (`…commit-paths.txt:46-56`). Provider error copy is `pi-ai`-owned. |
| 8 | `bff5ab71` | fix(coding-agent): show system prompt files in startup context (#7266) | **intentionally adapted** | Upstream adds `getSystemPromptSource()`/`getAppendSystemPromptSources()` to one `resource-loader.ts` (`…coding-agent.diff:1032-1041,1120-1135,1177-1209`). Atomic's loader is split across thirteen modules, so the same contract lands as: interface (`packages/coding-agent/src/core/resource-loader-types.ts:44,46`), state (`core/resource-loader-internals.ts:59,61`), fields/getters (`core/resource-loader-core.ts:80,82,162,211-216`), path resolution helpers beside their reader (`core/resource-loader-context-files.ts:25-37`), and both reload branches — deferred (`core/resource-loader-reload.ts:198,206`) and full (`core/resource-loader-reload.ts:372,382`). The startup listing is in `modes/interactive/interactive-resource-rendering.ts:148-155`, not `interactive-mode.ts`. Test: `packages/coding-agent/test/interactive-mode-status-resources.suite.ts:415-429`. |
| 9 | `4c1a0b92` | fix(ai): use Qwen thinking controls for token plan reasoning models | **inherited dependency** | `packages/ai/{scripts/generate-models.ts,src/types.ts}` (`…commit-paths.txt:68-72`). Generated reasoning capability metadata is AI-owned. |
| 10 | `4f0437e2` | docs(agent): harness design v2 (harness-v2.md) | **not applicable** | `packages/agent/docs/harness-v2.md` only (`…commit-paths.txt:73-75`). Design documentation for the upstream agent package. |
| 11 | `5a53f086` | fix(ai): preserve raw Mistral stop reasons | **inherited dependency** | `packages/ai/src/api/mistral-conversations.ts` (`…commit-paths.txt:76-79`). See the stop-reason note below. |
| 12 | `e5ef8d06` | fix(ai): preserve raw OpenAI response statuses | **inherited dependency** | `packages/ai/src/api/openai-responses.ts` (`…commit-paths.txt:80-83`). |
| 13 | `fe1c9b6d` | fix(ai): preserve raw OpenAI completion stop reasons | **inherited dependency** | `packages/ai/src/api/openai-completions.ts` (`…commit-paths.txt:84-87`). |
| 14 | `637737ca` | fix(ai): preserve raw Bedrock stop reasons | **inherited dependency** | `packages/ai/src/api/bedrock-converse-stream.ts` (`…commit-paths.txt:88-91`). |
| 15 | `926eb15c` | fix(ai): preserve raw Anthropic stop reasons | **inherited dependency** | `packages/ai/src/api/anthropic-messages.ts` (`…commit-paths.txt:92-95`). |
| 16 | `23cb385b` | fix(ai): preserve google providers raw stop reason | **inherited dependency** | `packages/ai/src/api/{google-generative-ai,google-vertex}.ts` (`…commit-paths.txt:96-101`). |
| 17 | `cced6a21` | fix(coding-agent): stop loading AGENTS.md twice in nested git worktrees (#7221) | **intentionally adapted** | Upstream puts `findShadowedContextFile` in `resource-loader.ts` (`…coding-agent.diff:1046-1091`). Atomic's context-file loading is its own module and its ancestor walk is `getAncestorDirectories`, not an inline `while (true)` loop, so the guard lands in `core/resource-loader-context-files.ts:69-95,122-130` and the shared `findGitPaths`/`GitPaths` export in `core/footer-data-provider.ts:12,22`. Tests (both the shadowed and the ordinary-repo case): `packages/coding-agent/test/pi-0.83.0-direct-fixes.test.ts:159-196`. |
| 18 | `f9476a61` | fix(ai): update TypeBox nullable array validation (#7243) | **inherited dependency** | `packages/ai` TypeBox usage (`…commit-paths.txt:107-115`). Resolved by the single hoisted `typebox@1.3.7`: `grep -c '"node_modules/[^"]*typebox"' package-lock.json` is `1`. Adopted on `pi-0.83.0/reconcile-deps`/`adopt-upstream`; the removal is documented as a Breaking Change in `packages/coding-agent/CHANGELOG.md:7-17`. |
| 19 | `fb4ecd63` | fix(tui): shorten image fallback paths and clamp width (#7262) | **inherited dependency** | `packages/tui/src/terminal-image.ts` (`…commit-paths.txt:116-120`). |
| 20 | `7796481e` | chore: approve contributors from issue #7217 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:121-123`). |
| 21 | `a5db0e4f` | chore: approve contributors from issue #7219 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:124-126`). |
| 22 | `e9e86e1c` | chore: approve contributors from issue #7224 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:127-129`). |
| 23 | `0c32e83a` | fix(coding-agent): enable streaming usage for llama.cpp provider (#7258) | **ported** | `packages/coding-agent/src/extensions/llama/provider.ts:46` now sets `supportsUsageInStreaming: true`, matching `…coding-agent.diff:1215-1223` exactly. Test: `test/pi-0.83.0-direct-fixes.test.ts:36-49`. |
| 24 | `027a5847` | feat(ai): add per-request fetch injection | **inherited dependency** | Thirteen `packages/ai` files plus `fetch-option.test.ts` (`…commit-paths.txt:133-148`). Transport injection is `pi-ai`-owned; Atomic's HTTP dispatcher (`core/http-dispatcher.ts`) is unaffected. |
| 25 | `fdbedcad` | docs(agent): add refs to harness design | **not applicable** | Documentation-only, no independently listed paths (`…commit-paths.txt:149-151`). |
| 26 | `47ca25fc` | Revert "fix(coding-agent): build-check-test (#7206)" | **not applicable** | Reverts `f1451955` inside the same range, so the range's net effect on Atomic is nil. Paired with row 28. |
| 27 | `0d008b74` | fix(coding-agent): show tool expansion status | **ported** | Upstream replaces `this.ui.requestRender()` with a status line (`…coding-agent.diff:1383-1389`). Atomic: `src/modes/interactive/interactive-editor-actions.ts:80` now calls `this.showStatus(\`Tool output: ${expanded ? "expanded" : "collapsed"}\`)`; `showStatus` itself requests the render (`modes/interactive/interactive-render-chat.ts:44,54`), so no render is lost. Tests: `test/pi-0.83.0-direct-fixes.test.ts:76-93` and `test/interactive-mode-status-basic.suite.ts:72,80`. |
| 28 | `f1451955` | fix(coding-agent): build-check-test (#7206) | **not applicable** | Reverted in-range by `47ca25fc` (row 26); nothing from it survives to `v0.83.0`. |
| 29 | `cefa40ed` | fix(coding-agent): guard tree navigation during responses (#7022) | **intentionally adapted** | Three upstream hunks (`…coding-agent.diff:782-791,857-866,1392-1410`). Atomic ports the guard verbatim into its split tree module (`core/agent-session-tree.ts:35-39`, same message) and the interactive caller (`modes/interactive/interactive-session-routing.ts:113-118` live-leaf comparison; `:177-183` abort-before-navigate with queued-message restore). The teardown settle is **adapted**: upstream's unconditional `await this.session.abort()` inside `teardownCurrent` is replaced by an overridable `settleActiveResponseBeforeTeardown()` that no-ops unless the session is streaming (`core/agent-session-runtime.ts:232-249`), and `IsolatedInteractiveRuntime` overrides it to a no-op (`modes/interactive-engine/isolated-runtime.ts:278-285`). Reason: in the isolated engine the host facade's `abort` is `abortAndRecover()`, an unbounded cooperative round trip (`modes/interactive-engine/isolated-runtime.ts:312,469-484`); calling it during teardown would hang every session replacement on an unresponsive or dead engine, which is precisely what Atomic's engine-recovery work (`2a6b716f1`, `#2076`) exists to survive. The child engine settles and persists its own turn before it reports the replacement. Test: `test/pi-0.83.0-direct-fixes.test.ts:257-271`. |
| 30 | `2fe21b40` | fix(ai): send max_tokens for Z.AI providers (#7174) | **inherited dependency** | `packages/ai/{scripts/generate-models.ts,src/api/openai-completions.ts}` (`…commit-paths.txt:170-174`). |
| 31 | `0563a7c0` | fix(coding-agent): clean up failed git installs (#7210) | **ported** | Upstream wraps clone/checkout/install in `try`/`catch` with `rmSync` + `pruneEmptyGitParents` (`…coding-agent.diff:986-1011`). Atomic's git install lives in `core/package-manager-git.ts`; the same wrapper is at `:105-121`, reusing the `pruneEmptyGitParents` helper Atomic already had at `:184-202`. Tests (clone failure and dependency-install failure): `test/pi-0.83.0-direct-fixes.test.ts:198-255`. |
| 32 | `f1ea6c0d` | fix(coding-agent): reset model selector selection to top row when filtering (#7211) | **ported** | `src/modes/interactive/components/model-selector.ts:241-244` is upstream's line verbatim, comment included (`…coding-agent.diff:1318-1322`). Test: `test/pi-0.83.0-direct-fixes.test.ts:51-74`. |
| 33 | `5d548ae9` | fix: rpc bash no longer bypass user_bash (#7214) | **intentionally adapted** | Upstream edits one `case "bash"` in `rpc-mode.ts` (`…coding-agent.diff:1418-1442`). Atomic's RPC is split: command dispatch is `modes/rpc/rpc-command-handler.ts` and the correlated client wait is `modes/rpc/rpc-client-waits.ts:48-75`. The interception is added inside Atomic's request-owner wrapper (`modes/rpc/rpc-command-handler.ts:258-289`) rather than around a bare `executeBash`, so request-scoped ownership, streaming correlation, single terminal response, and the owner-side `recordBashResult` persist/defer policy (`modes/rpc/rpc-bash-request-owners.ts:35-53`) are all preserved — upstream's inline `session.recordBashResult` would have bypassed them. `bash` and `user_bash` now share one executor body. Test: `test/pi-0.83.0-direct-fixes.test.ts:273-303`. |
| 34 | `66eead65` | fix(coding-agent): preserve resource metadata after extension resource reloads (#7218) | **intentionally adapted** | Upstream promotes the reload-local `metadataByPath` to an instance field (`…coding-agent.diff:1103,1116,1139-1163,1170-1173`). Atomic's reload is a free function over a state object, so the map is declared on the internals contract (`core/resource-loader-internals.ts:68-72`), initialized in the constructor (`core/resource-loader-core.ts:87,169`), reset and reused by both reload branches (`core/resource-loader-reload.ts:177,215-218`), and passed by `extendResources` to all three async updaters (`core/resource-loader-core.ts:270,278,286`) — Atomic's updaters are the `…Async` variants that already accept an optional metadata map (`core/resource-loader-assets.ts:45-55,75-105,127-137`). |
| 35 | `b6fb91e5` | fix(coding-agent): include scoped models in TUI extension context (#7215) | **ported** | Upstream adds `scopedModels: this.session.scopedModels` to the TUI shortcut context (`…coding-agent.diff:1375-1382`). Atomic's counterpart literal is `modes/interactive/interactive-extension-runtime.ts:38`. |
| 36 | `063fb963` | fix(coding-agent): isolate autoload-disabled package test from real home directory (#7167) | **not applicable** | `packages/coding-agent/test/package-manager.test.ts` only (`…commit-paths.txt:194-196`), an upstream test-isolation fix (`vi.stubEnv("HOME", …)`, `…coding-agent.diff:1818-1825`). Atomic's package-manager suites are independently organized and already isolate the agent directory per fixture. |
| 37 | `b63403a5` | fix(ai): prefer configured Bedrock profile over ambient AWS keys (#7176) | **inherited dependency** | `packages/ai/src/api/bedrock-converse-stream.ts` + `bedrock-credentials.test.ts` (`…commit-paths.txt:197-200`). |
| 38 | `04b15259` | feat(extensions): expose ctx.scopedModels to extensions (#7191) | **ported** | Upstream touches `core/extensions/{types,runner}.ts`, `core/agent-session.ts`, and `docs/extensions.md` (`…coding-agent.diff:868-946`). Upstream declares `ExtensionContext` inside `core/extensions/types.ts`; Atomic's file of that name is the public import path and re-exports sibling declaration modules (`:21-45`). The port therefore lands in two places. **In `core/extensions/types.ts` itself:** the element type `ScopedModel` is re-exported (`:19`) and the accessor's own type is named as `ExtensionScopedModels = ExtensionContext["scopedModels"]` (`:14,47-57`), so `scopedModels` is part of the public surface this file publishes and renaming or dropping the member fails the barrel at compile time. Both names are re-exported onward by `core/extensions/index.ts:99,154` and `src/index-extensions.ts:41,87`, so `import type { ExtensionScopedModels, ScopedModel } from "@bastani/atomic"` resolves. **In the modules it re-exports:** `ExtensionContext.scopedModels` in `core/extensions/context-types.ts:97-101`, `ExtensionContextActions.getScopedModels` in `core/extensions/runtime-types.ts:172`, the runner field/wiring in `core/extensions/runner.ts:12,128,193,401`, the context source and lazy getter in `core/extensions/runner-context.ts:5,35,93-96`, and the session binding in `core/agent-session-extension-bindings.ts:221-225`. **Isolated-engine adaptation:** the binding reads the public `this.scopedModels` accessor rather than the `_scopedModels` field, because under the isolated engine `RemoteModelCatalog` redefines `scopedModels` on the host-side facade session to the engine's catalogue (`modes/interactive-engine/remote-model-catalog.ts:58`) and never refreshes the private field. Documented at `packages/coding-agent/docs/extensions.md:1034-1056`; changelog entry at `packages/coding-agent/CHANGELOG.md:21`. Test: `test/pi-0.83.0-direct-fixes.test.ts:148-171`, whose `ExtensionScopedModels` / `ScopedModel` assignment is taken from the public path. |
| 39 | `2903063d` | chore: approve contributors from issue #7171 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:208-210`). |
| 40 | `c820aa26` | Merge branch 'design/durable-agent-harness' | **not applicable** | Merge bookkeeping; no independently listed paths (`…commit-paths.txt:211`). |
| 41 | `e8f9c071` | docs(agent): durable AgentHarness design (harness.md) | **not applicable** | `packages/agent/docs/harness.md` (`…commit-paths.txt:212-214`). |
| 42 | `a597371b` | Merge pull request #7117 (coding-agent evals) | **not applicable** | Merge bookkeeping (`…commit-paths.txt:215`). Its content is rows 43, 44, 46–49. |
| 43 | `b0864a66` | fix(coding-agent): preserve eval run diagnostics | **not applicable** | `packages/evals/src/{extensions.eval,pi-harness}.ts` (`…commit-paths.txt:216-219`). Atomic's eval suite is the independent Python Harbor/Pier suite under root `evals/`, not upstream's Vitest `packages/evals`. |
| 44 | `b56a35f9` | fix(coding-agent): project typed eval outputs | **not applicable** | `packages/evals/{README.md,src/extensions.eval.ts,src/pi-harness.ts}` (`…commit-paths.txt:220-224`). |
| 45 | `99e34013` | feat: auth print (#7168) | **ported** | Upstream adds `cli/credential-print.ts`, `cli/args.ts` help text, a `main.ts` dispatch branch, and `core/model-runtime.ts` `minOAuthValidityMs` (`…commit-paths.txt:225-234`; `…coding-agent.diff:593-777,969-981,1224-1305,1443-1552`). Atomic implements the **negotiated** door, which is stricter than upstream's: `packages/coding-agent/src/cli/credential-print.ts` — typed `Secret` whose `toString`/`toJSON`/`Symbol.toPrimitive` throw and whose `inspect.custom` redacts (`:74-105`), consumed once by `take()` (`:82-89`); `emitCredential` is the single egress, the only `take()` in `src` and the only stdout write of a credential (`:107-124`); one exit code per failure via `EXIT_CODES` (`:42-49`) and `CredentialPrintError.exitCode` (`:51-61`); `--min-expiry` rejected for `print-api-key` at parse time (`:191-195`); `--model` required and `--api-key`/prompts/files refused (`:208-221`); OAuth failure split into `RefreshFailed` and `MinValidityUnreachable` (`:223-238`). Dispatch and stdout discipline are in `src/main.ts:96-161,195-200`, which routes all chatter to stderr through `takeOverStdout()` (`:127`) and hands the unread `Secret` to `emitCredential` (`:145`). Help is branded through `APP_NAME` (`cli/credential-print.ts:139-165`; `cli/args.ts:262-263,311-315`). `minOAuthValidityMs` gains its first reader at `cli/credential-print.ts:302-305`. Tests: `test/credential-print.test.ts` (24 cases, including a real CLI child asserting byte-exact stdout, every exit code, an unchanged `auth.json` after a failed refresh, the `30m` default reaching `getAuth`, and a source-tree scan that fails if a second credential egress appears). Docs: `docs/usage.md:176-199`, `docs/security.md:54-67`. |
| 46 | `af19a9ee` | fix(coding-agent): simplify extension eval prompt | **not applicable** | `packages/evals/src/extensions.eval.ts` (`…commit-paths.txt:235-237`). |
| 47 | `95d1c60f` | fix(coding-agent): simplify multi-step eval input | **not applicable** | `packages/evals/src/{extensions.eval,pi-harness}.ts` (`…commit-paths.txt:238-241`). |
| 48 | `9423204c` | fix(coding-agent): clarify eval harness errors | **not applicable** | `packages/evals/src/pi-harness.ts` (`…commit-paths.txt:242-244`). |
| 49 | `8a976324` | fix(coding-agent): keep eval scenarios in test cases | **not applicable** | `packages/evals/{README.md,src/extensions.eval.ts,src/pi-harness.ts}` (`…commit-paths.txt:245-249`). |
| 50 | `2efa728d` | fix(coding-agent): support concurrent user bash cancellation (#7103) | **intentionally adapted** | Upstream replaces a single `_bashAbortController` with a `Set` (`…coding-agent.diff:800-854`). Atomic already carried a strictly stronger structure from the 0.82.1 port: a **request-keyed `Map`** (`core/agent-session.ts:111`) that supports both concurrent execution and *targeted* cancellation by request id (`core/agent-session-bash.ts:22-24,53,95-102`), with `isBashRunning` as `size > 0` (`core/agent-session-accessors.ts:124-127`) and RPC-level owners on top (`modes/rpc/rpc-bash-request-owners.ts:56-60`). The map is retained; the one behaviour upstream's `[...set]` copy contributes — a cancellation sweep that a listener mutating the collection cannot shorten — is adopted at `core/agent-session-bash.ts:100-102`. |
| 51 | `c2275d67` | fix(coding-agent): prevent duplicate messages on startup session switch (#7110) | **ported** | Upstream captures the session before the async extension bind and returns if it changed (`…coding-agent.diff:1347-1374`). Atomic: `modes/interactive/interactive-session-runtime.ts:109-127`. Upstream's `renderBeforeBind` reordering is not carried because Atomic renders outside `rebindCurrentSession` (`modes/interactive/interactive-session-routing.ts:34,289,310`); only the stale-rebind guard is load-bearing. Test: `test/pi-0.83.0-direct-fixes.test.ts:95-137`. |
| 52 | `61da9e2f` | feat(ai): add manual redirect URL fallback to OpenRouter OAuth login (#7114) | **ported (adapted)** | `packages/ai/src/auth/oauth/openrouter.ts` + test carry the flow itself, and upstream's only coding-agent change is `docs/providers.md` copy (`…commit-paths.txt:258-262`) — which is why this was first read as an inherited dependency. It is not one for Atomic. The inherited flow races the loopback callback against an `interaction.prompt({ type: "manual_code" })`, and Atomic's interactive host answers that prompt with `onManualCodeInput: () => manualCodePromise` (`modes/interactive/interactive-auth-login.ts:279`), a promise only `dialog.showManualInput` resolves — and that call is gated on `usesCallbackServer` (`:241`). Inheriting `pi-ai` alone therefore left OpenRouter prompting into an input that is never shown, so a remote or headless login waited for a callback it could not receive and ended at the timeout. Atomic adds `openrouter` to `CALLBACK_SERVER_PROVIDERS` (`core/oauth-provider-metadata.ts:19`) so the paste input is offered, which is the seam upstream does not have. Tests: `test/oauth-provider-metadata.test.ts:29-33` over the shipped provider set, and `test/interactive-auth-login.test.ts:185-236` driving a real OpenRouter login through `showLoginDialog`. |
| 53 | `f9a49869` | feat(ai): expose pending stop reason while streaming (#7151) | **inherited dependency** | Fourteen `packages/ai` files plus `packages/agent/src/proxy.ts`; the coding-agent changes are docs and upstream test-harness updates (`…commit-paths.txt:263-291`). The new `pending` streaming stop reason is produced by `pi-ai`. See the risk note below. |
| 54 | `60f6a803` | feat(ai): add GitHub Copilot Claude Opus 5 support (#7158) | **inherited dependency** | `packages/ai/{CHANGELOG.md,scripts/generate-models.ts,test/github-copilot-anthropic.test.ts}` (`…commit-paths.txt:292-296`). Generated model metadata only; Atomic removed all Copilot-specific handling, so `github-copilot` behaves exactly like upstream and there is no Atomic seam. |
| 55 | `f08f58f5` | fix(coding-agent): run coding-agent tests offline by default (#7031) | **not applicable** | Upstream test-harness policy: `test/test-network-env.ts`, seven upstream test files, and upstream's `vitest.config.ts` (`…commit-paths.txt:297-307`). Atomic already gates network-dependent suites on its own credentials/offline conditions (for example `describe.skipIf(!API_KEY)` in `packages/coding-agent/test/agent-session-tree-navigation.test.ts:15`), and its per-test timeout policy is repository-owned (`AGENTS.md`, `test/helpers/test-timeout.ts`). |
| 56 | `5f9d025e` | chore: approve contributors from issue #7143 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:308-310`). |
| 57 | `3cd39163` | chore: approve contributors from issue #7132 | **not applicable** | `.github/APPROVED_CONTRIBUTORS` (`…commit-paths.txt:311-313`). |
| 58 | `cee5ff75` | ref: remove openclaw reference from readme | **not applicable** | `packages/coding-agent/README.md` copy (`…commit-paths.txt:314-316`). Atomic's README is separately branded and carries no such reference. |
| 59 | `a0ac81c0` | fix(coding-agent): distinguish eval invariants | **not applicable** | `packages/evals/src/extensions.eval.ts` (`…commit-paths.txt:317-319`). |
| 60 | `4b8accab` | fix(coding-agent): simplify eval normalization | **not applicable** | `packages/evals/*` plus the upstream root lock (`…commit-paths.txt:320-324`). |
| 61 | `73c1696d` | fix(coding-agent): use focused eval harness | **not applicable** | `packages/evals/*`, upstream `biome.json`, upstream lock (`…commit-paths.txt:325-334`). |
| 62 | `66fbdb1c` | feat(coding-agent): add extension creation eval | **not applicable** | `packages/evals/*`, upstream `biome.json`, upstream lock (`…commit-paths.txt:335-344`). |
| 63 | `5bc1c2c0` | Add [Unreleased] section for next cycle | **not applicable** | Changelog headings in four upstream packages (`…commit-paths.txt:345-352`). Atomic already has its own `[Unreleased]` section. |

### Totals

| Classification | Commits | Count |
| --- | --- | ---: |
| **ported** | `0c32e83a`, `0d008b74`, `0563a7c0`, `f1ea6c0d`, `b6fb91e5`, `04b15259`, `c2275d67`, `99e34013` | 8 |
| **intentionally adapted** | `bff5ab71`, `cced6a21`, `cefa40ed`, `5d548ae9`, `66eead65`, `2efa728d`, `61da9e2f` | 7 |
| **inherited dependency** | `44b26c9b`, `34239180`, `5a2539a7`, `4c1a0b92`, `5a53f086`, `e5ef8d06`, `fe1c9b6d`, `637737ca`, `926eb15c`, `23cb385b`, `f9476a61`, `fb4ecd63`, `027a5847`, `2fe21b40`, `b63403a5`, `f9a49869`, `60f6a803` | 17 |
| **equivalent** | — | 0 |
| **not applicable** | rows 1, 3, 5, 6, 10, 20, 21, 22, 25, 26, 28, 36, 39–44, 46–49, 55–63 | 31 |
| **total** | every SHA in `upstream-v0.82.1-v0.83.0-commits.txt`, exactly once | **63** |

`8 + 7 + 17 + 0 + 31 = 63`. `04b15259` and `b6fb91e5` are two commits delivering one
feature (`ctx.scopedModels`) and are counted as the two commits they are. `61da9e2f`
moved from **inherited dependency** to **intentionally adapted**: the `pi-ai` flow is
inherited, but Atomic needs a seam upstream does not, and reading it as inherited is
what shipped OpenRouter's remote login without the input its prompt waits on.

## File matrix — the fifteen upstream `coding-agent/src` files (15/15)

`research/upstream-v0.82.1-v0.83.0-name-status.txt` lists 124 changed files, of which 15 are
under `packages/coding-agent/src`. Everything else is `packages/{agent,ai,tui,evals,server,storage}`,
upstream tests, upstream docs, upstream examples, upstream locks/manifests, or repository
governance, and is covered by its commit row above.

| Upstream file | Atomic counterpart | Classification |
| --- | --- | --- |
| `src/cli/args.ts` | `src/cli/args.ts:262-263,311-315` | **ported** (`99e34013`) — `auth` in the command list and two examples, rendered through `APP_NAME`. |
| `src/cli/credential-print.ts` (new) | `src/cli/credential-print.ts` (new, 349 lines) | **ported** (`99e34013`) — the negotiated door; see row 45 and the deviation table below. |
| `src/core/agent-session-runtime.ts` | `src/core/agent-session-runtime.ts:232-249` | **intentionally adapted** (`cefa40ed`) — overridable settle instead of an unconditional abort. |
| `src/core/agent-session.ts` | `src/core/agent-session-tree.ts:35-39`; `src/core/agent-session-bash.ts:22-24,53,95-102`; `src/core/agent-session-extension-bindings.ts:221-225` | **ported** + **intentionally adapted** — Atomic splits `AgentSession` across the `agent-session-*.ts` modules. |
| `src/core/extensions/runner.ts` | `src/core/extensions/runner.ts:12,128,193,401`; `runner-context.ts:5,35,93-96` | **ported** (`04b15259`). |
| `src/core/extensions/types.ts` | `src/core/extensions/types.ts:14,19,47-57` (`ScopedModel` re-export + `ExtensionScopedModels`); barrel re-exports (`:21-45`) → `context-types.ts:97-101`, `runtime-types.ts:172`; onward re-exports `core/extensions/index.ts:99,154`, `src/index-extensions.ts:41,87` | **ported** (`04b15259`). |
| `src/core/footer-data-provider.ts` | `src/core/footer-data-provider.ts:12,22` | **ported** (`cced6a21`) — `GitPaths`/`findGitPaths` exported verbatim. |
| `src/core/model-runtime.ts` | `src/core/model-runtime-types.ts:21` | **equivalent** — `ModelRuntimeAuthOverrides.minOAuthValidityMs` was already declared in Atomic (`5ef323e3f`) and the declaration is untouched; `cli/credential-print.ts:302-305` gives it its first reader. |
| `src/core/package-manager.ts` | `src/core/package-manager-git.ts:105-121` | **ported** (`0563a7c0`). |
| `src/core/resource-loader.ts` | `resource-loader-types.ts`, `-internals.ts`, `-core.ts`, `-context-files.ts`, `-reload.ts` | **intentionally adapted** (`bff5ab71`, `cced6a21`, `66eead65`) — thirteen-module split. |
| `src/extensions/llama/provider.ts` | `src/extensions/llama/provider.ts:46` | **ported** (`0c32e83a`). |
| `src/main.ts` | `src/main.ts:96-161,195-200` | **ported** (`99e34013`) — dispatch plus the stdout takeover that keeps the secret alone on the stream; the write itself lives behind `emitCredential`. |
| `src/modes/interactive/components/model-selector.ts` | same path, `:241-244` | **ported** (`f1ea6c0d`). |
| `src/modes/interactive/interactive-mode.ts` | `interactive-resource-rendering.ts:148-155`; `interactive-session-runtime.ts:110-127`; `interactive-extension-runtime.ts:38`; `interactive-editor-actions.ts:80`; `interactive-session-routing.ts:113-118,177-183` | **ported** + **intentionally adapted** — Atomic splits `InteractiveMode` across `interactive-*.ts` prototype modules. |
| `src/modes/rpc/rpc-mode.ts` | `src/modes/rpc/rpc-command-handler.ts:258-289` (with `rpc-client-waits.ts:48-75`, `rpc-bash-request-owners.ts:35-60`) | **intentionally adapted** (`5d548ae9`). |

## Credential-export deviations from upstream

`99e34013` is classified **ported**, but Atomic's door is deliberately stricter. Each row is a
refusal the design negotiated (§5.1 rubric, §5.2 wire surface, §7.1 security) that upstream does
not make. A reviewer should read this table as the security surface of the change.

| Concern | Upstream `99e34013` | Atomic | Evidence |
| --- | --- | --- | --- |
| Secret in transit | a plain `string` returned from `resolveCredentialForPrint` | `Secret`; `toString`, `toJSON`, and `Symbol.toPrimitive` throw, `inspect.custom` yields `[Secret]`, and `take()` works once | `cli/credential-print.ts:63-106`; `test/credential-print.test.ts:92-112` |
| Failure reporting | one `CredentialPrintError`, always `process.exitCode = 1` | six codes: usage `1`, `NoCredentialConfigured` `2`, `ProviderAmbiguous` `3`, `KindUnsupportedForProvider` `4`, `RefreshFailed` `5`, `MinValidityUnreachable` `6` | `cli/credential-print.ts:30-61`; `test/credential-print.test.ts:210-252,271-302,357-399` |
| Refresh vs. validity | both surface as the same generic failure | pi-ai's post-refresh validity error is separated from a failed refresh, the only available discriminator being its message | `cli/credential-print.ts:223-238`; `test/credential-print.test.ts:210-252` |
| stdout discipline | `process.stdout.write` on success; diagnostics rely on `console.error` | `takeOverStdout()` for the whole resolution — which also catches native `console.log` under Bun — and only the secret reaches `writeRawStdout` | `main.ts:96-161`; `test/credential-print.test.ts:339-442` |
| Egress chokepoint | the write lives at the call site in `main.ts` | `emitCredential` is the one function that opens a `Secret` and writes it, so `main.ts` holds a credential it cannot read; a test walks every file under `src` and fails when a second stdout path or a second `take()` appears | `cli/credential-print.ts:107-124`; `main.ts:140-145`; `test/credential-print.test.ts:450-562` |
| Help stream | `console.log` (stdout) | stderr, so stdout from `atomic auth` is a credential or empty | `cli/credential-print.ts:139-165`; `test/credential-print.test.ts:424-441` |
| Branding | help renders `pi auth …` | `APP_NAME`, so help and errors render `atomic auth …` | `cli/credential-print.ts:142-144,183-186`; `test/credential-print.test.ts:128-142,424-441` |

Two guarantees are inherited rather than added, and are verified rather than assumed:
`resolveStoredOAuth` in pi-ai `0.83.0` performs the refresh inside `credentials.modify`, so a
failed refresh never writes — `test/credential-print.test.ts:400-423` asserts an unchanged
`auth.json` after a real `invalid_grant` response — and it enforces the requested minimum only
when `minOAuthValidityMs` is set, which is what makes exit `6` reachable at all.

## Atomic-owned risks carried forward (P4)

These are **not** resolved by this branch; they are the probe list for the regression-probe
layer, restated here because the inheritance claim above depends on them holding.

- **Raw stop reasons** (`926eb15c`, `637737ca`, `23cb385b`, `5a53f086`, `e5ef8d06`, `fe1c9b6d`).
  Upstream states that unmapped terminal reasons now surface as provider errors rather than
  successful stops. Atomic's isolated engine, RPC projection, branch summaries, and Verbatim
  Compaction all consume stop reasons. A path that previously completed and now errors is a
  regression, not an inheritance.
- **`pending` streaming stop reason** (`f9a49869`). The isolated-engine protocol is at version
  `2`; an unhandled `pending` reaching that protocol or the RPC message projection is a defect.

## Probe coverage (P4, `pi-0.83.0/regression-probes`)

The layer above this one closes the list above. Each probe also covers the path that
*already worked*, because a probe that only asserts the new behaviour would pass against a
build that had broken every previously successful stop.

| Risk | Probe |
| --- | --- |
| Raw stop reasons | `test/unit/pi-0.83.0-stop-reason-probes.test.ts` — every raw reason that mapped to a successful stop still does, per provider family, over the real pi-ai streams; one unmapped reason per family proves the assertions discriminate |
| `pending` across the four consumers | `test/unit/pi-0.83.0-pending-stop-reason-probes.test.ts` — `pending` measured as the reason every streaming partial carries, then driven through the isolated-engine protocol (version `2`), the RPC JSONL projection, branch summaries and the Verbatim Compaction planner |
| Nested worktree context files, RPC bash `user_bash`, resource metadata across reload | `test/unit/pi-0.83.0-inherited-surface-probes.test.ts` — a real `git worktree add` layout, an RPC bash command with and without an intercepting handler, and package-sourced skills/prompts/themes read back after a later `extendResources` |
| Shorter OAuth refresh window (`#7168`, risk R2) | `test/unit/pi-0.83.0-oauth-refresh-window-probe.test.ts` — concurrent sessions over one shared `auth.json` refresh once, and a credential outside the window is not refreshed at all |
| `actions/cache` 4.3.0 -> 6.1.0 (D1) | `test/ci/actions-cache-bump-contract.test.ts`, with `npm run test:ci-contracts` green |
| `@dbos-inc/dbos-sdk` 4.24.16 (D2) | `test/unit/pi-0.83.0-dbos-replay-probe.test.ts` — the three required parts, with the modelled kill crossing `DBOSJSON` itself rather than a clone |

## Verification for this branch

```
npm run check                                   # biome + tsc --noEmit + shrinkwrap check — green
npm run test:unit                               # 5646 passed, 2 skipped
npm run test:integration                        # 484 passed, 1 skipped
npm run test --workspace=@bastani/atomic        # 2940 passed, 29 skipped, 0 failed
```
