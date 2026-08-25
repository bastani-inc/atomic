---
date: 2026-08-25
researcher: Claude Opus 5
git_commit: 3ae01c650
branch: pi-0.84.3/00-port-matrix
repository: atomic-monorepo
topic: Pi v0.84.2..upstream-main (v0.84.3 + 4) upstream commit and file port matrix
tags: [implementation, evidence, pi-0.84.3, port-matrix]
status: completed
last_updated: 2026-08-25
last_updated_by: Claude Fable 5
port_outcome: shipped on the pi-0.84.3/* stack
breaking_changes_allowed: false
compatibility_context: Preserve Atomic public SDK, branding, CLI names and paths, legacy PI_*/.pi aliases, providers, isolated runtime, fullscreen-only renderer, Verbatim Compaction, versionless 0.0.0 manifests, and Atomic's Bun-compiled release/CI pipeline.
---

# Pi v0.84.3 Port Matrix

Classifies **all 110 commits** in `914cf1472e^..dcd461925d` — the v0.84.2 release tag through
upstream `main`, four commits past the v0.84.3 tag — against Atomic's tree. **82 touch
`packages/coding-agent`**; the other 28 are upstream-package, script, CI, or governance
changes.

Atomic resolves every external `@earendil-works/pi-*` compatibility dependency at `^0.84.3`
after Slice **S1**. The regenerated lockfile carries `packages/tui`, `packages/agent`,
`packages/client`, and `packages/protocol` changes from this range; those changes are **never**
source-ported.

