---
date: 2026-08-14
researcher: Claude Opus 5
git_commit: 4ee9f77c8
branch: main
repository: atomic-monorepo
topic: Pi v0.84.1..v0.84.2 upstream commit and file port matrix
tags: [implementation, evidence, pi-0.84.2, port-matrix]
status: complete
last_updated: 2026-08-14
last_updated_by: Claude Opus 5
breaking_changes_allowed: false
compatibility_context: Preserve Atomic public SDK, branding, CLI, paths, legacy PI_*/.pi aliases, providers, isolated runtime, fullscreen-only renderer, Verbatim Compaction, and versionless manifests.
---

# Pi v0.84.2 Port Matrix

Classifies **all 137 commits** in upstream `v0.84.1..v0.84.2` against Atomic's
`packages/coding-agent` tree. **39 touch `packages/coding-agent`**; the other 98 are
upstream-package, dependency, release, or repository changes.

Atomic currently resolves `@earendil-works/pi-*` at `^0.84.1`
(`packages/coding-agent/package.json:88-92`) and runs **fullscreen only** — there is no
`tuiMode` setting, no `--tui-mode` flag, and no regular-renderer settings entry
(`src/core/settings-types.ts:147` carries `fullscreenScrollbar` and nothing else).
`AtomicTuiAltScreen extends TuiAltScreen` is the single renderer
(`src/modes/interactive/interactive-tui.ts:229,407-431`).

## Source evidence

- Commit inventory (137 rows): [`upstream-v0.84.1-v0.84.2-commits.txt`](upstream-v0.84.1-v0.84.2-commits.txt)
- Per-commit changed paths: [`upstream-v0.84.1-v0.84.2-commit-paths.txt`](upstream-v0.84.1-v0.84.2-commit-paths.txt)
- File inventory: [`upstream-v0.84.1-v0.84.2-name-status.txt`](upstream-v0.84.1-v0.84.2-name-status.txt)
- Range summary: [`upstream-v0.84.1-v0.84.2-log-stat.txt`](upstream-v0.84.1-v0.84.2-log-stat.txt)
- Full coding-agent patch (3720 lines): [`upstream-v0.84.1-v0.84.2-coding-agent.diff`](upstream-v0.84.1-v0.84.2-coding-agent.diff)

Classification vocabulary is unchanged from the 0.84.1 matrix: **ported**,
**intentionally adapted** *(present)* / *(not yet ported)*, **inherited dependency**,
**equivalent**, **not applicable**, plus **intentionally rejected** for behavior Atomic
declines on architectural grounds.

## Part A — 98 commits that do not touch `packages/coding-agent`

| Count | Group | Classification | Basis |
|---:|---|---|---|
| 47 | `docs(agent)` harness-v3 / storage design documents | **not applicable** | Upstream design prose under `packages/agent/docs`; Atomic vendors no agent-core source and ships no upstream design docs. |
| 9 | `packages/agent` JSONL codec, session listing, harness event listeners/watches, session-name clearing | **inherited dependency** | Arrives with `@earendil-works/pi-agent-core@0.84.2`. Atomic constructs `Agent` from the dependency (`src/core/sdk.ts`). |
| 4 | `packages/session-backends/sqlite-node` (CTEs, index deletion, time-as-number, search refactor) | **not applicable** | Atomic persists sessions as JSONL (`src/core/session-manager-storage.ts`) and declares no session-backend dependency. |
| 12 | `packages/ai` provider/transport fixes (Responses namespaces, DeepSeek `max_tokens`, DeepSeek case-insensitive base URL, Bedrock empty tool-argument keys, Google length stops with tool calls, Codex `end_turn`, upstream buffer retry, Cloudflare strict tools, AI Gateway binding transport, DeepSeek V4 Flash low effort, two test fixtures) | **inherited dependency** | Arrives with `@earendil-works/pi-ai@0.84.2`. |
| 7 | `packages/tui` renderer fixes (full-width row painting, idle focus-loss repaint, LaTeX control spaces across line endings, focused-overlay wheel/viewport keys, generic SGR mouse release, indent) | **inherited dependency** | Arrives with `@earendil-works/pi-tui@0.84.2`; Atomic vendors no renderer copy. |
| 16 | `.github` contributor allowlist approvals | **not applicable** | Upstream governance; Atomic has `CONTRIBUTING.md:27-35`. |
| 1 | `~scripts` npm 12 `pack --json` handling | **not applicable** | Atomic's release path is `scripts/cut-release.ts` + `publish.yml`, not `scripts/release.mjs`. |
| 1 | `~package-lock.json` nanoid 3.3.17 root refresh | **ported** (dependency) | Paired with coding-agent commit `66336183`. |
| 1 | `~SECURITY.md` typos | **not applicable** | Atomic owns `SECURITY.md`. |
| 1 | `~AGENTS.md` "require clear concrete explanations" | **not applicable** | Atomic owns `AGENTS.md`. |

