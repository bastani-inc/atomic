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

### Exact-tag post-merge audit

After the stacked PRs reached `main`, the port was re-audited directly against the fetched upstream tags rather than trusting this planning matrix. The exact range is `v0.84.2` (`914cf1472e715297caa30db4b9535d534a9eb718`) through `v0.84.3` (`4e58f324fae8ebfa98a3d45181fb248072a2afac`): **105 commits**, of which **78** touch `packages/coding-agent`, across **146** coding-agent files. Every one of those 78 commit IDs is present in this matrix. This matrix's larger 110-row inventory additionally includes the v0.84.2 baseline and four post-tag upstream commits, as stated above.

The exact-tag audit found eleven incomplete cross-file ports that the original commit-level classification failed to catch:

1. `/thinking` routing existed, but its `BUILTIN_SLASH_COMMANDS` registration and dynamic level completions were absent; `/model` also lacked upstream's `<provider/model>` argument hint.
2. The PowerShell implementation existed, but the package-root SDK factories/types, `getPowerShellConfig()`, typed extension call/result events, result guard, and tool-call narrowing overload were absent.
3. The llama.cpp docs described post-login `/llama` guidance, but the interactive login runtime still emitted generic `/model` guidance.
4. PowerShell was listed as a tool, but the shell-only system-prompt fallback still handled only Bash and omitted upstream's PowerShell file-operation guidance.
5. `showCacheMissNotices` existed, but persisted branch-summary billing notices and truthful aggregate usage for multi-attempt Verbatim Compaction were not rendered or counted.
6. UTF-8 BOM normalization covered configuration/resource readers but missed prompts returned from the external editor.
7. Managed-state atomic replacement still reset existing file modes despite the matrix claiming the permission-preservation fix had shipped.
8. `/model` honored Ctrl+S persistence but omitted the selector hint explaining session-only Enter versus saved-default Ctrl+S.

A second verification pass over the same tags — comparing every upstream-added exported
declaration and every long added user-visible literal, rather than re-reading this matrix —
found three more, all of which had already been claimed as shipped:

9. `a2f369d63a` ("order tree above thinking") was recorded as ported, but `BUILTIN_SLASH_COMMANDS` still listed `/thinking` second and `/tree` nineteenth — the exact ordering upstream fixed. `/tree` now precedes `/thinking`, and `test/unit/slash-commands.test.ts` asserts the relative order.
10. `80e62761f7` parameterizes each shell tool's transcript prompt and overflow temp-file prefix (`powershellToolConfig.prompt = "PS>"`, `tempFilePrefix: "pi-powershell"`). Atomic's `createPowerShellToolDefinition()` spread the bash definition and inherited the hardcoded `$` prompt and `atomic-bash` prefix, so PowerShell calls rendered as Bash. `bash.ts` now takes a `ShellToolPresentation`, and `test/powershell-tool.test.ts` renders both tools to prove the prompts differ.
11. `2ff8ba6223`/`5133c9284f` added a sentinel empty-state row explaining that a login or API key is required when no default-model catalog entry exists. Atomic's combined per-model thinking editor opened a zero-row picker instead; the sentinel row and an inert selection guard are covered by `test/settings-per-model-thinking.test.ts`.

One duplicate-billing guard shipped in repair 5 without coverage: the live `compaction_end`
path both rebuilds from a boundary that now persists its own usage and re-announces that
boundary, so `renderSessionEntries()` suppresses the persisted notice. `test/interactive-mode-compaction.test.ts`
now pins that to exactly one notice.

