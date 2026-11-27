---
title: "@bastani/atomic-tui"
sidebarTitle: "@bastani/atomic-tui"
description: "Terminal UI framework with differential rendering, alternate-screen viewports, components, overlays, key handling, and images."
---

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications (requires Node.js 24.20+). See [Standalone libraries](/libraries) for all standalone packages, or [Build TUI components](/tui) when writing Atomic extensions.

## Installation

```bash
npm install @bastani/atomic-tui
```

## Features

- **Interchangeable renderers:** Shared `TUI` interface with main-screen (`TuiMainScreen`) and alternate-screen (`TuiAltScreen`) implementations.
- **Differential rendering & synchronized output:** Updates only changed lines or viewport rows inside CSI 2026 synchronized frames.
- **Application-owned scrolling:** Alternate-screen viewports support mouse, trackpad, scrollbar dragging, and keyboard navigation.
- **Bracketed paste & autocomplete:** Compact paste markers for pastes over 10 lines plus slash-command and file-path completion.
- **Built-in components:** `Text`, `TruncatedText`, `Input`, `Editor`, `Markdown`, `Loader`, `CancellableLoader`, `SelectList`, `SettingsList`, `MouseRegion`, `Spacer`, `Image`, `Box`, `Container`, `WindowedContainer`, `VStack`, `HStack`, and `ScrollView`.
- **Inline images:** Renders PNG, JPEG, GIF, and WebP images in terminals supporting Kitty or iTerm2 graphics protocols.

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

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

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

// In raw mode Ctrl+C does not send SIGINT, so intercept it to exit
tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c"))) {
    tui.stop();
    process.exit(0);
  }
});

tui.start();
```

## Core API

### TUI interface and renderers

`TUI` is the shared interface for component management, focus, overlays, input, lifecycle, terminal queries, and rendering. Choose a concrete renderer when constructing the app:

- `new TuiMainScreen(terminal, showHardwareCursor?, logDirectory?)` renders into the main terminal buffer and preserves terminal scrollback.
- `new TuiAltScreen(terminal, showHardwareCursor?, logDirectory?, options?)` renders a fixed-height viewport in the alternate terminal buffer with application-owned scrolling. When stopped, it restores the main buffer and prints the complete final document.

<Note>
In `new TuiAltScreen(terminal, showHardwareCursor?, logDirectory?, options?)`, `options` (`TuiAltScreenOptions`) is the **fourth** positional argument—pass `undefined` for `showHardwareCursor` and `logDirectory` when you want defaults:

```typescript
const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: true, wheelScrollLines: "auto" });
```
</Note>

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@bastani/atomic-tui";

const tui: TUI = new TuiMainScreen(terminal);
// Or alternate screen with options:
// const tui: TUI = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: true });

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender();

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Debug logging and escape timing

Four environment variables control standalone TUI diagnostics and escape-key timing (legacy `PI_*` aliases work when `ATOMIC_*` is unset):

| Variable | Behavior |
| --- | --- |
| `ATOMIC_TUI_WRITE_LOG` | Captures raw ANSI bytes written to stdout (file path, or a directory path for one `tui-<timestamp>-<pid>.log` per process). |
| `ATOMIC_TUI_DEBUG=1` | Writes main-screen render snapshots to `/tmp/tui/render-<timestamp>-<random>.log` (`TuiMainScreen` only, not `TuiAltScreen`). |
| `ATOMIC_TUI_DEBUG_REDRAW=1` | Logs main-screen full-redraw triggers to `<logDirectory>/pi-tui-debug.log` (`TuiMainScreen` only; requires `logDirectory` in the constructor; the `pi-` filename prefix is intentional). |
| `ATOMIC_TUI_ESC_TIMEOUT` | Wait in milliseconds after a lone `ESC` byte before dispatching `Escape` instead of a legacy `Alt`/escape sequence. Defaults to `10` ms locally, `100` ms when `SSH_CONNECTION` or `SSH_TTY` is set. |

### Colors and terminal styles

Colors are values that can be parsed, converted, or mixed before rendering:

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

`Color` represents an indexed ANSI color, an sRGB color, or an OKLCH color. Every color converts to sRGB so `mixColors()` always works (ANSI indices `0`–`15` approximate the user's terminal palette). `styleText()` emits truecolor or 256-color ANSI codes based on the requested terminal mode.

`parseColor()` also accepts OKHSL strings (`okhsl(250 60% 55%)` or `okhsl(250 0.6 0.55)`, with an optional `deg` unit on hue). Use `okhslColor(h, s, l)` and `colorToOkhsl()` in code; OKHSL colors stay inside the sRGB gamut and convert to sRGB on creation.

Because OKLCH conversions are not cached, convert repeated colors once and reuse the resulting sRGB or ANSI sequence:

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b);
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

### Alternate-screen viewport layouts

`TuiAltScreen` supports explicit terminal-height layouts built with `VStack`, `HStack`, and `ScrollView` (unavailable on `TuiMainScreen`, where the terminal owns scrollback):

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

const editorAndFooter = new VStack([editor, new Text("status")]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(
    new VStack([
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
    ]),
  );
}
```

