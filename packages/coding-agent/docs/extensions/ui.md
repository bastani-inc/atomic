---
title: "Extension UI"
sidebarTitle: "Custom UI"
description: "Build dialogs, widgets, status indicators, host-native pickers and forms, custom overlays, editors, and message renderers."
---

<div id="custom-ui" />

Extensions interact with users through `ctx.ui` methods and customize how messages, entries, and tools render.

Check `ctx.hasUI` (or `ctx.mode === "tui"`) before showing interactive UI. For reusable component patterns (`SelectList`, `BorderedLoader`, `SettingsList`, working indicators, widgets, autocomplete, and custom footers), see [TUI components](/tui).

> **Interactive mode note:** In default interactive mode, extensions run in a separate background worker process. Dialogs, `ctx.ui.custom()`, widgets, status, notifications, and host-native pickers and forms work everywhere. APIs that require synchronous terminal UI callbacks (`onTerminalInput`, sync `getEditorText`, `setEditorComponent`, `addAutocompleteProvider`, `setHeader`, and `setFooter`) warn and do not run in default interactive mode. See [Responsive UI and crash recovery](/extensions#interactive-callback-isolation).

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

Notifications emitted during extension loading or startup always appear below the startup `RESOURCES` line.

### Timed dialogs with countdown

Dialogs accept `{ timeout }` (in milliseconds) to auto-dismiss with a live countdown:

```typescript
// Shows "Title (5s)", "Title (4s)", and auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);
```

Return values on timeout or caller abort:

- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` and `editor()` return `undefined`

Cancelling all pending input, closing the session, or replacing its input host can still reject with `HumanInputCancelled`.

### Manual dismissal with AbortSignal

Pass `{ signal }` to dismiss a dialog programmatically and distinguish a timeout from a user cancel:

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

These APIs render directly in the terminal UI process so typing, search, validation, and keybindings stay instant even in default interactive mode. They are omitted in print and headless RPC modes (check before calling).

### Session picker (`ctx.ui.hostSessionPicker`)

Open a searchable session-style picker with JSON-safe `HostSessionPickerRow` items (`SessionInfo` with `createdAt` and `modifiedAt` in epoch milliseconds):

```typescript
const picker = ctx.ui.hostSessionPicker?.({
  title: "Resume session",
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

The returned `HostSessionPickerHandle` exposes `result`, `update(rows)`, `error(message)`, and `close()`. See [Host-native session picker](/tui/reference#host-native-session-picker).

### Structured input form (`ctx.ui.hostInputForm`)

Open an inline structured form with JSON-safe field descriptors (`string`, `text`, `number`, `integer`, `boolean`, or `select`) and raw `initialValue` strings:

```typescript
const values = await ctx.ui.hostInputForm?.({
  title: "Configure endpoint",
  fields: [
    { name: "url", label: "Base URL", type: "string", initialValue: "https://api.example.com" },
    { name: "retries", label: "Retries", type: "integer", initialValue: "3" },
  ],
});
```

`hostInputForm()` resolves to a raw `Record<string, string>` or `undefined` on cancel, and rejects with `"The host could not read this input form."` if the host cannot read the form. See [Host-native input form](/tui/reference#host-native-input-form).

### Native questionnaire (`ctx.ui.hostQuestionnaire`)

Optional `ctx.ui.hostQuestionnaire?(params, signal)` delegates a full `ask_user_question` questionnaire to a host that implements native question UI. It returns the `QuestionnaireResult`, or `undefined` when the host cannot display it (so the caller renders the questionnaire itself).

## Widgets, status, header, and footer

Inline custom UIs opened with `{ purpose: "navigation" }` temporarily hide all `setWidget()` widgets above and below the editor (including the agent panel) as well as queued-message and pending-shell previews. Widgets keep updating in the background and return with their latest content once the navigation view closes. Overlays and `"prompt"` custom UIs do not hide them.

```typescript
// Status in footer (persistent until cleared)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);

// Request a TUI repaint after async state changes
ctx.ui.requestRender();

// Working loader customization (active from prompt submission through the turn)
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();        // Restore default
ctx.ui.setWorkingVisible(false);   // Hide working row (compaction indicator stays visible)
ctx.ui.setWorkingVisible(true);

// Working indicator customization (see TUI Pattern 4b)
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
ctx.ui.setWorkingIndicator();               // Restore default ∀ ramp

// Label shown when thinking blocks are collapsed (Ctrl+T)
ctx.ui.setHiddenThinkingLabel("Pondering...");
ctx.ui.setHiddenThinkingLabel();            // Restore default

// Widget above or below editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);   // Clear

// Scrollable widget with capped height and release callback
ctx.ui.setWidget(
  "my-scrollable",
  (tui, theme) => myScrollableComponent,    // Implements ScrollableWidgetComponent (getScrollRequest?, onScroll?)
  { placement: "aboveEditor", scroll: { maxHeight: 12, maxHeightFraction: 0.35 } },
);
const unsubscribeRelease = ctx.ui.onWidgetRelease?.("my-scrollable", () => {
  // Clean up resources when the host releases this widget
});

// Custom startup header and custom footer (embedded/non-worker interactive sessions)
ctx.ui.setHeader((tui, theme) => new Text(theme.fg("accent", "Custom header"), 0, 0));
ctx.ui.setHeader(undefined);                // Restore built-in header

ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width) {
    const branch = footerData.getGitBranch() ?? "";
    return [theme.fg("dim", `Custom footer ${branch}`)];
  },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);                // Restore built-in footer

// Read built-in footer data (git branch, extension statuses) directly
const footerData = ctx.ui.getFooterDataProvider();

// Terminal window/tab title
ctx.ui.setTitle("atomic - my-project");

// Editor text and paste
ctx.ui.setEditorText("Prefill text");
const current = ctx.ui.getEditorText();
ctx.ui.pasteToEditor("pasted content");     // Applies normal paste handling and large-paste collapse

// Raw terminal input interceptor (embedded/non-worker interactive sessions)
const stopInput = ctx.ui.onTerminalInput((data) => {
  if (data === "\x07") return { consume: true };
  return undefined;
});

// Tool output expansion
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// Theme management
const themes = ctx.ui.getAllThemes();       // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");
const result = ctx.ui.setTheme("light");
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
if (lightTheme) ctx.ui.setTheme(lightTheme);
ctx.ui.theme.fg("accent", "styled text");
```

Calling `setToolsExpanded()` with the current value is a no-op. `ATOMIC_REDUCED_MOTION=1` makes the default `∀` working indicator static, and `NO_COLOR` disables foreground colors. Custom frames render verbatim; apply theme colors with `ctx.ui.theme.fg(...)` when needed.

These APIs customize display only; they do not start turns or emit stream events. See [Working indicator customization](/tui#pattern-4b-working-indicator-customization) for timing details.

## Autocomplete providers

Use `ctx.ui.addAutocompleteProvider()` (available when running directly in the terminal UI process) to layer custom completion on top of built-in slash-command and path completion.

Return the complete result from the wrapped provider, including its metadata. Slash-command suggestions can set `completeOnConfirm: false` so `Enter` submits the typed command literally until the user navigates the list, while `Tab` still accepts the highlighted item.

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

Use `ctx.ui.custom()` to mount an interactive component until it calls `done(value)`. The `factory` callback may be synchronous or async (`Promise<ExtensionCustomComponent>`):

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
- `done(value)`: closes the component and resolves `ctx.ui.custom()` with `value` (must be JSON-serializable in default interactive mode)

Supported `options`:

| Option | Type | Purpose |
| --- | --- | --- |
| `purpose` | `"prompt" \| "navigation"` | Defaults to `"prompt"`. `"navigation"` skips approval-prompt events and temporarily hides widgets while an inline view is open. |
| `overlay` | `boolean` | Render as a floating modal over existing content instead of replacing the editor. |
| `overlayOptions` | `OverlayOptions \| (() => OverlayOptions)` | Static or dynamic positioning and sizing options; function form recomputes on terminal resize. |
| `onHandle` | `(handle: OverlayHandle) => void` | Receive the overlay handle to show or hide it programmatically. |
| `reserveTranscriptRows` | `boolean` | Overlay-only. Reserves at least six visible transcript rows above a bottom-anchored blocking dialog. |
| `handlesCtrlC` | `boolean` | Set `true` when the component handles `Ctrl+C` itself; otherwise Atomic closes it on the first `Ctrl+C` press. |
| `handlesInternalUiAction` | `boolean` | Declare that the component handles internal UI actions such as jump-to-bottom links. |
| `deferInlineCustomUiFocus` | `boolean` | Keep a pending inline custom UI unfocused in the background while this overlay is open. |
| `blocked` | `{ kind: ProgramStatus["kind"], message: string }` | Report Atomic as blocked on user input (OSC 7501 status) while waiting. |
| `signal` | `AbortSignal` | Dismiss the custom UI programmatically. In default interactive mode, aborting resolves `ctx.ui.custom()` with `undefined` (like user cancel); when embedded in the same process, it rejects with the signal's abort reason. |

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

Replace the main input editor (available when extensions run directly in the terminal UI process) by extending `CustomEditor`:

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

In fullscreen mode, clicking a custom message toggles `expanded` for that message alone (just as `Ctrl+O` toggles every block) and calls your renderer again. When running directly in the terminal UI process, a component can intercept clicks first by returning `{ handled: true }` from `handleMouse`; in default interactive mode, rendered rows are sent without custom mouse callbacks. A tool's title row always toggles first.

Send matching messages with `atomic.sendMessage()`:

```typescript
await atomic.sendMessage({
  customType: "my-extension",
  content: "Status update",
  display: true,
  details: { step: 2 },
});
```

## Theme colors

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

Syntax highlighting helper for custom renderers:

```typescript
import { highlightCode, getLanguageFromPath } from "@bastani/atomic";

const lang = getLanguageFromPath("/path/to/file.rs"); // "rust"
const highlighted = highlightCode("fn main() {}", lang, theme);
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