The repair includes compile-time root-export checks, slash-command metadata and ordering tests, Bash/PowerShell system-prompt matrix and transcript-prompt tests, llama.cpp guidance tests, aggregate planner-retry usage tests, compaction notice ordering/gating/de-duplication tests, BOM regression coverage across Atomic's split reader doors, managed-mode persistence tests, model-selector persistence-hint rendering, settings empty-state tests, user-facing SDK/extension/Windows/environment/settings documentation, and direct comparison of upstream's added public declarations and long user-visible literals. The remaining upstream-added declarations absent by name are intentional Atomic adaptations already classified below: combined settings selectors, private-Gist sharing, Bun rather than Node SEA, the existing package collector rather than Node glob expansion, hashline edit input, and Atomic's installer/update architecture. Three further absences are name-only, with verified Atomic equivalents: upstream's `THINKING_LEVEL_OPTIONS` is Atomic's `THINKING_LEVELS` plus `getAvailableThinkingLevels()`; upstream's `createLocalShellOperations`/`createShellToolDefinition`/`ShellToolConfig` split is Atomic's `createBashToolDefinition` plus `ShellToolPresentation`; and upstream's `normalizeSessionName()` test seam is the identical inline trim at `src/main.ts:438-441`.

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
| `836aee6d38` | Show compaction usage notices | **ported (adapted); post-merge audit repaired** | `showCacheMissNotices` now gates chronological billing notices for persisted branch summaries and completed Verbatim Compaction. Atomic aggregates every planner response across retries, overflow trimming, and fallback rungs; persists that usage on the compaction boundary; and includes it in session statistics, footer totals, and cost breakdowns. Focused tests cover retry aggregation, live notice ordering, and disabled-notice behavior. |
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
| `2ff8ba6223` | Keep model and thinking level changes session scoped (#8356) | **ported (adapted); verified** | `ModelMutationOptions.persist` makes model/cycle/thinking changes session-only by default, `modelThinkingLevels` stores per-model startup overrides, and `model-resolver-initial.ts` applies scoped → per-model → global precedence. The `SettingsList` hunk is inherited through pi-tui 0.84.3. |
| `5133c9284f` | Drop `--default` and the global model row | **ported (adapted)** | S3. Atomic has no flag parser or default-model settings row, so the deletions are already equivalent; the session/default fallback semantics and the Ctrl+S-only persistence contract are the portable part. |
| `98767a25d2` | Remove token estimates | **equivalent** (net-neutral) | Fully reverted by `f0a2880f29`; Atomic already renders the estimates. |
| `f0a2880f29` | Revert token-estimate removal | **equivalent** | Restores the state Atomic already has. |
| `496185f6e4` | `/thinking` command | **ported (adapted); post-merge audit repaired** | S4 plus the exact-tag repair. Atomic now has the final `/thinking <level>` routing, `BUILTIN_SLASH_COMMANDS` registration, active-model level completions, and tests; the superseded `--default` parser remains omitted. |
| `9c8070fbe4` | Ctrl+S persists `/model` | **ported (adapted); post-merge audit repaired** | Enter selects only for the current session; Ctrl+S passes `persist: true` and saves the startup default. The exact-tag repair added the missing remapping-aware footer that exposes both actions plus cancel. |
| `ee29aa118b` | Searchable default model and thinking level | **ported (adapted); shipped S4, empty state repaired** | Atomic shipped one searchable combined model/level editor rather than upstream's stepped model-then-level picker, preserving per-model overrides with a simpler Atomic settings surface. Upstream's empty-catalog sentinel row is now carried too, with an inert selection guard. |
| `a669db3c33` | Show `modelid [provider]` like `/model` | **ported (adapted)** | S4. Atomic's `/model` already renders id plus provider badge; the settings-side per-model picker and wider layout are new. |
| `1d3503fb9b` | Show and search saved defaults (#8399) | **ported (adapted); verified** | Model and thinking selectors expose saved defaults in labels/search and order current/default choices first. |
| `768184923a` | Narrow default-model query matching | **ported; verified** | The selector's default-aware search is scoped to the explicit default marker instead of broad incidental text matches. |
| `cffe4d776c` | Order current first, default second | **ported; verified** | Selector ordering pins the active model first and the saved default second before ordinary matches. |
| `5b3caaf4cb` | Drop the global default-thinking settings row | **ported (adapted); verified** | Atomic's settings surface now exposes `Default thinking level per model`, backed by `modelThinkingLevels`, instead of the old global row. |
| `a2f369d63a` | Order `/tree` above `/thinking` | **ported (adapted); post-merge audit repaired** | `/thinking` is registered immediately after `/tree`, preserving Atomic-only commands around the upstream order. |

### B5. Skills, packages, and llama.cpp (12) — S5

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `8c2529daeb` | Don't load root `.md` files as skills (#8012) | **ported; verified** | Ordinary root Markdown without skill frontmatter is silently skipped; malformed declared skills still produce diagnostics. |
| `5e11f65865` | Load nested markdown skills (#8255) | **ported; verified** | Package discovery recurses for nested `SKILL.md` entries instead of limiting loose Markdown handling to the package root. |
| `080932e53c` | Use `semver.gt` for version comparison (#8239) | **ported; verified** | Package update checks use semantic version ordering, preventing an older registry version from being treated as an upgrade. |
| `f8f03460a0` | Reduce workspace dependency tree | **intentionally deferred** | The coding-agent `glob` removal was attempted in S5, but removing the dependency broke ambient type resolution in Atomic's local toolchain. The dependency and existing collector remain; upstream workspace-package manifest hunks remain not applicable to Atomic's vendored/package layout. |
| `a1f955e9f4` | Remove redundant development dependencies | **ported; shipped**, S1 | Removed coding-agent's redundant `@types/diff` and `@types/ms` during S1's lock regeneration. Atomic had no root `jiti` duplicate. |
| `955a543b31` | Expose sleeping llama.cpp models (#8235) | **ported (adapted); verified** | `provider.ts` publishes both loaded and sleeping router models as selectable. |
| `a1bc0ec790` | llama.cpp guidance as no default (#8236) | **ported (adapted); post-merge audit repaired** | Login guidance sends users with no loaded models to `/llama` before `/model`; focused tests cover loaded and empty catalogs. |
| `d3e3bbc011` | Allow network for llama model discovery (#8238) | **ported; verified** | Local-router discovery is no longer blocked by the general offline catalog policy. |
| `dcd461925d` | Show llama presets if autoload enabled (#8558) | **ported (adapted); verified** | `LlamaClient.props()` probes `/props`; preset models are published only when `models_autoload` is enabled, while generation-checked catalog updates remain intact. |
| `e429d90b80` | Update Z.AI Coding Plan defaults | **equivalent; verified**, S1 | `src/core/model-resolver-defaults.ts:22-23` already uses `glm-5.3` for `zai` and `zai-coding-cn`. |
| `70e878d4cf` | Route xAI through Responses, default Grok 4.6 (#8124) | **equivalent; verified** (coding-agent) / **skipped-vendored-ai** (`packages/ai`), S1 | `model-resolver-defaults.ts:18` is already `grok-4.6`; routing lives in the fork. |
| `1c28f3032e` | Update Cloudflare gateway sonnet test id (#8260) | **equivalent; verified**, S1 | Atomic's resolver default (`cerebras: gpt-oss-120b`, `model-resolver-defaults.ts:20`) and its Cloudflare compat test already match. |

### B6. Extensions, events, export, and input robustness (12) — S6

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `f47faf459f` | Register flag type mismatch (#8123) | **ported; verified** | `registerFlag()` rejects a runtime default whose JavaScript type does not match its declared boolean/string type. |
| `a69bef789b` | Discard failed extension factory state (#8424) | **ported (adapted); verified** | Extension API creation is transactional: successful factories commit staged resources; failures discard flags, handlers, providers, and inherited registrations, including rollback of partially applied provider changes. |
| `81152d88bb` | Clarify custom footer usage APIs (#8482) | **ported; verified** | Public footer guidance consistently distinguishes context-window usage from cumulative token/cost totals. |
| `1d08508ef6` | Use `agent_settled` instead of `end` (#8242) | **ported; verified** | Long-lived extension/RPC/SDK examples now stop working indicators and clear checkpoints on `agent_settled`; genuinely per-turn examples retain their event. |
| `830a0a59e9` | Expose tool metadata at stream start (#7953) | **ported (adapted); verified** | JSON/RPC `toolcall_start` strips the cumulative snapshot but retains `id` and `toolName`, while Atomic keeps cumulative usage and optional `endTurn`. |
| `460191cfcf` | Include context in Radius session shares | **ported (adapted); verified** | Atomic emits an export-only `atomic.share` record with the system prompt and active tool schemas without mutating persisted sessions; Radius upload remains rejected. |
| `f4585b8bec` | Simplify session sharing links | **ported (adapted); verified** | Private-Gist sharing prints the canonical clickable viewer URL and runs authentication preflight before export, retaining Atomic's viewer environment aliases. |
| `686f3487f5` | Share via Radius artifacts under experimental (#8443) | **intentionally rejected; confirmed S6** | Uploading session artifacts — including the system prompt and tool schemas — to upstream's hosted Radius service remains outside Atomic's product boundary. Atomic ships only an export-time `atomic.share` context record and retains private-Gist sharing. |
| `77f2d1235e` | Only share via Radius if logged in | **intentionally rejected; confirmed S6** | Atomic does not silently route `/share` to an upstream-hosted service when a Radius credential exists; S6 preserved the existing private-Gist transport and Atomic viewer URL. |
| `df018b6020` | Retry hung model catalog requests | **ported; verified** | Management requests support a retryable per-attempt timeout, and remote catalog refreshes apply the upstream 4-second attempt bound inside the overall deadline. |
| `1355cd36e0` | Normalize UTF-8 BOMs in text inputs | **ported (adapted); post-merge audit repaired** | Atomic preserves BOM-aware hashline edits and strips one leading BOM across auth backends, models/configuration, keybindings/migrations, frontmatter, package identity/manifests, resources/context, themes, CLI input, and external-editor text. Focused tests cover Atomic's split reader doors. |
| `c49906ec77` | Preserve managed state file permissions | **ported (adapted); post-merge audit repaired** | Atomic keeps atomic temp-file replacement for lock-free readers, copies an existing POSIX mode onto the replacement inode, and uses owner-only `0600` for newly created auth/model state. Focused tests cover both creation and managed-mode preservation. |

### B7. Startup diagnostics and Windows surface (7) — S7

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `1e1a6e27be` | Include paths in settings errors | **ported; verified** | `SettingsError.path` carries the exact layered `.atomic`/legacy `.pi` source path through settings loading. |
| `913bcf3391` | Report settings diagnostic paths | **ported; verified** | Startup settings diagnostics format source paths and deduplicate repeated messages while preserving first-observed order. |
| `678f0af30d` | Show startup diagnostics in TUI | **ported; verified** | Interactive startup passes diagnostics into the initialized transcript; non-interactive modes continue reporting them on stderr. |
| `80e62761f7` | Add optional PowerShell tool (#8512) | **ported (adapted); post-merge audit repaired** | Atomic enables PowerShell by default only on native Windows with a resolvable executable, while `!`/`!!` remain Bash. The exact-tag repair completed package-root SDK factories/types, shell configuration export, typed extension events/guards, PowerShell-only system-prompt guidance, the shell-specific `PS>` transcript prompt and `atomic-powershell` overflow prefix, compile-time export tests, and user-facing docs. |
| `27b7a626de` | Use Windows-friendly keybinding defaults | **ported (adapted); verified** | `useWindowsKeybindings()` covers native Windows and WSL substitutions for undo, prompt navigation, model cycling, queueing, and image paste. Atomic intentionally keeps transcript-search bindings disabled; the TUI half is inherited through pi-tui 0.84.3. |
| `74786a748f` | Support `--` end-of-options (#7269) | **equivalent** | `src/cli/args.ts` already breaks on `--` and pushes every later token into `messages`; Atomic is deliberately stricter than upstream, which still expands `@file` afterwards. `insertForcedOptionsBeforeTerminator()` protects forced RPC options. |
| `bcad846f93` | Update end-of-options CLI test | **equivalent** | `test/experimental-cli-command.test.ts` already asserts the corrected split. |

### B8. Startup cost (2) — S5

| Commit | Subject | Outcome | Atomic site |
|---|---|---|---|
| `cec3a91c02` | Defer uncommon syntax grammars | **ported (adapted); verified** | Atomic eagerly registers the common grammar set and defers the remaining language imports until after initial interactive startup. |
| `faecac2ca8` | Reduce bundled startup work | **ported (adapted); verified** | Atomic carries the syntax-highlighter dynamic-import reduction; upstream's Node esbuild bundle hunk is not applicable to the Bun-compiled distribution. |

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
| `62bcbf6be0` | Document `--` end-of-options delimiter | **ported (adapted); verified** — CLI help, README, and usage docs show `[--]` and explain Atomic's stricter literal-message behavior after the terminator. |
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
