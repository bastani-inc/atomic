---
title: "@bastani/atomic-tui"
sidebarTitle: "TUI"
description: "Terminal UI framework with differential rendering, components, overlays, key handling and images."
---

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

## Features

- **Interchangeable renderers.** Shared `TUI` interface with main-screen and alternate-screen implementations.
- **Differential rendering.** Updates only changed lines or viewport rows.
- **Application-owned scrolling.** Alternate-screen viewport supports mouse, trackpad, and keyboard navigation.
- **Synchronized output.** Uses CSI 2026 for atomic, flicker-free screen updates.
- **Bracketed paste mode.** Handles large pastes with compact markers for pastes over 10 lines.
- **Component-based.** Simple `Component` interface with a `render(width)` method.
- **Theme support.** Components accept theme interfaces for styling.
- **Built-in components.** `Text`, `TruncatedText`, `Input`, `Editor`, `Markdown`, `Loader`, `CancellableLoader`, `SelectList`, `SettingsList`, `MouseRegion`, `Spacer`, `Image`, `Box`, `Container`, `VStack`, `HStack`, and `ScrollView`.
- **Inline images.** Renders images in terminals supporting Kitty or iTerm2 graphics protocols.
- **Autocomplete support.** File paths and slash commands.

## Quick start

```typescript
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  type TUI,
  TuiMainScreen,
} from "@bastani/atomic-tui";

// Create terminal and main-screen renderer
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

// Add header text
tui.addChild(new Text("Welcome to my app!"));

const editorTheme: EditorTheme = {
  borderColor: (s) => `\x1b[90m${s}\x1b[0m`,
  selectList: {
    selectedPrefix: (s) => `\x1b[36m${s}\x1b[0m`,
    selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
    description: (s) => `\x1b[90m${s}\x1b[0m`,
    scrollInfo: (s) => `\x1b[90m${s}\x1b[0m`,
    noMatch: (s) => `\x1b[90m${s}\x1b[0m`,
  },
};

const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C does not send SIGINT, so intercept it here to exit
tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c"))) {
    tui.stop();
    process.exit(0);
  }
});

// Start rendering
tui.start();
```

## Core API

### TUI interface and renderers

`TUI` is the shared interface for component management, focus, overlays, input, lifecycle, terminal queries, and rendering. Choose a concrete renderer only when constructing the application:

- `TuiMainScreen` renders into the main terminal buffer and preserves terminal scrollback.
- `TuiAltScreen` renders a fixed-height viewport in the alternate terminal buffer with application-owned scrolling. When stopped, it restores the main buffer and prints the complete final document.

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@bastani/atomic-tui";

const tui: TUI = new TuiMainScreen(terminal);
// To use an application-owned viewport in the alternate terminal buffer instead:
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Colors and terminal styles

Colors are values that can be converted or mixed before terminal rendering:

```typescript
import {
  colorToRgb,
  foregroundAnsi,
  getTerminalColorMode,
  mixColors,
  parseColor,
  rgbColor,
  styleText,
} from "@bastani/atomic-tui";

const accent = parseColor("oklch(70% 0.12 220)");
const background = parseColor("#20242a");
const foreground = mixColors(accent, background, 0.2);

const text = styleText(
  "Ready",
  { fg: foreground, bg: background, bold: true },
  getTerminalColorMode(),
);
```

`Color` is an indexed ANSI color, an sRGB color, or an OKLCH color. Every color converts to sRGB, so color math such as `mixColors()` always works. Indices 0-15 follow the user's terminal palette, so their sRGB values are approximations. `styleText()` converts colors to truecolor or 256-color output based on the requested terminal mode.

`parseColor()` also accepts OKHSL strings using either percentages (`okhsl(250 60% 55%)`) or 0 to 1 decimals (`okhsl(250 0.6 0.55)`), with an optional `deg` unit on the hue. Use `okhslColor(h, s, l)` to construct an OKHSL color in code and `colorToOkhsl()` to read any color's OKHSL channels. OKHSL saturation is relative to the sRGB gamut at that hue and lightness, so every value stays in gamut and equal saturation looks evenly colorful across hues. OKHSL colors convert to sRGB on creation.

Conversions are not cached. OKLCH colors, especially ones outside the sRGB gamut, are more expensive to convert than sRGB or indexed colors. For colors used on every render, convert once and reuse the result:

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b); // cheap to render repeatedly
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

### Alternate-screen viewport layouts

`TuiAltScreen` can render an explicit terminal-height layout. `VStack` and `HStack` allocate constrained regions, while `ScrollView` owns scrolling for one region. These semantics are intentionally unavailable on `TuiMainScreen`, where the terminal owns scrollback.

```typescript
import {
  Container,
  isViewportTUI,
  ScrollView,
  Text,
  VStack,
} from "@bastani/atomic-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([
  editor,
  new Text("status"),
]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: editorAndFooter,
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]));
}
```

Stack entries support `basis`, `grow`, `shrink`, `minSize`, `maxSize`, and responsive `visible` callbacks. Mouse-wheel input targets the scroll view under the pointer, and unused delta chains to outer scroll views by default.

The primary scroll view receives alternate-screen keyboard navigation actions and wheel input over non-scrollable regions. It can also jump between OSC 133 semantic prompt markers.

Press `Ctrl+Shift+F` to open or close the primary scroll view's bordered search panel. The panel displays the configured previous and next shortcuts with clickable arrow controls. By default, `Enter` or `Ctrl+G` moves to the next match, `Shift+Enter` or `Ctrl+Shift+G` moves to the previous match, and `Escape` closes search. Customize match highlighting through `TuiAltScreenOptions.searchMatchStyle` and `searchCurrentMatchStyle`, and arrow button styling through `searchNavigationButtonStyle` (which receives hover state).

`TuiAltScreenOptions.scrollToEndIndicator` renders a clickable label centered on the last row of a `follow: "end"` primary scroll view while scrolled away from the end. Clicking it resumes end-following.

Layout geometry is rebuilt for each requested frame. Stateful components are retained, and their existing rendered-line caches remain effective. Calling `render(width)` directly on these layout components produces an unbounded document, which is also used when alt mode restores the main screen.

### Overlays

Overlays render components on top of existing content without replacing it. Useful for dialogs, menus, and modal UI.

```typescript
// Show overlay with default options (centered, max 80 cols)
const handle = tui.showOverlay(component);

// Show overlay with custom positioning and sizing
// Values can be numbers (absolute) or percentage strings (e.g., "50%")
const handle = tui.showOverlay(component, {
  // Sizing
  width: 60,              // Fixed width in columns
  width: "80%",           // Width as percentage of terminal
  minWidth: 40,           // Minimum width floor
  maxHeight: 20,          // Maximum height in rows
  maxHeight: "50%",       // Maximum height as percentage of terminal

  // Anchor-based positioning (default: 'center')
  anchor: 'bottom-right', // Position relative to anchor point
  offsetX: 2,             // Horizontal offset from anchor
  offsetY: -1,            // Vertical offset from anchor

  // Percentage-based positioning (alternative to anchor)
  row: "25%",             // Vertical position (0%=top, 100%=bottom)
  col: "50%",             // Horizontal position (0%=left, 100%=right)

  // Absolute positioning (overrides anchor/percent)
  row: 5,                 // Exact row position
  col: 10,                // Exact column position

  // Margin from terminal edges
  margin: 2,              // All sides
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility
  visible: (termWidth, termHeight) => termWidth >= 100  // Hide on narrow terminals

  // Focus behavior
  nonCapturing: true       // Don't auto-focus when shown
});

// OverlayHandle methods
handle.hide();              // Permanently remove the overlay
handle.setHidden(true);     // Temporarily hide (can show again)
handle.setHidden(false);    // Show again after hiding
handle.isHidden();          // Check if temporarily hidden
handle.focus();             // Focus and bring to visual front
handle.unfocus();           // Release focus to normal fallback
handle.unfocus({ target: baseComponent }); // Release this overlay to a specific component
handle.unfocus({ target: null });   // Release this overlay and leave focus empty
handle.isFocused();         // Check if overlay has focus
handle.getBounds();         // Get last rendered terminal-relative bounds

handle.unfocus();
// Overlay loses focus; TUI falls back to another visible capturing overlay or the previous focus target.

handle.unfocus({ target: null });
// Overlay loses focus; no component receives input until focus is set again.

// A focused visible overlay reclaims keyboard input after temporary replacement UI
// releases focus. If you want a specific component to receive input while overlays remain
// visible, call handle.unfocus({ target: component }).

// Hide topmost overlay
tui.hideOverlay();

// Check if any visible overlay is active
tui.hasOverlay();
```

**Anchor values**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`

**Resolution order**:
1. `minWidth` is applied as a floor after width calculation
2. For position: absolute `row`/`col` > percentage `row`/`col` > `anchor`
3. `margin` clamps final position to stay within terminal bounds
4. `visible` callback controls whether overlay renders (called each frame)

### Component interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  capturesViewportInput?: boolean;
  readonly selectionTextMayChangeOnReplay?: boolean;
  invalidate(): void;
}
```

| Method | Description |
|--------|-------------|
| `render(width)` | Returns an array of strings, one per line. Each line **must not exceed `width`** or the TUI throws an error. Use `truncateToWidth()` or manual wrapping. |
| `handleInput?(data)` | Called when the component has focus and receives keyboard input. The `data` string contains raw terminal input, which may include ANSI escape sequences. |
| `handleMouse?(event)` | Called by `TuiAltScreen` for normalized pointer input targeted at the component. |
| `capturesViewportInput?` | When `true` on the focused component, `TuiAltScreen` forwards viewport scrolling and prompt-jump keys (`tui.altScreen.*` except search) to the component instead of scrolling the viewport, matching focused overlays. `SelectList`, `SettingsList`, and `Editor` (while autocomplete is open) set this so PageUp and PageDown move selection. Only the focused component is checked, so a wrapper forwarding input to a list must mirror this flag. Use `getSelectPageIndex(keybindings, data, selectedIndex, itemCount, pageSize)` to compute page movement. |
| `selectionTextMayChangeOnReplay` | Set to `true` on a `WindowedContainer` component whose text cannot be recreated from saved input. Fullscreen selection then keeps the selected fragments in memory until dismissed or replaced. While the component remains on screen, copying uses its latest painted text; if evicted and recreated, repeated copies keep the original selection. Leave unset for deterministic rows. |
| `invalidate()` | Required. Clears cached render state so the next `render()` rebuilds from scratch. Stateless components can leave the body empty. |

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line, so styles do not carry across lines. Reapply styles per line or use `wrapTextWithAnsi()` to preserve styling across wrapped lines.

### Mouse input

`TuiAltScreen` normalizes SGR mouse input and hit-tests components and overlays. Events contain component-local `x` and `y`, absolute `screenX` and `screenY`, bounds, button, modifiers, click count, and wheel delta. `TuiMainScreen` does not capture mouse input because the terminal owns its scrollback.

`isPointerIdle()` returns `true` while no text selection, press, drag, pending single click, or search depends on row positions. To observe changes without polling, `onViewportChange(listener)` invokes the listener at most once per event-loop turn after each input, deferred single click, or painted frame, and returns an unsubscribe function.

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

Returning `handled` suppresses renderer fallback behavior. `capture` routes subsequent drag and release events to the same component, and `focus` requests keyboard focus. The optional `render` flag controls repainting: press, click, drag, and wheel repaint by default, while move and release do not. Set `render: true` when hover state changes visibly, or `render: false` for a handled no-op. Render requests coalesce and output remains differential.

Each click carries `clickCount` (`1`, `2`, or `3`). When a single click should perform an action that a double-click must not (such as expanding a block whose text a double-click would select), return `{ handled: true, whenSingleClick: () => toggle() }` instead of running it immediately. `TuiAltScreen` invokes `whenSingleClick` once `MULTI_CLICK_INTERVAL_MS` (500 ms) passes after the press with no second press on the same spot, then repaints.

A second press at that location cancels the deferred action even if the button stays held past the deadline, and the same timing applies when the component handles the press itself. Pass `onSingleClickCancel` alongside `whenSingleClick` to release any reserved resources on cancellation. Hiding or removing an overlay cancels its pending single-click action even if you show it again before a repaint.

A held single click does not trigger `whenSingleClick` on release, though a control that claimed the press still receives button-up. When a double- or triple-click also selects text, a row that did not take the press still decides whether to handle the click or let the terminal copy the selection.

Capture the clicked item's identity rather than its screen coordinates because items can move before the callback runs. Read mutable state when the action executes rather than when the click arrives: two fast clicks on different rows are both single clicks, so the first may run right before the second.

Unhandled gestures retain alternate-screen defaults: wheel input scrolls the nearest `ScrollView` and chains unused delta, primary-button drags select text, OSC 8 links open before parent click handlers, and unhandled right-click runs configured paste behavior. Click events fire only when press and release complete without a drag.

Use `MouseRegion` to attach mouse handling without changing a component's rendering:

```typescript
const collapsible = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

`Container` and `Box` route events to nested children using geometry recorded during the last frame, so pointer motion does not rerender children just to hit-test them. Explicit `VStack`, `HStack`, and `ScrollView` layouts use the alternate-screen layout frame directly.

### Focusable interface (IME support)

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

  invalidate(): void {}
}
```

When a `Focusable` component has focus, TUI:
1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor only when `showHardwareCursor` is enabled

`renderFakeCursor()` wraps the cursor cell in zero-width markers. TUI renders them as reverse video. When `showHardwareCursor` is enabled, TUI removes the fake cursor that directly follows `CURSOR_MARKER`, so the focused component shows only the terminal cursor. Fake cursors without a preceding `CURSOR_MARKER` stay visible.

The hardware cursor remains hidden by default. This keeps the fake cursor rendering, while still positioning the hardware cursor for terminals that track IME candidate windows with hidden cursors. Some terminals require a visible hardware cursor for IME positioning; enable it with the renderer constructor's `showHardwareCursor` argument or `setShowHardwareCursor(true)`. The `Editor` and `Input` built-in components already implement this interface.

**Container components with embedded inputs:** When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child:

```typescript
import { Container, type Focusable, Input } from "@bastani/atomic-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Propagate focus to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean { return this._focused; }
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

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position.

## Built-in components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // Change background dynamically
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
  "Hello World",                  // text content
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (default: 0)
  0   // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

Clicking positions the cursor and gives the input keyboard focus in alternate-screen mode.

**Key bindings:**

- `Enter`: Submit
- `Ctrl+A` / `Ctrl+E`: Line start or end
- `Ctrl+W` or `Alt+Backspace`: Delete word backwards
- `Ctrl+U`: Delete to start of line
- `Ctrl+K`: Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` or `Alt+Left` / `Alt+Right`: Word navigation
- Arrow keys, `Backspace`, and `Delete`: Standard cursor and character editing

### Editor

Multi-line text editor with autocomplete, file completion, paste handling, and vertical scrolling when content exceeds terminal height.

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
  autocompleteHint?: (entries: readonly EditorAutocompleteHintEntry[], width: number) => string;
}

interface EditorOptions {
  paddingX?: number;                // Horizontal padding (default: 0)
  autocompleteMaxVisible?: number;  // Maximum visible autocomplete rows
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
editor.getHistory();
```

`getHistory()` returns past prompts, newest first. `autocompleteHint` draws one line below an open completion menu. Its entries name the available actions and labels, with `essential` marking actions to keep on narrow terminals. Resolve `actions` through the active keybindings; when `resolvedKeys` is present, use those keys instead (including an empty array, because `CustomEditor` supplies only keys that reach the menu after app shortcuts). Without `autocompleteHint`, the editor draws no menu hint.

**Features:**

- Click-to-position cursor and clickable autocomplete rows in alternate-screen mode
- Multi-line editing with word wrap
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (more than 10 lines creates a `[paste #1 +50 lines]` marker)
- Horizontal lines above and below the editor
- Fake cursor rendering (hidden real cursor)

**Key bindings:**

- `Enter`: Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter`: New line (terminal-dependent; `Alt+Enter` is the most reliable)
- `Tab`: Autocomplete
- `Ctrl+K`: Delete to end of line
- `Ctrl+U`: Delete to start of line
- `Ctrl+W` or `Alt+Backspace`: Delete word backwards
- `Alt+D` or `Alt+Delete`: Delete word forwards
- `Ctrl+A` / `Ctrl+E`: Line start or end
- `Ctrl+]`: Jump forward to character (awaits next keypress, then moves cursor to first occurrence)
- `Ctrl+Alt+]`: Jump backward to character
- Arrow keys, `Backspace`, and `Delete`: Standard cursor and character editing

### Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

**Features:**
- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Loading..."                      // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Working..."                      // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**

- `signal: AbortSignal`: Aborted when the user presses `Escape`.
- `aborted: boolean`: Whether the loader was aborted.
- `onAbort?: () => void`: Callback invoked when the user presses `Escape`.

### SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

**Controls:**
- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Select a row
- Arrow keys: Navigate
- Enter: Select
- Escape: Cancel

### SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // If provided, Enter/Space cycles through these
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**Controls:**
- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Activate a row
- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals.

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64-encoded image data
  "image/png",      // MIME type
  theme,            // ImageTheme
  options           // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.

#### Alternate-screen image compatibility

`TuiAltScreen` supports inline images and partial viewport cropping in terminals that implement the Kitty graphics protocol, including Kitty and Ghostty. iTerm2's inline-image protocol does not provide operations to delete an existing placement or crop its source while scrolling. To prevent stale images from remaining over repainted content, `TuiAltScreen` renders image components as text placeholders in iTerm2. `TuiMainScreen` continues to render iTerm2 inline images normally.

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@bastani/atomic-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

A lookup triggered before the editor received a provider (typing `/`, an `@` token, a trigger character, or pressing `Tab`) starts once `setAutocompleteProvider()` attaches a provider, provided the prompt text and cursor have not moved. Any intervening edit, cursor move, undo, history step, `Escape`, or cursor-placing click cancels that pending lookup.

`snapshotDraft()` captures any pending lookup, and `restoreDraft()` resumes it immediately or when the target editor receives a provider. `setTextAsTyped(text)` sets the prompt text like `setText(text)` and starts whatever lookup typing its last character would trigger.

Replacing the built-in editor's provider normally closes any open menu. Call `editor.setAutocompleteProvider(provider, { preserveSelection: true })` to keep the current menu while switching providers for future lookups. An open menu keeps the provider that produced its rows. Any in-flight lookup or empty lookup for the current text retries against the new provider (preserving whether the user pressed `Tab`), and a failed lookup leaves the prompt intact so later lookups still run.

Add `refreshMenu: true` to query the new provider for any open menu (commands, arguments, `@` files, or a `Tab` file menu) where the user has not chosen a row. A non-empty answer for the same text replaces the rows and selects an exact match. User selection, thrown or rejected lookups, empty answers, or answers arriving after the text changed leave the menu unchanged, and background refreshes never delay the editor's own lookups. Atomic forwards the same options to extension-provided editors' `setAutocompleteProvider()`, which may ignore them.

Lookup results appear on the next render. Until then, menu keys (`Up`, `Down`, `Page Up`, `Page Down`, `Tab`, `Enter`, `Escape`) and pointer clicks act on the drawn menu while it matches the prompt text; once the user types further, keys act on the answer for the new text. Clicks on rows that changed since they were drawn select nothing. A provider that throws or rejects returns no suggestions, and a provider that ignores its abort signal holds the next lookup for at most 100 ms.

**Features:**

- Type `/` to see slash commands
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefixes
- Filters to attachable files for the `@` prefix

## Key detection

Use `matchesKey()` with the `Key` helper for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import { matchesKey, Key } from "@bastani/atomic-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):

- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

## Rendering modes

`TuiMainScreen` uses three rendering strategies:

1. **First render.** Output all lines without clearing scrollback.
2. **Width changed or change above viewport.** Clear screen and fully re-render.
3. **Normal update.** Move the cursor to the first changed line, clear to the end, and render changed lines.

`TuiAltScreen` owns a terminal-height viewport. Without an explicit layout root it keeps single-document scrolling; with `setLayoutRoot()`, `VStack`, `HStack`, and nested `ScrollView` components allocate fixed regions and scroll constrained regions independently. It updates changed rows in place, follows streaming output at the bottom, and holds a manual scroll position while content grows.

Mouse-wheel and keyboard navigation scroll without altering terminal scrollback, including jumps between OSC 133 semantic prompt markers. Scrollbars support hover expansion, thumb dragging, and track-click jumping. Clicking an OSC 8 hyperlink invokes the configured `openUrl` handler.

Dragging with the primary mouse button selects text and, unless `TuiAltScreenOptions.copyOnSelect` is `false`, copies it with OSC 52. Holding a drag at a scroll view's top or bottom edge auto-scrolls and extends the selection into off-screen content. Kitty images support vertical viewport cropping, while iTerm2 inline images render as text placeholders because the iTerm2 protocol cannot delete or crop placements during viewport repainting.

Both renderers wrap updates in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Terminal interface

The TUI works with any object implementing the `Terminal` interface:

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  get kittyProtocolActive(): boolean;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(title: string): void;
  setProgress(active: boolean): void;
  setProgramStatus(status: ProgramStatus): void;
}
```

**Built-in implementation:** `ProcessTerminal`, which reads from `process.stdin` and writes to `process.stdout`. For automated tests, provide a mock or headless implementation of `Terminal`.

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";

// Get visible width of string (ignoring ANSI codes)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// Wrap text to width (preserving ANSI codes across line breaks)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## Creating custom components

When creating custom components, **each line returned by `render()` must not exceed the `width` parameter**. The TUI throws an error if any line is wider than the terminal.

### Handling input

Use `matchesKey()` with the `Key` helper for keyboard input:

```typescript
import { matchesKey, Key, truncateToWidth } from "@bastani/atomic-tui";
import type { Component } from "@bastani/atomic-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }

  invalidate(): void {}
}
```

### Handling line width

Use the provided utilities so lines stay within `width`:

```typescript
import { visibleWidth, truncateToWidth } from "@bastani/atomic-tui";
import type { Component } from "@bastani/atomic-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // Option 1: Truncate long lines
    return [truncateToWidth(this.text, width)];

    // Option 2: Check and pad to exact width
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // Pad to exact width (optional, for backgrounds)
    return [line + " ".repeat(width - visible)];
  }

  invalidate(): void {}
}
```

### ANSI code considerations

Both `visibleWidth()` and `truncateToWidth()` handle ANSI escape codes:

- `visibleWidth()` ignores ANSI codes when calculating display width.
- `truncateToWidth()` preserves ANSI codes and closes active styles when truncating.

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." with proper reset
```

### Caching

Cache rendered lines and rebuild only when `width` changes or `invalidate()` runs:

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

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

## Example

A self-contained alternate-screen chat interface combining `ScrollView`, `Markdown`, `Loader`, `Spacer`, `Editor`, and `CombinedAutocompleteProvider`:

```typescript
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type EditorTheme,
  Key,
  Loader,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
} from "@bastani/atomic-tui";

const plain = (s: string) => s;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: cyan,
  codeBlock: plain,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: (s) => `\x1b[3m${s}\x1b[0m`,
  strikethrough: (s) => `\x1b[9m${s}\x1b[0m`,
  underline: (s) => `\x1b[4m${s}\x1b[0m`,
};

const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

const tui = new TuiAltScreen(new ProcessTerminal());
const messages = new Container();
messages.addChild(new Markdown("# Chat\nType a message or `/clear`. Press `Ctrl+C` to exit.", 1, 0, markdownTheme));

const editor = new Editor(tui, editorTheme);
editor.setAutocompleteProvider(
  new CombinedAutocompleteProvider(
    [{ name: "clear", description: "Clear transcript" }],
    process.cwd(),
  ),
);

editor.onSubmit = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed === "/clear") {
    messages.clear();
    tui.requestRender();
    return;
  }

  messages.addChild(new Spacer(1));
  messages.addChild(new Text(`> ${trimmed}`, 1, 0));

  const loader = new Loader(tui, cyan, dim, "Thinking...");
  messages.addChild(loader);
  loader.start();

  setTimeout(() => {
    loader.stop();
    messages.removeChild(loader);
    messages.addChild(new Markdown(`Echo: **${trimmed}**`, 1, 0, markdownTheme));
    tui.requestRender();
  }, 400);
};

tui.setLayoutRoot(
  new VStack([
    { component: new ScrollView(messages, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
    { component: editor, basis: "auto", shrink: 1, minSize: 1 },
  ]),
);
tui.setFocus(editor);

tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c"))) {
    tui.stop();
    process.exit(0);
  }
});

tui.start();
```
