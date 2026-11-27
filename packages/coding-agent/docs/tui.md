---
title: "Build TUI components"
sidebarTitle: "Build TUI components"
description: "Build custom interactive terminal UI components, overlays, selectors, widgets, and editors for Atomic extensions."
---

Extensions and custom tools can render interactive terminal UI (TUI) components with `ctx.ui.custom()`, overlays, widgets, status indicators, and custom editors. For low-level rendering primitives (`TuiMainScreen`, `TuiAltScreen`, `Component`, `Focusable`, `matchesKey`, and built-in primitives), see [`@bastani/atomic-tui`](/libraries/tui). For full Atomic extension contracts (`ToolBlock`, `ExtensionCustomComponent`, advanced `ctx.ui.custom()` options, theme invalidation, debug logging, and host-native dialogs), see [TUI API reference](/tui/reference).

## Using `ctx.ui.custom()`

Pass a synchronous or `async` component factory (`ExtensionCustomComponent | Promise<ExtensionCustomComponent>`) to `ctx.ui.custom()`. The factory receives `(tui, theme, keybindings, done)`, and `ctx.ui.custom()` resolves with the value you pass to `done()`. Components can also implement `dispose?(): void` for cleanup when dismissed.

```typescript
atomic.on("session_start", async (_event, ctx) => {
  const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
    return new MyComponent(theme, done);
  });
  ctx.ui.notify(`Selected: ${result}`, "info");
});
```

Common options for `ctx.ui.custom(factory, options?)`:

| Option | Default | Purpose |
| --- | --- | --- |
| `overlay` | `false` | Mount the component as a floating overlay instead of replacing the editor slot (see [Overlays](#overlays)). |
| `overlayOptions` | Centered, max 80 cols | Static `OverlayOptions` object or `() => OverlayOptions` callback evaluated on render. |
| `onHandle` | — | Receives an `OverlayHandle` for programmatic focus and visibility control. |
| `handlesCtrlC` | `false` | By default, Atomic closes a custom component on the first `Ctrl+C` so a wedged component cannot trap input. Set `true` only if your component handles `Ctrl+C` cleanly itself. |
| `signal` | — | `AbortSignal` that dismisses the component when aborted (resolves `undefined` in Atomic's CLI TUI; rejects with `signal.reason` in embedded SDK TUI hosts). |
| `blocked` | — | `{ kind: "question" \| "permission" \| "auth", message: string }`. Reports Atomic as waiting for user input through [program status](/terminal-setup#program-status). |

For advanced options (`purpose`, `handlesInternalUiAction`, `deferInlineCustomUiFocus`, `reserveTranscriptRows`, `OVERLAY_ACTIVE_ROW_MARKER`, and `HostCustomUiState`), see [Custom component options](/tui/reference#custom-component-options).

<Note>
Do not rely on host process globals from `render()` or `handleInput()`, and pass only JSON-safe values to `done()`. Return `true` for consumed viewport keys or overlay mouse events and `false` to let the transcript handle them. Non-overlay components leave mouse scrolling and selection with the transcript.
</Note>

## Overlays

Overlays render components on top of existing content without clearing the screen. Pass `{ overlay: true }` to `ctx.ui.custom()`:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  { overlay: true }
);
```

For positioning and sizing, pass `overlayOptions` as a static object or a `() => OverlayOptions` function for dynamic updates:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new SidePanel({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      // Size: number or percentage string
      width: "50%",           // 50% of terminal width
      minWidth: 40,           // minimum 40 columns
      maxHeight: "80%",       // max 80% of terminal height

      // Position: anchor-based (default: "center")
      anchor: "right-center", // 9 positions: center, top-left, top-center, etc.
      offsetX: -2,            // offset from anchor
      offsetY: 0,

      // Or percentage/absolute positioning
      row: "25%",             // 25% from top
      col: 10,                // column 10

      // Margins
      margin: 2,              // all sides, or { top, right, bottom, left }

      // Responsive: hide on narrow terminals
      visible: (termWidth, termHeight) => termWidth >= 80,
    },
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

### Overlay focus and lifecycle

A focused visible overlay keeps input ownership across temporary non-overlay UI: if it opens another inline `ctx.ui.custom()` component, that component receives input while active, and the overlay reclaims input when it closes. Call `handle.unfocus()` to release input to the fallback target, or `handle.unfocus({ target })` to focus a specific component (or `null` for none).

Overlay components are disposed when closed, so always create fresh instances instead of reusing closed references:

```typescript
// Correct: call ctx.ui.custom() again to re-open a fresh instance
const showMenu = () =>
  ctx.ui.custom((_, __, ___, done) => new MenuComponent(done), { overlay: true });

await showMenu(); // First show
await showMenu(); // Re-show cleanly
```

See [overlay-qa-tests.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) for examples covering anchors, margins, stacking, responsive visibility, and animation.

## Built-in primitives

Import layout and content primitives from `@bastani/atomic-tui` (provided by Atomic without installing it):

```typescript
import { Box, Container, Image, Markdown, Spacer, Text } from "@bastani/atomic-tui";
```

| Component | Purpose | Typical usage |
| --- | --- | --- |
| `Text` | Multi-line wrapped text with padding and optional background | `new Text(theme.fg("accent", "Ready"), 1, 0)` |
| `Box` | Padded container with optional background color | `new Box(1, 1, (s) => theme.bg("selectedBg", s))` |
| `Container` | Vertical group of child components | `container.addChild(child); container.removeChild(child);` |
| `Spacer` | Vertical blank rows | `new Spacer(1)` |
| `Markdown` | Styled Markdown renderer with optional syntax highlighting | `new Markdown(md, 1, 1, getMarkdownTheme())` |
| `Image` | Inline image for Kitty/iTerm2-capable terminals (text fallback elsewhere) | `new Image(base64Data, "image/png", imageTheme, { maxWidthCells: 80 })` |

See [`@bastani/atomic-tui` built-in components](/libraries/tui#built-in-components) for full constructor signatures, options, and additional primitives (`Input`, `Editor`, `Loader`, `CancellableLoader`, `TruncatedText`, `WindowedContainer`, `VStack`, `HStack`, `ScrollView`).

## Creating custom components

Implement `render(width)`, `invalidate()`, and optional `handleInput(data)` to build a custom interactive component:

```typescript
import { Key, matchesKey, truncateToWidth } from "@bastani/atomic-tui";

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
      this.onSelect?.(this.items[this.selected]!);
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

Use it inside a slash command handler:

```typescript
atomic.registerCommand("pick", {
  description: "Pick an item",
  handler: async (_args, ctx) => {
    const items = ["Option A", "Option B", "Option C"];
    const selector = new MySelector(items);

    const selected = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
      selector.onSelect = (item) => done(item);
      selector.onCancel = () => done(undefined);
      return {
        render: (w) => selector.render(w),
        invalidate: () => selector.invalidate(),
        handleInput: (data) => {
          const handled = selector.handleInput(data);
          if (handled) tui.requestRender();
          return handled;
        },
      };
    });

    if (selected) {
      ctx.ui.notify(`Selected: ${selected}`, "info");
    }
  },
});
```

## Theming

Always use the `theme` passed to your callback (`ctx.ui.custom`, `ctx.ui.setWidget`, `renderCall`, `renderResult`) rather than importing a theme singleton directly:

```typescript
renderResult(result, options, theme, context) {
  const status = theme.fg("success", "Done!");
  const badge = theme.bg("toolPendingBg", theme.fg("accent", "pending"));
  return new Text(`${status} ${badge}`, 0, 0);
}
```

**Foreground colors** (`theme.fg(color, text)`):

| Category | Colors |
| --- | --- |
| General | `text`, `accent`, `muted`, `dim`, `searchMatchText` |
| Status | `success`, `error`, `warning` |
| Borders | `border`, `borderAccent`, `borderMuted` |
| Messages | `userMessageText`, `customMessageText`, `customMessageLabel` |
| Tools | `toolTitle`, `toolOutput` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| Thinking | `thinkingText`, `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh` |
| Modes | `bashMode` |

**Background colors** (`theme.bg(color, text)`): `selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `scrollbarThumb`, `searchMatchBg`.

For `Markdown` components, call `getMarkdownTheme()` from `@bastani/atomic`:

```typescript
import { getMarkdownTheme } from "@bastani/atomic";
import { Markdown } from "@bastani/atomic-tui";

renderResult(result, _options, _theme, _context) {
  return new Markdown(result.details.markdown, 0, 0, getMarkdownTheme());
}
```

If your component stores pre-baked themed strings in child components, rebuild them in `invalidate()` so live theme changes take effect; see [Invalidation and theme changes](/tui/reference#invalidation-and-theme-changes).

## Common patterns

Use these built-in Atomic patterns instead of building interactive widgets from scratch.

### Selection dialog (`Selector`)

Use `Selector` from `@bastani/atomic` for searchable, keyboard- and mouse-accessible pickers (the same component behind `/model`, `/login`, `/thinking`, `/trust`, and `ctx.ui.select`/`confirm`):

```typescript
import { DynamicBorder, Selector } from "@bastani/atomic";

const choice = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
  const selector = new Selector<string>({
    title: "Pick a preset",
    search: true, // typing filters; Esc clears search, then cancels
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

Navigation supports `Up`/`Down` (wrapping), `PageUp`/`PageDown`, `Home`/`End` (when search is off), `Enter`, `Right` (when search is empty), `Esc` (clears search, then cancels), `Ctrl+C`, mouse click, and wheel scrolling. Without a search box, `?` opens key help and `j`/`k` navigate.

Key `SelectorOptions` and item fields:

| Option | Default | Effect |
| --- | --- | --- |
| `title` / `subtitle` | — | Heading and dim wrapped subtitle (`\n` starts new lines). |
| `layout` | `"one-line"` | `"two-line"` places each description under its label (good for sessions or runs). |
| `mode` | `"single"` | `"multi"` adds checkboxes; `Space` toggles and `Enter` calls `onConfirm` with checked rows. |
| `search` / `searchPlaceholder` / `initialQuery` | `false` | Enables type-to-search with optional placeholder and starting query. |
| `maxVisible` | `10` | Maximum visible rows before scrolling. |
| `emptyText` | — | Message shown when `items` is empty. |
| `numbered` | `false` | Numbers rows `1.` `2.`; without search, digits `1`–`9` choose or toggle directly. |
| `wrap` | `false` | Wraps long titles and labels instead of truncating. |
| `initialId` / `initialChecked` | First `mark: "on"` or enabled row | Starting selection ID (and starting checked IDs in `"multi"` mode). |
| `closeOnSelect` | `true` | Single-select only. Set `false` to keep the picker open after `onSelect`. |
| `confirmLabel` / `cancelLabel` / `previewLabel` | `"choose"` or `"confirm"` / `"cancel"` | Custom hint text for `Enter`, `Esc`, and `Space` preview. |
| `spaceConfirms` / `rightConfirms` | `false` / `true` | Allow `Space` to confirm, or disable `Right` (`app.list.open`) confirmation. |
| `minDescriptionWidth` | — | Reserves columns for one-line descriptions, shortening labels first. |
| `selectedDetail` | — | Callback `(item) => string \| undefined` rendering extra detail for the selected row. |
| `onPreview` | — | `Space` previews the selected row; hint shows `space <previewLabel>`. |
| `onSelectionChange` | — | Fires when navigation or filtering changes the selected row ID (or `undefined`). |
| `extraKeys` | — | Custom key actions with hints and `enabled(item)` predicates. |
| `helpTitle` / `keybindings` / `style` | `title` / global / active theme | Title for `?` help overlay, keybindings source, and colors (`PLAIN_SELECTOR_STYLE` for unstyled). |
| Item fields | — | `group` (section label), `disabled`, `mark` (`"on"`/`"off"`/`"checked"`/`"unchecked"`), `tag` + `tagTone` (`"accent"` \| `"success"` \| `"warning"` \| `"error"` \| `"muted"` \| `"dim"`), `labelStyle`, `searchText`, `searchTextMode` (`"extend"` \| `"replace"`). |

For live updates, call `selector.setItems(nextItems)` and `tui.requestRender()`; selection stays on the same `id` when still enabled and matching. Call `selector.setNotice({ text, tone })` for a one-line status under the list, and call `selector.retrySelection()` if an async `onSelect`/`onConfirm` callback fails and should re-enable input. For headless testing (`SelectorState`, `selectorHintEntries`) and `UserMessageSelectorComponent`, see [Selector helpers](/tui/reference#selector-helpers).

### Bare list (`SelectList`)

Use `SelectList` from `@bastani/atomic-tui` when you need a minimal list inside your own layout (such as custom autocomplete rows) framed with `DynamicBorder`:

```typescript
import { DynamicBorder } from "@bastani/atomic";
import { Container, type SelectItem, SelectList, Text } from "@bastani/atomic-tui";

atomic.registerCommand("pick", {
  handler: async (_args, ctx) => {
    const items: SelectItem[] = [
      { value: "opt1", label: "Option 1", description: "First option" },
      { value: "opt2", label: "Option 2", description: "Second option" },
      { value: "opt3", label: "Option 3" },
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Pick an Option")), 1, 0));

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

      container.addChild(new Text(theme.fg("dim", "↑↓ Navigate • Enter Select • Escape Cancel"), 1, 0));
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

    if (result) ctx.ui.notify(`Selected: ${result}`, "info");
  },
});
```

**Examples:** [preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts), [tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts)

### Cancellable loader (`BorderedLoader`)

Use `BorderedLoader` for async operations that users should be able to cancel with `Escape`:

```typescript
import { BorderedLoader } from "@bastani/atomic";

atomic.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Fetching data...");
      loader.onAbort = () => done(null);

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

### Settings toggles (`SettingsList`)

Use `SettingsList` from `@bastani/atomic-tui` with `getSettingsListTheme()` from `@bastani/atomic`:

```typescript
import { getSettingsListTheme } from "@bastani/atomic";
import { Container, type SettingItem, SettingsList, Text } from "@bastani/atomic-tui";

atomic.registerCommand("settings", {
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
          ctx.ui.notify(`${id} = ${newValue}`, "info");
        },
        () => done(undefined),
        { enableSearch: true },
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

### Status indicator

Display persistent mode indicators in the footer:

```typescript
ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("accent", "● active"));
ctx.ui.setStatus("my-ext", undefined); // clear
```

**Examples:** [status-line.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/status-line.ts), [plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts), [preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts)

### Working indicator {#pattern-4b-working-indicator-customization}

Customize the inline Working indicator shown from accepted prompt submission through response streaming:

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

// Restore Atomic's default one-cell ∀ pulse
ctx.ui.setWorkingIndicator();
```

By default, Atomic shows a one-cell `∀` pulse beside a turn status message in a standalone row (custom editors can opt in to embedding it in their top border with `embedWorkingStatus: true`). `NO_COLOR` disables colors and text styles, and `ATOMIC_REDUCED_MOTION=1` freezes the built-in pulse (custom frames and intervals render verbatim).

Working appears during prompt startup and response streaming and disappears on completion, failure, or a no-turn result. Automatic retry, fallback, and compaction loaders use their own built-in indicators and take precedence; successful mid-turn compaction restores Working automatically.

**Examples:** [working-indicator.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts)

### Editor widgets

Show persistent content above or below the input editor (such as todo lists or progress panels):

```typescript
// Simple string array (above editor by default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Render below the editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });

// Component factory with theme
ctx.ui.setWidget("my-widget", (_tui, theme) => {
  const lines = items.map((item) =>
    item.done
      ? theme.fg("success", "✓ ") + theme.fg("muted", item.text)
      : theme.fg("dim", "○ ") + item.text
  );
  return { render: () => lines, invalidate: () => {} };
});

// Clear
ctx.ui.setWidget("my-widget", undefined);
```

To react when the host clears a widget during a UI reset, subscribe with `ctx.ui.onWidgetRelease(key, listener)` when available (replacing a widget with another factory does not trigger release). For ordinary updates, mutate your component state and call `requestRender()` rather than re-registering `setWidget()`.

#### Scrollable widgets

Pass `scroll: { maxHeight: 6 }` (or `{ maxHeight: 10, maxHeightFraction: 1 / 3 }` to scale with live terminal rows) to give a widget its own fullscreen viewport with mouse-wheel scrolling and a one-column overflow scrollbar. Render the full content rather than a pre-clipped slice:

```typescript
import type { ScrollableWidgetComponent, WidgetScrollRequest } from "@bastani/atomic";
import { truncateToWidth } from "@bastani/atomic-tui";

let position: WidgetScrollRequest = { version: 0, scrollTop: 0 };
ctx.ui.setWidget(
  "scrolling-items",
  () =>
    ({
      render: (width) => items.map((item) => truncateToWidth(item.label, width)),
      invalidate() {},
      getScrollRequest: () => position,
      onScroll: (_state) => {
        // state reports { scrollTop, viewportHeight, contentHeight } in rendered rows
      },
    }) satisfies ScrollableWidgetComponent,
  { placement: "belowEditor", scroll: { maxHeight: 6 } },
);

// Increment version only when intentionally repositioning, then request a render
position = { version: position.version + 1, scrollTop: 10 };
ctx.ui.requestRender();
```

`getScrollRequest` and `onScroll` are optional, and `installReactiveWidget` accepts the same `scroll` options. Keep `version` unchanged during ordinary content updates so user wheel scrolling is preserved. Native wheel scrolling requires fullscreen mode and a mouse-capable terminal.

**Examples:** [plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts)

### Custom footer

Replace the footer and read live Git branch and extension statuses from `footerData`:

```typescript
ctx.ui.setFooter((tui, _theme, footerData) => ({
  invalidate() {},
  render(_width: number): string[] {
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()),
}));

ctx.ui.setFooter(undefined); // restore default
```

`ctx.ui.getFooterDataProvider()` exposes the same read-only provider to embedded extension UIs. For a viewer showing a different working directory (`viewerCwd`), pass `viewerCwd` to both `footerData.onBranchChange(listener, viewerCwd)` and `footerData.getGitBranch(viewerCwd)`, and call the returned unsubscribe function on disposal (never call the parent provider's `dispose()`). An unsubscribed `getGitBranch(viewerCwd)` lookup is transient and does not retain a branch watcher.

**Examples:** [custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts)

### Custom editor (vim mode)

Extend `CustomEditor` (not base `Editor`) to customize editing while keeping Atomic's app keybindings (`Escape` to abort, `Ctrl+D` to exit, model switching, and autocomplete):

```typescript
import { CustomEditor, type ExtensionAPI } from "@bastani/atomic";
import { matchesKey, truncateToWidth } from "@bastani/atomic-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") {
        this.mode = "normal";
        return true;
      }
      return super.handleInput(data);
    }

    if (this.mode === "insert") return super.handleInput(data);

    switch (data) {
      case "i": this.mode = "insert"; return true;
      case "h": return super.handleInput("\x1b[D");
      case "j": return super.handleInput("\x1b[B");
      case "k": return super.handleInput("\x1b[A");
      case "l": return super.handleInput("\x1b[C");
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) return false;
    return super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length > 0) {
      const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
      const lastLine = lines[lines.length - 1]!;
      lines[lines.length - 1] = truncateToWidth(lastLine, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
  });
}
```

Pass `undefined` to `ctx.ui.setEditorComponent(undefined)` to restore the default editor. Custom editors exposing `setAutocompleteMaxVisible()` inherit the active `autocompleteMaxVisible` setting.

`new CustomEditor(tui, theme, keybindings, options?)` accepts `CustomEditorOptions`:

| Option | Type | Purpose |
| --- | --- | --- |
| `promptPrefix` | `string` | Custom prompt prefix rendered before input text. |
| `placeholder` | `string \| (() => string)` | Static or dynamic placeholder shown when the editor is empty. |
| `embedWorkingStatus` | `boolean` | When `true`, renders the streaming working indicator inside the editor's top rule instead of a standalone row. |
| `topRuleLabel` | `() => string \| undefined` | Optional dynamic label drawn on the editor's top rule. |
| `paddingX` | `number` | Horizontal padding (inherited from `EditorOptions`). |
| `autocompleteMaxVisible` | `number` | Maximum visible autocomplete rows (inherited from `EditorOptions`). |

<Note>
`setEditorComponent`, `setFooter`, `setHeader`, `onTerminalInput`, and `addAutocompleteProvider` require synchronous terminal callbacks and run only in single-process TUI hosts (they warn and do not run in default isolated interactive mode). See [Extension UI](/extensions/ui).
</Note>

**Examples:** [modal-editor.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts)

### Attached composer

When an extension or custom SDK host embeds a secondary chat editor, `applyAttachedComposer(style, label, placeholder, lines)` styles its rules with accent color, adds a bold `label` to the top rule, and displays a dim `placeholder` while empty:

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

export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const editor = new ReviewerEditor(tui, editorTheme, keybindings);
      editor.appTheme = ctx.ui.theme;
      return editor;
    });
  });
}
```

`applyAttachedComposer()` replaces plain `─` rules and editor overflow rules (`↑ N more` / `↓ N more`). For the bottom border, it scans upward from the end of `lines` to find and recolor the last rule line even when non-rule lines (such as a hint or autocomplete menu) follow it. It inserts `placeholder` only when the editor has a single empty prompt row (the bottom rule is at line index `2` and line `1` is bare `❯`). Long labels truncate with `…`, and below `INPUT_LABEL_MIN_COLUMNS` (`40`) columns the rules render without the label. Pass `undefined` for `label` or `placeholder` to omit either.

For `buildInputLabel()` and `applyInputLabelToEditorTopRule()`, see [Input label helpers](/tui/reference#input-label-helpers).

## Key rules

<Tip>
- **Always use `theme` from callbacks.** Do not import a theme singleton directly; use the `theme` passed to `ctx.ui.custom()`, `setWidget()`, `renderCall()`, or `renderResult()`.
- **Type `DynamicBorder` parameters explicitly.** Write `(s: string) => theme.fg("accent", s)`.
- **Call `tui.requestRender()` after state changes** inside `handleInput()`.
- **Prefer built-in components.** `Selector`, `SelectList`, `SettingsList`, and `BorderedLoader` cover most interactive UI cases.
</Tip>

## Examples

- **Selection UI:** [preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts) (`SelectList` with `DynamicBorder`)
- **Async with cancel:** [qna.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/qna.ts) (`BorderedLoader`)
- **Settings toggles:** [tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts) (`SettingsList`)
- **Status and widgets:** [plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts) (`setStatus`, `setWidget`)
- **Working indicator:** [working-indicator.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts) (`setWorkingIndicator`)
- **Custom footer:** [custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts) (`setFooter`)
- **Custom editor:** [modal-editor.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts) (Vim-like modal editing)
- **Interactive game loop:** [snake.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/snake.ts) (keyboard input and loop)
- **Custom tool rendering:** [todo.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/todo.ts) (`renderCall` and `renderResult`)

Continue to [TUI API reference](/tui/reference) for `ToolBlock`, `ExtensionCustomComponent`, theme invalidation, debug logging, and host-native UI contracts.
