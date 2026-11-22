---
title: RPC extension UI protocol
description: Drive extension-rendered UI over the RPC transport.
---

# RPC extension UI protocol

## Extension UI protocol

Extensions request user interaction through `ctx.ui.select()`, `ctx.ui.confirm()`, and related methods. Provider OAuth logins started with `login_provider` use the same `extension_ui_request` and `extension_ui_response` sub-protocol.

There are three categories of extension UI requests:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`, and `questionnaire` when the client [opted in](/rpc/protocol#set_extension_ui_capabilities)): emit an `extension_ui_request` on stdout and wait until the client sends an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget UI methods** (`cancel`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout and expect no response. Handle `cancel` by closing its matching dialog; other methods update the client display.
- **OAuth login methods** (`oauth_auth`, `oauth_device_code`, `oauth_progress`, `oauth_info`, `oauth_prompt`, `oauth_select`, `oauth_manual_code`, `oauth_manual_code_cancel`): drive interactive OAuth sign-in during `login_provider`. `oauth_prompt`, `oauth_select`, and `oauth_manual_code` expect an `extension_ui_response` with `value` or `cancelled: true`; the other OAuth methods are fire-and-forget.

When a dialog request includes `timeout` (milliseconds), Atomic auto-resolves with a default value when the timeout expires; clients do not need to track timeouts. For `select`, `confirm`, `input`, and `editor`, Atomic sends `cancel` when a request times out or its caller aborts it.

Some `ExtensionUIContext` methods are unsupported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`.
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, and `setEditorComponent()` are no-ops.
- `getEditorText()` returns `""`.
- `setToolsExpanded()` and `getToolsExpanded()` maintain context-local expansion state, matching `getChatRenderSettings().toolOutputExpanded` (not sent over the extension UI protocol). `getChatRenderSettings().hideThinkingBlock` is `false` unless Atomic's own interactive host drives the session.
- `pasteToEditor()` delegates to `setEditorText()` without paste or collapse handling.
- `getAllThemes()` returns `[]`, `getTheme()` returns `undefined`, and `setTheme()` returns `{ success: false, error: "..." }`.

In RPC mode, `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` because dialog and fire-and-forget methods work through this protocol. Guard terminal-only features like `custom()` with `ctx.mode === "tui"`.

### Extension UI requests (stdout)

All requests have `type: "extension_ui_request"`, an `id`, and a `method` field. Each dialog has a unique `id`; a later `cancel` request repeats that dialog's `id`. Requests can overlap. If your client displays one dialog at a time, queue later requests instead of replacing the current dialog. Remove a queued dialog on a matching `cancel` without showing it or sending a response.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

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

#### confirm

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

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### cancel

Close the dialog with the matching `id` and stop reading its input. The request has already ended on the agent side, so do not send a response. Ignore a cancellation for a dialog that is already closed.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "cancel"
}
```

#### questionnaire

A whole `ask_user_question` call: one to four questions, each with a short `header`, its options (`label`, `description`, optional markdown `preview`) and `multiSelect`. Sent only to a client that turned the `questionnaire` capability on with [`set_extension_ui_capabilities`](/rpc/protocol#set_extension_ui_capabilities); otherwise `ask_user_question` fails in RPC mode, because it needs a terminal.

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
        { "label": "libSQL", "description": "A shared database" }
      ]
    }
  ]
}
```

Expected response: `extension_ui_response` with `answers`, one per answered question, or `cancelled: true`. Each answer names its `questionIndex` and repeats its `question`, and its `kind` says what the user chose:

- `option`: one of the question's options; `answer` is its label.
- `multi`: for a `multiSelect` question; `answer` is `null` and `selected` lists the chosen labels.
- `custom`: free text typed instead of an option (single-select questions without previews); `answer` is the text.
- `chat`: the user wants to talk it over instead; `answer` is their text or `null`.

```json
{
  "type": "extension_ui_response",
  "id": "uuid-5",
  "answers": [{ "questionIndex": 0, "question": "Which storage should runs use?", "kind": "option", "answer": "libSQL" }]
}
```

Answers that don't match the questions, such as an unknown label, are rejected and the tool call fails.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. `widgetPlacement` is `"aboveEditor"` (default) or `"belowEditor"`. Optional `widgetScroll` (`{ maxHeight: number, maxHeightFraction?: number }`) passes scroll-bound hints when a widget requests scrolling. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "atomic - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

#### OAuth login methods

During `login_provider`, Atomic emits OAuth UI requests carrying `type: "extension_ui_request"`, `id`, `provider`, `loginId`, and `method`:

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

### Extension UI responses (stdin)

Responses are sent for dialog methods (`select`, `confirm`, `input`, `editor`, `questionnaire`) and interactive OAuth methods (`oauth_prompt`, `oauth_select`, `oauth_manual_code`). The `id` must match the request. Answer `questionnaire` with `answers` (see [questionnaire](#questionnaire)).

#### Value response (select, input, editor)

Also used for `oauth_prompt`, `oauth_select`, and `oauth_manual_code`:

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```
