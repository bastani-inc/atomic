# Workflow scroll adapter handoff

## Frozen contract and acceptance matrix

Goal: connect the workflow list to the independently verified native host viewport, preserving input, row limits and run anchors.

| Required clause | Current evidence |
| --- | --- |
| Base bc111134b, preserve df5dd4bca seed; designated branch only | git ancestry/status checks |
| Full rendered content, actual allocated viewport, multiline clipping | workflow-widget-scroll-input runtime dock tests |
| Ten-row and max(1,floor(rows/3)) cap, resize without remount | reactive-widget-scroll-contract fraction regression; adapter dock test |
| Run-ID anchors through insertion/deletion/collapse/resize, duplicate names | workflow-widget-anchor and adapter tests |
| Native local wheel, boundary containment, outside routing, overflow-only slim scrollbar | host and adapter runtime tests; dedicated terminal scenario |
| Alt+K/J, macOS Option labels, Alt+PageUp/Down aliases, configurable bindings | keybindings and adapter input tests; guides |
| Configured editor bindings win, preserve Alt+Up, focus and typing | conflict/sequence tests and terminal typing |
| Remote full content, resize/input state synchronization; legacy compatibility | serialized host and adapter tests |
| Required named test/unit/workflow-widget-scroll-input.test.ts with implementation assertions | focused vitest gate |
| Actionable guides and Unreleased changelogs only | diff/docs check |
| Focused tests, required build/type checks, independent behavior review | npm check/build; parent independent review |
| Dedicated terminal, actual platform/encoding evidence and limitations; no Herdr | Three dedicated macOS tmux sessions below; real RPC child observed; physical input/Linux/Windows unavailable |
| Commit all source, clean buildable tree; no push/PR/merge/tag/publish, no prior checkout/lifecycle changes | signed commit/status/diff; local-only command record |

## Interface decisions and transitions

Existing scroll options remain optional. Optional maxHeightFraction limits the existing numeric maxHeight using live host terminal rows, with a one-row fractional floor and actual allocation allowed to reach zero. The field travels unchanged over remote transport. No new rejection is added. Rendered string arrays, raw strings, duplicate display names and order are preserved.

Shortcut metadata is opt-in. `keybinding` selects an existing keybindings.json action; `preferEditor` yields to other resolved editor bindings. Empty arrays disable an action; remapping replaces defaults and aliases. Duplicate keys use the existing Map/last-registration policy, not a new uniqueness rejection. Workflow actions are not treated as editor-owned keys. Unrelated registrations retain their existing override/warning behavior, covered by the input gate. Hints omit conflicting or disabled keys and label Alt as Option on macOS. The final hint is part of the scrollable content, not a fixed overlay that can consume the only allocated row.

The host owns actual position and geometry. New intentional requests increment a version; wheel callbacks do not echo requests. Expanded to collapsed retains the expanded ID/row anchor while requesting zero. Expansion restores it. Insertion/removal resolves IDs, preferring the next surviving neighbor then the previous when the anchor disappears. Resize clamps in native layout. Unmount uses existing disposal; no lifecycle infrastructure changes.

## Validation results

Parent setup npm ci --ignore-scripts and npm run build passed; independent host baseline passed 25 tests. New fractional-cap regression failed before repair with 10 instead of 6 after resize and passes afterward, six host tests. Logs /tmp/adapter-cap-{red,green}.log.

The final source passed:

```sh
npm run check
npm run build
npm --workspace=@bastani/atomic run docs:check
npx vitest --run --project unit test/unit/workflow-widget-scroll-input.test.ts test/unit/reactive-widget-scroll-contract.test.ts test/unit/reactive-widget.test.ts test/unit/interactive-fullscreen-dock-live-widgets.test.ts test/unit/engine-custom-ui-hidden-invalidate.test.ts test/unit/workflow-widget-viewport.test.ts test/unit/workflow-widget-short-dock.test.ts test/unit/workflow-widget-anchor.test.ts test/unit/interactive-engine-shortcut-reload.test.ts test/unit/store-widget-installer*.test.ts
npm --workspace=@bastani/atomic test -- test/extensions-runner/shortcut-conflicts.suite.ts test/keybindings-migration.test.ts test/custom-editor-history-keybindings.test.ts test/interactive-fullscreen-input.test.ts test/interactive-fullscreen-layout.test.ts test/interactive-fullscreen-scrollbar.test.ts
git diff --check
```

