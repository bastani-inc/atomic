---
title: "RPC extension UI protocol"
sidebarTitle: "RPC UI protocol"
description: "Handle extension dialogs, notifications, status bars, widgets, questionnaires, and OAuth prompts over the RPC transport."
---

<div id="extension-ui-protocol" />

Extensions request user interaction through `ctx.ui.select()`, `ctx.ui.confirm()`, and related methods. Provider OAuth logins started with `login_provider` use the same `extension_ui_request` and `extension_ui_response` sub-protocol. For process startup, framing, and typed client code, see [RPC mode](/rpc), [RPC protocol reference](/rpc/protocol), and [RPC client examples](/rpc/examples).

Extension UI requests fall into three categories:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`, and `questionnaire` when the client [opted in](/rpc/protocol#set_extension_ui_capabilities)): emit an `extension_ui_request` on stdout and wait until the client sends an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget UI methods** (`cancel`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout and expect no response. Handle `cancel` by closing its matching dialog; other methods update your display.
- **OAuth login methods** (`oauth_auth`, `oauth_device_code`, `oauth_progress`, `oauth_info`, `oauth_prompt`, `oauth_select`, `oauth_manual_code`, `oauth_manual_code_cancel`): drive interactive OAuth sign-in during `login_provider`. `oauth_prompt`, `oauth_select`, and `oauth_manual_code` expect an `extension_ui_response` with `value` or `cancelled: true`; the other OAuth methods are fire-and-forget.

When a dialog request carries a `timeout` (in milliseconds) or an `AbortSignal`, Atomic resolves it automatically with its default value (`undefined` for `select`/`input`/`editor`, `false` for `confirm`, `{ answers: [], cancelled: true }` for `questionnaire`) if the timeout expires or the signal aborts. Clients do not need to run their own timers. For `select`, `confirm`, `input`, `editor`, and `questionnaire`, Atomic sends a matching `cancel` notification when the request times out or aborts. Note that `editor` does not serialize `timeout` on the wire request, even though Atomic still enforces `opts.timeout` locally and emits `cancel` if it expires.

## Unsupported and degraded methods in plain RPC mode

In RPC mode, `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` because dialog and fire-and-forget methods work through this protocol. Guard terminal-only features such as `ctx.ui.custom()` with `ctx.mode === "tui"`.

The following `ExtensionUIContext` methods are unsupported or degraded in plain RPC mode:

- `setWidget(key, factory)`: passing a component factory function throws `Error("Component-factory widgets are unavailable in this RPC host.")`. Only string arrays (or `undefined` to clear) work over plain RPC.
- `custom()`: resolves to `undefined`.
- `hostSessionPicker` and `hostInputForm`: omitted (`undefined`).
- `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `addAutocompleteProvider()`, and `requestRender()`: no-ops.
- `onTerminalInput()`, `onHostCustomUiStateChange()`, and `onWidgetRelease()`: return a no-op unsubscribe function.
- `getEditorText()`: returns `""`.
- `getEditorComponent()`: returns `undefined`.
- `pasteToEditor(text)`: delegates to `setEditorText(text)` without paste-collapse handling.
- `getFooterDataProvider()`: returns a stub where `getGitBranch()` returns `null`, `getExtensionStatuses()` returns an empty `Map`, `getAvailableProviderCount()` returns `1`, and `onBranchChange()` returns a no-op unsubscribe function.
- `getHostCustomUiState()`: returns `{ blockingInlineCustomUiDepth: 0, blockingInlineCustomUiActive: false }`; `focusHostInlineCustomUi()` returns `false`.
- `setToolsExpanded()` and `getToolsExpanded()`: store expansion state locally for the session, matching `getChatRenderSettings().toolOutputExpanded` (not sent over the wire). `getChatRenderSettings().hideThinkingBlock` is `false`.
- `getAllThemes()` returns `[]`, `getTheme()` returns `undefined`, and `setTheme()` returns `{ success: false, error: "Theme switching not supported in RPC mode" }`.

## Extension UI requests (stdout)

Every request includes `type: "extension_ui_request"`, a unique `id`, and a `method`. A later `cancel` request repeats the `id` of the dialog it cancels.

Requests can overlap. If your client shows one dialog at a time, queue incoming dialogs instead of replacing the active one. When a `cancel` arrives for a queued dialog, remove it without showing it or sending a response.

### select

Prompt the user to pick one option from a list. If `timeout` expires, Atomic resolves with `undefined` and sends `cancel`.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true` or `false`, or `cancelled: true`.

### input

Prompt the user for single-line text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered string) or `cancelled: true`.

### editor

Open a multi-line text editor with optional prefilled text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited string) or `cancelled: true`.

### cancel

Close the dialog (`select`, `confirm`, `input`, `editor`, or `questionnaire`) with the matching `id` and stop reading input for it. The request has already ended on the agent side, so do not send a response. Ignore a `cancel` for a dialog that is already closed.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "cancel"
}
```

