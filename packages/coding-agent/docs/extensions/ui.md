---
title: "Build custom UI"
sidebarTitle: "Build custom UI"
description: "Build dialogs, host-native pickers and forms, status widgets, custom components, overlays, and message renderers."
---

<div id="custom-ui" />

Extensions interact with users through `ctx.ui` methods and customize how messages, entries, and tools appear in the terminal.

Check `ctx.hasUI` (or `ctx.mode === "tui"`) before rendering terminal UI, and check `ctx.hasHumanInput` before calling dialogs in extensions that may run outside interactive mode. For reusable component patterns (`SelectList`, `BorderedLoader`, `SettingsList`, widgets, autocomplete, and custom footers), see [TUI components](/tui).

<Warning>
In **default interactive CLI mode** (`atomic`), extensions run in an isolated background worker process so slow code cannot freeze your keyboard. Dialogs, `ctx.ui.custom()`, widgets, status, notifications, and host-native pickers and forms work normally, while synchronous TUI callbacks, theme switching, working-indicator customization, and `registerMarkdownTransformer()` require an **embedded in-process TUI** host created via the SDK. There is no CLI flag to disable worker isolation.
</Warning>

## UI API compatibility matrix

Use this matrix to see what each UI API does across Atomic's four runtimes:

| API | Default interactive CLI (worker) | Embedded in-process TUI (SDK) | Headless RPC (`--mode rpc`) | Print / JSON (`-p`, `--mode json`, no `humanInput`) |
| --- | --- | --- | --- | --- |
| `select()`, `confirm()`, `input()` (incl. `{ timeout }`) | Supported (live countdown) | Supported (live countdown) | Supported via RPC dialog requests | Rejects with `HumanInputUnavailable` |
| `editor(title, prefill, { timeout })` | Supported, but `timeout` auto-cancels locally with **no countdown display** | Supported (live countdown) | Supported via RPC (`timeout` omitted from request) | Rejects with `HumanInputUnavailable` |
| `notify()`, `setStatus()`, `setTitle()`, `setEditorText()` | Supported | Supported | Supported (fire-and-forget RPC requests) | No-op |
| `setWidget(key, lines)` | Supported | Supported | Supported | No-op |
| `setWidget(key, factoryFn)` | Supported | Supported | **Throws** `Error("Component-factory widgets are unavailable in this RPC host.")` | No-op |
| `custom(factory, options)` | Supported (return value must be JSON-serializable) | Supported | Resolves `undefined` | Rejects with `HumanInputUnavailable` |
| `hostSessionPicker()`, `hostInputForm()` | Supported (runs natively in TUI host) | Supported | Omitted (`undefined`) | Omitted (`undefined`) |
| `hostQuestionnaire()` | Omitted (interactive TUI renders questionnaire directly) | Omitted | Supported when client advertises `questionnaire` capability; else resolves `undefined` | Omitted (`undefined`) |
| `requestRender()`, `getHostCustomUiState()`, `onHostCustomUiStateChange()`, `focusHostInlineCustomUi()`, `onWidgetRelease()` | Supported | Supported | No-op / default idle state | No-op / omitted |
| `pasteToEditor(text)` | Delegates to `setEditorText(text)` (**replaces** editor text; no paste collapse) | Full paste handling and large-paste collapse | Delegates to `setEditorText(text)` | No-op |
| `getToolsExpanded()` / `setToolsExpanded()` | Worker-local boolean only (does not read or change host TUI state) | Reads and toggles live TUI expansion | Worker-local boolean only | `false` / no-op |
| `getChatRenderSettings()` | Reads host `hideThinkingBlock`, `fullscreenScrollbar`, `fullscreenWheelScrollLines`, and tool/message renderers; hardcodes `hiddenThinkingLabel: "Thinking..."`, `showImages: false`, `imageWidthCells: 60`, `markdownTransformers: []` | Full live TUI settings | Static defaults | Static defaults |
| `setWorkingMessage()`, `setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()` | Silent no-op | Supported | Silent no-op | Silent no-op |
| `setTheme()`, `getAllThemes()`, `getTheme()` | `setTheme()` returns `{ success: false, error: "Theme switching not supported in RPC mode" }`; `getAllThemes()` returns `[]`; `getTheme()` returns `undefined` | Supported | Same as worker | `setTheme()` returns `{ success: false, error: "UI not available" }`; `[]` / `undefined` |
| `onTerminalInput()`, `getEditorText()`, `setEditorComponent()`, `addAutocompleteProvider()`, `setHeader()`, `setFooter()` | Emits a one-time warning and does not run (`getEditorText()` returns `""`) | Supported | Silent no-op (`getEditorText()` returns `""`) | Silent no-op (`getEditorText()` returns `""`) |
| `atomic.registerMarkdownTransformer()` | Does not run | Supported | Does not run | Does not run |

