---
date: 2026-08-14
researcher: Claude Opus 5
git_commit: 4ee9f77c8
branch: main
repository: atomic-monorepo
topic: Pi v0.84.1..v0.84.2 upstream commit and file port matrix
tags: [implementation, evidence, pi-0.84.2, port-matrix]
status: complete
last_updated: 2026-08-15
last_updated_by: Claude Opus 5
port_outcome: shipped — every layer L1–L21 landed on the `pi-0.84.2/*` stack; classifications below are flipped to their shipped outcomes
breaking_changes_allowed: false
compatibility_context: Preserve Atomic public SDK, branding, CLI, paths, legacy PI_*/.pi aliases, providers, isolated runtime, fullscreen-only renderer, Verbatim Compaction, and versionless manifests.
---

# Pi v0.84.2 Port Matrix

Classifies **all 137 commits** in upstream `v0.84.1..v0.84.2` against Atomic's
`packages/coding-agent` tree. **39 touch `packages/coding-agent`**; the other 98 are
upstream-package, dependency, release, or repository changes.

**Outcome (2026-08-15): the migration shipped.** All 21 stack layers landed on the
`pi-0.84.2/*` branches; the classification cells below record the *shipped* outcome,
not a recommendation, and the layer that carried each change is named where it is not
the dependency itself.

Atomic resolved `@earendil-works/pi-*` at `^0.84.1` before the migration and ran
**fullscreen only** — there was no `tuiMode` setting, no `--tui-mode` flag, and no
regular-renderer settings entry (`src/core/settings-types.ts:147` carried
`fullscreenScrollbar` and nothing else). The L1 bump moved all six ranges to `^0.84.2`;
`AtomicTuiAltScreen extends TuiAltScreen` remains the single renderer
(`src/modes/interactive/interactive-tui.ts`), and Atomic is still fullscreen-only.

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