Stack entries accept `basis`, `grow`, `shrink`, `minSize`, `maxSize`, and responsive `visible` callbacks. Mouse-wheel input targets the scroll view under the pointer and chains unused delta to outer scroll views by default. The primary scroll view handles alternate-screen keyboard scrolling, OSC 133 prompt jumps, and built-in transcript search (`Ctrl+Shift+F`, with `Enter`/`Ctrl+G` next, `Shift+Enter`/`Ctrl+Shift+G` previous, `Escape` close).

**`TuiAltScreenOptions` summary:**

| Option | Type | Description |
| --- | --- | --- |
| `wheelScrollLines` | `number \| "auto"` | Logical lines moved per wheel event (default `1`; `"auto"` accelerates fast spins; Alt+wheel moves 5x). |
| `mouse` | `boolean` | Capture mouse events for scrolling and application-owned text selection (default `true`). |
| `copyOnSelect` | `boolean` | Automatically copy dragged selections on mouse release (default `true`). |
| `copySelection` | `(text: string) => Promise<boolean \| string>` | Custom system clipboard writer; falls back to OSC 52 when omitted. |
| `openUrl` | `(url: string) => void` | Handler invoked when clicking an OSC 8 hyperlink. |
| `onRightClickPaste` | `() => void` | Secondary-button paste handler (Windows). |
| `searchMatchStyle` / `searchCurrentMatchStyle` | `(text: string) => string` | Highlighters for transcript search matches and the active match. |
| `searchNavigationButtonStyle` | `(text: string, hovered: boolean) => string` | Styling callback for the search panel's previous/next buttons. |
| `scrollToEndIndicator` | `() => string` | Clickable jump-to-end indicator shown when scrolled away from the bottom of a `follow: "end"` primary scroll view. |
| `scrollPinnedPrompt` | `{ isPrompt, render }` | Pins matching prompt rows at the top of the scroll viewport. |

Layout geometry rebuilds per frame while retaining stateful components and their rendered-line caches. Calling `render(width)` directly on layout components produces an unbounded document (also used when `TuiAltScreen` stops and prints to the main buffer).

### Overlays

Overlays render floating components on top of existing content:

```typescript
const handle = tui.showOverlay(component, {
  // Sizing: number or percentage string
  width: "80%",
  minWidth: 40,
  maxHeight: "50%",

  // Positioning: absolute row/col > percentage row/col > anchor (default "center")
  anchor: "bottom-right", // center, top-left, top-right, bottom-left, bottom-right, top-center, bottom-center, left-center, right-center
  offsetX: 2,
  offsetY: -1,

  // Margin clamping from terminal edges
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility evaluated each frame
  visible: (termWidth, _termHeight) => termWidth >= 100,

  // Set true to avoid auto-focusing when shown
  nonCapturing: false,
});

handle.hide();                             // Permanently remove
handle.setHidden(true);                    // Temporarily hide
handle.isHidden();
handle.focus();                            // Focus and bring to front
handle.unfocus();                          // Release focus to fallback target
handle.unfocus({ target: baseComponent }); // Release focus to a specific component (or null)
handle.isFocused();
handle.getBounds();                        // Last rendered terminal-relative bounds

tui.hideOverlay(); // Hide topmost overlay
tui.hasOverlay();  // Check if any visible overlay is active
```

A focused visible overlay reclaims input after temporary non-overlay replacement UI closes; use `handle.unfocus({ target })` to send input elsewhere while keeping the overlay visible.

### Component interface

All components implement:

```typescript
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
```