## Dialogs

```typescript
// Select from options
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled text");

// Notification (non-blocking)
ctx.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

Notifications emitted during extension loading or startup appear below the startup `RESOURCES` line.

### Timed dialogs with countdown

Pass `{ timeout }` (in milliseconds) to auto-dismiss a dialog:

```typescript
// Shows "Title (5s)", "Title (4s)", and auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);
```

Return values when a dialog times out or your own `signal` aborts:

- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` and `editor()` return `undefined`

<Note>
In default interactive CLI mode and RPC mode, `select()`, `confirm()`, and `input()` forward `timeout` to display a live countdown, whereas `editor()` cancels locally after `timeout` ms without rendering a countdown. If the session closes, cancels all pending input, or swaps its input host while a dialog is waiting, the promise rejects with an error whose `code` is `"HumanInputCancelled"` (or `"SessionClosed"` if the session already closed).
</Note>

### Manual dismissal with AbortSignal

Pass `{ signal }` to dismiss a dialog programmatically and tell a timeout apart from a user cancellation:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Timed out
} else {
  // User cancelled (Escape or "No")
}
```

See [examples/extensions/timed-confirm.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/timed-confirm.ts).

## Host-native pickers and forms

These APIs render directly inside the terminal UI process so typing, search, validation, and keybindings stay instant even in default interactive CLI mode. They are `undefined` in print, JSON, and headless RPC modes, so guard calls with optional chaining.

### Session picker (`ctx.ui.hostSessionPicker`)

Open a searchable session-style picker with JSON-safe `HostSessionPickerRow` items (`SessionInfo` with `createdAt` and `modifiedAt` flattened to epoch milliseconds):

```typescript
const picker = ctx.ui.hostSessionPicker?.({
  title: "Resume session",
  variant: "sessions", // "sessions" | "runs"
  showRenameHint: false,
  sessions: rows,
  onDelete: async (path) => {
    await deleteSession(path);
  },
});

// Update rows dynamically, surface a transient error, or close early:
picker?.update(updatedRows);
picker?.error("Could not refresh list");

const selectedPath = await picker?.result; // Selected path or undefined on cancel
```

Each `HostSessionPickerRow` accepts standard session metadata (`path`, `id`, `cwd`, `createdAt`, `modifiedAt`, `messageCount`, `firstMessage`, optional `summary`, `allMessagesText`, `name`) plus optional synthetic display fields (`title`, `detail`, `messageColor`: `"success" | "warning" | "accent" | "error"`, `canDelete`).

The returned `HostSessionPickerHandle` exposes `result`, `update(rows)`, `error(message)`, and `close()`. See [Host-native session picker](/tui/reference#host-native-session-picker).

### Structured input form (`ctx.ui.hostInputForm`)

Open an inline structured form with JSON-safe field descriptors (`string`, `text`, `number`, `integer`, `boolean`, or `select`) and raw string `initialValue` entries:

```typescript
const values = await ctx.ui.hostInputForm?.({
  title: "Configure endpoint",
  heading: "API settings",
  submitLabel: "Save",
  fields: [
    {
      name: "url",
      type: "string",
      description: "Base URL for API requests",
      required: true,
      placeholder: "https://api.example.com",
      initialValue: "https://api.example.com",
    },
    {
      name: "retries",
      type: "integer",
      description: "Maximum retry attempts",
      initialValue: "3",
    },
    {
      name: "mode",
      type: "select",
      choices: ["fast", "strict"],
      initialValue: "fast",
    },
  ],
});
```

`HostInputFormField` supports `name`, `type`, `initialValue`, and optional `description`, `required`, `choices` (for `"select"`), and `placeholder`. `hostInputForm()` resolves to a `Record<string, string>` or `undefined` on cancel, and rejects with `"The host could not read this input form."` if the host cannot read the form. See [Host-native input form](/tui/reference#host-native-input-form).

### Native questionnaire (`ctx.ui.hostQuestionnaire`)

In headless RPC mode, optional `ctx.ui.hostQuestionnaire?(params, signal)` delegates a full `ask_user_question` questionnaire as a single RPC request when the client advertises `questionnaire` capability. It returns the `QuestionnaireResult`, or `undefined` when the host cannot display it (so the caller renders the questionnaire itself).

## Status, widgets, and editor controls

### Status bar and terminal title

These methods work in default interactive CLI mode, embedded in-process TUI, and RPC mode:

```typescript
// Status text in the footer (persistent until cleared with undefined)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);

