---
title: "TUI API reference"
sidebarTitle: "TUI API"
description: "Reference for Atomic TUI component, focusable, keyboard, theme invalidation, debug logging, and host-native UI contracts."
---

## Tool blocks

Use `ToolBlock` from `@bastani/atomic` for a transcript item with a state glyph, one header row, and connected result rows. It accepts `status`, `title`, and optional `args`, `meta`, `details`, `body`, and `outputPad` (default `1`).

Supported `ToolBlockStatus` (aliases `NoticeStatus`) values:

- General states: `running` (`∀`), `success`, `failure`, `stopped` (interrupted or not run, muted `◼`), `warning`, `paused` (warning-colored `‖`), `waiting` (dim `◌`, wakes automatically when what it waits on finishes), `heartbeat` (muted `♥`), and `info`.
- Subagent and background-task states (shared with the agent panel and `/tasks`): `agent-running` (grey `◯`), `shell-running` (`⧗`), `input` (`◆`, waiting for an answer), `task-queued` (dim `○`), `task-stopping` (warning-colored `◼`), and `task-stopped` (red `◯`).

`TASK_MARKS` from `@bastani/atomic` exports these glyphs for custom rendering. Exhaustive switches on `ToolBlockStatus` or `NoticeStatus` must handle all general states (including `waiting` and `heartbeat`) plus all six subagent and background-task states.

A `NoticeLine` reports a task, drawing `running` as a grey `◯`, `stopped` as a red `◯`, and `paused` as warning-colored `‖`. With `NO_COLOR`, running and stopped notices (like `agent-running` and `task-stopped` blocks) both show plain `◯`, distinguished by their text.

```typescript
import { ToolBlock, ToolBlockRecords } from "@bastani/atomic";

const item = new ToolBlock({
  status: "success",
  title: "Inspect",
  args: "sample.ts",
  details: new ToolBlockRecords(["Read 42 lines", "No errors found"]),
});
```

A block does not add a leading blank line; its container controls spacing between items. `ToolBlockGroup` separates several blocks with one blank line. `ToolBlockMarkdown(text)` sanitizes terminal controls and renders Markdown with links shown as text and URLs, not clickable terminal links, and images shown as `[image]`.

In ordinary tool renderers, return only the call title from `renderCall` and unframed result content from `renderResult`; Atomic supplies the state glyph and connectors. Return `ToolBlockRecords` when several results need separate connectors.

When embedding `ChatSessionHost` (an experimental embedded-chat host exported from `@bastani/atomic`; not yet a guaranteed stable extension API), forward the complete `ctx.ui.getChatRenderSettings()` result. Its optional component factories preserve tool renderers and the embedded chat's repaint and expansion settings. Do not copy only `getToolDefinition`. Custom message renderers can use `options.cwd` for the receiving chat's working directory instead of assuming `process.cwd()` matches it.

`host.replaceMessages(messages)` starts a fresh unread baseline. Use `host.replaceMessages(messages, { preserveUnread: true })` for a new snapshot of the same conversation; arrivals that have not painted yet remain unread.

An extra row supplied through `host.appendExtraEntry()` may exist nowhere else. Atomic keeps those rows in memory until the host is disposed without saving private extension data to disk.

An extension card in saved chat history can also hold state that its saved message cannot reproduce, so the chat keeps the original component when it scrolls offscreen. If a renderer can recreate its component without losing state, set `historyReplayable: true` as an own data property on the component so the chat can discard and re-render it on demand. Keep private rows and stateful cards small in long-lived chats.

The `Markdown` component from `@bastani/atomic-tui` also accepts per-instance `hyperlinks: false` and `images: false` in its sixth constructor argument. These options do not change other components or terminal capabilities.

## Component interface

`@bastani/atomic-tui` defines the base `Component` interface, and Atomic extends it with `ExtensionCustomComponent` for components returned by `ctx.ui.custom()`:

```typescript
// Base component interface from @bastani/atomic-tui
interface Component {
  render(width: number): string[];
  renderSized?(width: number, height: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  paintedRowKey?(row: number): string | undefined;
  readonly selectionTextMayChangeOnReplay?: boolean;
  readonly historyReplayable?: boolean;
  wantsKeyRelease?: boolean;
  capturesViewportInput?: boolean;
  invalidate(): void;
}

// Returned by ctx.ui.custom() in @bastani/atomic
type ExtensionCustomComponent = Omit<Component, "handleInput"> & {
  handleInput?: (data: string) => boolean | undefined | Promise<boolean | undefined>;
  dispose?(): void;
};
```

| Member | Description |
| --- | --- |
| `render(width)` | Return an array of lines; each line **must not exceed `width`**. |
| `renderSized?(width, height)` | Optional sized renderer called instead of `render()` when a layout allocates a fixed row count. |
| `handleInput?(data)` | Receive keyboard input when focused (a focused overlay also receives mouse input before the fullscreen viewport). On `ExtensionCustomComponent`, return `true` (or a promise resolving to `true`) when consuming input; return `false`, `undefined`, or reject to let matching fullscreen viewport keys or overlay mouse events fall through to the viewport. Non-overlay focused components leave mouse input with `@bastani/atomic-tui` so transcript scrolling, scrollbar dragging, and text selection remain available. |
| `handleMouse?(event)` | Optional normalized mouse event handler on base `@bastani/atomic-tui` components. |
| `paintedRowKey?(row)` | Optional stable identity for what the last render drew on `row` so click press/release pairs match the same item across repaints. |
| `selectionTextMayChangeOnReplay?` | Set `true` when rendered text depends on private state that cannot be replayed from history. |
| `historyReplayable?` | Set `true` as an own data property on chat render components that can be discarded and recreated from saved entries without losing state. |
| `wantsKeyRelease?` | If `true`, component receives key release events (Kitty protocol). Default: `false`. |
| `capturesViewportInput?` | If `true` while focused, fullscreen viewport keys such as PageUp/PageDown go to the component instead of scrolling the transcript, as they do for a focused overlay. `SelectList`, `SettingsList`, and the editor with open autocomplete set it; wrappers can forward it. Default: `false`. |
| `invalidate()` | Clear cached render state. Called on theme changes. |
| `dispose?()` | Optional cleanup hook on `ExtensionCustomComponent`, invoked when `ctx.ui.custom()` closes or dismisses the component. |

The `@bastani/atomic-tui` `Component` type permits handlers returning `void`; Atomic treats a missing or `undefined` return as unhandled only for matching fullscreen viewport keys or mouse events deferred to a focused overlay. Components that mutate state for such inputs must return `true` so the viewport does not apply them a second time.

A focused overlay without `handleInput` lets fullscreen viewport keys and mouse wheel reports reach the transcript, so notices and progress panels do not freeze scrolling behind them.

Atomic evaluates an asynchronous handler when it settles. Only a promise resolving to `true` consumes the input; `false`, `undefined`, and rejection fall through to the viewport (going to whichever component holds focus when it settles).

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines; reapply styles per line or use `wrapTextWithAnsi()` when wrapping styled text.

Bundled MCP tools (`mcp__<server>__<tool>`) render `<server>/<tool>` in the call header before results arrive, including on resumed sessions whose server has not connected yet. Atomic resolves the label from the registered tool owner or splits an unambiguous `mcp__<server>__<tool>` name (falling back to the raw tool name when ambiguous or hash-suffixed), without opening connections or exposing tool arguments.

