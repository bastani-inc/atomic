# #2303 fullscreen workflow mouse evidence

These raw pane files are `tmux capture-pane -p -J` output from the #2303 reproduction and fix run. The four after/control captures below are preserved byte-for-byte as historical evidence; their branch, model, footer, and transcript metadata describe that run, not the later #2222 layer. They are not current-layer claims.

The current #2222 behavior is covered by the source-path and real-CLI checks named below. Do not edit these historical captures to reflect later UI changes.

## Before and control

- `before-fullscreen-graph.txt` is the fullscreen graph before input.
- `before-fullscreen-wheel.txt` is the same fullscreen graph after SGR wheel-down; the graph did not move.
- `before-fullscreen-click.txt` is after fullscreen left-button press/release; it remains on `GRAPH` and does not open a `STAGE` pane.
- `regular-control-click.txt` is the regular-mode control. The same workflow click opens `STAGE fan-out-and-synthesize / branch-01-typescript-fact`.

## After

- `after-fullscreen-graph.txt` is the fixed fullscreen graph before input.
- `after-fullscreen-wheel.txt` records the fixed fullscreen wheel dispatch. That graph fit its viewport, so its pane text is unchanged.
- `after-fullscreen-click.txt` shows `STAGE goal / completion-reviewer-1` after the fixed fullscreen node click.
- `after-stage-before-wheel.txt` and `after-stage-wheel.txt` show the fixed attached stage chat before and after wheel-down. The diff adds older transcript lines, proving stage-chat wheel scrolling moved the pane.

## Keyboard paths re-tested in this repair

- Graph `j`/`k` focus movement passed in `test/unit/overlay-graph-navigation-01.test.ts`.
- Graph `PageUp`/`PageDown` remained unhandled for the host transcript in the overflowing-overlay case in `test/unit/overlay-graph-navigation-03.test.ts`.
- Attached stage-chat `PageUp`/`PageDown` history scrolling and mouse-wheel history scrolling passed in `test/unit/stage-chat-view-13.test.ts`.
- The fullscreen remote routing, post-close transcript-wheel, and non-overlay transcript-selection regression cases passed in `test/unit/interactive-engine-remote-input.test.ts`.

The exact focused command and passing Vitest summary are in `keyboard-and-routing-tests.txt`.

## Terminal-mode lifecycle

The repair also covers local non-isolated fullscreen fallback hosts: opening, hiding, disposing, and closing the overlay emit no local mouse-tracking or autowrap disable/restore escapes, leaving pi-tui's fullscreen baseline in charge. The unit assertion is `leaves fullscreen terminal modes to pi-tui on the local fallback path` in `test/unit/overlay-adapter-autowrap.test.ts`.