// Terminal window/tab title
ctx.ui.setTitle("atomic - my-project");

// Request a TUI repaint after async extension state changes
ctx.ui.requestRender();

// Read built-in footer data (git branch, extension statuses, available providers)
const footerData = ctx.ui.getFooterDataProvider();
```

### Widgets

Place persistent status panels above or below the editor using either string lines or a component factory:

```typescript
import { Text } from "@bastani/atomic-tui";

// Plain string lines above (default) or below the editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });

// Component factory (supported in default interactive CLI and embedded TUI; throws in standalone headless RPC)
ctx.ui.setWidget("my-widget", (_tui, theme) => ({
  render: (width) => new Text(theme.fg("accent", "Custom widget"), 0, 0).render(width),
  invalidate() {},
  dispose() {
    // Optional cleanup hook run when the widget is cleared or replaced
  },
}));

// Clear the widget
ctx.ui.setWidget("my-widget", undefined);
```

For taller content, opt into a host-managed scroll viewport (`ScrollableWidgetComponent` with optional `getScrollRequest?()`, `onScroll?()`, and `dispose?()`) and subscribe to host release notifications:

```typescript
ctx.ui.setWidget(
  "my-scrollable",
  (_tui, _theme) => myScrollableComponent,
  { placement: "aboveEditor", scroll: { maxHeight: 12, maxHeightFraction: 0.35 } },
);

const unsubscribeRelease = ctx.ui.onWidgetRelease?.("my-scrollable", () => {
  // Clean up timers or subscriptions if the host releases this widget
});
```

For widgets driven by reactive snapshots or periodic timers, `@bastani/atomic` also exports `installReactiveWidget()` and `decideReactiveWidgetAction()` to coalesce mount, unmount, and redraw updates cleanly.

<Note>
Inline custom UIs opened with `{ purpose: "navigation" }` temporarily hide all `setWidget()` widgets above and below the editor (including the agent panel) along with queued-message and pending-shell previews. Widgets keep updating in the background and reappear once the navigation view closes. Overlays and `"prompt"` custom UIs do not hide widgets.
</Note>

### Editor text and host UI state

```typescript
// Prefill or replace the main input editor
ctx.ui.setEditorText("Draft prompt");

// Paste text (in embedded in-process TUI, applies large-paste collapse;
// in default CLI worker and RPC mode, replaces editor text via setEditorText)
ctx.ui.pasteToEditor("pasted content");

// Inspect or react to whether an inline blocking custom UI is mounted
const uiState = ctx.ui.getHostCustomUiState?.();
const stopObserving = ctx.ui.onHostCustomUiStateChange?.((nextState) => {
  if (nextState.blockingInlineCustomUiActive) {
    // Move keyboard focus back to a deferred inline custom UI when ready
    ctx.ui.focusHostInlineCustomUi?.();
  }
});

// Read active chat render preferences (see compatibility matrix for worker defaults)
const renderSettings = ctx.ui.getChatRenderSettings();
```

### In-process TUI only

<Note>
The APIs below require direct access to the terminal UI process and **only work in embedded in-process TUI sessions** (created via the SDK). In default interactive CLI mode, working-indicator, hidden-thinking, and theme calls are silent no-ops/stubs, while header, footer, editor-read, and raw terminal input calls emit a warning and skip.
</Note>

#### Working indicator and collapsed thinking label

```typescript
// Customize the loading text shown from prompt submission through the turn
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();      // Restore default
ctx.ui.setWorkingVisible(false); // Hide working row (compaction indicator stays visible)
ctx.ui.setWorkingVisible(true);

