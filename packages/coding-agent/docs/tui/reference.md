---
title: "TUI API reference"
sidebarTitle: "TUI API"
description: "Reference for Atomic TUI tool blocks, custom component options, theme invalidation, debug logging, and host-native UI contracts."
---

This page documents Atomic's extension TUI contracts exported from `@bastani/atomic`. For task-based extension patterns, see [Build TUI components](/tui). For the underlying terminal renderer, built-in layout primitives, mouse events, IME focus, and keyboard utilities, see [`@bastani/atomic-tui`](/libraries/tui).

## Tool blocks

Use `ToolBlock` from `@bastani/atomic` for a transcript item with a status glyph, one header row, and connected result rows. `new ToolBlock(spec)` accepts `status`, `title`, and optional `args`, `meta`, `details`, `body`, and `outputPad` (default `1`).

Supported `ToolBlockStatus` (aliases `NoticeStatus`) values and their glyphs:

| Category | Status | Glyph | Meaning |
| --- | --- | --- | --- |
| General | `running` | `∀` | Tool call in progress |
| General | `success` | `●` | Completed successfully |
| General | `failure` | `✗` | Failed with an error |
| General | `stopped` | `◼` | Interrupted or not run (muted) |
| General | `warning` | `!` | Warning state |
| General | `paused` | `‖` | Paused (warning color) |
| General | `waiting` | `◌` | Released while waiting on a call; wakes automatically (dim) |
| General | `heartbeat` | `♥` | Periodic check on still-running work (muted) |
| General | `info` | `›` | Informational notice (muted) |
| Subagent / task | `agent-running` | `◯` | Running subagent (grey) |
| Subagent / task | `shell-running` | `⧗` | Running background shell (accent) |
| Subagent / task | `input` | `◆` | Subagent waiting for an answer (warning color) |
| Subagent / task | `task-queued` | `○` | Task waiting for its turn to run (dim) |
| Subagent / task | `task-stopping` | `◼` | Task currently stopping (warning color) |
| Subagent / task | `task-stopped` | `◯` | Stopped subagent or background task (red) |

`TASK_MARKS` from `@bastani/atomic` exports these task glyphs for custom rendering. Exhaustive switches on `ToolBlockStatus` or `NoticeStatus` must handle all 9 general states and all 6 subagent/task states.

A `NoticeLine` reports a task using task marks (`running` draws grey `◯`, `stopped` draws red `◯`, `paused` draws warning-colored `‖`). Under `NO_COLOR`, `agent-running` and `task-stopped` both render plain `◯` and are distinguished by their text.

```typescript
import { ToolBlock, ToolBlockRecords } from "@bastani/atomic";

const item = new ToolBlock({
  status: "success",
  title: "Inspect",
  args: "sample.ts",
  details: new ToolBlockRecords(["Read 42 lines", "No errors found"]),
});
```

- **Spacing and groups:** A `ToolBlock` adds no leading blank line; `ToolBlockGroup` separates multiple blocks with one blank line.
- **Records:** `new ToolBlockRecords(records, { preserveConnectors?: boolean })` renders each string or `Component` record with a leading `⎿` connector. Set `preserveConnectors: true` when child lines already carry their own connector formatting.
- **Markdown inside blocks:** `ToolBlockMarkdown(text)` sanitizes terminal control sequences, renders links as plain text plus URLs (not clickable terminal links), and renders images as `[image]`. The base `Markdown` component from `@bastani/atomic-tui` also accepts per-instance `{ hyperlinks: false, images: false }` in its sixth constructor argument.
- **Tool renderers:** In `renderCall`, return only the call title; in `renderResult`, return unframed result content (or `ToolBlockRecords` when multiple results need separate connectors). Atomic supplies the state glyph and outer connectors.
- **MCP headers:** Bundled MCP tools (`mcp__<server>__<tool>`) render `<server>/<tool>` in the call header before results arrive—including on resumed sessions before the server connects—without opening connections or exposing tool arguments.

### Heartbeat blocks (`HeartbeatBlock`)

`HeartbeatBlock` renders a periodic status check using the `♥` glyph, one header row, connected record rows, and a dim inspect hint:

```typescript
import { HeartbeatBlock, type HeartbeatBlockSpec } from "@bastani/atomic";

const spec: HeartbeatBlockSpec = {
  title: "Task heartbeat",
  subject: "test suite",
  meta: ["2m 15s", "running"],
  records: [["142 passed, 0 failed"]],
  hint: "/tasks to inspect",
  expandable: false,
  expanded: false,
};
const block = new HeartbeatBlock(spec);
```

Each row inside `records` is either a `string` (truncated to width with `…`) or `{ text: string; wrap: true }` (wrapped across lines). When `expandable` is `true` and `expanded` is `false`, Atomic appends the expand key hint (`ctrl+o to expand`) to `hint`.

### Experimental: embedded chat host (`ChatSessionHost`)

<Warning>
`ChatSessionHost` is an experimental internal host exported from `@bastani/atomic` for embedded chats. It is not yet a guaranteed stable extension API and may change across releases.
</Warning>

When embedding `ChatSessionHost`:

- Forward the complete object returned by `ctx.ui.getChatRenderSettings()` (which includes `getToolDefinition`, `getCustomMessageRenderer`, and optional `createToolComponent` / `createCustomMessageComponent` factories) rather than copying only `getToolDefinition`, so tool renderers and repaint/expansion settings stay intact.
- Custom message renderers can read `options.cwd` for the receiving chat's working directory instead of assuming `process.cwd()`.
- `host.replaceMessages(messages)` starts a fresh unread baseline; pass `{ preserveUnread: true }` when applying a newer snapshot of the same conversation so unpainted arrivals stay unread.
- Rows added with `host.appendExtraEntry()` remain in memory until disposal without writing private extension data to disk.
- By default, Atomic keeps custom extension cards from saved chat history in memory when they scroll offscreen so stateful components are not lost. If your renderer can recreate a component deterministically from its saved message, set `historyReplayable: true` as an own data property on the component so Atomic can discard and re-render it on demand to save memory.

## Custom component options {#custom-component-options}

Complete options for `ctx.ui.custom(factory, options?)`:

| Option | Type | Behavior |
| --- | --- | --- |
| `handlesCtrlC` | `boolean` | Default `false` (Atomic closes the component on first `Ctrl+C`). Set `true` only if your component handles `Ctrl+C` cleanly itself. |
| `handlesInternalUiAction` | `boolean` | Set `true` when the component claims internal UI actions such as clicking the jump-to-bottom link. |
| `signal` | `AbortSignal` | Dismisses the component and releases input ownership on abort (resolves `undefined` in CLI TUI; rejects with `signal.reason` in embedded SDK TUI hosts). |
| `purpose` | `"prompt" \| "navigation"` | Default `"prompt"` (for approvals and required decisions). Pass `"navigation"` for inspection/browsing views: suppresses prompt status events and hides `setWidget()` widgets, the agent panel, and queued previews while mounted inline (overlays do not hide them). |
| `blocked` | `{ kind: "question" \| "permission" \| "auth"; message: string }` | Reports Atomic as blocked via [program status](/terminal-setup#program-status). Inline components report blocked while visible; overlays report blocked until `done()` or `signal` abort even when hidden or covered. |
| `overlay` | `boolean` | Mounts the component as a floating overlay. |
| `overlayOptions` | `OverlayOptions \| (() => OverlayOptions)` | Static or dynamic overlay size, anchor, margins, and responsive visibility. |
| `onHandle` | `(handle: OverlayHandle) => void` | Receives the overlay handle for focus and visibility control. |
| `deferInlineCustomUiFocus` | `boolean` | Overlay-only. Keeps pending inline custom UI deferred in the background while the overlay holds focus. |
| `reserveTranscriptRows` | `boolean` | Overlay-only option for blocking bottom-anchored dialogs (`bottom-left`, `bottom-center`, `bottom-right`; rejects `row` and nonzero `offsetY`). Leaves at least 6 transcript rows visible above the overlay and extends scrollback. Embed `OVERLAY_ACTIVE_ROW_MARKER` (from `@bastani/atomic`) once per frame in the active row so Atomic windows cropped overlays around it on short terminals. |

Main-chat inline custom UIs share the editor slot: completing an older mount leaves the current one visible, closing the current mount restores the previous pending inline UI, and the main editor returns only after the last inline owner closes. Reserving bottom prompts wait out of view while inline navigation or an overlay with `deferInlineCustomUiFocus` holds input.

Overlays inspecting host inline custom UI state via `ctx.ui.getHostCustomUiState()` or `ctx.ui.onHostCustomUiStateChange()` receive `HostCustomUiState`:

```typescript
interface HostCustomUiState {
  blockingInlineCustomUiDepth: number;          // Number of active non-overlay host custom UI mounts
  blockingInlineCustomUiActive: boolean;        // True when at least one inline custom UI is mounted
  blockingInlineCustomUiFocusDeferred?: boolean;// True while inline custom UI waits behind a focused overlay
  blockingInlineCustomUiNeedsInput?: boolean;   // Distinguishes required prompts from navigation views
}
```

### Selector helpers {#selector-helpers}

- **`SelectorState`:** Holds search query, filtered rows, selection, and checked rows headless for unit testing. `SelectorState.items` is read-only and frozen; update rows via `state.setItems(rows)` or copy with `[...state.items]`.
- **`selectorHintEntries(state, options)`:** Returns the hint key entries for a `SelectorState`.
- **`themeSelectorStyle()` / `PLAIN_SELECTOR_STYLE`:** Returns themed or unstyled `SelectorStyle` colors.
- **Invalidation:** Call `selector.invalidate()` before `tui.requestRender()` when external data used by a custom `style` or `extraKeys` `enabled` callback changes (`labelStyle` runs on every render).
- **`UserMessageSelectorComponent`:** Implements the `/fork` picker on `Selector`: `new UserMessageSelectorComponent(messages, onSelect, onCancel, initialSelectedId?)` accepts `{ id, text }` user messages oldest first, renders two-line rows, selects `initialSelectedId` or the newest message, and filters as you type. Focus the component directly; `getMessageList()` returns the component, and `onSelect`/`onCancel` are assignable properties.

### Input label helpers {#input-label-helpers}

- **`buildInputLabel(style, name, maxNameWidth, prefix, suffix)`:** Formats a truncated label `{ plain, styled }` (returning `undefined` when `maxNameWidth < 1`).
- **`applyInputLabelToEditorTopRule(style, kind, name, lines)`:** Decorates an editor's top `─` rule with `[stage: <name>]` or `[subagent: <name>]` when terminal width is at least `INPUT_LABEL_MIN_COLUMNS` (`40`).

## Component interface

Atomic extends `@bastani/atomic-tui`'s base [`Component` interface](/libraries/tui#component-interface) with `ExtensionCustomComponent` for components returned by `ctx.ui.custom()`:

```typescript
import type { Component } from "@bastani/atomic-tui";

type ExtensionCustomComponent = Omit<Component, "handleInput"> & {
  handleInput?: (data: string) => boolean | undefined | Promise<boolean | undefined>;
  dispose?(): void;
};
```

- **Consuming input:** Return `true` (or a promise resolving to `true`) from `handleInput()` when your component consumes a fullscreen viewport key or an overlay mouse event. Returning `false`, `undefined`, or rejecting lets matching viewport keys or overlay mouse events fall through to the transcript viewport.
- **Async handlers:** Atomic evaluates async `handleInput()` return values when they settle; unhandled inputs fall through to whichever component holds focus when the promise settles.
- **Pass-through overlays:** A focused overlay without `handleInput` lets fullscreen viewport keys and mouse wheel events scroll the transcript behind it.
- **Non-overlay mouse behavior:** Focused inline components leave mouse scrolling, scrollbar dragging, and text selection with `@bastani/atomic-tui`.
- **Line resets:** The TUI appends full SGR and OSC 8 resets at the end of every rendered line; reapply styles per line or use `wrapTextWithAnsi()`.

See [`@bastani/atomic-tui` Component interface](/libraries/tui#component-interface) for every base `Component` member (`render`, `renderSized`, `handleMouse`, `paintedRowKey`, `selectionTextMayChangeOnReplay`, `historyReplayable`, `wantsKeyRelease`, `capturesViewportInput`, `invalidate`).

## Focusable interface (IME support)

Components that display a text cursor and support CJK/IME input must implement `Focusable` (`focused: boolean`), emit `CURSOR_MARKER` right before `renderFakeCursor(...)`, and—for container dialogs wrapping an `Input` or `Editor`—propagate `focused` down to the child input. See [`@bastani/atomic-tui` Focusable interface](/libraries/tui#focusable-interface-ime-support) for the full implementation pattern.

## Keyboard input

Use `matchesKey(data, Key.*)` from `@bastani/atomic-tui` for keyboard handling (including Kitty protocol sequences), `decodePrintableKey(data)` for printable CSI-u / `modifyOtherKeys` text input, and `normalizePastedText(content)` for bracketed paste normalization. See [`@bastani/atomic-tui` Key detection](/libraries/tui#key-detection).

## Line width

Every line returned by `render(width)` **must not exceed `width` columns** or the renderer throws an error. Use `visibleWidth()`, `truncateToWidth()`, and `wrapTextWithAnsi()` from `@bastani/atomic-tui` (see [`@bastani/atomic-tui` Utilities](/libraries/tui#utilities)).

## Invalidation and theme changes

When the user switches themes or edits a watched custom theme file, the TUI calls `invalidate()` on every mounted component.

<Note>
The `Theme` object passed to Atomic extension callbacks (`ctx.ui.custom`, `setWidget`, `setFooter`, `renderCall`, `renderResult`) is a live proxy that always resolves against the active theme. Store that `theme` reference on your component and call `this.theme.fg(...)` / `this.theme.bg(...)` when rebuilding in `invalidate()`.
</Note>

### Why pre-baked theme strings go stale

If a component bakes ANSI color codes into a child `Text` string in its constructor and never rebuilds that string on `invalidate()`, the cached child retains the old theme's ANSI codes even after its render cache clears:

```typescript
import type { Theme } from "@bastani/atomic";
import { Container, Text } from "@bastani/atomic-tui";

// Wrong: pre-baked colors stay stale after theme switches
class BadComponent extends Container {
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    this.content = new Text(theme.fg("accent", message), 1, 0);
    this.addChild(this.content);
  }
}
```

### Rebuilding themed content on `invalidate()`

Store `private theme: Theme` and rebuild pre-baked strings inside `invalidate()`:

```typescript
import type { Theme } from "@bastani/atomic";
import { Container, Text } from "@bastani/atomic-tui";

class GoodComponent extends Container {
  private message: string;
  private theme: Theme;
  private content: Text;

  constructor(message: string, theme: Theme) {
    super();
    this.message = message;
    this.theme = theme;
    this.content = new Text("", 1, 0);
    this.addChild(this.content);
    this.updateDisplay();
  }

  private updateDisplay(): void {
    this.content.setText(this.theme.fg("accent", this.message));
  }

  override invalidate(): void {
    super.invalidate();   // Clear child caches
    this.updateDisplay(); // Rebuild with active theme
  }
}
```

For complex component trees, clear and rebuild children on `invalidate()`:

```typescript
import type { Theme } from "@bastani/atomic";
import { Container, Spacer, Text } from "@bastani/atomic-tui";

interface SomeData {
  items: { label: string; active: boolean }[];
}

class ComplexComponent extends Container {
  private data: SomeData;
  private theme: Theme;

  constructor(data: SomeData, theme: Theme) {
    super();
    this.data = data;
    this.theme = theme;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Title")), 1, 0));
    this.addChild(new Spacer(1));

    for (const item of this.data.items) {
      const color = item.active ? "success" : "muted";
      this.addChild(new Text(this.theme.fg(color, item.label), 1, 0));
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }
}
```

Rebuild in `invalidate()` whenever you pre-bake `theme.fg()`/`theme.bg()` into child components, cache `highlightCode()` output, or construct themed child trees in the constructor. You do **not** need this pattern when passing theme callbacks evaluated during `render()`, using plain layout containers, or computing styled lines fresh inside `render()`.

## Debug logging

Capture TUI rendering diagnostics and tune escape-key reassembly with these environment variables (legacy `PI_*` aliases work when the `ATOMIC_*` variable is unset):

| Variable | Behavior | Scope |
| --- | --- | --- |
| `ATOMIC_TUI_WRITE_LOG` | Captures raw ANSI bytes written to stdout. Pass a file path, or a directory path to write one `tui-<timestamp>-<pid>.log` file per process. | Both fullscreen (`TuiAltScreen`) and main-screen (`TuiMainScreen`) |
| `ATOMIC_TUI_DEBUG=1` | Writes render snapshots to `/tmp/tui/render-<timestamp>-<random>.log`. | Main-screen (`TuiMainScreen`) only |
| `ATOMIC_TUI_DEBUG_REDRAW=1` | Logs full-redraw triggers to `~/.atomic/agent/pi-tui-debug.log` (or `<agentDir>/pi-tui-debug.log` in Atomic; `<logDirectory>/pi-tui-debug.log` in standalone `@bastani/atomic-tui`, where `logDirectory` must be set). The `pi-` filename prefix is intentional. | Main-screen (`TuiMainScreen`) only |
| `ATOMIC_TUI_ESC_TIMEOUT` | Milliseconds to wait after a lone `ESC` byte before treating it as `Escape` instead of an `Alt`/escape sequence. Default: `10` ms locally, `100` ms when `SSH_CONNECTION` or `SSH_TTY` is set. | Both renderers |

```bash
ATOMIC_TUI_WRITE_LOG=/tmp/tui-ansi.log atomic
```

<Warning>
Captured terminal logs include rendered prompts, code, and tool outputs. Review and redact them before sharing in bug reports.
</Warning>

## Performance

Cache rendered output by width and clear the cache in `invalidate()`:

```typescript
class CachedComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines = this.computeLines(width);
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

Call `invalidate()` when state changes, then `ctx.ui.requestRender()` from extension context or `tui.requestRender()` from a `ctx.ui.custom()` factory.

## Host integration

### Controlling terminal autowrap

Inside Atomic's terminal UI, components never write escape sequences directly to `process.stdout`. Use `tui.terminal.setAutowrap` when a Windows overlay needs to toggle autowrap (DECAWM):

```typescript
await ctx.ui.custom((tui, _theme, _keybindings, done) => {
  tui.terminal.setAutowrap?.(false);
  return new MyOverlay({ onClose: done });
}, { overlay: true });
```

Atomic restores the previous autowrap mode when the component hides, closes, or disposes, or if the terminal host recovers from a crash or restart. In standalone hosts without `setAutowrap`, write escape sequences only when your component owns the terminal directly.

### Detecting fullscreen vs. main-screen mode

`tui.mode` is `"fullscreen"` when Atomic paints on the alternate screen and `"regular"` on the main-screen fallback (`TERM=dumb`, CI, or non-TTY).

Each rendered frame updates `tui.mode` to match the active renderer and invalidates components on mode changes. Because `tui.mode` starts as `"regular"` before the first frame paints, read `tui.mode` inside `render()` rather than caching it in your factory.

### Host-native session picker

Use `ctx.ui.hostSessionPicker(request)` for responsive session-list navigation and search even while an extension is busy. This capability exists in interactive terminal sessions and is absent in headless RPC or print mode; report that limitation instead of building a fallback picker.

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

Each row renders two lines (`name` or `firstMessage`, then age, message count, and summary). Set `title` and `detail` on rows to override those lines for non-session items such as runs; search matches `title`, `detail`, and the row's other text fields.

Set `request.title` for the heading (default `Resume session`), and set `variant: "runs"` (default `"sessions"`) for non-session rows so the heading defaults to `Resume run` and session-only filters and path keys are hidden. Set `canDelete: false` on a row to disable `Ctrl+D` deletion even when `onDelete` is provided. Keep a row until deletion finishes, then remove it with `update()` or report errors with `error()`; rows cannot be selected while deletion is pending.

### Host-native input form

Use `ctx.ui.hostInputForm(request)` for a structured inline form in the editor slot (`Tab`/`Shift+Tab`, arrow keys, configured keybindings, `Enter`, `Escape`, and `Ctrl+C`). The promise rejects with `"The host could not read this input form."` if the host cannot read the form.

```typescript
try {
  const values = await ctx.ui.hostInputForm?.({
    title: "Release",
    heading: "Prepare release",
    submitLabel: "Publish",
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

Every current interactive Atomic host exposes this optional capability, while headless RPC and print modes omit it. Each field header shows `✓` when ready or `✗` with the reason (`required`, `choose one`, `choose on or off`, `must be a whole number`, `must be a whole number within ±9007199254740991`, `must be a number`, `must be on or off`, or `not in choices`). `Enter` on the submit button runs only when every field is ready; booleans accept `true`, `false`, `on`, `off`, `1`, or `0`.