## Part B — 39 commits touching `packages/coding-agent`

### B1. Bookkeeping (3)

| Commit | Subject | Classification |
|---|---|---|
| `310411ba` | Add `[Unreleased]` section | **not applicable** — Atomic maintains its own changelog; released sections frozen by `test/unit/changelog.test.ts`. |
| `d10c974b`, `9b4adc82` | docs: audit changelogs since v0.84.1 | **not applicable** — upstream release prose. |
| `914cf147` | Release v0.84.2 | **not applicable** — Atomic release bases stay at `0.0.0`. |

### B2. Dependency-carried, coding-agent hunk is changelog-only (4)

| Commit | Subject | Atomic action |
|---|---|---|
| `9dd90a49` | Mistral SDK → native transport | **inherited dependency**; drop `@mistralai/mistralai` from Atomic's `install-lock/package-lock.json` and `npm-shrinkwrap.json` when regenerating. |
| `b3edf017` | Bound Copilot policy update concurrency | **inherited dependency**. |
| `9d2ec7ff` | pi User-Agent for Kimi Coding | **inherited dependency**; Atomic sends its own UA via `src/utils/pi-user-agent.ts` — verify no regression. |
| `66336183` | nanoid → 3.3.17 | **ported** — lockfile refresh only. |

### B3. Fullscreen surface (7) — the decision cluster

| Commit | Subject | Recommendation | Atomic-specific note |
|---|---|---|---|
| `ac4ac9ea` | `fullscreenExitOutput` setting | **take, adapted** | Atomic has no `switchTuiMode("regular")` step. Adapt `stopInteractiveTui()` to either paint the transcript on the main screen or `ui.stop({ preserveScreen: true })` and print only the resume hint. Drop all "no effect in regular TUI mode" wording. |
| `00121ed9` | Fullscreen transcript search | **take** | Engine is in pi-tui. Atomic owns: `searchMatchBg`/`searchMatchText` theme colors + schema (`theme/theme.ts`, `theme-schema.json`, `dark.json`, `light.json`), the `searchMatchStyle`/`searchCurrentMatchStyle` options at `interactive-tui.ts:415-430`, and `docs/keybindings.md`. **Also** add the four `tui.altScreen.search*` actions to Atomic's explicit action allowlist (`interactive-mode-base.ts:67-74`) or the bindings will not route. |
| `1279952d` | Unbound single-line scroll actions | **take (docs + allowlist)** | Same allowlist requirement as above. |
| `4caa3c44` | Selection copy through host clipboard | **take** | Atomic already exports `copyToClipboard` (`src/utils/clipboard.ts:48`); pass `copySelection` in `createInteractiveTui`. |
| `06ed8716` | `PI_TUI_ESC_TIMEOUT` for split Alt+Enter | **take (docs)** | Fix is in pi-tui. The variable is pi-tui-owned, so it stays `PI_TUI_*`; document in `docs/environment-variables.md`. |
| `2a9b4ebc` | Terminal-specific fullscreen mouse behavior docs | **take, adapted** | Copy the terminal-behavior content; drop every `regular` / `--tui-mode` sentence. |
| `6f707eb3` | Managed-tool startup status in TUI | **take, partial** | Atomic already backgrounds `ensureTool` (`interactive-startup.ts:226-234`), so the startup-blocking half is **equivalent**. Take the `ensureTool(tool, onStatus)` signature change and route warnings into the transcript — Atomic's current `console.error` at `:233` writes into the alternate screen. Atomic already accepts input during deferred startup, so `handleStartupSubmit` gating is **intentionally rejected**. |

**Explicitly rejected across this cluster:** the `tuiMode` setting, the `--tui-mode` flag,
the `/settings` "TUI mode" row, and every doc sentence that offers `regular` mode. Any
upstream hunk that reintroduces them is dropped, not adapted.

### B4. Core fixes (7)