Results: root 16 files / 158 tests, package 6 files / 19 tests, docs 91 pages. The required input gate has four tests covering actual registration/resolution, legacy policy, real clipped dock wheel/keyboard/editor behavior, and serialized remote workflow rendering with wheel/shortcut/resize synchronization. The host gate has six tests, including legacy/default compatibility and boundary containment. Checks include Biome, both typechecks, type fixtures and shrinkwrap. Logs are `/tmp/adapter-{check-final,build,docs,focused-final,package-final}.log`. An earlier package command named `extensions-runner.test.ts`, which the package config excludes; it did not prove that suite. The final command explicitly ran `shortcut-conflicts.suite.ts` instead.

Earlier fixture failures were resolved rather than waived: direct producer tests expected pre-clipped slices and now drive actual native `renderLayoutFrame`; two duplicate mount suites expected old options and now assert both native caps. The first new dock fixture used a stub editor without `getText`; replacing it with production `CustomEditor` proves real input. A remote fixture needed explicit method forwarding rather than spreading a class instance. These are test-fixture corrections, not claimed product fixes. Existing `ISSUES.md` was not overwritten on the case-insensitive filesystem.

Qlty 0.642.0 used the existing `.qlty/qlty.toml`. Scoped `qlty metrics --functions` and `qlty smells` ran on the adapter viewport/hint, shortcut resolver, and native scroll wrapper. Initial candidate resolver cognitive complexity was 42 with new deep-nesting findings; extracting the configured-key filter reduced it to 25 and removed deep-nesting findings. Final smells still reports resolver file complexity 50 and buildBuiltinKeybindings complexity 19. Those are disclosed, not a clean-metrics claim or reason for unrelated refactoring. A pre-change file exported to `/tmp` could not be measured because Qlty rejected its outside-root path, so no measured pre-change comparison is claimed. `qlty check` found no applicable modified files/plugins; repository Biome remains the lint evidence. Logs: `/tmp/adapter-qlty-{check,final-metrics,final-smells,before}.log`.

## Repeatable terminal scenario and limitations

Platform: macOS arm64, Node v26.8.2, Bun 1.4.2, tmux 3.7c. No Herdr control was requested or used. Launch from this checkout:

```sh
mkdir -p /tmp/widget-adapter-terminal-agent
tmux new-session -d -s widget-adapter-proof -x 100 -y 30 -c "$PWD" 'ATOMIC_CODING_AGENT_DIR=/tmp/widget-adapter-terminal-agent bun packages/coding-agent/src/cli.ts --no-session --no-extensions -e ./test/fixtures/workflow-widget-scroll-extension.ts'
# If prompted, select Trust (this session only).
tmux capture-pane -t widget-adapter-proof:0.0 -p
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033j'
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033k'
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033[<65;2;22M'
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033[5;3~'
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033[6;3~'
tmux send-keys -t widget-adapter-proof:0.0 -l -- ' VERIFIED'
tmux send-keys -t widget-adapter-proof:0.0 -l -- $'\033[<64;2;2M'
tmux resize-window -t widget-adapter-proof:0 -x 100 -y 18
tmux capture-pane -t widget-adapter-proof:0.0 -p
tmux send-keys -t widget-adapter-proof:0.0 C-c C-c
```

Actual sessions `widget-adapter-9436`, `widget-adapter-final`, and `widget-adapter-vim` used the committed fixture and exited with two Ctrl+C inputs. The source CLI's real `cli.ts --mode rpc --extension .../workflow-widget-scroll-extension.ts` child was observed in `ps`.

- At 100x30, ESC+j moved the list one row and ESC+k restored the entire initial capture byte-for-byte. An SGR wheel at widget row 22 produced the same capture as ESC+j. Alt+PageUp restored the initial capture and Alt+PageDown matched ESC+j. `cmp` passed for all four comparisons.
- Typing ` VERIFIED` stayed in the editor. An outside wheel at row 2 changed the transcript while a diff of the final ten widget rows remained empty. Resize to 100x18 retained the selected run and reduced the widget to six rows. A 27-column collapse and expansion restored the captured list position.
- A paced 55-key ESC+j run at 100x18 reached the final workflow detail, bottom border and `Option+k/Option+j · Wheel scroll workflows` hint. An earlier unpaced tmux burst was not used as end-of-list or exact per-keystroke-count evidence.
- CSI-u Shift+Enter, `ESC[13;2u`, inserted eight actual newlines; captures show five visible editor rows and the `4 more` editor indicator. ESC+k moved the widget while preserving that draft. An earlier bracketed-paste experiment flattened newlines and is not multiline evidence.
- A separate agent directory with `{"tui.editor.cursorUp":["up","alt+k"],"tui.editor.cursorDown":["down","alt+j"]}` proved editor precedence. ESC+k moved into the preceding draft line, where typed `VIM` produced `typingVIM stays here`; widget rows remained identical. Alt+PageDown still moved the widget. Resize to 100x9 retained both draft lines and a two-row widget allocation. The durable short-dock test separately covers one-row allocation.

