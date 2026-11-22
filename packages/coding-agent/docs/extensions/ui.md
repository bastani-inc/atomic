---
title: Extension UI
description: Render custom UI from an extension.
---

# Extension UI

## Custom UI

Extensions interact with users through `ctx.ui` methods and customize how messages and tools render.

For custom components, see [TUI components](/tui), which provides copy-paste patterns for:

- Selection dialogs (`SelectList`)
- Async operations with cancellation (`BorderedLoader`)
- Settings toggles (`SettingsList`)
- Status indicators (`setStatus`)
- Working message, visibility, and indicator from accepted prompt startup through active turns (`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`)
- Widgets above and below the editor (`setWidget`)
- Autocomplete providers layered on top of built-in slash and path completion (`addAutocompleteProvider`)
- Custom footers (`setFooter`)

### Dialogs

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

Notifications emitted while extensions load or startup is in progress always appear below the startup `RESOURCES` disclosure line, never above it.

#### Timed dialogs with countdown

Dialogs support a `timeout` option that auto-dismisses with a live countdown display:

```typescript
// Dialog shows "Title (5s)", then "Title (4s)", and auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // User confirmed
} else {
  // User cancelled or timed out
}
```

Return values on timeout or caller abort:

- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` and `editor()` return `undefined`

The dialog closes without requiring an answer. These defaults apply to the request's `timeout` and `signal`. Cancelling all pending human input, closing the session, or replacing its input host can still reject with `HumanInputCancelled`.

#### Manual dismissal with AbortSignal

For finer control, such as distinguishing a timeout from a user cancel, pass an `AbortSignal`:

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
  // Dialog timed out
} else {
  // User cancelled (pressed Escape or selected "No")
}
```

See [examples/extensions/timed-confirm.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/timed-confirm.ts) for complete examples.

### Widgets, status, and footer

Inline custom UIs opened with `{ purpose: "navigation" }` temporarily hide every `setWidget()` widget above and below the editor, including the agent panel. Queued-message and pending-shell previews also stay hidden. The widgets and previews keep updating and return with their latest content after the last inline navigation view closes. Overlays and the default `"prompt"` custom UIs do not hide them.

```typescript
// Status in footer (persistent until cleared)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);  // Clear

// Working loader customization (active from accepted prompt startup through the agent turn)
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();  // Restore default
ctx.ui.setWorkingVisible(false);  // Hide the built-in working indicator; the compaction indicator stays visible
ctx.ui.setWorkingVisible(true);   // Show the built-in working indicator

// Working indicator customization (same lifecycle; see TUI Pattern 4b)
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // Static dot
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] });  // Hide indicator
ctx.ui.setWorkingIndicator();  // Restore the default one-cell ∀ luminance ramp
// The working status uses a standalone row by default. A CustomEditor can opt
// into placing it in the top border with { embedWorkingStatus: true }.

// Widget above editor (default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// Widget below editor
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);  // Clear

// Custom footer (replaces built-in footer)
ctx.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);  // Restore built-in footer

// Terminal title
ctx.ui.setTitle("atomic - my-project");

// Editor text
ctx.ui.setEditorText("Prefill text");
const current = ctx.ui.getEditorText();

// Paste into editor (triggers paste handling, including collapse for large content)
ctx.ui.pasteToEditor("pasted content");

// Stack custom autocomplete behavior on top of the built-in provider
ctx.ui.addAutocompleteProvider((current) => ({
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#42", label: "#42", description: "Fix login redirect" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// Tool output expansion
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// Custom editor (vim mode, emacs mode, etc.)
ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ctx.ui.setEditorComponent(undefined);  // Restore default editor

// Theme management (see Themes for creating custom themes)
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");  // Load without switching
const result = ctx.ui.setTheme("light");  // Switch by name
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
ctx.ui.setTheme(lightTheme!);  // Or switch by Theme object
ctx.ui.theme.fg("accent", "styled text");  // Access current theme
```

Calling `setToolsExpanded()` with the current value is a no-op.

The default indicator is `∀`. `ATOMIC_REDUCED_MOTION=1` makes it static, and `NO_COLOR` disables foreground colors. Custom frames and intervals render as supplied; add colors with `ctx.ui.theme.fg(...)` if wanted.

