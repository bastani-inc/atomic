# Fullscreen pass-through gate handoff

This layer deliberately does **not** repair fullscreen return-value pass-through. A future dedicated layer must address it without changing the polish fixes here.

## Current blockers

- `RemoteComponent.handleInput` in `packages/coding-agent/src/modes/interactive-engine/remote-component.ts:64-74` cannot report whether the child handled a key: `sendEngineCommand({ type: "engine_custom_input", ... })` is fire-and-forget.
- `packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts:280` calls the child component handler and discards its return value.
- `packages/coding-agent/src/modes/interactive-engine/protocol.ts:107` carries no reply for `engine_custom_input`.
- Roughly sixteen shipped host components still declare `handleInput(): void`; a focused selector can mutate its state and then let the fullscreen viewport act on the same key.
- `tui.select.pageUp` and `tui.altScreen.pageUp` share the `pageUp` default in pi-tui (`keybindings.js:80-83,91-99`), so selector paging is a concrete double-action case.

A real fix needs either a reply channel for `engine_custom_input`, or a documented decision that remote components always consume input. Do not add a compatibility shim for the breaking contract.

## Settling test

Mount a `RemoteComponent` in a real fullscreen harness, focus it, and use a child component whose `handleInput` is a no-op. Feed `\x1bOH` and assert that the transcript reaches `scrollTop === 0`. The test must also show that the child received the key exactly once; it should run through the isolated engine path rather than only an in-process component.
