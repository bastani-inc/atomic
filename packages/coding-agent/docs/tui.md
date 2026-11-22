---
title: "TUI components"
description: "Build custom terminal UI for extensions."
---

# TUI components

Extensions and custom tools can render custom TUI components for interactive user interfaces. This page covers the component system and common interaction patterns.

**Source:** TUI components come from Atomic's `@bastani/atomic-tui` runtime dependency. The [`@bastani/atomic-tui` library page](/libraries/tui) documents its full API, including standalone use outside Atomic.

## On this page and its reference

This page covers writing your first component and common interaction patterns. The component and focusable interfaces, host terminal modes, the host-native session picker and input form, keyboard input, line width, invalidation, debug logging, and performance contracts live in the [TUI API reference](/tui/reference).

## Using components

Use `ctx.ui.custom()` with a component factory. The factory receives `done(result)`, and `ctx.ui.custom()` resolves with that result when the component finishes:

```typescript
pi.on("session_start", async (_event, ctx) => {
  const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
    return new MyComponent(done);
  });
  ctx.ui.notify(`Selected: ${result}`, "info");
});
```

Pass `{ signal }` to `ctx.ui.custom()` when the UI belongs to an abortable operation. Aborting a mounted custom UI dismisses it and releases its input ownership. In-process mode rejects the returned promise with the signal reason; isolated mode resolves it with `undefined`, like host-side cancellation. For overlays, use `options.onHandle` to receive an overlay handle for programmatic visibility control.

For inspection or navigation, pass `{ purpose: "navigation" }` so Atomic mounts the component without emitting `ui_prompt_start` or `ui_prompt_end` (preventing persistent viewers from reporting the session as blocked). Inline navigation temporarily hides all `ctx.ui.setWidget()` widgets above and below the editor, including the agent panel, plus queued-message and pending-shell previews, restoring them when the last inline navigation view closes. Overlays do not hide them. The default purpose is `"prompt"` (for approvals and required user decisions); prompts opened during navigation still emit their own lifecycle events.

Navigation still owns keyboard focus. In `getHostCustomUiState()` and its change listener, `blockingInlineCustomUiActive` counts all inline mounts, while `blockingInlineCustomUiNeedsInput` distinguishes real pending prompts from navigation-only mounts (preserved across the isolated-engine bridge).

Custom components do not report Atomic as waiting through [program status](/terminal-setup#program-status) by default, because `ctx.ui.custom()` also hosts loaders and non-blocking UI. When a component waits for an answer, pass `blocked: { kind, message }` (`kind` is `"question"`, `"permission"`, or `"auth"`):

- Inline components report blocked while visible; a newer dialog shown in their place reports its own status.
- Overlays report blocked from mount until `done()` or `signal` abort, even while hidden with `setHidden()` or covered by another overlay.
- When several blocking prompts are open, the most recently shown one supplies `kind` and `message`.

Main-chat inline custom UIs share the editor slot. Completing an older mount leaves the current one visible; closing the current mount restores the most recent pending inline UI, and the main editor returns only after the last inline owner closes.

Reserving bottom prompts (`reserveTranscriptRows`, including `ask_user_question`) wait out of view while inline navigation or an overlay with `deferInlineCustomUiFocus` owns input. Leaving navigation restores the same pending prompt, and `Escape` belongs exclusively to the active navigation view until then.

In isolated interactive mode, do not access host process objects from `render()` or `handleInput()`. Return JSON-safe values to `done()`. Return `true` for consumed viewport keys or overlay mouse events and `false` to let the transcript handle them. Set `wantsKeyRelease = true` only when your component needs release events. Non-overlay components leave mouse scrolling and selection with the transcript.

## Overlays

Overlays render components on top of existing content without clearing the screen. Pass `{ overlay: true }` to `ctx.ui.custom()`:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

For positioning and sizing, use `overlayOptions`:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // Size: number or percentage string
      width: "50%",          // 50% of terminal width
      minWidth: 40,          // minimum 40 columns
      maxHeight: "80%",      // max 80% of terminal height

      // Position: anchor-based (default: "center")
      anchor: "right-center", // 9 positions: center, top-left, top-center, etc.
      offsetX: -2,            // offset from anchor
      offsetY: 0,

      // Or percentage/absolute positioning
      row: "25%",            // 25% from top
      col: 10,               // column 10

      // Margins
      margin: 2,             // all sides, or { top, right, bottom, left }

      // Responsive: hide on narrow terminals
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
    // Get handle for programmatic focus and visibility control
    onHandle: (handle) => {
      // handle.focus() - focus this overlay and bring it to the visual front
      // handle.unfocus() - release input to normal fallback
      // handle.unfocus({ target }) - release input to a specific component or null
      // handle.setHidden(true/false) - toggle visibility
      // handle.hide() - permanently remove
    },
  }
);
```

### Overlay focus

A focused visible overlay keeps input ownership across temporary non-overlay UI. If an overlay opens another `ctx.ui.custom()` component without `{ overlay: true }`, that replacement UI receives input while active; when it closes, the focused overlay reclaims input.

Use `handle.unfocus()` to release input to another visible capturing overlay or the previous focus target. Use `handle.unfocus({ target })` to focus a specific component while keeping the overlay visible, or `{ target: null }` to leave no focused component until focus is set again.

### Overlay lifecycle

Overlay components are disposed when closed. Create fresh instances rather than reusing references:

```typescript
// Wrong - stale reference
let menu: MenuComponent;
await ctx.ui.custom((_, __, ___, done) => {
  menu = new MenuComponent(done);
  return menu;
}, { overlay: true });
setActiveComponent(menu);  // Disposed