| Member | Description |
| --- | --- |
| `render(width)` | Returns one string per line. Each line **must not exceed `width`** or the TUI throws an error; use `truncateToWidth()` or `wrapTextWithAnsi()`. |
| `renderSized?(width, height)` | Optional sized renderer invoked instead of `render()` when a layout slot allocates a fixed row height. |
| `handleInput?(data)` | Receives raw keyboard input (including ANSI/Kitty escape sequences) while focused. |
| `handleMouse?(event)` | Receives normalized pointer input targeted at the component in `TuiAltScreen`. |
| `paintedRowKey?(row)` | Optional stable identity for what the last render drew on `row`, so press and release become a click only when both hit the same item across repaints. |
| `selectionTextMayChangeOnReplay` | Set `true` on a `WindowedContainer` child whose text cannot be recreated from saved input, keeping selected fragments in memory until dismissed. |
| `historyReplayable` | Set `true` on a component that can be evicted offscreen and recreated from saved input without losing state. |
| `wantsKeyRelease` | When `true`, receives Kitty key release events in `handleInput()`. Default: `false`. |
| `capturesViewportInput` | When `true` on the focused component, `TuiAltScreen` forwards viewport navigation keys (`tui.altScreen.pageUp`, `pageDown`, `halfPageUp`, `halfPageDown`, `lineUp`, `lineDown`, `previousPrompt`, `nextPrompt`, `top`, `bottom`) to the component instead of scrolling the viewport (search keys `tui.altScreen.search*` remain handled by `TuiAltScreen`). `SelectList`, `SettingsList`, and `Editor` (while autocomplete is open) set this flag. |
| `invalidate()` | Required. Clears cached render state so the next `render()` rebuilds cleanly. |

For selectable lists that set `capturesViewportInput = true`, use `getSelectPageIndex()` to compute page jumps cleanly:

```typescript
import { getKeybindings, getSelectPageIndex } from "@bastani/atomic-tui";

// Returns the next clamped index on tui.select.pageUp / tui.select.pageDown,
// or undefined for any other key (returns 0 on an empty list, so guard itemCount > 0).
const nextIndex = getSelectPageIndex(getKeybindings(), data, selectedIndex, items.length, maxVisible);
if (nextIndex !== undefined && items.length > 0) {
  selectedIndex = nextIndex;
}
```

The TUI appends a full SGR reset and OSC 8 reset at the end of every rendered line, so styles never leak across lines; reapply styles per line or use `wrapTextWithAnsi()`.

### Mouse input

`TuiAltScreen` normalizes SGR mouse input and hit-tests components and overlays (`TuiMainScreen` does not capture mouse input). Events include component-local `x`/`y`, absolute `screenX`/`screenY`, bounds, button, modifiers, `clickCount` (`1`, `2`, or `3`), and wheel delta.

`isPointerIdle()` returns `true` when no selection, press, drag, pending single click, or search depends on row positions. `onViewportChange(listener)` fires at most once per event-loop turn after input, deferred clicks, or painted frames, and returns an unsubscribe function.

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

- `handled`: suppresses renderer fallback behavior.
- `capture`: routes subsequent drag and release events to the same component.
- `focus`: requests keyboard focus.
- `render`: overrides default repainting (press, click, drag, and wheel repaint by default; move and release do not).
- `whenSingleClick` / `onSingleClickCancel`: defers a single-click action until `MULTI_CLICK_INTERVAL_MS` (`500` ms) elapses without a second press at the same spot (so double-clicks can select text without triggering single-click toggles). Capture item identity rather than screen coordinates and read mutable state inside the callback; hiding or removing an overlay cancels its pending single click.

Unhandled gestures keep alternate-screen defaults: wheel scrolls the nearest `ScrollView` (chaining unused delta), primary drags select text, OSC 8 links open before parent click handlers, and right-click runs `onRightClickPaste`. Wrap any component with `new MouseRegion(content, handler)` to add mouse handling without changing its rendering.

### Focusable interface (IME support)

Components displaying a text cursor that need IME (Input Method Editor) candidate-window positioning should implement `Focusable`:

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@bastani/atomic-tui";

class MyInput implements Component, Focusable {
  focused = false; // Set by TUI when focus changes