## Focusable interface (IME support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@bastani/atomic-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // Emit marker right before the fake cursor
    return [`> ${beforeCursor}${marker}${renderFakeCursor(atCursor)}${afterCursor}`];
  }
}
```

When a `Focusable` component has focus, TUI:
1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor only when `showHardwareCursor` is enabled

`renderFakeCursor()` wraps the cursor cell in zero-width markers that TUI draws in reverse video. When `showHardwareCursor` is enabled, TUI removes the fake cursor that directly follows `CURSOR_MARKER`, so the focused component shows only the terminal cursor. Fake cursors without a preceding `CURSOR_MARKER` stay visible. Code that renders a component outside TUI sees the markers and must strip them.

The hardware cursor remains hidden by default. This keeps the fake cursor rendering, while still positioning the hardware cursor for terminals that track IME candidate windows with hidden cursors. Some terminals require a visible hardware cursor for IME positioning; enable it with `showHardwareCursor`, `setShowHardwareCursor(true)`, or `ATOMIC_HARDWARE_CURSOR=1`. The `Editor` and `Input` built-in components already implement this interface.

### Container components with embedded inputs

When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child. Otherwise, the hardware cursor won't be positioned correctly for IME input.

```typescript
import { Container, type Focusable, Input } from "@bastani/atomic-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Focusable implementation - propagate to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position on screen.

## Keyboard input

Use `matchesKey()` for key detection:

```typescript
import { matchesKey, Key } from "@bastani/atomic-tui";

handleInput(data: string): boolean {
  if (matchesKey(data, Key.up)) {
    this.selectedIndex--;
    return true;
  } else if (matchesKey(data, Key.enter)) {
    this.onSelect?.(this.selectedIndex);
    return true;
  } else if (matchesKey(data, Key.escape)) {
    this.onCancel?.();
    return true;
  } else if (matchesKey(data, Key.ctrl("c"))) {
    // CTRL+C
    return true;
  }
  return false;
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):
- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

For custom text inputs, use `decodePrintableKey(data)` from `@bastani/atomic-tui` to decode printable Kitty CSI-u and modifyOtherKeys sequences. It returns `undefined` for plain text and non-text keys, so handle ordinary printable text separately.

For bracketed paste, remove the paste markers and pass the content to `normalizePastedText(content)` from the same package. It restores tmux-encoded control bytes, normalizes CRLF and CR to newlines, expands tabs to four spaces, and removes C0 control bytes other than newlines.

## Line width

**Critical:** Each line from `render()` must not exceed the `width` parameter.

```typescript
import { visibleWidth, truncateToWidth } from "@bastani/atomic-tui";

render(width: number): string[] {
  // Truncate long lines
  return [truncateToWidth(this.text, width)];
}
```

Utilities:
- `visibleWidth(str)`: display width (ignores ANSI codes).
- `truncateToWidth(str, width, ellipsis?)`: truncate with optional ellipsis.
- `wrapTextWithAnsi(str, width)`: word wrap preserving ANSI codes.

## Invalidation and theme changes

When the theme changes, the TUI calls `invalidate()` on all components. Clear cached render state there so the new theme takes effect.

### Why pre-baked theme strings go stale

If a component pre-bakes theme colors into strings (via `theme.fg()`, `theme.bg()`, etc.) and caches them, the cached strings contain ANSI escape codes from the old theme. Clearing the render cache alone does not update pre-baked strings stored separately.

**Wrong approach** (theme colors won't update):

```typescript
class BadComponent extends Container {
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    // Pre-baked theme colors stored in Text component
    this.content = new Text(theme.fg("accent", message), 1, 0);
    this.addChild(this.content);
  }
  // No invalidate override: parent invalidate only clears
  // child render caches, not the pre-baked content
}
```

### Rebuilding themed content on invalidate

Components that build content with theme colors must rebuild that content when `invalidate()` is called:

```typescript
class GoodComponent extends Container {
  private message: string;
  private content: Text;

  constructor(message: string) {
    super();
    this.message = message;
    this.content = new Text("", 1, 0);
    this.addChild(this.content);
    this.updateDisplay();
  }

  private updateDisplay(): void {
    // Rebuild content with current theme
    this.content.setText(theme.fg("accent", this.message));
  }