These APIs customize presentation only; they do not start work or emit an extension stream event before prompt startup. See [Working indicator customization](/tui#pattern-4b-working-indicator-customization) for accepted-prompt, pre-stream, and agent-turn handoff timing.

### Autocomplete providers

Use `ctx.ui.addAutocompleteProvider()` to stack custom autocomplete logic on top of the built-in slash-command and path provider.

Return the complete result from a provider you wrap, including its metadata. Slash-command suggestions can set `completeOnConfirm: false` so Enter submits the typed command literally until the user navigates the suggestion list; Tab still accepts the highlighted completion.

Typical pattern:

- Inspect the text before the cursor.
- Return your own suggestions when your extension-specific syntax matches.
- Delegate to `current.getSuggestions(...)` otherwise.
- Delegate `applyCompletion(...)` unless you need custom insertion behavior.

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

See [github-issue-autocomplete.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/github-issue-autocomplete.ts) for a complete example that preloads the latest open GitHub issues with `gh issue list` and filters them locally for `#...` completion. It requires GitHub CLI (`gh`) and a GitHub repository checkout.

### Custom components

For complex UI, use `ctx.ui.custom()`. This temporarily replaces the editor with your component until `done()` is called:

```typescript
import { Text, type Component } from "@bastani/atomic-tui";

class ConfirmPrompt implements Component {
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

  constructor(private readonly done: (value: boolean) => void) {}
}

const result = await ctx.ui.custom<boolean>((_tui, _theme, _keybindings, done) => {
  return new ConfirmPrompt(done);
});

if (result) {
  // User pressed Enter
}
```

The callback receives four arguments:

- `tui`. The TUI instance for screen dimensions and focus management.
- `theme`. The current theme for styling.
- `keybindings`. The app keybinding manager for checking shortcuts.
- `done(value)`. Call to close the component and return a value.

Pass `{ signal }` to dismiss the custom UI when an operation aborts. In-process mode rejects the returned promise with the signal reason; isolated interactive mode resolves it with `undefined`, like host-side cancellation.

Custom component `handleInput` methods must return `true` when they consume an input and `false` or `undefined` when they do not. In fullscreen mode, an unhandled viewport key continues to the transcript; remote components also fall through on a failed or timed-out reply. Return `true` for a handled key so it is not applied twice.

A handler that returns a promise is judged when it settles. Only a resolved `true` consumes the key, while `false`, `undefined`, and a rejection fall through to the viewport. A component with no `handleInput` declines everything, so viewport keys still scroll the transcript behind it.

Pass `{ handlesCtrlC: true }` when the component binds Ctrl+C itself (cancel, skip, or close). In isolated interactive sessions the host otherwise closes a component that owns input on the first Ctrl+C, so a component that never resolves cannot trap the keyboard. See [Interactive callback isolation](/extensions#interactive-callback-isolation).

See [TUI components](/tui) for the full component API.

#### Overlay mode (experimental)

Pass `{ overlay: true }` to render the component as a floating modal on top of existing content, without clearing the screen:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

For positioning (anchors, margins, percentages, and responsive visibility), pass `overlayOptions`. Use `onHandle` to control visibility programmatically:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (handle) => { /* handle.setHidden(true/false) */ }
  }
);
```

See [TUI components](/tui) for the full `OverlayOptions` API and [overlay-qa-tests.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) for examples.

Pass `{ reserveTranscriptRows: true }` for a blocking bottom dialog that must leave at least six transcript rows visible. Set `overlayOptions.anchor` to `bottom-left`, `bottom-center`, or `bottom-right`; `row` and nonzero `offsetY` are rejected. Horizontal placement, margins, and numeric or percentage `maxHeight` remain supported. Reservation updates on resize and visibility changes and ends when the overlay closes. Leave it unset for a full-screen overlay. The built-in `ask_user_question` dialog uses it.

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  {
    overlay: true,
    reserveTranscriptRows: true,
    overlayOptions: { anchor: "bottom-center", width: "100%" },
  }
);
```

A component mounted with `reserveTranscriptRows` always releases configured fullscreen transcript actions and vertical wheel input to the host viewport, including while a nested input has focus. The component keeps all other keyboard and mouse input, including text editing, arrows, confirmation, cancellation, and clicks. This rule applies only to reserving overlays. Other focused overlays still receive page and wheel input first and can keep it by returning `true`.