| Commit | Subject | Classification | Atomic site |
|---|---|---|---|
| `3dd4623e` | Trailing newline after "Current working directory" (#7887) | **take** | `src/core/system-prompt.ts` (cwd emitted around `:68`). |
| `47b5119d` | `triggerTurn: false` must not steer an active run (#8022) | **take, adapted** | Atomic's ladder is larger: `src/core/agent-session-custom-message-commit.ts:52-57` and the second copy at `:107-134`. Guard the generic `isStreaming` branch with `options?.triggerTurn !== false`. |
| `c93ea6cc` | Preserve cumulative `usage` in `message_update` (#7982) | **take** | `src/modes/json-event.ts` is byte-identical to upstream pre-fix. Additive wire field; `docs/json.md` + `docs/rpc.md` follow. |
| `e14afc64` | Collapse fallback extension tool output (#7979) | **take** | `src/modes/interactive/components/tool-execution.ts` — 10-line preview + expand hint. |
| `7d8c11d3` | Share concurrent model-catalog refreshes | **take** | New `src/modes/interactive/model-catalog-refresh.ts` (missing in Atomic) + model-selector/interactive-mode wiring. |
| `ab0dc51f` | `APP_NAME` in user-facing messages (#8067) | **audit** | Atomic already threads `APP_NAME` widely; spot-check the six upstream sites for residual literals. |
| `5f7195c5` | Cloudflare compat test model refresh | **take** | `test/model-runtime-cloudflare-compat.test.ts`. |

### B5. Features (5)

| Commit(s) | Subject | Recommendation | Atomic-specific note |
|---|---|---|---|
| `4d9aa837` + `541045ae` | `defaultTools` setting | **take both together** | `541045ae` is the fix that stops `defaultTools` from dropping extension/custom tools. Atomic ships builtin extension tools (`workflow`, `subagent`, `intercom`, `mcp`, `web_search`, `todo`, `ask_user_question`); without `541045ae` a `defaultTools` array would silently disable all of them. Sites: `src/core/sdk.ts` (~`:244`), `src/core/settings-types.ts`, `src/core/settings-manager*.ts`, `docs/settings.md`. |
| `9795d602` | `--use-theme <name[/name]>` | **take** | Requires refactoring `InteractiveThemeController`'s constructor to the options object with `getSettingsManager` and `initialThemeSetting` (`src/modes/interactive/theme/theme-controller.ts:18-36`), plus `src/cli/args.ts`, `main.ts`, `agent-session.ts`. Non-persistent by design. |
| `7915cdac` | Strict JSON-schema constrained sampling under `PI_EXPERIMENTAL=1` | **take** | Atomic's gate already exists (`src/core/experimental.ts`, honoring `ATOMIC_EXPERIMENTAL` and `PI_EXPERIMENTAL`). Apply to `read`, `bash`, `edit`, `write`, and `src/server/create-harness.ts`. Open question: whether Atomic-only tools opt in. |
| `b987ead3` | `expandPromptTemplates` in `sendUserMessage()` | **take** | Atomic hardcodes `expandPromptTemplates: false` (`src/core/agent-session-prompt.ts:517-522`). Thread the option through `agent-session-methods.ts:175`, `extensions/api-types.ts:214`, `extensions/context-types.ts:217`, `extensions/runtime-types.ts:159`, `extensions/loader-api.ts:164`. Default stays `false`. |
| `e47b8e37` | `supportsAdditionalTools` compat flag | **take** | One optional field in `OpenAIResponsesCompatSchema` (`src/core/model-config.ts:114-123`); the behavior is in pi-ai. |

### B6. Upstream example extension (2)

| Commit | Subject | Recommendation |
|---|---|---|
| `e3798ca9` | Subagent example inherits parent session model/thinking/tool config (#7897) | **audit `@bastani/subagents`** — Atomic ships its own subagent package instead of the example extension. |
| `d268454e` | Subagent example accepts array-form `tools` frontmatter (#7598) | **audit `@bastani/subagents`** — same. |

### B7. Documentation (7)

| Commit | Subject | Recommendation |
|---|---|---|
| `9cb7f493` | `AI_AGENT` process marker | **take, adapted** — Atomic already sets `AI_AGENT=atomic` (`src/cli.ts:19`, `src/bun/split-loader.ts:11`, `src/utils/child-process.ts:29`) but `docs/environment-variables.md` does not document it. Document `AI_AGENT=atomic` alongside the Atomic/legacy `PI_CODING_AGENT` marker. |
| `581d75a8` | Model catalog refresh docs | **take** (pairs with `7d8c11d3`). |
| `46bb9a2c` | Windows paths in settings JSON | **take** — Atomic ships `docs/windows.md` and full Windows CI. |
| `368e013d`, `47610217`, `31b513e3`, `6d520c58` | Compaction docs (ASCII alignment, "reloads" phrasing, bullet rewrite) | **audit** — Atomic's `docs/compaction.md` documents Verbatim Compaction, a different mechanism; take only hunks that still describe Atomic behavior. |