// Correct - re-call to re-show
const showMenu = () => ctx.ui.custom((_, __, ___, done) => 
  new MenuComponent(done), { overlay: true });

await showMenu();  // First show
await showMenu();  // "Back" = just call again
```

See [overlay-qa-tests.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) for examples covering anchors, margins, stacking, responsive visibility, and animation.

## Built-in components

Import from `@bastani/atomic-tui`:

```typescript
import { Text, Box, Container, Spacer, Markdown } from "@bastani/atomic-tui";
```

### Text

Multi-line text with word wrapping.

```typescript
const text = new Text(
  "Hello World",    // content
  1,                // paddingX (default: 1)
  1,                // paddingY (default: 1)
  (s) => bgGray(s)  // optional background function
);
text.setText("Updated");
```

### Box

Container with padding and background color.

```typescript
const box = new Box(
  1,                // paddingX
  1,                // paddingY
  (s) => bgGray(s)  // background function
);
box.addChild(new Text("Content", 0, 0));
box.setBgFn((s) => bgBlue(s));
```

### Container

Groups child components vertically.

```typescript
const container = new Container();
container.addChild(component1);
container.addChild(component2);
container.removeChild(component1);
```

### Spacer

Empty vertical space.

```typescript
const spacer = new Spacer(2);  // 2 empty lines
```

### Markdown

Renders markdown with syntax highlighting.

```typescript
const md = new Markdown(
  "# Title\n\nSome **bold** text",
  1,        // paddingX
  1,        // paddingY
  theme     // MarkdownTheme (see below)
);
md.setText("Updated markdown");
```

### Image

Renders images in supported terminals (Kitty, iTerm2, Ghostty, WezTerm, Warp).

```typescript
const image = new Image(
  base64Data,   // base64-encoded image
  "image/png",  // MIME type
  theme,        // ImageTheme
  { maxWidthCells: 80, maxHeightCells: 24 }
);
```

## Creating custom components

Example: Interactive selector

```typescript
import {
  matchesKey, Key,
  truncateToWidth, visibleWidth
} from "@bastani/atomic-tui";

class MySelector {
  private items: string[];
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  
  public onSelect?: (item: string) => void;
  public onCancel?: () => void;

