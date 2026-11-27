---
title: "Handle extension UI over RPC"
sidebarTitle: "RPC extension UI"
description: "Handle extension dialogs, notifications, status bars, widgets, questionnaires, and OAuth prompts over the RPC transport."
---

Extensions request user interaction through `ctx.ui.select()`, `ctx.ui.confirm()`, and related methods. Provider OAuth logins started with `login_provider` (`authType: "oauth"`) use the same `extension_ui_request` and `extension_ui_response` sub-protocol. For process startup, framing, and typed client code, see [Drive Atomic over RPC](/rpc), [RPC protocol reference](/rpc/protocol), and [Connect with RPC clients](/rpc/examples).

## Extension UI protocol {#extension-ui-protocol}

Extension UI requests fall into three categories:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`, and `questionnaire` when the client [opted in](/rpc/protocol#set_extension_ui_capabilities)): emit an `extension_ui_request` on stdout and wait until the client sends an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget UI methods** (`cancel`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout and expect no response. Handle `cancel` by closing its matching dialog; other methods update your display.
- **OAuth login methods** (`oauth_auth`, `oauth_device_code`, `oauth_progress`, `oauth_info`, `oauth_prompt`, `oauth_select`, `oauth_manual_code`, `oauth_manual_code_cancel`): drive interactive OAuth sign-in during `login_provider`. `oauth_prompt`, `oauth_select`, and `oauth_manual_code` expect an `extension_ui_response` with `value`; the other OAuth methods are fire-and-forget.

<Note>
When a standard dialog (`select`, `confirm`, `input`, `editor`, or `questionnaire`) carries a `timeout` (in milliseconds) or an `AbortSignal`, Atomic resolves it automatically with its default value (`undefined` for `select`/`input`/`editor`, `false` for `confirm`, `{ answers: [], cancelled: true }` for `questionnaire`) if the timeout expires or the signal aborts, and sends a matching `cancel` notification. Clients do not need to run their own timers. Note that `editor` does not serialize `timeout` on the wire request even though Atomic still enforces `opts.timeout` locally and emits `cancel` if it expires.
</Note>

## Unsupported and degraded methods in plain RPC mode

In RPC mode, `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` because dialog and fire-and-forget methods work through this protocol. Guard terminal-only features such as `ctx.ui.custom()` with `ctx.mode === "tui"`.

| Method or property | Behavior in plain RPC mode |
| --- | --- |
| `setWidget(key, factory)` | Throws `Error("Component-factory widgets are unavailable in this RPC host.")`. Only string arrays (or `undefined` to clear) work over plain RPC. |
| `custom()` | Resolves to `undefined`. |
| `hostSessionPicker`, `hostInputForm` | Omitted (`undefined`). |
| `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `addAutocompleteProvider()`, `requestRender()` | No-ops. |
| `onTerminalInput()`, `onHostCustomUiStateChange()`, `onWidgetRelease()` | Return a no-op unsubscribe function. |
| `getEditorText()` | Returns `""`. |
| `getEditorComponent()` | Returns `undefined`. |
| `pasteToEditor(text)` | Delegates to `setEditorText(text)` without paste-collapse handling. |
| `getFooterDataProvider()` | Returns a stub (`getGitBranch() -> null`, `getExtensionStatuses() -> empty Map`, `getAvailableProviderCount() -> 1`, `onBranchChange() -> no-op unsubscribe`). |
| `getHostCustomUiState()`, `focusHostInlineCustomUi()` | Returns `{ blockingInlineCustomUiDepth: 0, blockingInlineCustomUiActive: false }`; `focusHostInlineCustomUi()` returns `false`. |
| `setToolsExpanded()`, `getToolsExpanded()`, `getChatRenderSettings()` | Stores tool-expansion state locally (matching `getChatRenderSettings().toolOutputExpanded`; not sent over the wire). `hideThinkingBlock` is `false`. |
| `getAllThemes()`, `getTheme()`, `setTheme()` | Returns `[]`, `undefined`, and `{ success: false, error: "Theme switching not supported in RPC mode" }`. |

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