  render(_width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${beforeCursor}${marker}${renderFakeCursor(atCursor)}${afterCursor}`];
  }

  invalidate(): void {}
}
```

When a `Focusable` component has focus, TUI locates `CURSOR_MARKER`, positions the hardware terminal cursor there, and shows the hardware cursor only when `showHardwareCursor` is enabled (hiding the directly following `renderFakeCursor()` reverse-video cell so only the real cursor renders). Built-in `Editor` and `Input` implement `Focusable` automatically.

Container components wrapping an `Input` or `Editor` must also implement `Focusable` and propagate `focused` to their child input so IME candidate windows position accurately:

```typescript
import { Container, type Focusable, Input } from "@bastani/atomic-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput = new Input();
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
    this.addChild(this.searchInput);
  }
}
```

## Built-in components

### Container

Groups child components vertically:

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### WindowedContainer

Virtualized vertical container for large transcripts inside `ScrollView`. Keeps only visible children mounted in memory and materializes or evicts off-screen rows on demand while respecting `historyReplayable` and `selectionTextMayChangeOnReplay`.

Key supporting contracts exported alongside `WindowedContainer`:

| Type | Purpose |
| --- | --- |
| `HistorySource` | `{ readonly last: number; read(from, to, width): Promise<readonly HistoryRowsBlock[]> }` — supplies unmounted saved rows on demand (for scrolling and fullscreen copy across evicted history). |
| `WindowRequest` | `{ width, top, moved?, exact?, height, followEnd, requestRender }` — viewport request passed by `ScrollView` to compute a visible row window. |
| `WindowRows` | Virtualized row accessor (`length`, `at(index)`, plus optional row tracking and history inspection hooks) returned for a layout frame. |
| `WindowLayout` | Extends `WindowRows` with the resolved `top` offset for the frame. |

### Box

Container applying padding and optional background styling to all children:

```typescript
import { Box, getTerminalColorMode, parseColor, styleText, Text } from "@bastani/atomic-tui";

const mode = getTerminalColorMode();
const bgGray = (s: string) => styleText(s, { bg: parseColor("#30343c") }, mode);
const bgBlue = (s: string) => styleText(s, { bg: parseColor("#1e3a5f") }, mode);

const box = new Box(
  1,      // paddingX (default: 1)
  1,      // paddingY (default: 1)
  bgGray, // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn(bgBlue); // update background dynamically
```

### Text

Multi-line text with word wrapping, padding, and optional background function:

```typescript
import { getTerminalColorMode, parseColor, styleText, Text } from "@bastani/atomic-tui";

const mode = getTerminalColorMode();
const bgGray = (s: string) => styleText(s, { bg: parseColor("#30343c") }, mode);
const bgBlue = (s: string) => styleText(s, { bg: parseColor("#1e3a5f") }, mode);

const text = new Text("Hello World", 1, 1, bgGray);
text.setText("Updated text");
text.setCustomBgFn(bgBlue);
```

### TruncatedText

Single-line text that truncates to viewport width (useful for headers and status bars):

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0, // paddingX (default: 0)
  0, // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling (click to position cursor and focus in `TuiAltScreen`):

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

Supports `Enter` (submit), `Ctrl+A`/`Ctrl+E` (line start/end), `Ctrl+W`/`Alt+Backspace` (delete word back), `Ctrl+U`/`Ctrl+K` (delete to start/end), `Ctrl+Left`/`Right` or `Alt+Left`/`Right` (word jump), and standard cursor editing.

### Editor

Multi-line text editor with autocomplete, paste markers (over 10 lines), history, click-to-position cursor, and height-aware scrolling:

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
  autocompleteHint?: (entries: readonly EditorAutocompleteHintEntry[], width: number) => string;
}

interface EditorOptions {
  paddingX?: number;               // Horizontal padding (default: 0)
  autocompleteMaxVisible?: number; // Maximum visible autocomplete rows
}

const editor = new Editor(tui, theme, options?);
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true;
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => `\x1b[34m${s}\x1b[0m`; // update border color dynamically
editor.setPaddingX(1);
editor.getPaddingX();
editor.getHistory(); // past prompts, newest first
```

`autocompleteHint` draws one line below an open completion menu, using `resolvedKeys` when provided (including an empty array when outer shortcuts shadow keys) and keeping `essential` entries on narrow terminals.

Supports `Enter` (submit), `Shift+Enter`/`Ctrl+Enter`/`Alt+Enter` (newline), `Tab` (autocomplete), `Ctrl+A`/`Ctrl+E`, `Ctrl+U`/`Ctrl+K`, `Ctrl+W`/`Alt+Backspace`, `Alt+D`/`Alt+Delete`, and `Ctrl+]`/`Ctrl+Alt+]` (jump forward/backward to next typed character).

### Markdown

Renders Markdown with optional syntax highlighting, LaTeX math rendering, caching, and per-instance options:

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
  codeBlockIndent?: string; // Prefix per rendered code block line (default: "  ")
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

interface MarkdownOptions {
  hyperlinks?: boolean;                 // Override OSC 8 hyperlink emission for this instance
  images?: boolean;                     // Override inline image rendering for this instance
  preserveOrderedListMarkers?: boolean; // Keep original ordered list numbering
  preserveBackslashEscapes?: boolean;   // Keep backslash-escaped punctuation verbatim
  transform?: (markdown: string, availableWidth: number) => string; // Pre-parse transform
  renderLatex?: boolean;                // Render supported LaTeX math as Unicode (default: true)
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,            // paddingX
  1,            // paddingY
  theme,        // MarkdownTheme
  defaultStyle, // optional DefaultTextStyle
  options,      // optional MarkdownOptions
);
md.setText("Updated markdown");
```