  constructor(items: string[]) {
    this.items = items;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.invalidate();
      return true;
    } else if (matchesKey(data, Key.down) && this.selected < this.items.length - 1) {
      this.selected++;
      this.invalidate();
      return true;
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.items[this.selected]);
      return true;
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.items.map((item, i) => {
      const prefix = i === this.selected ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Usage in an extension:

```typescript
pi.registerCommand("pick", {
  description: "Pick an item",
  handler: async (args, ctx) => {
    const items = ["Option A", "Option B", "Option C"];
    const selector = new MySelector(items);
    
    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
      selector.onSelect = (item) => done(item);
      selector.onCancel = () => done(undefined);
      return selector;
    });

    if (selected) {
      ctx.ui.notify(`Selected: ${selected}`, "info");
    }
  }
});
```

## Theming

Components accept theme objects for styling.

**In `renderCall`/`renderResult`**, use the `theme` parameter:

```typescript
renderResult(result, options, theme, context) {
  // Use theme.fg() for foreground colors
  return new Text(theme.fg("success", "Done!"), 0, 0);
  
  // Use theme.bg() for background colors
  const styled = theme.bg("toolPendingBg", theme.fg("accent", "text"));
}
```

**Foreground colors** (`theme.fg(color, text)`):

| Category | Colors |
|----------|--------|
| General | `text`, `accent`, `muted`, `dim` |
| Status | `success`, `error`, `warning` |
| Borders | `border`, `borderAccent`, `borderMuted` |
| Messages | `userMessageText`, `customMessageText`, `customMessageLabel` |
| Tools | `toolTitle`, `toolOutput` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| Thinking | `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh` |
| Modes | `bashMode` |

**Background colors** (`theme.bg(color, text)`):

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

**For Markdown**, use `getMarkdownTheme()`:

```typescript
import { getMarkdownTheme } from "@bastani/atomic";
import { Markdown } from "@bastani/atomic-tui";

renderResult(result, options, theme, context) {
  const mdTheme = getMarkdownTheme();
  return new Markdown(result.details.markdown, 0, 0, mdTheme);
}
```

**For custom components**, define your own theme interface:

```typescript
interface MyTheme {
  selected: (s: string) => string;
  normal: (s: string) => string;
}
```

## Common patterns

These patterns cover the most common UI needs in extensions. Copy these patterns instead of building from scratch.

### Pattern 1: Selection dialog (`Selector`)

For letting users pick from a list, use `Selector` from `@bastani/atomic`. It powers `/model`, `/login`, `/logout`, `/thinking`, `/trust`, `/scoped-models`, and extension `select` and `confirm` dialogs, with a title, optional search box, one- or two-line rows with dim descriptions and right-aligned tags, scroll indicators, an empty state, and a key hint line.

```typescript
import { DynamicBorder, Selector } from "@bastani/atomic";

const choice = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
  const selector = new Selector<string>({
    title: "Pick a preset",
    search: true,                         // typing filters; esc clears the search, then cancels
    items: [
      { id: "fast", value: "fast", label: "fast", description: "small model, low effort", mark: "on", tag: "current" },
      { id: "deep", value: "deep", label: "deep", description: "large model, high effort", mark: "off" },
    ],
    onSelect: (item) => done(item.value),
    onCancel: () => done(null),
  });
  const border = new DynamicBorder();
  return {
    render: (width) => [...border.render(width), ...selector.render(width)],
    invalidate: () => selector.invalidate(),
    handleInput: (data) => {
      selector.handleInput(data);
      tui.requestRender();
      return true;
    },
  };
});
```

Keys: Up/Down select (wrapping), PageUp/PageDown page, Home/End jump when search is off, Enter confirms, Right confirms when search is empty, Esc clears search before cancelling, and Ctrl+C always cancels. Mouse click chooses a row (or toggles in multi-select) and wheel input scrolls to the ends. Key options:

| Option | Effect |
| --- | --- |
| `layout: "two-line"` | Places each description on the line under its label, for rows like sessions or runs. |
| `wrap: true` | Wraps long titles and option labels instead of truncating. Extension `select` and `confirm` dialogs enable this automatically. |
| `mode: "multi"` | Checkboxes: Space toggles, Enter calls `onConfirm` with checked rows and stops the picker regardless of `closeOnSelect`. |
| `closeOnSelect: false` | Single-select only. Choosing a row calls `onSelect` and leaves the picker open so Enter or a click can choose again. Default `true`. |
| `numbered: true` | Numbers rows; without a search box, digits 1 to 9 choose a row directly (or toggle with `mode: "multi"`). |
| `onPreview` | Space previews the selected row; the hint shows `space preview`. |
| `rightConfirms: false` | Disables the `app.list.open` shortcut (Right by default) when only Enter should confirm. |
| `minDescriptionWidth` | Reserves columns for a one-line row's description, shortening its label before the value or right-hand tag. |
| `onSelectionChange` | Fires when navigation or filtering changes the selected row's identity, or `undefined` when no enabled row matches. |
| `extraKeys` | Custom keys with hints and `enabled(item)` checks so unavailable keys stay hidden. |
| `group` on items | Groups rows under section labels (hidden while searching). |
| `disabled` on items | Drawn dim, skipped by navigation and wheel, and ignored by Enter and clicks. |
| `mark` on items | `"on"`/`"off"` draw `●`/`○`; `"checked"`/`"unchecked"` draw `[✓]`/`[ ]`. |
| `labelStyle` on items | Custom label styling callback receiving whether the row is selected. |
| `searchText` on items | Extra text matched by type-to-search (combined with label, description, and tag by default). |
| `searchTextMode: "replace"` on items | Matches search only against `searchText` instead of label, description, and tag (default `"extend"`). |
| `subtitle` | Dim text under the title; `\n` starts new lines and long lines wrap. |

Without a search box, `?` opens key help (ignoring mouse input while open) and `j`/`k` navigate down/up. `setNotice({ text, tone })` displays a one-line status under the list.

A picker stops accepting input once it invokes `onCancel`, `onConfirm`, or `onSelect` (unless `closeOnSelect` is `false`), so repeated keypresses or clicks run callbacks once. If an async callback fails (for example while saving), call `selector.retrySelection()` to resume input and pair it with `setNotice()` to display the error.

`setItems()` replaces rows while keeping the selected enabled row by ID, then tries `preferId`, then scans forward (clamped) and backward for an enabled row. `onSelectionChange` fires only when the selected ID changes. `SelectorState.items` is read-only and frozen; use `state.setItems(rows)` or copy with `[...state.items]`. For persistent single-select pickers that replace rows after `onSelect`, set `closeOnSelect: false`.

Call `selector.invalidate()` before `tui.requestRender()` when external data used by a custom `style` or `extraKeys` `enabled` callback changes. A row's `labelStyle` runs on every render.

`SelectorState` holds search, selection, and checked rows headless for testing, and `selectorHintEntries(state, options)` returns its hint keys. `themeSelectorStyle()` returns themed colors; pass `style: PLAIN_SELECTOR_STYLE` for unstyled output.

For live lists, call `selector.setItems(nextItems)` and `tui.requestRender()`. Selection stays on the same `id` when still enabled and matching, otherwise moves to the first enabled match, and removed checked items are dropped.

`UserMessageSelectorComponent` implements the `/fork` picker on `Selector`: `new UserMessageSelectorComponent(messages, onSelect, onCancel, initialSelectedId?)` accepts user messages oldest first (`{ id, text }`), renders two-line rows, selects `initialSelectedId` or the newest message, and filters as you type. Focus the component directly; `getMessageList()` returns the component, and `onSelect`/`onCancel` are assignable properties.

### Pattern 1b: Selection dialog (`SelectList`)

The lower-level `SelectList` from `@bastani/atomic-tui` is still available when you need a bare list inside your own layout, such as autocomplete rows. Frame it with `DynamicBorder`.

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { DynamicBorder } from "@bastani/atomic";
import { Container, type SelectItem, SelectList, Text } from "@bastani/atomic-tui";

pi.registerCommand("pick", {
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "opt1", label: "Option 1", description: "First option" },
      { value: "opt2", label: "Option 2", description: "Second option" },
      { value: "opt3", label: "Option 3" },  // description is optional
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();

      // Top border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      // Title
      container.addChild(new Text(theme.fg("accent", theme.bold("Pick an Option")), 1, 0));

      // SelectList with theme
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      // Help text
      container.addChild(new Text(theme.fg("dim", "↑↓ Navigate • Enter Select • Escape Cancel"), 1, 0));

      // Bottom border
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          selectList.handleInput(data);
          tui.requestRender();
          return true;
        },
      };
    });

    if (result) {
      ctx.ui.notify(`Selected: ${result}`, "info");
    }
  },
});
```

**Examples:** [preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts), [tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts)

### Pattern 2: Async Operation with Cancel (BorderedLoader)

For operations that take time and should be cancellable. `BorderedLoader` shows a spinner and handles escape to cancel.

```typescript
import { BorderedLoader } from "@bastani/atomic";