  override invalidate(): void {
    super.invalidate();  // Clear child caches
    this.updateDisplay(); // Rebuild with new theme
  }
}
```

### Pattern: rebuild on invalidate

For components with complex content:

```typescript
class ComplexComponent extends Container {
  private data: SomeData;

  constructor(data: SomeData) {
    super();
    this.data = data;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();  // Remove all children

    // Build UI with current theme
    this.addChild(new Text(theme.fg("accent", theme.bold("Title")), 1, 0));
    this.addChild(new Spacer(1));

    for (const item of this.data.items) {
      const color = item.active ? "success" : "muted";
      this.addChild(new Text(theme.fg(color, item.label), 1, 0));
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
```

### When to rebuild on invalidate

This pattern is needed when:

1. **Pre-baking theme colors:** using `theme.fg()` or `theme.bg()` to create styled strings stored in child components.
2. **Syntax highlighting:** using `highlightCode()`, which applies theme-based syntax colors.
3. **Complex layouts:** building child component trees that embed theme colors.

This pattern is not needed when:

1. **Using theme callbacks:** passing functions like `(text) => theme.fg("accent", text)` called during render.
2. **Simple containers:** grouping other components without adding themed content.
3. **Stateless render:** computing themed output fresh in every `render()` call without caching.

## Debug logging

Three environment variables capture TUI rendering diagnostics (legacy `PI_*` aliases are also accepted when the `ATOMIC_*` variable is unset):

- **`ATOMIC_TUI_WRITE_LOG`** (legacy `PI_TUI_WRITE_LOG`): captures the raw ANSI byte stream written to stdout. Pass a file path, or a directory path to write one `tui-<timestamp>-<pid>.log` file per process.
- **`ATOMIC_TUI_DEBUG=1`** (legacy `PI_TUI_DEBUG=1`): writes main-screen render snapshots to `/tmp/tui/render-<timestamp>-<random>.log`.
- **`ATOMIC_TUI_DEBUG_REDRAW=1`** (legacy `PI_TUI_DEBUG_REDRAW=1`): logs full-redraw triggers to `pi-tui-debug.log` in the TUI log directory.

Review all captured logs for sensitive content before sharing.

```bash
ATOMIC_TUI_WRITE_LOG=/tmp/tui-ansi.log atomic
```

Use these captures when reporting a terminal-rendering bug.

## Performance

Cache rendered output when possible:

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    // ... compute lines ...
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Call `invalidate()` when state changes, then `ctx.ui.requestRender()` from the extension context or `tui.requestRender()` from a `ctx.ui.custom()` factory to trigger re-render.

## Host integration

These runtime contracts pair with [Build TUI components](/tui), which provides runnable `ctx.ui.custom()` examples and common interaction patterns.

### Controlling terminal autowrap

When running inside Atomic's terminal UI, components do not write escape sequences directly to `process.stdout`. Use the optional `tui.terminal.setAutowrap` setter when a Windows overlay needs to toggle autowrap:

```typescript
await ctx.ui.custom((tui, theme, keybindings, done) => {
  tui.terminal.setAutowrap?.(false); // disable autowrap (DECAWM) on Windows terminals
  return new MyOverlay({ onClose: done });
}, { overlay: true });
```

Only autowrap control is exposed. Atomic restores the previous mode when the component hides, closes, or disposes, or if the terminal host recovers from a crash or restart. Fullscreen mode retains its baseline mouse and autowrap behavior. In custom standalone hosts, `setAutowrap` may be absent; write escape sequences directly only when your component owns the terminal directly.

### Detecting fullscreen vs. main-screen mode

`tui.mode` is `"fullscreen"` when Atomic paints on the alternate screen and `"regular"` on the main-screen fallback (used under `TERM=dumb`, in CI, or without a TTY).

Each rendered frame updates `tui.mode` to match the active terminal renderer, and Atomic invalidates the component whenever the mode changes. Before the first frame renders, `tui.mode` starts as `"regular"`, so read `tui.mode` inside `render()` rather than caching it inside the factory.

### Host-native session picker

Use `ctx.ui.hostSessionPicker(request)` for responsive session-list navigation and search, even while an extension is busy. Pass JSON-safe rows, update or close the picker, and handle selection, cancellation, and confirmed `Ctrl+D` deletion through the API.

This API is available in interactive terminal sessions and absent in headless RPC or print mode; report that limitation instead of building a fallback picker.

```typescript
const picker = ctx.ui.hostSessionPicker?.({
  sessions: rows, // HostSessionPickerRow[]: SessionInfo with createdAt/modifiedAt epoch millis
  showRenameHint: false,
  onDelete: async (path) => {
    // Deletion is extension-owned: the host keeps the row until you reply.
    const outcome = await remove(path);
    if (outcome.ok) picker!.update(rowsWithout(path));
    else picker!.error(outcome.message);
  },
});
if (!picker) throw new Error("This command requires an interactive session picker");
picker.update(await loadMoreRows()); // merge late rows into the open picker
const path = await picker.result;    // selected row's path, or undefined on cancel
```

Each row renders two lines: `name` or `firstMessage`, followed by age, message count, and summary. Set `title` and `detail` to override those lines for non-session rows such as jobs or runs; search matches `title`, `detail`, and the row's other text fields.

The request's `title` sets the picker heading (default `Resume session`). Set `variant: "runs"` (default `"sessions"`) for non-session rows so the heading defaults to `Resume run` and session-specific folder scope, named-only filter, and path keys are hidden.

Set `canDelete: false` on a row to disable deletion even when `onDelete` is present. Keep the row until deletion finishes, then remove it with `update()` or report errors with `error()` from `onDelete`; rows cannot be selected while deletion is pending. `SessionInfo` exports optional `title`, `detail`, and `canDelete` fields for synthetic rows.

### Host-native input form

Use `ctx.ui.hostInputForm(request)` for a structured inline form in the editor slot. It supports `Tab`/`Shift+Tab`, arrow keys, text editing, configured keybindings, `Enter`, `Escape`, and `Ctrl+C`. The promise rejects with `"The host could not read this input form."` if the host cannot read the form.

```typescript
try {
  const values = await ctx.ui.hostInputForm?.({
    title: "Release",
    heading: "Prepare release",    // optional panel heading label
    submitLabel: "Publish",        // optional submit button label
    fields: [
      {
        name: "version",
        type: "string",
        description: "Semantic version tag",
        placeholder: "1.2.3",
        required: true,
        initialValue: "",
      },
      { name: "channel", type: "select", choices: ["stable", "beta"], initialValue: "stable" },
    ],
  });
  if (values === undefined) return;
} catch (error) {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}
```

`HostInputFormRequest` accepts `title`, `fields`, optional `heading`, and optional `submitLabel`. Each `HostInputFormField` accepts `name`, `type` (`"string"`, `"text"`, `"number"`, `"integer"`, `"boolean"`, or `"select"`), `initialValue` (raw string), and optional `description`, `placeholder`, `required`, and `choices`. Returned values are raw strings; your extension owns parsing and domain coercion.

Every current interactive Atomic host exposes the optional capability, while headless RPC and print surfaces omit it. Keep a legacy fallback only when compatibility with older hosts is required.

Each field's header shows whether its value is ready: `✓`, or `✗` with the reason (`required`, `choose one`, `choose on or off`, `must be a whole number`, `must be a whole number within ±9007199254740991`, `must be a number`, `must be on or off`, or `not in choices`).

Integers must stay within JavaScript's safe integer range so values are not rounded. Enter on the submit button runs only when every field is ready. Booleans accept `true`, `false`, `on`, `off`, `1`, or `0`; anything else is refused rather than read as off.