During [`login_provider`](/rpc/protocol#login_provider) with `"authType": "oauth"`, Atomic emits OAuth UI requests containing `type: "extension_ui_request"`, `id`, `provider`, `loginId`, and `method`:

<Warning>
**Do NOT send `cancelled: true` to cancel `oauth_prompt` or `oauth_manual_code`.** Atomic turns `cancelled: true` into `undefined`, and both `oauth_prompt` and `oauth_manual_code` coalesce `undefined` to an empty string (`""`) — submitting an empty answer instead of cancelling the sign-in flow! (Only `oauth_select` receives `undefined`.) To cancel an OAuth login, send [`cancel_login_provider`](/rpc/protocol#cancel_login_provider) with the matching `provider` and `loginId`. Unlike standard dialogs, cancelling an OAuth flow does **not** emit a `method: "cancel"` notification for `oauth_prompt` or `oauth_select` (close any open prompt when you send `cancel_login_provider` or when `login_provider` responds).
</Warning>

| Method | Payload fields | Response expected |
| --- | --- | --- |
| `oauth_auth` | `info`: `{ url: string, instructions?: string }` | None (fire-and-forget) |
| `oauth_device_code` | `info`: `{ userCode: string, verificationUri: string, openBrowserOnConfirm?: boolean, copyCodeOnConfirm?: boolean, intervalSeconds?: number, expiresInSeconds?: number }` | None (fire-and-forget) |
| `oauth_progress` | `message: string` | None (fire-and-forget) |
| `oauth_info` | `message: string`, `links: Array<{ url: string, label?: string }>` | None (fire-and-forget) |
| `oauth_prompt` | `prompt`: `{ message: string, placeholder?: string, allowEmpty?: boolean }` | `extension_ui_response` with `value: string` (to abort login, send `cancel_login_provider`) |
| `oauth_select` | `prompt`: `{ message: string, options: Array<{ id: string, label: string }> }` | `extension_ui_response` with `value` (selected option `id`) or `cancelled: true` (resolves `undefined`) |
| `oauth_manual_code` | None | `extension_ui_response` with `value: string` (to abort login, send `cancel_login_provider`) |
| `oauth_manual_code_cancel` | None | None (close pending `oauth_manual_code` prompt without responding) |

Concrete wire payloads for each OAuth UI request:

```json
{"type":"extension_ui_request","id":"oa-1","method":"oauth_auth","provider":"anthropic","loginId":"login-1","info":{"url":"https://console.anthropic.com/oauth/authorize?...","instructions":"Open the URL to authorize Atomic."}}
{"type":"extension_ui_request","id":"oa-2","method":"oauth_device_code","provider":"github-copilot","loginId":"login-2","info":{"userCode":"ABCD-1234","verificationUri":"https://github.com/login/device","openBrowserOnConfirm":true,"copyCodeOnConfirm":true,"intervalSeconds":5,"expiresInSeconds":900}}
{"type":"extension_ui_request","id":"oa-3","method":"oauth_progress","provider":"github-copilot","loginId":"login-2","message":"Waiting for authorization..."}
{"type":"extension_ui_request","id":"oa-4","method":"oauth_info","provider":"openai-codex","loginId":"login-3","message":"Review workspace access:","links":[{"url":"https://chatgpt.com/settings","label":"Account settings"}]}
{"type":"extension_ui_request","id":"oa-5","method":"oauth_prompt","provider":"anthropic","loginId":"login-1","prompt":{"message":"Paste the authorization code","placeholder":"code#state","allowEmpty":false}}
{"type":"extension_ui_request","id":"oa-6","method":"oauth_select","provider":"google-gemini-cli","loginId":"login-4","prompt":{"message":"Choose a project","options":[{"id":"proj-a","label":"Project A"},{"id":"proj-b","label":"Project B"}]}}
{"type":"extension_ui_request","id":"oa-7","method":"oauth_manual_code","provider":"openai-codex","loginId":"login-3"}
{"type":"extension_ui_request","id":"oa-8","method":"oauth_manual_code_cancel","provider":"openai-codex","loginId":"login-3"}
```

## Extension UI responses (stdin)

Send responses for dialog methods (`select`, `confirm`, `input`, `editor`, `questionnaire`) and interactive OAuth methods (`oauth_prompt`, `oauth_select`, `oauth_manual_code`). The `id` must match the request.

**Response handling rules:**

- Responses with an unknown or already-resolved `id` are silently ignored.
- For `select`, `input`, and `editor`, a non-cancelled response without `value` resolves to `undefined`. `select` does not validate `value` against the original `options` list, so clients should send one of the offered options.
- For `confirm`, a non-cancelled response without `confirmed` resolves to `false`.
- For `questionnaire`, see [questionnaire](#questionnaire) for answer validation.
- For `oauth_prompt` and `oauth_manual_code`, send `value` as a string; to cancel sign-in, send [`cancel_login_provider`](/rpc/protocol#cancel_login_provider) rather than `cancelled: true`.

### Value response (`select`, `input`, `editor`, `oauth_prompt`, `oauth_select`, `oauth_manual_code`)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

### Confirmation response (`confirm`)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

### Cancellation response (standard dialogs and `oauth_select`)

Dismiss a standard dialog (`select`, `confirm`, `input`, `editor`, or `questionnaire`) or resolve `oauth_select` to `undefined`. Standard dialogs receive `undefined` (for `select`, `input`, `editor`), `false` (for `confirm`), or `{ answers: [], cancelled: true }` (for `questionnaire`). Do not use this to cancel `oauth_prompt` or `oauth_manual_code` — send `cancel_login_provider` instead.

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## See also

<Columns cols={2}>
  <Card title="Drive Atomic over RPC" href="/rpc">
    Startup flags, command concurrency lanes, JSONL framing, and shutdown signals.
  </Card>
  <Card title="RPC protocol reference" href="/rpc/protocol">
    All commands, streamed events, and structured error codes.
  </Card>
  <Card title="Connect with RPC clients" href="/rpc/examples">
    TypeScript `RpcClient` recipes and standalone Node.js examples.
  </Card>
</Columns>