pi.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Fetching data...");
      loader.onAbort = () => done(null);

      // Do async work
      fetchData(loader.signal)
        .then((data) => done(data))
        .catch(() => done(null));

      return loader;
    });

    if (result === null) {
      ctx.ui.notify("Cancelled", "info");
    } else {
      ctx.ui.setEditorText(result);
    }
  },
});
```

**Examples:** [qna.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/qna.ts), [handoff.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/handoff.ts)

### Pattern 3: Settings/Toggles (SettingsList)

For toggling multiple settings. Use `SettingsList` from `@bastani/atomic-tui` with `getSettingsListTheme()`.

```typescript
import { getSettingsListTheme } from "@bastani/atomic";
import { Container, type SettingItem, SettingsList, Text } from "@bastani/atomic-tui";

pi.registerCommand("settings", {
  handler: async (_args, ctx) => {
    const items: SettingItem[] = [
      { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
      { id: "color", label: "Color output", currentValue: "on", values: ["on", "off"] },
    ];

    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Settings")), 1, 1));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, newValue) => {
          // Handle value change
          ctx.ui.notify(`${id} = ${newValue}`, "info");
        },
        () => done(undefined),  // On close
        { enableSearch: true }, // Optional: enable fuzzy search by label
      );
      container.addChild(settingsList);

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          settingsList.handleInput?.(data);
          return true;
        },
      };
    });
  },
});
```

**Examples:** [tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts)

### Pattern 4: Persistent Status Indicator

Show status in the footer that persists across renders. Good for mode indicators.

```typescript
// Set status (shown in footer)
ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● active"));