### questionnaire

Represents one `ask_user_question` tool call: one to four questions, each with a short `header`, `options` (`label`, `description`, optional markdown `preview`), and optional `multiSelect`. Sent only when the client enabled the `questionnaire` capability through [`set_extension_ui_capabilities`](/rpc/protocol#set_extension_ui_capabilities); otherwise `ask_user_question` fails in RPC mode because no terminal is attached.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "questionnaire",
  "questions": [
    {
      "question": "Which storage should runs use?",
      "header": "Storage",
      "options": [
        { "label": "SQLite", "description": "A local file" },
        { "label": "PostgreSQL", "description": "A shared database" }
      ]
    }
  ]
}
```

Expected response: `extension_ui_response` with `answers` (one entry per answered question) or `cancelled: true`. Each answer specifies `questionIndex`, repeats `question`, and sets `kind`:

- `option`: one of the question's options; `answer` is its `label`.
- `multi`: for a `multiSelect` question; `answer` is `null` and `selected` lists the chosen labels.
- `custom`: free text typed instead of an option (single-select questions without previews); `answer` is the text.
- `chat`: the user chose to discuss instead; `answer` is their text or `null`.

```json
{
  "type": "extension_ui_response",
  "id": "uuid-5",
  "answers": [{ "questionIndex": 0, "question": "Which storage should runs use?", "kind": "option", "answer": "PostgreSQL" }]
}
```

Answers that do not match the questions (such as an unknown option label) are rejected and fail the `ask_user_question` tool call.

### notify

Display a notification. Fire-and-forget; send no response.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

`notifyType` is `"info"`, `"warning"`, or `"error"` (defaults to `"info"` when omitted).

### setStatus

Set or clear a status entry in the status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Omit `statusText` (or pass `undefined`) to clear the entry for `statusKey`.

### setWidget

Set or clear a text widget displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Omit `widgetLines` (or pass `undefined`) to clear the widget. `widgetPlacement` is `"aboveEditor"` (default) or `"belowEditor"`. Optional `widgetScroll` (`{ maxHeight: number, maxHeightFraction?: number }`) passes scroll bounds when requested. Plain RPC supports only string arrays; passing a component factory throws `Error("Component-factory widgets are unavailable in this RPC host.")`.

### setTitle

Set the window or tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "setTitle",
  "title": "atomic - my project"
}
```

### set_editor_text

Replace the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-10",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### OAuth login methods

During `login_provider`, Atomic emits OAuth UI requests containing `type: "extension_ui_request"`, `id`, `provider`, `loginId`, and `method`:

| Method | Additional fields | Response expected |
| --- | --- | --- |
| `oauth_auth` | `info` (`OAuthAuthInfo`: authorization URL and optional instructions) | None (fire-and-forget) |
| `oauth_device_code` | `info` (`OAuthDeviceCodeInfo`: verification URI and user code) | None (fire-and-forget) |
| `oauth_progress` | `message` (status update string) | None (fire-and-forget) |
| `oauth_info` | `message`, `links` (`AuthInfoLink[]`) | None (fire-and-forget) |
| `oauth_prompt` | `prompt` (`OAuthPrompt`) | `extension_ui_response` with `value` or `cancelled: true` |
| `oauth_select` | `prompt` (`OAuthSelectPrompt`) | `extension_ui_response` with `value` or `cancelled: true` |
| `oauth_manual_code` | None | `extension_ui_response` with `value` or `cancelled: true` |
| `oauth_manual_code_cancel` | None | None (close pending manual-code prompt) |

## Extension UI responses (stdin)

Send responses for dialog methods (`select`, `confirm`, `input`, `editor`, `questionnaire`) and interactive OAuth methods (`oauth_prompt`, `oauth_select`, `oauth_manual_code`). The `id` must match the request.

**Response handling rules:**

- Responses with an unknown or already-resolved `id` are silently ignored.
- For `select`, `input`, and `editor`, a non-cancelled response without `value` resolves to `undefined`. `select` does not validate `value` against the original `options` list, so clients should send one of the offered options.
- For `confirm`, a non-cancelled response without `confirmed` resolves to `false`.
- For `questionnaire`, see [questionnaire](#questionnaire) for answer validation.

### Value response (`select`, `input`, `editor`)

Also used for `oauth_prompt`, `oauth_select`, and `oauth_manual_code`:

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

### Confirmation response (`confirm`)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for `select`, `input`, `editor`), `false` (for `confirm`), or `{ answers: [], cancelled: true }` (for `questionnaire`).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## See also

- [RPC mode](/rpc): startup flags, JSONL framing, and shutdown signals.
- [RPC protocol reference](/rpc/protocol): all commands, events, and structured error codes.
- [RPC client examples](/rpc/examples): `RpcClient` extension UI handling and standalone Node.js examples.