HTML tags render as plain text, and top-level blocks cache syntax-highlighted lines across resizes until `invalidate()`.

### Loader and CancellableLoader

Animated spinners (`CancellableLoader` adds `Escape` cancellation and an `AbortSignal`):

```typescript
import { CancellableLoader, Loader } from "@bastani/atomic-tui";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

const loader = new Loader(tui, cyan, gray, "Loading...");
loader.start();
loader.setMessage("Still loading...");
loader.stop();

const cancellable = new CancellableLoader(tui, cyan, gray, "Working...");
cancellable.onAbort = () => done(null); // triggered on Escape
// cancellable.signal: AbortSignal, cancellable.aborted: boolean
doAsyncWork(cancellable.signal).then(done);
```

### SelectList

Interactive selection list with keyboard and mouse navigation:

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
  5,     // maxVisible
  theme, // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt");
```

### SettingsList

Settings panel with value cycling and submenus:

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
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
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (_val, _done) => modelSelector },
  ],
  10,
  theme,
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled"),
);
settings.updateValue("theme", "light");
```

### Spacer

Empty lines for vertical spacing:

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders PNG, JPEG, GIF, and WebP images inline in Kitty or iTerm2-capable terminals (automatically parsing header dimensions), falling back to a text placeholder elsewhere:

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(base64Data, "image/png", theme, options);
tui.addChild(image);
```

<Note>
**Alternate-screen image compatibility:** `TuiAltScreen` renders inline Kitty images with partial viewport cropping (Kitty, Ghostty). Because the iTerm2 inline-image protocol cannot delete or crop placements during scrolling, `TuiAltScreen` renders text placeholders in iTerm2, while `TuiMainScreen` renders iTerm2 inline images normally.
</Note>

## Autocomplete

`CombinedAutocompleteProvider` provides slash-command (`/`) and file-path (`Tab`, `~/`, `./`, `../`, `@`) completion:

```typescript
import { CombinedAutocompleteProvider } from "@bastani/atomic-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd(), // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

- **Pending lookups & drafts:** A lookup triggered before a provider attaches runs automatically once `setAutocompleteProvider()` is called (unless canceled by edits, cursor moves, undo, history, or `Escape`). `snapshotDraft()` / `restoreDraft()` preserve pending lookups across editor swaps, and `setTextAsTyped(text)` inserts text while triggering any completion its last character would start.
- **Swapping providers cleanly:** Pass `{ preserveSelection: true }` to `setAutocompleteProvider()` to keep an open menu active while updating the provider for future lookups, and add `refreshMenu: true` to silently re-query open menus where the user has not chosen a row yet.
- **Error isolation:** Lookups that throw or reject yield no suggestions; providers that ignore their abort signal hold the next lookup for at most 100 ms.

## Key detection

Use `matchesKey()` with `Key` helpers (or string literals) to detect keyboard input across legacy terminals, xterm `modifyOtherKeys`, and the Kitty keyboard protocol:

```typescript
import { Key, matchesKey } from "@bastani/atomic-tui";

if (matchesKey(data, Key.ctrl("c"))) process.exit(0);
if (matchesKey(data, Key.enter)) submit();
else if (matchesKey(data, Key.escape)) cancel();
else if (matchesKey(data, Key.up)) moveUp();
```