// Clear status
ctx.ui.setStatus("my-ext", undefined);
```

**Examples:** [status-line.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/status-line.ts), [plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts), [preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts)

### Pattern 4b: Working indicator customization

Customize the inline Working indicator shown from accepted interactive prompt submission through the active agent turn.

```typescript
// Static indicator
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });

// Custom animated indicator
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});

// Hide the indicator entirely
ctx.ui.setWorkingIndicator({ frames: [] });

// Restore Atomic's default one-cell identity pulse
ctx.ui.setWorkingIndicator();
```

This affects the normal Working indicator from accepted prompt submission through response streaming. It appears in a standalone status row by default; custom editors may place it in their top border. Newlines and terminal control characters in extension-supplied messages or frames remain stored verbatim, and the standalone row preserves their multi-line rendering.

Working appears during prompt startup and response streaming, then disappears on completion, failure, or a no-turn result. Manual retry clears stale status; automatic retry and fallback messages take precedence.

The default is a one-cell `∀` pulse beside a message selected once per turn. Theme `workingIndicator` tones customize its colors. `NO_COLOR` disables foreground and background colors and text styles (bold, italic, dim, underline, inverse, and strikethrough), rendering the indicator unstyled. `ATOMIC_REDUCED_MOTION=1` makes it static. Custom frames and intervals render unchanged.

Compaction and retry loaders use their own factual text and the built-in indicator, not extension frames. Successful mid-turn compaction restores Working without another user submission. Cancelled or failed compaction stops activity; errors appear when supplied by the compaction event.

**Examples:** [working-indicator.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts)

### Pattern 5: Widgets Above/Below Editor

Show persistent content above or below the input editor. Good for todo lists, progress.

```typescript
// Simple string array (above editor by default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Render below the editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });

// Or with theme
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item, i) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return {
    render: () => lines,
    invalidate: () => {},
  };
});

// Clear
ctx.ui.setWidget("my-widget", undefined);
```

Hosts may clear extension widgets during a UI reset, and `ctx.ui.setWidget(key, undefined)` is the same kind of host removal. A reactive extension that needs to keep a long-lived widget registration can observe `ctx.ui.onWidgetRelease(key, listener)` when available.
The listener runs after the host removes that key, so the extension can reset local mount state and re-register on its next refresh. Replacing a widget with another factory is not a release. Ordinary content changes should continue to update the existing component with `requestRender()` rather than repeatedly calling `setWidget()`.

#### Scrollable widgets

Opt in with `scroll: { maxHeight: 6 }` to give a widget its own fullscreen viewport. The host may allocate fewer rows when the editor or other widgets need space. Render the full content, not a pre-clipped slice. Wheel input over the widget scrolls only that widget, including at either end. A one-column scrollbar appears only while content overflows. Scrolling does not take editor focus or register keyboard shortcuts.

For a cap that follows terminal resizing, use `scroll: { maxHeight: 10, maxHeightFraction: 1 / 3 }`. The fraction is applied to live terminal rows, rounded down with a one-row minimum, then limited by `maxHeight`. Actual allocation may still be zero when other dock content uses all available rows. Omitting the fraction retains the fixed cap. The same options work for isolated-engine widgets.

```typescript
import type { ScrollableWidgetComponent, WidgetScrollRequest } from "@bastani/atomic";
import { truncateToWidth } from "@bastani/atomic-tui";