| Commit | Subject | Outcome |
|---|---|---|
| `9dd90a49` | Mistral SDK → native transport | **inherited dependency; shipped** — `@mistralai/mistralai` left `package-lock.json` and the published `npm-shrinkwrap.json` in the L1 regeneration (`08d9fe99ed`), and L20 (`2ae060de4a`) restated the transport as native Mistral Chat Completions streaming in `docs/custom-provider.md`. |
| `b3edf017` | Bound Copilot policy update concurrency | **inherited dependency; shipped** with `pi-agent-core@0.84.2`. |
| `9d2ec7ff` | pi User-Agent for Kimi Coding | **inherited dependency; verified** — Atomic sends its own UA via `src/utils/pi-user-agent.ts`, which the L1 suite run exercised without regression. |
| `66336183` | nanoid → 3.3.17 | **ported** — lockfile refreshed in L1 (Atomic was already at 3.3.18, past upstream's 3.3.17 floor). |

### B3. Fullscreen surface (7) — the decision cluster

| Commit | Subject | Outcome | Shipped where / Atomic-specific note |
|---|---|---|---|
| `ac4ac9ea` | `fullscreenExitOutput` setting | **ported (adapted)** | L10 (`2336974e39`). Setting, accessors, and `/settings` row shipped; Atomic has no `switchTuiMode("regular")` step — the transcript exit hands the document container to pi-tui's exit paint, the resume-hint exit stops with `preserveScreen`, and the fatal-error path passes `"transcript"` explicitly. No "no effect in regular TUI mode" wording exists anywhere. |
| `00121ed9` | Fullscreen transcript search | **ported** | L8 (`ea4001619e`): theme colors + schemas + `Theme` constructor fallbacks, `searchMatchStyle`/`searchCurrentMatchStyle`, all four `tui.altScreen.search*` actions in `FULLSCREEN_VIEWPORT_ACTIONS`, `docs/keybindings.md`. L9 (`6958924144`+) extended it to stage chats. L21 finished `docs/themes.md`/`docs/tui.md`. |
| `1279952d` | Unbound single-line scroll actions | **ported** | L8: `tui.altScreen.lineUp`/`lineDown` added to the allowlist and documented as *(none)* defaults in `docs/keybindings.md`. |
| `4caa3c44` | Selection copy through host clipboard | **ported** | L10: `copySelection` routes through Atomic's `copyToClipboard`; pi-tui flashes "Copy failed" when the clipboard never received the text (#8110 fix). |
| `06ed8716` | `PI_TUI_ESC_TIMEOUT` for split Alt+Enter | **ported (docs)** | Fix arrived with pi-tui 0.84.2; L21 documents the variable in `docs/environment-variables.md` (100 ms over SSH, 10 ms otherwise). The name stays `PI_TUI_*` — the variable is pi-tui-owned. |
| `2a9b4ebc` | Terminal-specific fullscreen mouse behavior docs | **ported (adapted)** | L21: `docs/terminal-setup.md` gained the iTerm2 fast-trackpad workaround and the Ghostty fullscreen link-hover section; the upstream "Regular TUI mode" headings and every `regular`-mode sentence were dropped. |
| `6f707eb3` | Managed-tool startup status in TUI | **ported (partial)** | L10: `ensureTool(tool, onStatus)` replaced the silent flag; fd/rg readiness reports through the transcript instead of `console.error` into the alternate screen. The startup-blocking half was already **equivalent** (Atomic backgrounds `ensureTool`), and `handleStartupSubmit` gating stays **intentionally rejected** — Atomic already accepts input during deferred startup. |

**Explicitly rejected across this cluster:** the `tuiMode` setting, the `--tui-mode` flag,
the `/settings` "TUI mode" row, and every doc sentence that offers `regular` mode. Any
upstream hunk that reintroduces them is dropped, not adapted.

### B4. Core fixes (7)

| Commit | Subject | Outcome | Shipped where / Atomic site |
|---|---|---|---|
| `3dd4623e` | Trailing newline after "Current working directory" (#7887) | **ported** | L4 (`f8d5553840`), `src/core/system-prompt.ts`, both default and custom-prompt branches. |
| `47b5119d` | `triggerTurn: false` must not steer an active run (#8022) | **ported (adapted)** | L4: the generic `isStreaming` branch in both commit ladders of `src/core/agent-session-custom-message-commit.ts` is guarded with `options?.triggerTurn !== false`. |
| `c93ea6cc` | Preserve cumulative `usage` in `message_update` (#7982) | **ported** | L4: `src/modes/json-event.ts` carries `usage` on every update; a non-assistant message throws. L21 documented it in `docs/json.md` + `docs/rpc.md`. |
| `e14afc64` | Collapse fallback extension tool output (#7979) | **ported** | L4: `src/modes/interactive/components/tool-execution.ts` — 10-line preview + expand hint. |
| `7d8c11d3` | Share concurrent model-catalog refreshes | **ported** | L4 + follow-ups: `src/modes/interactive/model-catalog-refresh.ts`, keyed on runtime, effective network policy, credential state, and catalog content; wired through startup and the `/model` selector. |
| `ab0dc51f` | `APP_NAME` in user-facing messages (#8067) | **audited, resolved** | Five of six upstream sites already threaded `APP_NAME`/`APP_TITLE`. L4 fixed the residual literal ("not a valid Atomic session" now reads `APP_TITLE`); L4's `491ea86288` fixed the one the audit itself missed — the `-e` extension-source trust prompt in `main.ts`. |
| `5f7195c5` | Cloudflare compat test model refresh | **ported** | L1 (`08d9fe99ed`): `test/model-runtime-cloudflare-compat.test.ts` moved to `kimi-k2.6`. |

### B5. Features (5)

| Commit(s) | Subject | Outcome | Shipped where / Atomic-specific note |
|---|---|---|---|
| `4d9aa837` + `541045ae` | `defaultTools` setting | **ported (both together)** | L11 (`3f98195f73`, `d550e5a72e`): narrows only `initialActiveToolNames`, leaves `allowedToolNames` undefined, so builtin extension tools (`workflow`, `subagent`, `intercom`, `mcp`, `web_search`) stay registered and active; the accessor guards malformed values. L21 documented it in `docs/settings.md` + `docs/usage.md`. |
| `9795d602` | `--use-theme <name[/name]>` | **ported** | L13 (`67e2e34e70`): `InteractiveThemeController` moved to the options-object constructor with `getSettingsManager` and `initialThemeSetting`; non-persistent by design; `/export` and `/share` use the run theme. L12 shipped the concurrent-probe prerequisite. L21 documented it in `docs/themes.md` + `docs/usage.md`. |
| `7915cdac` | Strict JSON-schema constrained sampling under `PI_EXPERIMENTAL=1` | **ported (extended)** | L14 (`a62d4481fc`): applied to `read`, `bash`, `edit`, `write`, `find`, `search`, `ls`, `ask_user_question`, `todo`, and the harness wrapper — beyond upstream's four — behind `ATOMIC_EXPERIMENTAL=1`/`PI_EXPERIMENTAL=1`, with `prefer` (not `require`) semantics and composed (never double-wrapped) caller constraints. |
| `b987ead3` | `expandPromptTemplates` in `sendUserMessage()` | **ported** | L14: threaded through `agent-session-prompt.ts`, `agent-session-methods.ts`, `extensions/api-types.ts`, `context-types.ts`, `runtime-types.ts`, `loader-api.ts`; default stays `false`. L21 documented it in `docs/extensions.md`. |
| `e47b8e37` | `supportsAdditionalTools` compat flag | **ported** | L1 (`08d9fe99ed`): optional field in `OpenAIResponsesCompatSchema`; behavior shipped in pi-ai. |

### B6. Upstream example extension (2)

| Commit | Subject | Outcome |
|---|---|---|
| `e3798ca9` | Subagent example inherits parent session model/thinking/tool config (#7897) | **audited, parity fixed** — L16 (`dab93eaa41`): a `@bastani/subagents` child that pins no model of its own now inherits the dispatching session's thinking level alongside its model; declared `thinking` and candidate `:level` suffixes still win. |
| `d268454e` | Subagent example accepts array-form `tools` frontmatter (#7598) | **audited, parity fixed** — L16: agent frontmatter accepts YAML array-form `tools` (flow and block sequences) through Atomic's YAML-backed `parseFrontmatter`; follow-ups (`e860e043af`, `a47ab7d3a4`) repaired multi-line flow sequences, zero-indent block lists, and lossless extra-field round-tripping. |

### B7. Documentation (7)

| Commit | Subject | Outcome |
|---|---|---|
| `9cb7f493` | `AI_AGENT` process marker | **ported (docs)** — Atomic already set `AI_AGENT=atomic` and already documented it in `docs/environment-variables.md` (Subprocess attribution) and `docs/usage.md`; no further change was needed. Atomic keeps its own marker value (`atomic`, not upstream's `pi`). |
| `581d75a8` | Model catalog refresh docs | **ported** — L19 (`4cb0c70399`) documents `ModelRuntime.create({ allowModelNetwork, modelRefreshTimeoutMs })`, the models-store location, the four-hour refresh throttle, and `refresh({ allowNetwork, force, signal })` in `docs/sdk.md`, with defaults pinned to the implementation by a doc-contract test. |
| `46bb9a2c` | Windows paths in settings JSON | **ported** — L21 adds the forward-slash/escaped-backslash guidance with both `shellPath` spellings to `docs/settings.md`. |
| `368e013d` | Compaction docs ASCII alignment (5 lines) | **audited, not applicable** — the fix aligns upstream's entry-box `┌──┬──` diagrams, which do not exist in Atomic's Verbatim Compaction `docs/compaction.md`; that document carries different ASCII art (branch-navigation trees) that was already aligned. No hunk taken. |
| `6d520c58` | Compaction docs ASCII alignment (2 lines) | **audited, not applicable** — same upstream diagrams as `368e013d`; nothing in Atomic's compaction doc corresponds. No hunk taken. |
| `47610217` | Compaction docs "reloads" phrasing | **audited, equivalent already present** — upstream rewrote "Session reloads" as "Session rebuilds the context for the next request". Atomic's compaction doc never used reload phrasing; it already describes rebuild ("On rebuild, Atomic emits one visible custom-role boundary message…"), and a grep confirms no "reload" wording remains. No hunk taken. |
| `31b513e3` | Compaction docs bullet rewrite | **audited, not applicable** — the rewritten bullet belongs to upstream's summary-compaction "How It Works" list, a mechanism Atomic's verbatim line compaction does not share (Atomic's parameters, rungs, and markers tables replaced it). No hunk taken. |