Captures: `/tmp/adapter-terminal-{before,altj,altk,wheel,pageup,pagedown,typing,outside,resize,collapsed,expanded,slow-bottom,real-multiline,real-multiline-scroll,vim-before,vim-after,vim-alias,short}.txt`. Mouse/key bytes were injected through tmux, not physical keyboard/trackpad evidence. Live Linux/Windows, physical macOS Option/mouse forwarding, and arbitrary terminal/multiplexer encodings were not verified. The fixtures required no model calls or production credentials. Existing startup Intercom errors and `[Herdr] protocol_rejected` notices appeared; no lifecycle repair was attempted.

The parent still owns independent contract review and the final gate. This writer does not claim reviewer quorum or authorize a PR.

## Contract amendments received

After the implementation PR exists, parent may merge only with green CI on its exact current head and no remaining addressable review/comment feedback. Parent then publishes 0.9.19-alpha.10 from latest origin/main containing the change, not the stale preparation base. This stage remains local-only and must not merge, publish, resume prior runs, or alter the original uncommitted changelog preparations. No PR feedback is known in this stage because no PR has been created here.

Additional parent amendment: "minimal backwards-compatible host cap/editor precedence amendments allowed, no broader API/lifecycle redesign. Affected earlier host evidence invalidated for final candidate; rerun host geometry, native/remote serialization + resize parity, legacy/default compatibility, build/types on final adapter SHA. Independent reviewers will inspect host deltas against bc111134b. Include amendment in notes. Preserve prior host checkout/commits." The final commands above rerun the affected host behavior in this checkout; parent review remains required.

## Deferred

No unrelated implementation work. Live Linux/Windows and physical macOS input evidence remain unavailable until explicitly exercised; injected terminal sequences must not be represented as physical keyboard or mouse proof.

## Independent P2 editor-precedence repair (after c936ac1)

The independent original review remains unmodified at `/tmp/independent-widget-c936/review.md` (candidate c936ac1e5a396adfa5f4ed648569153a8109b951 against bc111134b). It found one consolidated P2: lowercase string comparison allowed parser-equivalent editor keys to remain registered as workflow shortcuts and advertised by hints. Its actual registration probe and real CLI remap scenario demonstrated `ctrl+alt+k` versus `alt+ctrl+k`; it also confirmed `shift+return` versus `shift+enter` and `esc` versus reserved `escape`. Modified `ctrl+esc` was explicitly rejected by the parser and is not a required equivalence. Original passing host/terminal evidence and macOS-only limitations in that review are preserved, not reattributed to this repair writer.

Repair: one small comparison-only `keybindingIdentity` helper follows pi-tui's private key-id parser's modifier ordering/case rules and accepted return/escape aliases. The public `parseKey` accepts terminal bytes, not configured key ids, so it cannot directly normalize configuration. Host configured shortcut filtering and workflow hints now share identity comparison; literal `preferEditor` registrations also use it. Existing raw/configured spellings, registration map policy and unrelated legacy conflict rules remain intact. No input rejection, Alt+Up override, host geometry redesign, or lifecycle change was added. Existing keybinding guide and both Unreleased scrolling entries already promise editor precedence and need no new user action or duplicate release note.

### Red/green evidence and checks