// Customize the animated working indicator (default pulses Atomic's ∀ spinner across 6 brightness tones)
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] }); // Hide indicator
ctx.ui.setWorkingIndicator();               // Restore default animated spinner

// Label shown when thinking blocks are collapsed (Ctrl+T)
ctx.ui.setHiddenThinkingLabel("Pondering...");
ctx.ui.setHiddenThinkingLabel();            // Restore default
```

`ATOMIC_REDUCED_MOTION=1` makes the default spinner static, and `NO_COLOR` disables foreground colors. Custom frames render verbatim; apply theme colors with `ctx.ui.theme.fg(...)` when needed. See [Working indicator customization](/tui#pattern-4b-working-indicator-customization).

#### Custom header, footer, raw input, and tool expansion

```typescript
// Replace startup header or footer (factories may return an optional dispose() cleanup hook)
ctx.ui.setHeader((_tui, theme) => new Text(theme.fg("accent", "Custom header"), 0, 0));
ctx.ui.setHeader(undefined); // Restore built-in header

ctx.ui.setFooter((_tui, theme, footerData) => ({
  render(_width) {
    const branch = footerData.getGitBranch() ?? "";
    return [theme.fg("dim", `Custom footer ${branch}`)];
  },
  invalidate() {},
  dispose() {},
}));
ctx.ui.setFooter(undefined); // Restore built-in footer

// Read editor text synchronously
const current = ctx.ui.getEditorText();

// Intercept or transform raw terminal input before Atomic handles it
const stopInput = ctx.ui.onTerminalInput((data) => {
  if (data === "\x07") return { consume: true }; // Drop key
  if (data === "a") return { data: "A" };        // Rewrite key data
  return undefined;                              // Pass through unchanged
});

