# Host scroll widget handoff

## Frozen contract and scope

Implement slice 1 only: an opt-in, backwards-compatible native host scroll-widget contract using actual allocated layout, local wheel containment, an overflow-only one-column scrollbar, and local/remote parity. Preserve seed `df5dd4bca54725ae9f36b14411de1884ce5bb43e`. Work only on `feat/widget-scroll-host` in the assigned checkout. No adapter, shortcut registration, lifecycle repair, other-checkout mutation, push, PR, merge, tag, publish, or prior-workflow resumption.

The authoritative context is `/Users/tonystark/.atomic/agent/workflows/widget-scroll-slices/context.md`, as referenced by goal `6d733571-9a04-4ecb-8281-b2bb09a04d1e`. The full workflow scrolling goal remains dependent on the separately gated adapter slice; this commit does not claim that goal complete.

## Acceptance matrix

| Contract clause | Current evidence or gate |
| --- | --- |
| Opt-in host API; older/default widgets unchanged | `reactive-widget-scroll-contract.test.ts`: helper opt-in test and legacy prefix-clipping regression; existing `reactive-widget.test.ts` |
| Actual allocation, not requested maxHeight | Gate's multiline editor/other-widget test compares native layout box and reported viewport; resize and zero-height cases |
| Reuse ScrollView/VStack; preserve unrelated widget behavior | Native ScrollWidget and opt-in WidgetContainer; default containers stay opaque; legacy clipping regression |
| Clipping and full multiline content | 30-row producer clipped below multiline editor and another widget; full content height remains 30 |
| Native wheel inside/outside/boundaries | Gate sends SGR terminal input through production host; verifies both boundaries and transcript containment |
| Overflow-only one-column scrollbar; no overflow | Native scrollbar rendering; gate checks visibility for overflow, short content and zero viewport; terminal capture shows one final-column track |
| In-process/remote parity | Gate runs real EngineCustomUiService and RemoteComponentController via serialized messages into production dock |
| Remote serialization, full content and state | Gate checks full 20-row wire frame including spaces, versioned requests and callback state |
| Resize/state parity and stale frames | Gate checks resized content width, native allocation, scrollTop and rejection of older frame/request positions |
| Mouse outside widget and normal editor input preserved | Outside wheel leaves widget position unchanged; normal text and arrow input reach focused editor; terminal typing scenario |
| Required `test/unit/reactive-widget-scroll-contract.test.ts` | Five runtime tests, not source-regex assertions |
| Context host suites, tests/typechecks/build/docs | Exact commands below; no transition to adapter before independent gate |
| SDK guidance and concise adapter handoff | `packages/coding-agent/docs/tui.md`, public type exports, usage section below |
| Numeric counter removal seed preserved | `git merge-base --is-ancestor df5dd4bca54725ae9f36b14411de1884ce5bb43e HEAD`; no workflow package edits |
| Assigned checkout/branch, signed commit and clean tree | Commit receipt and `git status --porcelain` after commit |
| No external writes or paused-work changes | Local diff only; no push/PR/merge/tag/publish commands; no original/prior checkout edits |
| Independent behavioral review before adapter | Parent/reviewer gate remains required after this writer handoff |
| Terminal/platform evidence and limitations | Dedicated macOS tmux scenario below; no Linux/Windows live claim |
| Configured editor bindings win; Alt+K/J, Option label, Alt+PageUp/Down aliases, Alt+Up preservation | Adapter-only clauses remain deferred by explicit slice boundary. This host registers no keys and leaves editor input unchanged |
| Run-ID anchors, row cap adaptation, collapsed summaries and workflow docs | Adapter-only clauses remain deferred by explicit slice boundary; host exposes row state and requested positioning |
| No unchecked adapter transition or final PR | This note is a host API handoff only, not gate approval or PR authorization |

## API and state ownership

`ExtensionWidgetOptions.scroll?: { maxHeight: number }` opts in. `ScrollableWidgetComponent` optionally adds `getScrollRequest(): WidgetScrollRequest | undefined` and `onScroll(WidgetScrollState): void`. `WidgetScrollRequest` has required numeric `version` and `scrollTop`. `WidgetScrollState` has required numeric `scrollTop`, `viewportHeight`, and `contentHeight`. All positions count rendered rows. `ReactiveWidgetComponent` and `installReactiveWidget` expose the same optional hooks/options.

Render full `string[]` content at the requested width. Keep raw strings, duplicates, and ordering; no text normalization or item identity rules are added. Existing string-array widget formatting stays unchanged; opted-in arrays no longer hit the old fixed truncation limit. Omitted scroll options retain existing behavior. Zero maxHeight is accepted and yields a zero-row viewport. Numeric clamping follows native ScrollView/VStack behavior; no new validation errors are added.

States and transitions:

- Unmounted to mounted: native host starts at row zero, then applies the first request when layout is known.
- Mounted non-overflow to overflow: content/resize creates a scrollbar and a clamped scroll range.
- Overflow to non-overflow: clamp position to zero and hide the scrollbar.
- Wheel inside the actual viewport: update native host scrollTop, report state on layout; contain either boundary.
- Wheel outside: do not change widget position. Editor focus/input is unchanged in every state.
- New request version: apply once, clamped to current content/allocation. Unchanged or older versions do not reset native wheel state. Increment versions for intentional producer positioning.
- Remote render: existing component/request IDs fence stale frames; full content and optional request travel to host, actual scroll state travels back. Terminal rows are read live after resize.
- Remove/replace: dispose the old component and start new state on remount. Existing remote generation teardown remains in charge; no lifecycle changes.