let position: WidgetScrollRequest = { version: 0, scrollTop: 0 };
let currentTop = 0;
ctx.ui.setWidget("scrolling-items", () => ({
  render: (width) => items.map((item) => truncateToWidth(item.label, width)),
  invalidate() {},
  getScrollRequest: () => position,
  onScroll: (state) => {
    // state reports scrollTop, viewportHeight and contentHeight in rendered rows.
    currentTop = state.scrollTop;
  },
} satisfies ScrollableWidgetComponent), {
  placement: "belowEditor",
  scroll: { maxHeight: 6 },
});

// To intentionally reposition, increase version, then request a render.
position = { version: position.version + 1, scrollTop: 10 };
ctx.ui.requestRender();
```

`getScrollRequest` and `onScroll` are optional. Keep the request version unchanged during ordinary updates so they do not reset wheel scrolling. New positions are clamped to the actual viewport. Requests with older versions are ignored. Unmounting starts a fresh viewport. Keep item identity and insertion/deletion anchors in your extension; positions here count rendered rows.

`installReactiveWidget` accepts the same `scroll`, `getScrollRequest`, and `onScroll` options. Existing widgets remain unscrolled unless they opt in. Factory widgets work in both in-process and isolated-engine sessions. Native wheel input requires the fullscreen renderer and a terminal that forwards mouse events; the guarded main-screen fallback does not provide a native viewport. No Option/Alt key setup is required for wheel input.

**Examples:** [plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts)

### Pattern 6: Custom Footer

Replace the footer. `footerData` exposes data not otherwise accessible to extensions.

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()), // reactive
}));

ctx.ui.setFooter(undefined); // restore default
```

`ctx.ui.getFooterDataProvider()` exposes the same read-only status and Git-branch provider to embedded extension UIs, including isolated interactive sessions.

For a viewer with a different cwd, subscribe with that cwd to retain its branch watcher, and read the live branch during each render using the same raw cwd string:

```typescript
// viewerCwd is fixed for this viewer's lifetime.
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    return [`${ctx.model?.id} (${footerData.getGitBranch(viewerCwd) || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender(), viewerCwd),
}));
```

The returned unsubscribe function belongs to the viewer: call it on disposal or before replacing the viewer's cwd, then subscribe for the new cwd. Embedded UIs using `ctx.ui.getFooterDataProvider()` must likewise release their own subscription. Active viewers using the same raw cwd share the cached provider and watcher; the last unsubscribe releases that alternate-cwd resource. Do not call the parent provider's `dispose()` from an individual viewer.

An unleased `getGitBranch(viewerCwd)` lookup is transient: it does not retain an alternate-cwd cache or watcher, so an unscoped callback alone does not enable branch updates for that directory. Scoped subscriptions retain resources, but notifications still reach the same branch-change listeners; they are not filtered by cwd. Omitting the cwd argument retains the provider's own cwd behavior shown in the default recipe above.

Token stats available via `ctx.sessionManager.getBranch()` and `ctx.model`.

**Examples:** [custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts)

### Pattern 7: Custom Editor (vim mode, etc.)

Replace the main input editor with a custom implementation. Useful for modal editing (vim), different keybindings (emacs), or specialized input handling.

```typescript
import { CustomEditor, type ExtensionAPI } from "@bastani/atomic";
import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): boolean {
    // Escape: switch to normal mode, or pass through for app handling
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        return true;
      }
      // In normal mode, escape aborts agent (handled by CustomEditor)
      return super.handleInput(data);
    }

    // Insert mode: pass everything to CustomEditor
    if (this.mode === "insert") {
      return super.handleInput(data);
    }

    // Normal mode: vim-style navigation
    switch (data) {
      case "i": this.mode = "insert"; return true;
      case "h": return super.handleInput("\x1b[D"); // Left
      case "j": return super.handleInput("\x1b[B"); // Down
      case "k": return super.handleInput("\x1b[A"); // Up
      case "l": return super.handleInput("\x1b[C"); // Right
    }
    // Pass unhandled keys to super (ctrl+c, etc.), but filter printable chars
    if (data.length === 1 && data.charCodeAt(0) >= 32) return false;
    return super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // Add mode indicator to bottom border (use truncateToWidth for ANSI-safe truncation)
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      // Pass "" as ellipsis to avoid adding "..." when truncating
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Factory receives the TUI, theme, and keybindings from the app
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**Key points:**