// Read or toggle tool output expansion (no-op if already equal to target value)
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);
```

#### Theme switching

```typescript
const themes = ctx.ui.getAllThemes(); // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");
const result = ctx.ui.setTheme("light");
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
if (lightTheme) ctx.ui.setTheme(lightTheme);
```

## Autocomplete providers

<Note>
`ctx.ui.addAutocompleteProvider()` requires an **embedded in-process TUI** host. In default interactive CLI mode, calling it emits a warning and does not register the provider.
</Note>

Use `ctx.ui.addAutocompleteProvider()` to layer custom completion on top of built-in slash-command and path completion. Return the complete result from the wrapped provider, including its metadata. Slash-command suggestions can set `completeOnConfirm: false` so `Enter` submits the typed command literally until the user navigates the list, while `Tab` still accepts the highlighted item.

```typescript
atomic.on("session_start", (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#42", label: "#42", description: "Fix login redirect" },
          { value: "#57", label: "#57", description: "Add retry backoff" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

See [github-issue-autocomplete.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/github-issue-autocomplete.ts) for a complete example using `gh issue list`.

## Custom components

Use `ctx.ui.custom()` to mount an interactive component until it calls `done(value)`. Works in both default interactive CLI mode and embedded in-process TUI hosts. The `factory` callback may be synchronous or async (`Promise<ExtensionCustomComponent>`), and the component may define an optional `dispose?()` cleanup method that runs when it unmounts:

```typescript
import { Text, type Component } from "@bastani/atomic-tui";

class ConfirmPrompt implements Component {
  constructor(private readonly done: (value: boolean) => void) {}

  render(width: number): string[] {
    return new Text("Enter Confirm · Escape Cancel", 1, 1).render(width);
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (data === "\r") {
      this.done(true);
      return true;
    }
    if (data === "\x1b") {
      this.done(false);
      return true;
    }
    return false;
  }
}

const result = await ctx.ui.custom<boolean>(async (_tui, _theme, _keybindings, done) => {
  return new ConfirmPrompt(done);
});
```

The factory receives four arguments:

- `tui`: TUI instance for screen dimensions and focus management
- `theme`: current theme for styling
- `keybindings`: configured `KeybindingsManager` for shortcut matching
- `done(value)`: closes the component and resolves `ctx.ui.custom()` with `value` (must be JSON-serializable in default interactive CLI mode)

Supported `options`:

| Option | Type | Purpose |
| --- | --- | --- |
| `purpose` | `"prompt" \| "navigation"` | Defaults to `"prompt"`. `"navigation"` skips approval-prompt events and temporarily hides widgets while an inline view is open. |
| `overlay` | `boolean` | Render as a floating modal over existing content instead of replacing the editor. |
| `overlayOptions` | `OverlayOptions \| (() => OverlayOptions)` | Static or dynamic positioning and sizing options; function form recomputes on terminal resize. |
| `onHandle` | `(handle: OverlayHandle) => void` | Receive the overlay handle to show or hide it programmatically. |
| `reserveTranscriptRows` | `boolean` | Overlay-only. Reserves at least six visible transcript rows above a bottom-anchored blocking dialog. |
| `handlesCtrlC` | `boolean` | Set `true` when the component handles `Ctrl+C` itself; otherwise Atomic closes it on the first `Ctrl+C` press. |
| `handlesInternalUiAction` | `boolean` | Route Atomic's internal terminal click actions (such as clicking a jump-to-bottom transcript link) to this component's `handleInput()` instead of letting the host handle them directly. |
| `deferInlineCustomUiFocus` | `boolean` | When an inline custom UI is already open in the editor slot, keep keyboard focus on this overlay rather than shifting focus back to the inline UI while the overlay is visible. |
| `blocked` | `{ kind: ProgramStatus["kind"], message: string }` | Signals supporting terminals and multiplexers that Atomic is waiting for user input while this component is active. |
| `signal` | `AbortSignal` | Dismiss the custom UI programmatically. In default interactive CLI mode, aborting resolves `ctx.ui.custom()` with `undefined` (like user cancel); in an embedded in-process TUI, it rejects with the signal's abort reason. |

### Input handling contract

- `handleInput(data)` must return `true` when it consumes an input and `false` or `undefined` when it does not.
- In fullscreen mode, an unhandled viewport key continues to the transcript. If a component does not reply in time, the key also falls through to the transcript.
- An async `handleInput()` is judged when its promise settles: only a resolved `true` consumes the key, while `false`, `undefined`, and rejections fall through.
- A component without `handleInput` declines all keys so viewport keys continue scrolling the transcript behind it.
- Set `{ handlesCtrlC: true }` whenever your component binds `Ctrl+C` itself. Otherwise Atomic closes the component on the first `Ctrl+C` so a hung component cannot trap the keyboard. See [Responsive UI and crash recovery](/extensions#interactive-callback-isolation).

See [TUI components](/tui) for the full component API.

### Overlay mode

Pass `{ overlay: true }` to render a floating modal without clearing the screen:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: () => ({ anchor: "top-right", width: "50%", margin: 2 }),
    onHandle: (handle) => {
      // handle.setHidden(true/false)
    },
  },
);
```

See [overlay-qa-tests.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) for positioning and resize examples.

Pass `{ reserveTranscriptRows: true }` for a blocking bottom dialog that must leave at least six transcript rows visible:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  {
    overlay: true,
    reserveTranscriptRows: true,
    overlayOptions: { anchor: "bottom-center", width: "100%" },
  },
);
```

- Set `overlayOptions.anchor` to `bottom-left`, `bottom-center`, or `bottom-right`; `row` and nonzero `offsetY` are rejected.
- A reserving overlay always passes fullscreen transcript scroll keys and vertical mouse wheel input through to the transcript, even when a nested input has focus, while keeping all other keyboard and mouse input.
- Embed `OVERLAY_ACTIVE_ROW_MARKER` from `@bastani/atomic` once per frame on the active row so it remains visible when the dialog is cropped (zero visible width, stripped before terminal output):

```typescript
import { OVERLAY_ACTIVE_ROW_MARKER } from "@bastani/atomic";

render(width: number): string[] {
  return this.items.map((item, index) =>
    index === this.selected ? `${this.row(item, width)}${OVERLAY_ACTIVE_ROW_MARKER}` : this.row(item, width),
  );
}
```

## Custom editor

<Note>
`ctx.ui.setEditorComponent()` requires an **embedded in-process TUI** host. In default interactive CLI mode, calling it emits a warning and keeps the built-in editor.
</Note>

Replace the main input editor by extending `CustomEditor`:

```typescript
import { CustomEditor, type ExtensionAPI } from "@bastani/atomic";
import { matchesKey } from "@bastani/atomic-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return true;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return true;
    }
    return super.handleInput(data);
  }
}

export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings),
    );
  });
}
```

Key points:

- Extend `CustomEditor` (not base `Editor`) so built-in shortcuts such as Escape, Ctrl+D, model switching, and prompt navigation (`Down` to focus the agent panel, `Left` to return from a subagent to `main`) keep working via `super.handleInput(data)`.
- Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to draw the working indicator inside the editor's top border instead of a standalone row.
- Capture `const previous = ctx.ui.getEditorComponent()` before calling `setEditorComponent()` to wrap another extension's editor, and pass `undefined` to restore the default editor.
- If your custom editor implements `setAutocompleteMaxVisible()`, Atomic initializes it from `autocompleteMaxVisible` in settings.

## Message rendering

Register a custom renderer for messages carrying your `customType`:

```typescript
import { Text } from "@bastani/atomic-tui";

atomic.registerMessageRenderer("my-extension", (message, options, theme) => {
  if (!message.details) return null; // Suppress completely (no box, no spacer)

  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  } else {
    text += ` (${options.keyHint("app.tools.expand", "to expand")})`;
  }

  return new Text(text, outputPad, 0);
});
```

Return-value contract for `registerMessageRenderer`:

- **`Component`:** Mounts and renders your component in the transcript.
- **`null`:** Suppresses the message completely (zero rows, no spacer, and no default fallback box). Useful for hiding rehydrated messages whose backing state no longer exists.
- **`undefined`:** Falls back to Atomic's default boxed `[customType]` rendering.

In fullscreen mode, clicking a custom message toggles `expanded` for that message alone (just as `Ctrl+O` toggles every block) and calls your renderer again. In an embedded in-process TUI, a component can intercept clicks first by returning `{ handled: true }` from `handleMouse`; in default interactive CLI mode, rendered rows are sent without custom mouse callbacks. A tool's title row always toggles first.

Send matching messages with `atomic.sendMessage()`:

```typescript
await atomic.sendMessage({
  customType: "my-extension",
  content: "Status update",
  display: true,
  details: { step: 2 },
});
```

## Theme colors and formatting helpers

All render functions receive the active `theme` object. See [Customize themes](/themes) and [Theme reference](/themes/reference) for all color tokens.

```typescript
// Foreground and background colors
theme.fg("toolTitle", text)
theme.fg("accent", text)
theme.fg("success", text)
theme.fg("error", text)
theme.fg("warning", text)
theme.fg("muted", text)
theme.fg("dim", text)
theme.bg("selectedBg", text)

// Text styles
theme.bold(text)
theme.italic(text)
theme.underline(text)
theme.dim(text)
theme.inverse(text)
theme.strikethrough(text)

// Raw ANSI escape sequences
theme.getFgAnsi("accent")
theme.getBgAnsi("selectedBg")
```

Syntax highlighting helper for custom renderers (`highlightCode(code, lang?)` reads the active theme automatically and returns highlighted lines):

```typescript
import { highlightCode, getLanguageFromPath } from "@bastani/atomic";

const lang = getLanguageFromPath("/path/to/file.rs"); // "rust"
const highlighted = highlightCode("fn main() {}", lang);
```

Line-range label helper for `read`-like tools (`formatReadLineRange` accepts numbers, numeric strings, and `null`, returning `""` for missing or malformed ranges):

```typescript
import { formatReadLineRange } from "@bastani/atomic";

formatReadLineRange(25, 13);      // ":25-37"
formatReadLineRange("25", null);  // ":25"
formatReadLineRange("abc", 13);   // ""
```

## Next steps

Try the runnable [Extension examples](/extensions/examples), and check context properties and method signatures in the [Extension API reference](/extensions/api-reference).