- `bun /tmp/independent-widget-c936/modifier-probe.ts`: initial exit 1, `true !== false` at line 12; repaired exit 0 and registration list excludes the conflicting key. Logs `/tmp/repair-{red,green}-probe.log`.
- Required `workflow-widget-scroll-input.test.ts`: each modifier-order, return, escape and literal opt-in regression was added and failed before its corresponding implementation change; successive green totals were 5, 6, 7 and 8. Logs `/tmp/repair-{red,green}-{modifier,return,escape,literal}.log`. Escape also checks reserved ownership with `preferEditor=false` on the configured workflow action.
- Restoring only the old hint comparison reproduced three hint failures (`ctrl+alt+k`, `shift+return`, `esc` advertised); restoring the fix passed all eight tests. Logs `/tmp/repair-{red,green}-hints.log`. All existing remap, empty, alias, platform, native and remote tests remain enabled.
- The exact root/package commands above were rerun: root **16 files / 162 tests** (the original 158 plus four regressions), package **6 files / 19 tests**, exit 0. Logs `/tmp/repair-{focused,package}.log`.
- `npm run check`, `npm run build`, `npm --workspace=@bastani/atomic run docs:check`, and `git diff --check` passed. Docs: 91 pages. Logs `/tmp/repair-{check,build,docs}.log`.
- `bun /tmp/independent-widget-c936/geometry.ts` passed mixed legacy/two fractional widget allocations, 36→18→9→5→3→24→45 resize, zero-height recovery, boundary containment and overflow disappearance. Log `/tmp/repair-geometry.log`.
- Qlty 0.642.0 preserved `.qlty/qlty.toml`. Scoped `check`, `metrics --functions`, and `smells` covered the resolver/hint/helper. Check says no issues, but this config has no lint plugins; Biome is authoritative. Before/after smells both report existing function complexity 19 (`buildBuiltinKeybindings`) and 25 (`resolveExtensionShortcuts`); no new function-complexity finding. Helper cognitive complexity is 3. Logs `/tmp/repair-qlty-{before-metrics,before-smells,check,metrics,smells}.log`. No unrelated complexity refactor or config changes.

### New dedicated actual CLI remap evidence

Scenario: macOS arm64, Bun 1.4.2, Node v26.8.2, tmux 3.7c, 100×30; c936ac1 plus this repair's source changes (built successfully before launch). The dedicated `widget-precedence-repair` session used `/tmp/widget-precedence-repair/agent/keybindings.json` containing `{"app.workflows.scrollUp":["ctrl+alt+k"],"tui.editor.cursorUp":["up","alt+ctrl+k"]}`. Launch:

```sh
tmux new-session -d -s widget-precedence-repair -x 100 -y 30 -c "$PWD" 'ATOMIC_CODING_AGENT_DIR=/tmp/widget-precedence-repair/agent bun packages/coding-agent/src/cli.ts --no-session --no-extensions -e ./test/fixtures/workflow-widget-scroll-extension.ts'
# Trust (this session only): Down Down Enter. Discovered pane: %279.
tmux send-keys -t %279 -l -- $'\033[13;2u'
tmux send-keys -t %279 -l -- 'second line'
tmux send-keys -t %279 -l -- $'\033j'
tmux capture-pane -t %279 -p # before.txt
tmux send-keys -t %279 -l -- $'\033[107;7u'
tmux send-keys -t %279 -l -- X
tmux capture-pane -t %279 -p # after.txt
tmux send-keys -t %279 C-c C-c
```

Bounded capture polling confirmed the two-line draft and scrolled workflow before the tested key. The real RPC child PID 38999, parent 38997, was observed (`rpc.txt`). After the equivalent editor key and X, the first draft line is `typing stayXs here`, and `second line` is unchanged: the editor cursor moved up. Diff of the final ten widget rows before/after is empty: the workflow stayed at its scrolled position. This reverses the original review's `second lineX`/workflow-to-top failure. Captures `/tmp/widget-precedence-repair/{ready,draft,before,after}.txt`. Both Ctrl+C inputs exited the owned session; `tmux has-session` returned 1. No model calls or production credentials were needed. Existing Intercom startup stack and `[Herdr] protocol_rejected` notice appeared but were not changed; no Herdr operation was used.

These are injected terminal bytes, not physical keyboard/mouse or OS-forwarding proof. Live Linux/Windows and physical macOS Option/trackpad coverage remain unavailable. No other checkout, host commit, prior run or release state was altered.

### Exact-commit gate record

Per the parent amendment, after the signed repair commit the same root/package gates, independent geometry probe, `npm run check` and `npm run build` must run on the exact final SHA. Post-commit logs are reserved as `/tmp/repair-post-{focused,package,geometry,check,build,docs}.log`; `/tmp/repair-post-result.md` records the actual SHA and outcomes after execution without changing that verified commit. This pre-commit note does not claim those future runs passed. Parent owns the subsequent independent recheck, exact-head CI/no-feedback merge gate and latest-main alpha.10 release; this writer performs none of those publication actions.
