# #2303 fullscreen workflow mouse evidence

These remaining raw pane files are `tmux capture-pane -p -J` output from the #2303 reproduction and fix run.
The four stale after/control captures from that older run (`after-fullscreen-click.txt`,
`after-stage-before-wheel.txt`, `after-stage-wheel.txt`, and `regular-control-click.txt`)
were removed in the #2222 repair instead of editing their footer; their branch, model,
and transcript metadata do not describe this layer. No current-layer capture is claimed
for those scenarios.

## Before and control

- `before-fullscreen-graph.txt` is the fullscreen graph before input.
- `before-fullscreen-wheel.txt` is the same fullscreen graph after SGR wheel-down; the graph did not move.
- `before-fullscreen-click.txt` is after fullscreen left-button press/release; it remains on `GRAPH` and does not open a `STAGE` pane.

## After

- `after-fullscreen-graph.txt` is the fixed fullscreen graph before input.
- `after-fullscreen-wheel.txt` records the fixed fullscreen wheel dispatch. That graph fit its viewport, so its pane text is unchanged.

## Keyboard paths re-tested in this repair

- Graph `j`/`k` focus movement passed in `test/unit/overlay-graph-navigation-01.test.ts`.
- Graph `PageUp`/`PageDown` remained unhandled for the host transcript in the overflowing-overlay case in `test/unit/overlay-graph-navigation-03.test.ts`.
- Attached stage-chat `PageUp`/`PageDown` history scrolling and mouse-wheel history scrolling passed in `test/unit/stage-chat-view-13.test.ts`.
- The fullscreen remote routing, post-close transcript-wheel, and non-overlay transcript-selection regression cases passed in `test/unit/interactive-engine-remote-input.test.ts`.

The exact focused command and passing Vitest summary are in `keyboard-and-routing-tests.txt`.

## Terminal-mode lifecycle

The repair also covers local non-isolated fullscreen fallback hosts: opening, hiding, disposing, and closing the overlay emit no local mouse-tracking or autowrap disable/restore escapes, leaving pi-tui's fullscreen baseline in charge. The unit assertion is `leaves fullscreen terminal modes to pi-tui on the local fallback path` in `test/unit/overlay-adapter-autowrap.test.ts`.