**`packages/ai` is not touched on any branch.** Atomic vendors its own `packages/ai` fork,
published as `@bastani/pi-ai`, which was independently verified to already carry every
`fix(ai)`/`feat(ai)` behavior in this range (evidence in [B0](#b0-vendored-ai-verification)).
Those commits are classified **skipped-vendored-ai**. Where an upstream `packages/ai/README.md`
delta describes user-facing behavior, the delta is reflected in Atomic's own
`packages/coding-agent/docs`, not copied into the fork's README.

## Source evidence

- Commit inventory (110 rows): [`upstream-v0.84.2-v0.84.3-commits.txt`](upstream-v0.84.2-v0.84.3-commits.txt)
- Per-commit changed paths: [`upstream-v0.84.2-v0.84.3-commit-paths.txt`](upstream-v0.84.2-v0.84.3-commit-paths.txt)
- File inventory: [`upstream-v0.84.2-v0.84.3-name-status.txt`](upstream-v0.84.2-v0.84.3-name-status.txt)
- Range summary: [`upstream-v0.84.2-v0.84.3-log-stat.txt`](upstream-v0.84.2-v0.84.3-log-stat.txt)
- Full coding-agent patch (11002 lines): [`upstream-v0.84.2-v0.84.3-coding-agent.diff`](upstream-v0.84.2-v0.84.3-coding-agent.diff)

Classification vocabulary extends the 0.84.2 matrix: **ported**, **ported (adapted)**,
**inherited dependency**, **equivalent**, **not applicable**, **intentionally rejected**, plus
**skipped-vendored-ai** for `packages/ai` code changes Atomic's fork already carries.

Slice labels used below map to the stack branches:

| Slice | Branch | Theme |
|---|---|---|
| S1 | `pi-0.84.3/01-dep-bump-0843` | `@earendil-works/pi-*` → `^0.84.3`, lockfile, dependency-carried defaults |
| S2 | `pi-0.84.3/02-compaction-correctness` | compaction failure events, tool suppression, truncation, usage notices |
| S3 | `pi-0.84.3/03-session-scoped-model-thinking` | session-scoped model/thinking state, per-model thinking defaults |
| S4 | `pi-0.84.3/04-thinking-command-and-selectors` | `/thinking`, selector search/defaults/ordering, settings rows |
| S5 | `pi-0.84.3/05-skills-packages-llama-startup` | skills discovery, package manager, llama.cpp, deferred grammars |
| S6 | `pi-0.84.3/06-extensions-events-and-robustness` | extension API/rollback, JSON+RPC metadata, export/share, BOM/HTTP/permissions |
| S7 | `pi-0.84.3/07-startup-diagnostics-and-windows` | settings diagnostics, PowerShell tool, Windows keybindings |
| S8 | `pi-0.84.3/08-docs-changelog-and-matrix` | docs, `[Unreleased]` changelog, matrix outcome finalization |

## Part A — 28 commits that do not touch `packages/coding-agent`

| Count | Commits | Group | Classification | Basis |
|---:|---|---|---|---|
| 19 | `d5278eaac3`, `086c32e745`, `d3ab2af969`, `86d001d36b`, `af2c352238`, `10acee6045`, `87205484bf`, `6db110e6fa`, `9117326b4c`, `ad58801ce7`, `e5dde9a76b`, `a6c6f80180`, `59a71b235d`, `55b0db4d3e`, `d57e531f5d`, `3de00332f7`, `87af49dec2`, `4ca636c5e0`, `b7bb00b936` | `packages/ai` provider/transport/auth/catalog work | **skipped-vendored-ai** | Atomic's `packages/ai` fork already carries every behavior; sampled and verified file-by-file in [B0](#b0-vendored-ai-verification). `59a71b235d` reverts `a6c6f80180` and is superseded by `4809c2abca` (listed in [B2](#b2-dependency-carried-anthropic-summarization-shim-3) because it also touches `packages/coding-agent`); the net state is what the fork holds. `4ca636c5e0` and `b7bb00b936` also touch `packages/server`, which Atomic does not ship — its RPC surface is `src/modes/rpc*`, covered by `830a0a59e9` in S6. |
| 2 | `2509b5c037`, `3a0b9a3eee` | `packages/agent` provider-context construction, added then reverted | **not applicable** | Net zero upstream. Atomic constructs `Agent` from `@earendil-works/pi-agent-core` (`src/core/sdk.ts`); nothing to inherit. |
| 2 | `f0c5d86d20`, `8f2ae3fadd` | `packages/tui` narrow-width text padding, wrapped-table link colour leaks | **inherited dependency; shipped** | Arrived with `@earendil-works/pi-tui@0.84.3` in S1. Atomic vendors no renderer copy. |
| 1 | `5cd93f688a` | `scripts/auto-pi.sh` developer `pi` PATH wrapper defaulting `PI_EXPERIMENTAL=1` | **not applicable** | Developer convenience for the `pi` binary name; Atomic's CLI is `atomic` and copying it would ship wrong branding and paths. |
| 1 | `39d869f02a` | Publish installer artifacts + advance an R2 installer pointer | **not applicable** | Touches `.github/workflows/build-binaries.yml` and `scripts/publish-release-announcement.mjs`, neither of which exists in Atomic. Atomic publishes through tag-triggered `publish.yml`, GitHub release assets, npm OIDC, and `scripts/cut-release.ts`. |
| 1 | `bfb004d441` | Extract Windows release ZIPs with PowerShell instead of `tar` in CI | **equivalent** | Atomic's `publish.yml` Windows smoke job already runs on Windows and uses `Expand-Archive`; the archive creator carries a PowerShell fallback. |
| 1 | `c36552212e` | `AGENTS.md` / `.pi/prompts/wr.md` changelog-entry rules | **not applicable** | Atomic owns `AGENTS.md` and requires changelog entries for shipped behavior; upstream's rule is the opposite. |
| 1 | `b1efcf7d7c` | `.github/APPROVED_CONTRIBUTORS` allowlist approval | **not applicable** | Upstream governance; Atomic uses `CONTRIBUTING.md` and has no allowlist file. |
## Part B — 82 commits touching `packages/coding-agent`

### B0. Vendored-AI verification

Not a commit group — the audit that justifies every **skipped-vendored-ai** cell. Each upstream
`packages/ai` behavior in this range was located in Atomic's fork:

| Upstream behavior | Upstream commit | Atomic evidence |
|---|---|---|
| xAI Responses routing + Grok 4.6 default | `70e878d4cf` | `packages/ai/src/providers/xai.ts:7-23`, `packages/ai/src/api/openai-responses.ts:325,360,366` (xAI catalog JSON is generated at build time into `packages/ai/src/providers/data/`) |
| Chinese Z.AI Coding Plan catalog | `87205484bf` | `packages/ai/scripts/generate-models.ts:1183-1199`, `src/providers/zai-coding-cn.ts:6-14` |
| Google thinking-level maps | `af2c352238` | `packages/ai/src/api/google-shared.ts:31-50`, callers at `google-generative-ai.ts:325`, `google-vertex.ts:331` |
| Bedrock Smithy response headers | `10acee6045` | `packages/ai/src/api/bedrock-converse-stream.ts:476-508` |
| Simple tool-choice option | `e5dde9a76b` | `packages/ai/src/types.ts:82,326-330`, forwarded across provider adapters |
| openai-completions reasoning details | `4ca636c5e0`, `b7bb00b936` | `packages/ai/src/api/openai-completions.ts:137-165,636-645,1265-1294` |
| Anthropic fallback usage | `a6c6f80180` → `4809c2abca` | `packages/ai/src/types.ts:320-324`, `src/api/anthropic-messages.ts:616-633,1132-1135` |
| Bedrock redacted-reasoning round-trip | `d57e531f5d` | `packages/ai/src/api/bedrock-converse-stream.ts:105-114,641-671,991-995,1304-1324` |
| Direct OpenTelemetry dependency removed | `209bc7b9a8` | absent from `packages/ai/package.json:69-79`; remaining lock entries are transitive |
| Copilot sequential policy login + 429 retry | `d5278eaac3`, `086c32e745`, `55b0db4d3e` | `packages/ai/src/auth/oauth/github-copilot.ts:135-194,390-431` |
| Kimi cached tokens | `d3ab2af969` | `packages/ai/src/api/openai-completions.ts:1487-1503` |
| Generalized thinking-token-budget fields | `b237412699` | `packages/ai/src/types.ts:92,97,604-622`, `src/api/openai-completions.ts:839,945-1030` |

Upstream `packages/ai/README.md` deltas in `70e878d4cf` (Grok 4.5 → 4.6 example) and
`b237412699` (`thinkingTokenBudgetField`, `supportsThinkingTokenBudget`, `thinking.budget`)
are already reflected in Atomic's user-facing docs — `docs/providers.md:94` names Grok 4.6 and
`docs/{settings,models,custom-provider}.md` all document the thinking-budget fields. **S8**
re-verifies rather than re-writes them.

### B1. Bookkeeping and release (7)

| Commit | Subject | Classification |
|---|---|---|
| `914cf1472e` | Release v0.84.2 (range baseline) | **not applicable** — Atomic release bases stay at `0.0.0`; versions are stamped only on the detached `cut-release.ts` commit. |
| `0e0021fbbe`, `31d4ed5860` | Add `[Unreleased]` section for next cycle | **not applicable** — Atomic maintains its own changelog cycle; released sections are frozen by `test/unit/changelog.test.ts`. |
| `77c540704d` | Add missing end-of-options changelog entry | **not applicable** — upstream release prose. The Atomic-side outcome is restated by **S8**. |
| `7623e8a0f1` | Audit unreleased changelogs | **not applicable** — upstream release prose spanning `agent`/`ai`/`coding-agent`. **S8** selectively restates only Atomic's shipped outcomes. |
| `4e58f324fa` | Release v0.84.3 | **not applicable** — 28 manifest/lock stamps against versionless Atomic bases. |
| `0e4d495414` | Remove deprecated Xiaomi models | **skipped-vendored-ai** — the coding-agent hunk is changelog-only; the generator filter already exists at `packages/ai/scripts/generate-models.ts:2271-2272`. |

### B2. Dependency-carried: Anthropic summarization shim (3)

Upstream added a transient coding-agent-side Anthropic refusal/fallback shim in
`src/core/compaction/compaction.ts`, refined it, then deleted it once `packages/ai` owned the
behavior. The net upstream state carries no shim, and Atomic never had one.

| Commit | Subject | Outcome |
|---|---|---|
| `eb1f87fa9a` | anthropic refusal error and fallbacks (#8258) | **inherited dependency** — adds `getAnthropicSummarizationFallback()`/`createSummarizationOptions()`; provider behavior belongs to the vendored fork. |
| `4809c2abca` | anthropic fallback usage (#8319) | **inherited dependency** — refines the same helper to preserve fallback cost metadata. |
| `ed867e9094` | fallback cost not via stream options (#8352) | **inherited dependency** — removes the shim entirely; Atomic supplies no local `refusalFallbacks`, so it is already at the net state. |

### B3. Compaction (12) — S2

Atomic runs **Verbatim Compaction**, not upstream's summary compaction, so half this cluster
has no analogue. The classifications name the Atomic symbol that was checked.

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `47bf47f11f` | Clarify compaction paths (JSDoc) | **equivalent — verified S2** | Upstream expands doc comments on `AgentSession.compact()`/`_checkCompaction()`/`_runAutoCompaction()`; Atomic already separates these structurally into `agent-session-compaction.ts` and `agent-session-auto-compaction.ts`. |
| `58302d34e7` | Support compaction routing sessions | **intentionally rejected — verified S2** | Upstream reuses an active routing `sessionId` for summary requests. Atomic's `planDeletedLineRanges()`, `generateBranchSummary()`, and `generateSessionSummary()` deliberately issue fresh `uuidv7()` IDs with `cacheRetention: "none"` so planner traffic never joins the user's routed session. |
| `c7c763f5c4` | Clarify truncated recovery failure | **equivalent — verified S2** | Atomic's `_checkCompaction()` already tracks `contextOverflow` separately from recoverable-length attempts and emits distinct messages. |
| `ef8dc7385b` | Centralize compaction summary requests | **equivalent — verified S2** | Atomic already funnels all default execution through `_applyVerbatimCompaction()` and isolates request construction in `planDeletedLineRanges()`. |
| `cff1cf52c6` | Cache-friendly compaction primitives | **not applicable — verified S2** | Reverted by `8dab70281b`; the feature nets to zero upstream, and `CacheFriendlySummaryOptions`/source-context replay have no safe analogue in byte-preserving verbatim deletion. |
| `8dab70281b` | Revert "cache-friendly compaction primitives" | **not applicable — verified S2** | Exact revert of a primitive Atomic never adopted. |
| `a6b1dbceb1` | Emit compaction-failed for extensions (#8241) | **ported (adapted) — shipped S2** | Added the Verbatim-aware event and failure emissions from `emitManualCompactionFailure()`, `_checkCompaction()` recovery exhaustion, `_runAutoCompaction()`, and `_preflightPostToolContext()`, with public API, tests, and docs. |
| `90305d90a0` | Disable tools during summarization | **ported (adapted) — shipped S2** | `generateBranchSummary()`, `generateSessionSummary()`, and `planDeletedLineRanges()` now disable tools and reject tool calls while retaining the planner's validated truncated-record recovery airlock. |
| `4495469a5e` | Compact without provider usage | **ported (adapted) — shipped S2** | `_checkCompaction()` now uses the pure message-size estimate for all-zero usage and keeps the stale usage-boundary guard for usage-backed estimates. |
| `836aee6d38` | Show compaction usage notices | **ported (adapted)**, S4 | Upstream gates persisted billing notices on `showCacheMissNotices`. Atomic persists `BranchSummaryEntry.usage` but exposes no aggregate for multi-attempt Verbatim planning; add truthful aggregate planner usage, the setting row, and fullscreen transcript notices. Shipped with the settings surface in S4 rather than S2. |
| `d711bd5f0a` | Preserve branch summary source leaf | **ported — shipped S2** | `navigateTree()` now passes its pre-navigation `oldLeafId` through so the summary parent remains the destination while `fromId` is the source; tree-traversal tests cover both identities. |
| `97fa14e39c` | Reject truncated compaction summaries (#7048) | **ported (adapted) — shipped S2** | `generateBranchSummary()` and `generateSessionSummary()` reject `length` prose; `planDeletedLineRanges()` still safely recovers only complete validated deletion records from truncated output. Atomic deliberately checks for tool calls before truncated-range recovery, unlike upstream's ordering: a response that emitted a tool call despite `toolChoice: "none"` is treated as derailed, so its partial ranges are not salvaged. |

### B4. Model and thinking-level scope (13) — S3 and S4

An evolving upstream series whose net state is what Atomic ports; intermediate commits that
were later reverted or stripped are recorded as net-neutral. Net upstream diff
(`2ff8ba6223^..cffe4d776c` plus `a2f369d63a`) is **912 additions + 200 deletions**.

**Net behavior adopted:** model and thinking changes are session-scoped by default; `Enter`
selects for the session and `Ctrl+S` also persists the startup default; a new `/thinking
[level]` command and a searchable thinking selector appear; selectors show, search, and sort by
the saved default with `model-id [provider]` labels; the global default-model and
default-thinking settings rows are replaced by a searchable per-model thinking override editor.

| Commit | Subject | Outcome | Slice / Atomic note |
|---|---|---|---|
| `2ff8ba6223` | Keep model and thinking level changes session scoped (#8356) | **ported (adapted)** | S3. Atomic's `agent-session-models.ts` persists every `setModel`/cycle/thinking change and has no per-model lookup. Add `ModelMutationOptions`, per-model thinking storage in `settings-types.ts` + accessors, and startup precedence in `model-resolver-initial.ts`/`sdk.ts`. Atomic's `packages/tui` `SettingsList` hunk is **inherited dependency** via S1. |
| `5133c9284f` | Drop `--default` and the global model row | **ported (adapted)** | S3. Atomic has no flag parser or default-model settings row, so the deletions are already equivalent; the session/default fallback semantics and the Ctrl+S-only persistence contract are the portable part. |
| `98767a25d2` | Remove token estimates | **equivalent** (net-neutral) | Fully reverted by `f0a2880f29`; Atomic already renders the estimates. |
| `f0a2880f29` | Revert token-estimate removal | **equivalent** | Restores the state Atomic already has. |
| `496185f6e4` | `/thinking` command | **ported (adapted)** | S4. Atomic has `components/thinking-selector.ts` but no `/thinking` in `core/slash-commands.ts`, no autocomplete entry, and no routing in `interactive-input-handling.ts`. Port the final `/thinking <level>` form; omit the superseded `--default` parser. |
| `9c8070fbe4` | Ctrl+S persists `/model` | **ported (adapted)** | S4. Atomic's model selector always persists on Enter; split into session-only Enter and persisting Ctrl+S callbacks. |
| `ee29aa118b` | Searchable default model and thinking level | **ported (adapted); shipped S4** | Atomic shipped one searchable combined model/level editor rather than upstream's stepped model-then-level picker, preserving per-model overrides with a simpler Atomic settings surface. |
| `a669db3c33` | Show `modelid [provider]` like `/model` | **ported (adapted)** | S4. Atomic's `/model` already renders id plus provider badge; the settings-side per-model picker and wider layout are new. |
| `1d3503fb9b` | Show and search saved defaults (#8399) | **ported (adapted)** | S4. Neither Atomic selector has a default badge or default-aware search. |
| `768184923a` | Narrow default-model query matching | **ported** | S4. Ships with the selector port; no standalone Atomic analogue. |
| `cffe4d776c` | Order current first, default second | **ported** | S4. Atomic sorts current-first by provider only. |
| `5b3caaf4cb` | Drop the global default-thinking settings row | **ported (adapted)** | S4. Atomic still exposes `Thinking level` in `settings-selector-items.ts`; replace it with the per-model override row. |
| `a2f369d63a` | Order `/tree` above `/thinking` | **ported (adapted)** | S4. Insert `/thinking` immediately after Atomic's existing `/tree`, preserving every Atomic-only command. |

### B5. Skills, packages, and llama.cpp (12) — S5

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `8c2529daeb` | Don't load root `.md` files as skills (#8012) | **ported**, S5 | `src/core/skills.ts:264` still routes every root `.md` through `loadSkillFromFile`, and line 279 diagnoses undeclared files. Silently skip non-`SKILL.md` files without frontmatter; keep diagnostics for malformed declared skills. Doc delta in `docs/skills.md`. |
| `5e11f65865` | Load nested markdown skills (#8255) | **ported**, S5 | `src/core/package-manager-resource-files.ts:140` includes loose Markdown only for `mode === "pi" && dir === root`; nested Agents-format Markdown is dropped. |
| `080932e53c` | Use `semver.gt` for version comparison (#8239) | **ported**, S5 | `package-manager-operations.ts:199` and `package-manager-npm.ts:256` both compare with `!==`, so a newer installed package can be downgraded. |
| `f8f03460a0` | Reduce workspace dependency tree | **intentionally deferred** | The coding-agent `glob` removal was attempted in S5, but removing the dependency broke ambient type resolution in Atomic's local toolchain. The dependency and existing collector remain; upstream workspace-package manifest hunks remain not applicable to Atomic's vendored/package layout. |
| `a1f955e9f4` | Remove redundant development dependencies | **ported; shipped**, S1 | Removed coding-agent's redundant `@types/diff` and `@types/ms` during S1's lock regeneration. Atomic had no root `jiti` duplicate. |
| `955a543b31` | Expose sleeping llama.cpp models (#8235) | **ported (adapted)**, S5 | `src/extensions/llama/provider.ts:64-65` filters sleeping models out even though `index.ts` and the UI already recognize them. |
| `a1bc0ec790` | llama.cpp guidance as no default (#8236) | **ported (adapted)**, S5 | Atomic's split `interactive-auth-login.ts:36-47` offers no llama-specific guidance; `docs/llama-cpp.md` needs the matching note. |
| `d3e3bbc011` | Allow network for llama model discovery (#8238) | **ported**, S5 | `src/extensions/llama/index.ts:54-57` refuses catalog refresh under offline mode; a local router is not the network policy's concern. |
| `dcd461925d` | Show llama presets if autoload enabled (#8558) | **ported (adapted)**, S5 | Atomic's llama client has no `/props` probe, no autoload detection, and no preset selection. Port while preserving Atomic's generation-checked catalog publishing. |
| `e429d90b80` | Update Z.AI Coding Plan defaults | **equivalent; verified**, S1 | `src/core/model-resolver-defaults.ts:22-23` already uses `glm-5.3` for `zai` and `zai-coding-cn`. |
| `70e878d4cf` | Route xAI through Responses, default Grok 4.6 (#8124) | **equivalent; verified** (coding-agent) / **skipped-vendored-ai** (`packages/ai`), S1 | `model-resolver-defaults.ts:18` is already `grok-4.6`; routing lives in the fork. |
| `1c28f3032e` | Update Cloudflare gateway sonnet test id (#8260) | **equivalent; verified**, S1 | Atomic's resolver default (`cerebras: gpt-oss-120b`, `model-resolver-defaults.ts:20`) and its Cloudflare compat test already match. |

### B6. Extensions, events, export, and input robustness (12) — S6

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `f47faf459f` | Register flag type mismatch (#8123) | **ported**, S6 | `src/core/extensions/api-types.ts:156` and `loader-api.ts:95` still take `{ type: "boolean" \| "string"; default?: boolean \| string }` with no runtime type check. |
| `a69bef789b` | Discard failed extension factory state (#8424) | **ported (adapted)**, S6 | `loader-core.ts:67` builds the API and awaits the factory with no success/discard transaction, and `loader-runtime.ts:11` commits staged inherited resources from a `finally` even when `run()` throws. Adapt the transaction to Atomic's resource-ownership batching and builtin extension packages. |
| `81152d88bb` | Clarify custom footer usage APIs (#8482) | **ported**, S6 | `src/core/extensions/ui-types.ts:260-262`, `footer-data-provider.ts:104-106`, and `examples/extensions/custom-footer.ts:8` all repeat the stale token/context guidance. |
| `1d08508ef6` | Use `agent_settled` instead of `end` (#8242) | **ported**, S6 | Atomic emits `agent_settled` (`agent-session-prompt.ts:257-259`) but `examples/extensions/{border-status-editor,git-checkpoint,notify,titlebar-spinner}.ts`, `examples/rpc-extension-ui.ts`, and `examples/sdk/README.md:142` still treat `agent_end` as final. Examples whose intent is genuinely per-turn stay unchanged. |
| `830a0a59e9` | Expose tool metadata at stream start (#7953) | **ported (adapted)**, S6 | `src/modes/json-event.ts:41-49` strips `partial` generically and loses the starting tool call's `id`/`toolName`; the adaptation must keep Atomic's `withEndTurn` (`:52-59`) and cumulative `usage`. Docs in `docs/json.md` + `docs/rpc.md`. |
| `460191cfcf` | Include context in Radius session shares | **ported (adapted)**, S6 | Only the export half: emit an export-only, Atomic-branded `atomic.share` custom entry carrying system prompt and tool schemas from `agent-session-export.ts`, without mutating the persisted session. The Radius upload half is rejected — see `686f3487f5`. |
| `f4585b8bec` | Simplify session sharing links | **ported (adapted)**, S6 | Atomic prints plain Gist/pi.dev URLs and runs the `gh auth status` preflight before export. Take the canonical-hyperlink and preflight-ordering cleanup; keep `ATOMIC_SHARE_VIEWER_URL` with its legacy `PI_SHARE_VIEWER_URL` alias. |
| `686f3487f5` | Share via Radius artifacts under experimental (#8443) | **intentionally rejected; confirmed S6** | Uploading session artifacts — including the system prompt and tool schemas — to upstream's hosted Radius service remains outside Atomic's product boundary. Atomic ships only an export-time `atomic.share` context record and retains private-Gist sharing. |
| `77f2d1235e` | Only share via Radius if logged in | **intentionally rejected; confirmed S6** | Atomic does not silently route `/share` to an upstream-hosted service when a Radius credential exists; S6 preserved the existing private-Gist transport and Atomic viewer URL. |
| `df018b6020` | Retry hung model catalog requests | **ported**, S6 | `src/utils/management-http.ts:9-11` exposes only an overall `timeoutMs` and reuses one combined signal, so a hung attempt can never be retried; `remote-catalog-provider.ts:85` needs the 4 s per-attempt limit. |
| `1355cd36e0` | Normalize UTF-8 BOMs in text inputs | **ported (adapted)**, S6 | Partly present: `src/utils/json.ts:9-15` already provides `stripJsonBom`/`parseJsonFileContent` for settings and trust, and `test/hashline-tools.test.ts:513` proves hashline edits preserve a file's BOM. Port the remaining readers (auth, models, model config, keybindings, frontmatter, package manager, resource loader, theme, CLI file processor) without disturbing either. |
| `c49906ec77` | Preserve managed state file permissions | **ported (adapted)**, S6 | `auth-storage-backends.ts:113-119` writes a temp file, chmods `0600`, and renames over the target, so simply dropping the chmod would still replace the inode and its mode. Carry the existing target mode onto the replacement while keeping `0600` as the creation default. |

### B7. Startup diagnostics and Windows surface (7) — S7

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `1e1a6e27be` | Include paths in settings errors | **ported**, S7 | `src/core/settings-types.ts:176-179` carries only `{scope,error}` and `settings-manager-core.ts:328` records no path. Atomic must report layered primary `.atomic` and legacy `.pi` paths rather than one path per scope. |
| `913bcf3391` | Report settings diagnostic paths | **ported**, S7 | `src/core/settings-diagnostics.ts` does not exist; `main.ts:704` calls `reportDiagnostics(runtime.diagnostics)` with no path-aware formatting or deduplication. Builds on `1e1a6e27be`. |
| `678f0af30d` | Show startup diagnostics in TUI | **ported**, S7 | `main.ts:704` writes diagnostics before the renderer starts, so a fullscreen-only Atomic loses them to the alternate-screen switch. Route them into the transcript instead. |
| `80e62761f7` | Add optional PowerShell tool (#8512) | **ported (adapted)**, S7 | Atomic has no `src/core/tools/powershell.ts`, no `getPowerShellConfig`, and `src/utils/shell.ts` only resolves Bash; `docs/windows.md` still states Atomic requires a bash shell. Port opt-in and Windows-only, preferring `pwsh.exe` then `powershell.exe`, keeping `!`/`!!` on Bash, Atomic's `ToolName` union (`search`, `ask_user_question`, `todo`), and dual `ATOMIC_*`/`PI_*` variables. |
| `27b7a626de` | Use Windows-friendly keybinding defaults | **ported (adapted)**, S7 | Atomic has no `useWindowsKeybindings()` or WSL detection and only special-cases native Windows for suspend and image paste. Adopt the Windows/WSL substitutions and doc updates, but **do not** restore upstream's transcript-search bindings: Atomic deliberately keeps `tui.altScreen.search*` at `defaultKeys: []`. The `packages/tui` half is **inherited dependency** via S1. |
| `74786a748f` | Support `--` end-of-options (#7269) | **equivalent** | `src/cli/args.ts` already breaks on `--` and pushes every later token into `messages`; Atomic is deliberately stricter than upstream, which still expands `@file` afterwards. `insertForcedOptionsBeforeTerminator()` protects forced RPC options. |
| `bcad846f93` | Update end-of-options CLI test | **equivalent** | `test/experimental-cli-command.test.ts` already asserts the corrected split. |

### B8. Startup cost (2) — S5

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `cec3a91c02` | Defer uncommon syntax grammars | **ported (adapted)**, S5 | `src/utils/syntax-highlight.ts` imports all of `highlight.js` eagerly. Register the ~20 common grammars up front and load the rest after first render, wiring the deferral into Atomic's split startup module rather than upstream's monolithic `interactive-mode.ts`. |
| `faecac2ca8` | Reduce bundled startup work | **ported (adapted)**, S5 | Only the `syntax-highlight.ts` dynamic-import simplification. The `scripts/build-coding-agent-bundle.mjs` hunk is **not applicable**: Atomic has no Node esbuild bundle. |

### B9. Upstream Node-runtime and installer architecture (5)

| Commit | Subject | Outcome |
|---|---|---|
| `7d4c0e05dd` | Bundle Node runtime (#8474) | **ported (adapted); dependency compatibility shipped in S1** — Node SEA remains not applicable because Atomic ships a Bun-compiled executable. However, pi-tui 0.84.3 extracted native lookup into `native-module-path.js`; Atomic now stages that required sidecar beside `native-modifiers.js` in both package and release binary builds, with the compiled-launcher boundary test covering execution from an unrelated cwd. |
| `c061328981` | Load extensions in Node SEA hosts (#8237) | **not applicable** — Node SEA is not an Atomic distribution; `loader-virtual-modules.ts:517` already covers Atomic's compiled artifact. |
| `c1279a65b3` | Defer jiti until extension loading | **not applicable** — touches only `scripts/build-coding-agent-bundle.mjs`, which Atomic does not have; Atomic's loader imports `jiti/static` under a Bun build that consumes raw TypeScript. |
| `309b524f4f` | Avoid duplicate clipboard binaries | **equivalent** — Atomic's `scripts/build-binaries.sh`, `stage-clipboard-native-bindings.ts`, and `copy-clipboard-native-bindings.ts` already stage target binaries into `@mariozechner/clipboard` without retaining native leaf packages, and `publish.yml` smoke-tests Linux, Windows, and musl archives. |
| `4af9d21d3b` | Update managed installations in place | **not applicable** — introduces `PI_MANAGED_INSTALL_ROOT` and a `pi.dev` lockfile-backed installer API. Atomic self-updates writable npm/pnpm installs and replaces archive installs by re-running its PowerShell installer against the `atomic-current` junction. |

### B10. Docs and CLI help (2)

| Commit | Subject | Outcome |
|---|---|---|
| `62bcbf6be0` | Document `--` end-of-options delimiter | **ported (adapted)**, S8 — `docs/usage.md` already explains the literal-message semantics, but `README.md` and `printHelp()` still omit `[--]` and its option row. |
| `b237412699` | Generalize thinking token budget fields (#8275) — docs half | **equivalent** — `docs/{custom-provider,models,settings}.md` already document `thinkingTokenBudgetField`, `supportsThinkingTokenBudget`, the vLLM alias, the 1024-token answer reserve, and the DashScope/Qwen caveat. The `packages/ai` half is **skipped-vendored-ai**. |

### B11. Upstream test hygiene (4)

| Commit | Subject | Outcome |
|---|---|---|
| `ca21c16861` | Single edit input (#8011) | **not applicable** — upstream accepts a lone `{oldText,newText}` object where its legacy edit tool wanted an array. Atomic's edit contract is hashline (`src/core/tools/edit.ts:299-302` parses one non-empty script through `Patch.parse`); there is no `edits` array to relax. |
| `8af7690c4f` | Skip trusted subagent prompts | **equivalent** — the fix lives in upstream's `examples/extensions/subagent`, which Atomic does not ship. Atomic's real implementation is `packages/subagents`, and host trust is resolved once in `main.ts:463-542` and surfaced through `ctx.isProjectTrusted()` (`extensions/runner-context.ts:170`). |
| `54d22b74b3` | Reduce redundant git update tests | **not applicable** — upstream test pruning; Atomic's `test/git-update.test.ts` is a Vitest suite with Atomic-specific hook-environment setup. |
| `b82a374c7d` | Reduce redundant slow tests | **not applicable** — test-seam refactor. Atomic's startup code is already split and `createSessionManager` is already imported at `main.ts:82`. |

### B12. Changelog-only or lockfile-only coding-agent hunks (3)

| Commit | Subject | Outcome |
|---|---|---|
| `209bc7b9a8` | Remove unused opentelemetry dependency | **equivalent; verified**, S1 — the regenerated lock and shrinkwrap retain no direct `@opentelemetry/api` dependency; remaining entries are transitive. Atomic's fork already omitted the direct dependency. |
| `374e56e553` | Avoid duplicate VS Code right-click paste | **inherited dependency; shipped**, S1 — `@earendil-works/pi-tui@0.84.3` carries the renderer fix, which Atomic's `AtomicTuiAltScreen extends TuiAltScreen` inherits directly; Atomic's changelog records the user-visible outcome. |
| `a470b121bf` | Expose finish reason compatibility override (#8487) | **equivalent** — `src/core/model-config.ts:77` already declares `supportsFinishReason: Type.Optional(Type.Boolean())`, and Atomic's vendored fork consumes the compat field. |

The release and bookkeeping commits `914cf1472e`, `4e58f324fa`, `0e0021fbbe`, and `31d4ed5860`
also carry `packages/coding-agent` manifest or changelog hunks only; they are classified in
[B1](#b1-bookkeeping-and-release-7) and are not recounted here.

## Outcome tally

All 110 commits, one primary classification each (28 in Part A, 82 in Part B):

| Classification | Part A | Part B | Total |
|---|---:|---:|---:|
| ported | 0 | 15 | 15 |
| ported (adapted) | 0 | 29 | 29 |
| inherited dependency | 2 | 4 | 6 |
| equivalent | 1 | 15 | 16 |
| not applicable | 6 | 15 | 21 |
| intentionally rejected | 0 | 3 | 3 |
| skipped-vendored-ai | 19 | 1 | 20 |
| **Total** | **28** | **82** | **110** |

**44 commits carry portable work** (15 ported + 29 ported (adapted)); they are distributed
across slices S1–S8 as recorded in each row above.

Three decisions are worth restating because they are refusals, not omissions:

1. **Radius artifact sharing** (`686f3487f5`, `77f2d1235e`) is declined. Atomic will not upload
   a session's system prompt and tool schemas to an upstream-hosted service, and will not do so
   implicitly on the strength of a stored credential.
2. **Compaction routing sessions** (`58302d34e7`) is declined. Verbatim planner requests stay on
   fresh session IDs with `cacheRetention: "none"`.
3. **Transcript-search keybindings** stay unbound inside `27b7a626de`. Atomic's
   `tui.altScreen.search*` defaults remain `[]`, as decided in the 0.84.2 port.