- **Basic keys:** `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`, `Key.up`, `Key.down`, `Key.left`, `Key.right`
- **Modified keys:** `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")` (string literals like `"ctrl+shift+p"` also work)

## Rendering modes

- **`TuiMainScreen`:** Outputs all lines on first render without clearing scrollback; clears and fully re-renders on width changes or changes above the viewport; otherwise moves to the first changed line, clears to end, and writes changed lines.
- **`TuiAltScreen`:** Owns a fixed terminal-height viewport with differential in-place updates, bottom-following streaming, hover-expanding draggable scrollbars, OSC 133 prompt jumps, OSC 8 clickable links, drag-to-select with auto-scroll and OSC 52 copy, and Kitty image cropping.

Both renderers wrap frames in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for flicker-free updates.

## Terminal interface

The TUI runs against any implementation of `Terminal` (`ProcessTerminal` wraps `process.stdin`/`process.stdout`; pass a mock implementation for headless tests):

```typescript
interface ProgramStatus {
  state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
  app?: string;                             // Stable app name ([A-Za-z0-9_.+-]{1,32})
  kind?: "permission" | "question" | "auth";// Only used when state === "blocked"
  message?: string;                         // Single line, capped at 2,048 UTF-8 bytes
}

interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  handOff?(held?: readonly string[]): void;
  readonly continuedFromHandOff?: boolean;
  restoreOnExit?(before: string, after: string): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  flush?(): Promise<void>;
  readonly colorDepth?: number;
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

Key lifecycle and protocol hooks on `Terminal`:

- **`handOff?(held?)` and `continuedFromHandOff`:** Allows switching from one renderer (such as a fast startup screen) to another without resetting terminal modes or clearing the screen; input arriving during the hand-off is buffered and replayed in order after `held` once the next renderer calls `start()`.
- **`restoreOnExit?(before, after)`:** Synchronously writes terminal mode resets (`before`, the terminal's own resets, then `after`) from a process `exit` handler if `stop()` did not run.
- **`setProgramStatus(status)`:** Emits an [OSC 7501 Program Status](https://www.superlogical.com/rex/docs/build/program-status) update once the terminal confirms support, re-sending the latest state when support is confirmed or the terminal restarts.

## Utilities

```typescript
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";

const width = visibleWidth("\x1b[31mHello\x1b[0m");               // 5
const truncated = truncateToWidth("Hello World", 8);              // "Hello..."
const noEllipsis = truncateToWidth("Hello World", 8, "");         // "Hello Wo"
const wrapped = wrapTextWithAnsi("A long line to wrap nicely", 14);
```

Additional exported helpers:

| Export | Purpose |
| --- | --- |
| `fuzzyFilter` / `fuzzyMatch` | Fuzzy matching and ranked filtering for pickers and search inputs. |
| `KeybindingsManager` / `TUI_KEYBINDINGS` / `getSelectPageIndex` | Configurable TUI keybinding definitions, matching, and list paging helper. |
| `decodePrintableKey` | Decode printable Kitty CSI-u and `modifyOtherKeys` sequences. |
| `normalizePastedText` | Normalize bracketed paste text (CRLF/CR, tmux control bytes, tabs, C0 control filtering). |
| `stripTerminalSequences` / `sliceByColumn` | Strip ANSI/OSC sequences or slice styled strings by display column range. |
| `hyperlink` / `clickableHint` | Format OSC 8 clickable terminal links and clickable hint badges. |
| `renderLatex` | Render inline or block LaTeX math into Unicode text for terminals. |
| `formatProgramStatus` | Encode OSC 7501 program-status escape sequences. |
| `getNativeClipboard` | Access the native clipboard integration when available. |

## Creating custom components

Keep every line returned by `render(width)` within `width` columns, match keys via `matchesKey()`, and cache lines by width until `invalidate()` runs:

```typescript
import { type Component, Key, matchesKey, truncateToWidth } from "@bastani/atomic-tui";

class CachedList implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  private cachedWidth?: number;
  private cachedLines?: string[];
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = this.items.map((item, i) =>
      truncateToWidth(`${i === this.selectedIndex ? "> " : "  "}${item}`, width),
    );
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## Example

A self-contained alternate-screen chat app combining `ScrollView`, `Markdown`, `Loader`, `Spacer`, `Editor`, and `CombinedAutocompleteProvider`:

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