- **Extend `CustomEditor`** (not base `Editor`) to get app keybindings (escape to abort, ctrl+d to exit, model switching, etc.)
- **Call `super.handleInput(data)`** for keys you don't handle
- **Working status**: editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to opt into the editor-border spinner.
- **Factory pattern**: `setEditorComponent` receives a factory function that gets `tui`, `theme`, and `keybindings`
- **Autocomplete limit**: custom editors installed through `setEditorComponent()` that expose `setAutocompleteMaxVisible()` inherit the active `autocompleteMaxVisible` setting
- **Pass `undefined`** to restore the default editor: `ctx.ui.setEditorComponent(undefined)`

**Examples:** [modal-editor.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts)

### Pattern 7b: Attached Composer

When an extension or custom SDK host embeds a secondary chat editor, `applyAttachedComposer(style, label, placeholder, lines)` distinguishes it from the main prompt: accent-coloured rules above and below the prompt, the top rule ending in a bold `label`, and a dim `placeholder` after the cursor while nothing is typed.

```typescript
import { applyAttachedComposer, CustomEditor, type ExtensionAPI, type Theme } from "@bastani/atomic";

class ReviewerEditor extends CustomEditor {
  appTheme?: Theme;

  render(width: number): string[] {
    const theme = this.appTheme;
    if (theme === undefined) return super.render(width);
    return applyAttachedComposer(
      {
        accent: (text) => theme.fg("accent", text),
        text: (text) => theme.fg("text", text),
        dim: (text) => theme.fg("dim", text),
      },
      "reviewer · checking the diff · 2m",
      "Message reviewer…",
      super.render(width),
    );
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const editor = new ReviewerEditor(tui, editorTheme, keybindings);
      editor.appTheme = ctx.ui.theme;
      return editor;
    });
  });
}
```

It replaces only a plain editor rule or one that reads `↑ N more` or `↓ N more`: a first or last line that is not a rule, such as one your editor draws itself, is left as it is. A long label is cut with `…` to fit. Below `INPUT_LABEL_MIN_COLUMNS` (40) columns, the rules stay heavy without the label. Pass `undefined` for `label` or `placeholder` to leave either out.

## Key rules

1. **Always use theme from callback.** Do not import theme directly; use `theme` passed to `ctx.ui.custom((tui, theme, keybindings, done) => ...)`.

2. **Always type `DynamicBorder` color parameters.** Write `(s: string) => theme.fg("accent", s)`, not `(s) => theme.fg("accent", s)`.

3. **Call `tui.requestRender()` after state changes.** In `handleInput`, call `tui.requestRender()` after updating state.

4. **Return the three-method object.** Custom components need `{ render, invalidate, handleInput }`.

5. **Use existing components.** `Selector`, `SelectList`, `SettingsList`, and `BorderedLoader` cover most interactive UI cases.

## Examples

- **Selection UI**: [examples/extensions/preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts): `SelectList` with `DynamicBorder` framing.
- **Async with cancel**: [examples/extensions/qna.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/qna.ts): `BorderedLoader` for LLM calls.
- **Settings toggles**: [examples/extensions/tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts): `SettingsList` for tool enable/disable.
- **Status indicators**: [examples/extensions/plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts): `setStatus` and `setWidget`.
- **Working indicator**: [examples/extensions/working-indicator.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts): `setWorkingIndicator`.
- **Custom footer**: [examples/extensions/custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts): `setFooter` with stats.
- **Custom editor**: [examples/extensions/modal-editor.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts): Vim-like modal editing.
- **Snake game**: [examples/extensions/snake.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/snake.ts): game with keyboard input and game loop.
- **Custom tool rendering**: [examples/extensions/todo.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/todo.ts): `renderCall` and `renderResult`.

## Moved sections

<a id="component-interface" />
<a id="focusable-interface-ime-support" />
<a id="container-components-with-embedded-inputs" />
<a id="host-terminal-modes-from-an-isolated-component" />
<a id="host-native-session-picker" />
<a id="host-native-input-form" />
<a id="keyboard-input" />
<a id="line-width" />
<a id="debug-logging" />
<a id="performance" />
<a id="invalidation-and-theme-changes" />
<a id="the-problem" />
<a id="the-solution" />
<a id="pattern-rebuild-on-invalidate" />
<a id="when-this-matters" />

These component, input, invalidation, logging, performance, and host-integration contracts moved to [TUI API reference](/tui/reference).
