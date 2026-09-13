---
title: "TUI components"
description: "Build custom terminal UI for extensions."
---

> Atomic can create TUI components. Ask it to build one for your use case.

# TUI Components

Extensions and custom tools can render custom TUI components for interactive user interfaces. This page covers the component system and available building blocks.

**Source:** TUI components are provided by Atomic's installed `@earendil-works/pi-tui` runtime dependency (`node_modules/@earendil-works/pi-tui/dist/`).

## On this page and its reference

This page covers writing your first component and the common interaction patterns. The component and focusable interfaces, host terminal modes, the host-native session picker and input form, keyboard input, line width, invalidation, debug logging, and performance contracts live in the [TUI API reference](/tui/reference).

## Component Interface

Moved to [TUI API reference](/tui/reference#component-interface).

## Focusable Interface (IME Support)

Moved to [TUI API reference](/tui/reference#focusable-interface-ime-support).

### Container Components with Embedded Inputs

Moved to [TUI API reference](/tui/reference#container-components-with-embedded-inputs).

## Using Components

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

For inspection or navigation, pass `{ purpose: "navigation" }`. Atomic then mounts the component without emitting `ui_prompt_start` / `ui_prompt_end`, so a persistent viewer does not falsely mark Herdr as blocked. The default is `"prompt"`; keep it for approvals and required user decisions. Separate prompts opened while a navigation view is mounted still emit their own lifecycle events.

Navigation still owns keyboard focus. In `getHostCustomUiState()` and its change listener, `blockingInlineCustomUiActive` counts all inline mounts. When navigation is present, `blockingInlineCustomUiNeedsInput` distinguishes real pending prompts from navigation-only mounts; when omitted, use `blockingInlineCustomUiActive`. This distinction is preserved across the isolated-engine bridge.

Main-chat inline custom UIs share the editor slot. Completing or canceling an older mount leaves the current one visible; closing the current mount restores the most recently mounted UI that is still pending, including task navigation or an approval. The main editor returns only after the last inline owner closes. A foreground workflow graph keeps focus until you hide or close it, then the surviving inline UI is visible and receives input.

Reserving bottom prompts (`reserveTranscriptRows`, including `ask_user_question`) also wait out of view while inline navigation or an overlay's `deferInlineCustomUiFocus` owns input. Leaving navigation restores the same pending prompt, not a new questionnaire. Escape belongs exclusively to the active navigation view until then; once the questionnaire returns, its ordinary Escape cancellation applies.

In Atomic's default interactive mode, the component instance remains in the isolated engine child. The terminal host caches rendered lines and forwards input asynchronously, so `render()` and `handleInput()` must not depend on direct access to host process objects. For a matching fullscreen viewport key, or for mouse input while a workflow overlay has focus, the host waits for the child's boolean input reply: `true` keeps the input local, while `false` lets the host transcript process it. Left-button selection events are also mirrored to pi-tui when an overlay handles them, so drag and multi-click selection stays available over fullscreen workflow overlays. Mouse input remains with pi-tui when a non-overlay component has focus, preserving transcript scrolling, scrollbar interaction, and drag selection. A stalled reply has a bounded fallback. The remote bridge preserves pi-tui's key-release contract: release events are filtered unless the child component sets `wantsKeyRelease = true`, matching a directly mounted component. Return values passed to `done()` must be JSON-safe.

### Host terminal modes from an isolated component

Moved to [TUI API reference](/tui/reference#host-terminal-modes-from-an-isolated-component).

### Host-native session picker

Moved to [TUI API reference](/tui/reference#host-native-session-picker).

### Host-native input form

Moved to [TUI API reference](/tui/reference#host-native-input-form).

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

### Overlay Focus

A focused visible overlay keeps input ownership across temporary non-overlay UI. If an overlay opens another `ctx.ui.custom()` component without `{ overlay: true }`, that replacement UI receives input while it is active; when it closes, the focused overlay can reclaim input.

Use `handle.unfocus()` when a visible overlay should stop owning input and let TUI fall back to another visible capturing overlay or the previous focus target. Use `handle.unfocus({ target })` when a specific component should receive input while the overlay stays visible. Passing `{ target: null }` intentionally leaves no focused component until focus is set again.

### Overlay Lifecycle

Overlay components are disposed when closed. Don't reuse references - create fresh instances:

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

See [overlay-qa-tests.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) for comprehensive examples covering anchors, margins, stacking, responsive visibility, and animation.

## Built-in Components

Import from `@earendil-works/pi-tui`:

```typescript
import { Text, Box, Container, Spacer, Markdown } from "@earendil-works/pi-tui";
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

## Keyboard Input

Moved to [TUI API reference](/tui/reference#keyboard-input).

## Line Width

Moved to [TUI API reference](/tui/reference#line-width).

## Creating Custom Components

Example: Interactive selector

```typescript
import {
  matchesKey, Key,
  truncateToWidth, visibleWidth
} from "@earendil-works/pi-tui";

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
import { Markdown } from "@earendil-works/pi-tui";

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

## Debug logging

Moved to [TUI API reference](/tui/reference#debug-logging).

## Performance

Moved to [TUI API reference](/tui/reference#performance).

## Invalidation and Theme Changes

Moved to [TUI API reference](/tui/reference#invalidation-and-theme-changes).

### The Problem

Moved to [TUI API reference](/tui/reference#the-problem).

### The Solution

Moved to [TUI API reference](/tui/reference#the-solution).

### Pattern: Rebuild on Invalidate

Moved to [TUI API reference](/tui/reference#pattern-rebuild-on-invalidate).

### When This Matters

Moved to [TUI API reference](/tui/reference#when-this-matters).

## Common Patterns

These patterns cover the most common UI needs in extensions. **Copy these patterns instead of building from scratch.**

### Pattern 1: Selection Dialog (SelectList)

For letting users pick from a list of options. Use `SelectList` from `@earendil-works/pi-tui` with `DynamicBorder` for framing.

```typescript
import type { ExtensionAPI } from "@bastani/atomic";
import { DynamicBorder } from "@bastani/atomic";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

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

For toggling multiple settings. Use `SettingsList` from `@earendil-works/pi-tui` with `getSettingsListTheme()`.

```typescript
import { getSettingsListTheme } from "@bastani/atomic";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

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

### Pattern 4b: Working Indicator Customization

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

This affects the normal Working indicator from accepted prompt submission through response streaming. It appears in a standalone status row by default; custom editors may opt into placing it in their top border. Newlines and terminal control characters in extension-supplied messages or frames remain stored verbatim, and the standalone row preserves their ordinary multi-line rendering. Working appears immediately during attachment and other pre-stream startup, then continues without a visible gap when the agent turn begins. A no-turn result, prompt failure, or turn completion removes it. An accepted manual retry clears stale status from the prior prompt before showing new pre-stream activity. Factual automatic retry and fallback status takes precedence while that transition is active; ordinary Working resumes only when a later Working lifecycle actually starts. With no extension override, Atomic renders the exact one-cell `∀` immediately before one of its 453 original randomized whimsical working verbs, selected once per turn. Every agent and SDK turn starts at regular weight with a fresh lifecycle-relative 88ms cadence, then follows a ten-frame, theme-aware dark → accent → bright/bold → accent → dark luminance ramp without changing glyph or geometry. Optional theme tone overrides control any desired phases exactly, including terminal palette indices 0–255; Atomic derives omitted tones from selected-surface, `accent`, and `text` roles. Dark, light, custom, and dynamically reloaded themes therefore retain their own palette. Under `NO_COLOR`, the same cadence remains visible through regular/bold weight without foreground-color escapes. Turn completion and terminal cleanup stop the timer cleanly. Restoring Atomic's default after an extension override also restarts at the dark regular phase; custom extension frames and intervals remain unchanged and render verbatim. `ATOMIC_REDUCED_MOTION=1` shows a static regular accent `∀` without an animation timer. The icon and longest message fit standard and 64-column widths. Factual status copy takes precedence. Compaction and automatic retry loaders use the built-in `∀` indicator with their own status text, not extension-provided frames or whimsical messages. Rate-limit and summary retry countdowns honor the same theme, reduced-motion, and `NO_COLOR` behavior while continuing to update the remaining delay. During successful post-tool autocompaction, Atomic temporarily replaces the Working indicator with the compaction loader and restores it before the same stream continues; no additional user input is required.

Post-tool autocompaction is more precisely delimited by its own event pair. Pi opens the follow-up turn while the compaction is still unmatched, so the compaction status — not a generic Working message — owns the status surface from `compaction_start` until `compaction_end`, and the interposed turn does not take it back early. The status paints as soon as the compaction starts rather than on the next animation frame, in the main chat and in an attached workflow-stage chat alike. Ordinary Working then resumes for the continuing stream on any successful mid-turn completion, including a compaction that found nothing to compact and therefore reports no result. A cancelled or failed compaction stops all activity instead. The main chat reports automatic cancellation; an attached workflow-stage chat clears the transient status because the abort event carries no error text. Failures retain their event-provided error text.

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

Hosts may clear extension widgets during a UI reset. A reactive extension that needs to keep a long-lived widget registration can observe `ctx.ui.onWidgetRelease(key, listener)` when available.
The listener runs after the host removes that key, so the extension can reset local mount state and re-register on its next refresh. Ordinary content changes should continue to update the existing component with `requestRender()` rather than repeatedly calling `setWidget()`.

#### Scrollable widgets

Opt in with `scroll: { maxHeight: 6 }` to give a widget its own fullscreen viewport. The host may allocate fewer rows when the editor or other widgets need space. Render the full content, not a pre-clipped slice. Wheel input over the widget scrolls only that widget, including at either end. A one-column scrollbar appears only while content overflows. Scrolling does not take editor focus or register keyboard shortcuts.

```typescript
import type { ScrollableWidgetComponent, WidgetScrollRequest } from "@bastani/atomic";
import { truncateToWidth } from "@earendil-works/pi-tui";

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

`ctx.ui.getFooterDataProvider()` exposes the same read-only provider to embedded extension UIs. In isolated interactive mode Atomic maintains the provider inside the engine session, mirrors every `setStatus()` update into it, and uses the session cwd with the same cached Git-branch watcher, so synchronous renderers can read current status and branch data without an RPC round trip or per-render Git process.

For a workflow-stage session with a different cwd, subscribe with that cwd to retain its branch watcher, and read the live branch during each render using the same raw cwd string:

```typescript
// stageCwd is fixed for this viewer's lifetime.
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    return [`${ctx.model?.id} (${footerData.getGitBranch(stageCwd) || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender(), stageCwd),
}));
```

The returned unsubscribe function belongs to the viewer: call it on disposal or before replacing the viewer's cwd, then subscribe for the new cwd. Embedded UIs using `ctx.ui.getFooterDataProvider()` must likewise release their own subscription. Active viewers using the same raw cwd share the cached provider and watcher; the last unsubscribe releases that alternate-cwd resource. Do not call the parent provider's `dispose()` from an individual viewer.

An unleased `getGitBranch(stageCwd)` lookup is transient: it does not retain an alternate-cwd cache or watcher, so an unscoped callback alone does not enable stage-branch updates. Scoped subscriptions retain resources, but notifications still reach the same branch-change listeners; they are not filtered by cwd. Omitting the cwd argument retains the provider's own cwd behavior shown in the default recipe above.

Token stats available via `ctx.sessionManager.getBranch()` and `ctx.model`.

**Examples:** [custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts)

### Pattern 7: Custom Editor (vim mode, etc.)

Replace the main input editor with a custom implementation. Useful for modal editing (vim), different keybindings (emacs), or specialized input handling.

```typescript
import { CustomEditor, type ExtensionAPI } from "@bastani/atomic";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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

## Key Rules

1. **Always use theme from callback** - Don't import theme directly. Use `theme` from the `ctx.ui.custom((tui, theme, keybindings, done) => ...)` callback.

2. **Always type DynamicBorder color param** - Write `(s: string) => theme.fg("accent", s)`, not `(s) => theme.fg("accent", s)`.

3. **Call tui.requestRender() after state changes** - In `handleInput`, call `tui.requestRender()` after updating state.

4. **Return the three-method object** - Custom components need `{ render, invalidate, handleInput }`.

5. **Use existing components** - `SelectList`, `SettingsList`, `BorderedLoader` cover 90% of cases. Don't rebuild them.

## Examples

- **Selection UI**: [examples/extensions/preset.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/preset.ts) - SelectList with DynamicBorder framing
- **Async with cancel**: [examples/extensions/qna.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/qna.ts) - BorderedLoader for LLM calls
- **Settings toggles**: [examples/extensions/tools.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/tools.ts) - SettingsList for tool enable/disable
- **Status indicators**: [examples/extensions/plan-mode/index.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/plan-mode/index.ts) - setStatus and setWidget
- **Working indicator**: [examples/extensions/working-indicator.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts) - setWorkingIndicator
- **Custom footer**: [examples/extensions/custom-footer.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts) - setFooter with stats
- **Custom editor**: [examples/extensions/modal-editor.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts) - Vim-like modal editing
- **Snake game**: [examples/extensions/snake.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/snake.ts) - Full game with keyboard input, game loop
- **Custom tool rendering**: [examples/extensions/todo.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/todo.ts) - renderCall and renderResult
