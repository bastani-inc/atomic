---
title: TUI API reference
sidebarTitle: "TUI API"
description: Component and focusable interfaces, keyboard input, line width, invalidation, logging, and performance contracts.
---

# TUI API reference

## Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): boolean | void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| Method | Description |
|--------|-------------|
| `render(width)` | Return array of strings (one per line). Each line **must not exceed `width`**. |
| `handleInput?(data)` | Receive keyboard input when the component has focus. A focused overlay also receives mouse input before the fullscreen viewport. Return `true` when it consumes input; return `false`, `undefined`, or `void` when a matching fullscreen viewport key or overlay mouse event should fall through to viewport handling. Non-overlay focused components leave mouse input with pi-tui so transcript scrolling, scrollbar interaction, and drag selection remain available. |
| `wantsKeyRelease?` | If true, component receives key release events (Kitty protocol). Default: false. |
| `invalidate()` | Clear cached render state. Called on theme changes. |

The installed pi-tui type still permits handlers that return `void`; Atomic treats a missing or `undefined` result as unhandled only for a matching fullscreen viewport key or a mouse event deferred to a focused overlay. Components that mutate state for such an input must return `true` so the viewport does not apply it a second time.

A focused overlay without `handleInput` lets fullscreen viewport keys and mouse wheel reports reach the transcript. A notice or progress panel therefore does not freeze scrolling behind it.

Atomic judges an asynchronous handler when it settles. Only a promise that resolves `true` consumes the input; `false`, `undefined`, and rejection fall through to the viewport. If focus moved while the promise was pending, input goes to the component that holds focus when it settles.

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines. If you emit multi-line text with styling, reapply styles per line or use `wrapTextWithAnsi()` so styles are preserved for each wrapped line.

Bundled MCP tools render their server name in the call header before results arrive. Direct calls use the registered server; gateway calls use the explicit target or an unambiguous match in available metadata or configured prefixes. Unresolved calls still show the tool or operation without guessing a server. This display does not open connections or expose tool arguments.

## Focusable Interface (IME Support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@earendil-works/pi-tui";

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

### Container Components with Embedded Inputs

When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child. Otherwise, the hardware cursor won't be positioned correctly for IME input.

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

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

## Keyboard Input

Use `matchesKey()` for key detection:

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

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

## Line Width

**Critical:** Each line from `render()` must not exceed the `width` parameter.

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

render(width: number): string[] {
  // Truncate long lines
  return [truncateToWidth(this.text, width)];
}
```

Utilities:
- `visibleWidth(str)` - Get display width (ignores ANSI codes)
- `truncateToWidth(str, width, ellipsis?)` - Truncate with optional ellipsis
- `wrapTextWithAnsi(str, width)` - Word wrap preserving ANSI codes

## Invalidation and Theme Changes

When the theme changes, the TUI calls `invalidate()` on all components. Clear cached render state there so the new theme takes effect.

### The Problem

If a component pre-bakes theme colors into strings (via `theme.fg()`, `theme.bg()`, etc.) and caches them, the cached strings contain ANSI escape codes from the old theme. Simply clearing the render cache isn't enough if the component stores the themed content separately.

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
  // No invalidate override - parent's invalidate only clears
  // child render caches, not the pre-baked content
}
```

### The Solution

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

### Pattern: Rebuild on Invalidate

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

### When This Matters

This pattern is needed when:

1. **Pre-baking theme colors** - Using `theme.fg()` or `theme.bg()` to create styled strings stored in child components
2. **Syntax highlighting** - Using `highlightCode()` which applies theme-based syntax colors
3. **Complex layouts** - Building child component trees that embed theme colors

This pattern is NOT needed when:

1. **Using theme callbacks** - Passing functions like `(text) => theme.fg("accent", text)` that are called during render
2. **Simple containers** - Just grouping other components without adding themed content
3. **Stateless render** - Computing themed output fresh in every `render()` call (no caching)

## Debug logging

Set `PI_TUI_WRITE_LOG` to capture the raw ANSI stream written to stdout. A directory path writes one `tui-<timestamp>-<pid>.log` file per process. Review logs for sensitive content before sharing.

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log atomic
```

Use this capture when reporting a terminal-rendering problem.

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

These runtime contracts moved here from the [TUI components guide](/tui), which keeps the runnable `ctx.ui.custom()` example and the common interaction patterns.

### Host terminal modes from an isolated component

In isolated mode, writing escape sequences to `process.stdout` does not control the host terminal. Use the optional `tui.terminal.setAutowrap` setter when a Windows overlay needs to change autowrap:

```typescript
await ctx.ui.custom((tui, theme, keybindings, done) => {
  tui.terminal.setAutowrap?.(false); // disable autowrap (DECAWM) — Windows terminals only
  return new MyOverlay({ onClose: done });
}, { overlay: true });
```

Only autowrap control is exposed. Atomic restores the mode when the component hides, closes, or is disposed, and after an engine crash or restart. Fullscreen mode retains its baseline mouse and autowrap behavior. On non-isolated hosts the setter may be absent; only write escape sequences directly when your component owns the real terminal.

### Host-native session picker

Use `ctx.ui.hostSessionPicker(request)` for responsive session-list navigation and search, including when an extension is busy. Send JSON-safe rows, update or close the picker, and handle selection, cancellation, and confirmed Ctrl+D deletion through the API.

The API is available in interactive modes, not headless RPC or print. Report that limitation rather than building a fallback picker. Callers do not need to branch on engine isolation.

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

`/workflow resume` uses this picker.

### Host-native input form

Use `ctx.ui.hostInputForm(request)` for a structured inline form in the editor slot. It supports Tab/Shift+Tab, arrows, text editing, configured keybindings, Enter, Escape, and Ctrl+C, including under engine isolation.

```typescript
const values = await ctx.ui.hostInputForm?.({
  title: "Release",
  fields: [
    { name: "version", type: "string", required: true, initialValue: "" },
    { name: "channel", type: "select", choices: ["stable", "beta"], initialValue: "stable" },
  ],
});
if (values === undefined) return; // Escape, Ctrl+C, teardown, or close
```

Field types are `string`, `text`, `number`, `integer`, `boolean`, and `select`. Initial and returned values are raw strings; the caller owns domain coercion. Every current interactive Atomic host exposes the optional capability, while headless RPC and print surfaces omit it. Keep a legacy fallback only when compatibility with older hosts is required.

`/workflow <name>` uses this input form.