The adapter should maintain run-ID anchors, translate them into rendered row requests, and increment request versions only for intentional repositioning. Do not continuously echo `onScroll` as a new request. Shortcut conflict policy and workflow row/collapse behavior belong to the adapter, not this host.

## Validation commands

Setup had already passed `npm ci --ignore-scripts && npm run build` before this writer started. This is a Node/vitest TypeScript workspace with Bun build scripts and native Rust setup, not a Bun test suite.

Final results are recorded in the commit receipt after these commands complete:

```sh
npm run check
npm run build
npm --workspace=@bastani/atomic run docs:check
npx vitest --run --project unit test/unit/reactive-widget-scroll-contract.test.ts test/unit/reactive-widget.test.ts test/unit/interactive-fullscreen-dock-live-widgets.test.ts test/unit/engine-custom-ui-hidden-invalidate.test.ts test/unit/workflow-widget-viewport.test.ts test/unit/workflow-widget-short-dock.test.ts test/unit/workflow-widget-anchor.test.ts test/unit/interactive-engine-shortcut-reload.test.ts test/unit/interactive-engine-dialog-host.test.ts test/unit/rpc-extension-ui.test.ts
npm --workspace=@bastani/atomic test -- test/interactive-fullscreen-input.test.ts test/interactive-fullscreen-layout.test.ts test/interactive-fullscreen-scrollbar.test.ts
qlty metrics --functions packages/coding-agent/src/modes/interactive/components/scroll-widget.ts
qlty smells packages/coding-agent/src/modes/interactive/components/scroll-widget.ts
```

Qlty uses the existing supplemental configuration. `qlty check` reported no modified files applicable to checks; that is not lint coverage. Repository Biome and typechecks remain authoritative. The new wrapper has no pre-change metrics baseline. The private pi-tui layout-node import uses the installed, pinned package's shipped file; build and packaged Node loading must pass.

Early validation caught missing `invalidate` hooks/types in test fixtures, then a missing root `LAYOUT_NODE` export during the default-widget compatibility repair. Both were implementation-time failures, not waived gates. The wheel test now sends enough events to exceed the full 30-row range rather than assuming a particular wheel step. The gate demonstrated these paths by failing during the incomplete repairs. Existing `ISSUES.md` was not overwritten by a case-insensitive `issues.md` tracker.

## Repeatable terminal scenario

No Herdr session was requested. Use a dedicated tmux session and the committed fixture, without a provider or model call:

```sh
mkdir -p /tmp/widget-host-terminal-agent
tmux new-session -d -s widget-host-proof -x 80 -y 24 -c "$PWD" 'ATOMIC_CODING_AGENT_DIR=/tmp/widget-host-terminal-agent bun packages/coding-agent/src/cli.ts --no-session --no-extensions -e ./test/fixtures/widget-scroll-extension.ts'
# If the trust dialog appears, select Trust (this session only).
tmux capture-pane -t widget-host-proof:0.0 -p
tmux send-keys -t widget-host-proof:0.0 -l -- $'\033[<65;2;20M'
tmux send-keys -t widget-host-proof:0.0 -l -- ' VERIFIED'
tmux send-keys -t widget-host-proof:0.0 -l -- $'\033[<65;2;2M'
tmux resize-window -t widget-host-proof:0 -x 55 -y 18
tmux capture-pane -t widget-host-proof:0.0 -p
tmux send-keys -t widget-host-proof:0.0 C-c
tmux send-keys -t widget-host-proof:0.0 C-c
```

Expected at 80x24: wheel at row 20 moves `SCROLL ROW 0` to `SCROLL ROW 1`, row 2 wheel leaves that position unchanged, editor reads `typing stays here VERIFIED`, and resize retains position with one-column scrollbar. The full source CLI spawns its real isolated RPC child. SGR bytes are injected through tmux, not a claim about physical trackpad encoding. Linux, Windows, physical macOS terminal wheel forwarding, and Option-as-Alt encodings are unverified. The environment reports an unrelated `[Herdr] protocol_rejected` notice; no lifecycle repair is attempted. The guarded main-screen fallback has no native wheel viewport.

## Deferred work

Only the explicitly dependent adapter work and independent review/final gate remain. No unrelated improvements were added. The gh-commit skill was not found in the available skill locations; configured SSH signing, conventional commit style, model attribution and normal hooks are used directly.

## Final writer validation results

On the final compatibility-container source, `npm run check`, `npm run build`, and `npm --workspace=@bastani/atomic run docs:check` passed. The root command above passed 10 files and 64 tests, including all five host-contract tests. The package fullscreen command passed 3 files and 13 tests. Docs validation checked 91 pages. `git diff --check` passed. Node v26.8.2 loaded the built `dist/modes/interactive/components/scroll-widget.js` and rendered a new `WidgetContainer` as `[]`, confirming resolution of the shipped pi-tui layout-node import.

Final Qlty metrics reported maximum cognitive complexity 4 for `updateLayout`, 3 for `scrollStack`; smells reported no findings. No whole-repository complexity claim is made.

Final macOS arm64 terminal run used Bun 1.4.2 and tmux 3.7c against the final source, with a real isolated RPC child visible in `ps`. Captures `/tmp/widget-host-final-before.txt`, `/tmp/widget-host-final-wheel.txt`, `/tmp/widget-host-final-outside.txt`, and `/tmp/widget-host-final-resize.txt` show rows 0 through 4 before input and 1 through 5 afterward; outside wheel and 55x18 resize preserve that position and `typing stays here VERIFIED`. The dedicated session exited with two Ctrl+C inputs. These final captures supersede the earlier pre-compatibility-container captures.
