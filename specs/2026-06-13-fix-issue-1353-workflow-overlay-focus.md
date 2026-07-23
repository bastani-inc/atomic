# Workflow graph overlay focus when main chat asks a question

| Document Metadata      | Details |
| ---------------------- | ------- |
| Status                 | Final |
| Issue                  | [bastani-inc/atomic#1353](https://github.com/bastani-inc/atomic/issues/1353) |
| Created / Updated      | 2026-06-13 / 2026-06-13 |

## Summary

Issue #1353 exposed a focus conflict between the full-screen workflow graph overlay and parent/main-chat `ask_user_question` prompts. The selected UX is **graph-overlay-first**: while the graph overlay is visible, keyboard focus stays on the graph so navigation, stage attachment, Ctrl+X leave-to-main-chat, and graph recovery shortcuts remain usable. A parent/main-chat question is allowed to mount, but its focus is deferred and the graph shows a status hint telling the user to leave or hide the graph to answer it.

This is better than hiding or yielding the graph automatically because it avoids making the overlay appear frozen, preserves the user's current graph context, and keeps the user in control of when to leave graph mode.

## Goals

- Keep a visible workflow graph overlay interactive when the parent/main-chat agent opens `ask_user_question`.
- Mount the parent question without stealing focus from the graph overlay.
- Surface a clear hint (`Main chat needs input — exit graph to answer.`) while the question is pending behind the graph.
- When the user hides/exits the graph, focus the pending main-chat question so it can be answered immediately.
- Avoid remounting the graph overlay or committing duplicate overlay frames into chat scrollback.
- Preserve stage-local workflow HIL behavior: in-stage `ask_user_question`, readiness gates, and `ctx.ui.*` prompts still focus inside the attached workflow pane.
- Preserve custom UI lifecycle correctness: synchronous factory invocation, cleanup on resolve/reject/abort/throw, and no host-state notifications for already-aborted custom UI calls.

## Non-goals

- Redesigning `ask_user_question` schemas, answer envelopes, or response semantics.
- Converting every `ask_user_question` prompt into an overlay.
- Adding nested workflow graph overlays or general-purpose third-party overlay stacking.
- Changing workflow execution, stage scheduling, HIL persistence, or `/workflow send` coercion.

## Selected approach

### 1. Host owns inline custom UI state

`InteractiveMode.showExtensionCustom()` tracks host-owned inline custom UI depth and exposes that state through the extension UI context:

- `getHostCustomUiState()`
- `onHostCustomUiStateChange(listener)`
- `focusHostInlineCustomUi()`

Inline custom UI requests acquire host state only after the pre-abort check. If the abort signal is already aborted, the factory is not called and observers are not notified.

### 2. Overlay defers host inline focus

The workflow graph overlay opens with `deferInlineCustomUiFocus: true`. While that deferral is active, main-chat inline custom UI can mount, but `InteractiveMode` stores it as pending focus instead of calling `setFocus(component)`.

When the overlay is hidden via Ctrl+X/toggle/setHidden, the deferral is released and `focusHostInlineCustomUi()` focuses the pending main-chat question.

### 3. Graph remains interactive while the question is pending

`WorkflowGraphOverlayAdapter` observes host custom UI state only to display/clear the main-chat input hint. It does **not** auto-hide, unfocus, remount, or suppress graph focus while a host inline custom UI is active.

Store-update and stage-chat focus paths continue to focus the visible graph when workflow-local prompts require it, so workflow HIL remains usable even if a parent question is pending behind the overlay.

## Validation

Automated coverage should assert:

- Same-turn graph `open()` calls through the interactive host custom path do not remount.
- Pre-aborted host custom UI does not invoke the factory, emit host-state notifications, hide the graph, unfocus it, or refocus it.
- A parent/main-chat inline custom UI does not steal focus while the graph is visible.
- Hiding the graph focuses the pending main-chat inline custom UI.
- Host custom UI state changes do not hide, restore, remount, or repaint the graph overlay.
- User-hidden graph overlays are not restored by host custom UI state changes.
- Graph/store-update and stage-chat focus paths still keep workflow-local HIL interactive.

Targeted validation command:

```sh
bun test test/integration/overlay-entrypoints.test.ts packages/coding-agent/test/interactive-mode-status.test.ts
```