Embed `OVERLAY_ACTIVE_ROW_MARKER` once per frame on the line that should stay visible when the dialog is cropped, usually the selected row. The first marked line wins, even with `maxHeight: 1`. The marker has zero visible width and is removed before terminal output. Focused inputs also keep their cursor row visible.

```typescript
import { OVERLAY_ACTIVE_ROW_MARKER } from "@bastani/atomic";

render(width: number): string[] {
  return this.items.map((item, index) =>
    index === this.selected ? `${this.row(item, width)}${OVERLAY_ACTIVE_ROW_MARKER}` : this.row(item, width),
  );
}
```

### Custom editor

Replace the main input editor with a custom implementation (such as vim or emacs mode):

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
    return super.handleInput(data);  // App keybindings + text editing
  }
}

export default function (atomic: ExtensionAPI) {
  atomic.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

Key points:

- Extend `CustomEditor` (not base `Editor`) to get app keybindings such as Escape to abort, Ctrl+D, and model switching.
- Call `super.handleInput(data)` for keys you do not handle. A passed-through key keeps its prompt behavior: Down (`app.agents.focus`) on an empty prompt focuses the agent panel, and Left (`app.nav.back`) on an empty prompt returns from a subagent's chat to `main`.
- Editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to place the spinner in the editor border.
- The factory receives `tui`, `theme`, and `keybindings` from the app.
- Call `ctx.ui.getEditorComponent()` before `setEditorComponent()` to wrap a previously configured custom editor.
- Pass `undefined` to restore the default editor: `ctx.ui.setEditorComponent(undefined)`.
- When a custom editor installed through `ctx.ui.setEditorComponent()` exposes `setAutocompleteMaxVisible()`, Atomic initializes it from the active `autocompleteMaxVisible` setting.

To compose with another extension that already replaced the editor, capture the previous factory before setting yours:

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

See [TUI components](/tui) Pattern 7 for a complete example with a mode indicator.

### Message rendering

Register a custom renderer for messages with your `customType`:

```typescript
import { Text } from "@bastani/atomic-tui";

atomic.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  } else if (message.details) {
    text += ` (${options.keyHint("app.tools.expand", "to expand")})`;
  }

  return new Text(text, outputPad, 0);
});
```

In fullscreen mode, clicking the message toggles `expanded` for that message alone (just as Ctrl+O does for every block) and Atomic calls your renderer again.

When the main chat runs in the terminal UI process, a message, saved-entry, or tool renderer's component can handle a click first by returning `{ handled: true }` from `handleMouse`. Leave clicks outside the control unhandled to keep click-to-expand there. A tool's title row always toggles first. A separate engine sends rendered rows rather than mouse callbacks, and if your renderer draws the same rows either way, clicking leaves the message unchanged.

Messages are sent via `atomic.sendMessage()`:

```typescript
atomic.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

### Theme colors

All render functions receive a `theme` object. See [Themes](/themes) for creating custom themes and the full color palette.

```typescript
// Foreground colors
theme.fg("toolTitle", text)   // Tool names
theme.fg("accent", text)      // Highlights
theme.fg("success", text)     // Success (green)
theme.fg("error", text)       // Errors (red)
theme.fg("warning", text)     // Warnings (yellow)
theme.fg("muted", text)       // Secondary text
theme.fg("dim", text)         // Tertiary text

// Text styles
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

For syntax highlighting in custom tool renderers:

```typescript
import { highlightCode, getLanguageFromPath } from "@bastani/atomic";

// Highlight code with explicit language
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// Auto-detect language from file path
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

To label a `read` call's line range from `offset` and `limit` arguments, use `formatReadLineRange`. It accepts numbers, numeric strings, and `null`, and returns an empty string for missing or malformed ranges:

```typescript
import { formatReadLineRange } from "@bastani/atomic";

formatReadLineRange(25, 13);      // ":25-37"
formatReadLineRange("25", null);  // ":25"
formatReadLineRange("abc", 13);   // ""
```

## Next steps

Try the runnable [extension examples](/extensions/examples), and use the [Extension API reference](/extensions/api-reference) for context and method contracts.
