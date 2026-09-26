---
title: Extension UI
description: Render custom UI from an extension.
---

# Extension UI

## Custom UI

Extensions can interact with users via `ctx.ui` methods and customize how messages/tools render.

**For custom components, see [TUI components](/tui)** which has copy-paste patterns for:
- Selection dialogs (SelectList)
- Async operations with cancel (BorderedLoader)
- Settings toggles (SettingsList)
- Status indicators (setStatus)
- Working message, visibility, and indicator from accepted prompt startup through active turns (`setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`)
- Widgets above/below editor (setWidget)
- Autocomplete providers layered on top of built-in slash/path completion (addAutocompleteProvider)
- Custom footers (setFooter)

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

#### Timed Dialogs with Countdown

Dialogs support a `timeout` option that auto-dismisses with a live countdown display:

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
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

**Return values on timeout:**
- `select()` returns `undefined`
- `confirm()` returns `false`
- `input()` returns `undefined`

#### Manual Dismissal with AbortSignal

For more control (e.g., to distinguish timeout from user cancel), use `AbortSignal`:

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

### Widgets, Status, and Footer

```typescript
// Status in footer (persistent until cleared)
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);  // Clear

// Working loader customization (active from accepted prompt startup through the agent turn)
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();  // Restore default
ctx.ui.setWorkingVisible(false);  // Hide the built-in working indicator entirely
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

// Custom footer (replaces built-in footer entirely)
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
      items: [{ value: "#2983", label: "#2983", description: "Extension API for autocomplete" }],
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

// Theme management (see themes.md for creating themes)
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

These APIs customize presentation only; they do not start work or emit an extension stream event before prompt startup. See [Working Indicator Customization](/tui#pattern-4b-working-indicator-customization) for accepted-prompt, pre-stream, and agent-turn handoff timing.

### Autocomplete Providers

Use `ctx.ui.addAutocompleteProvider()` to stack custom autocomplete logic on top of the built-in slash-command and path provider.

Typical pattern:

- inspect the text before the cursor
- return your own suggestions when your extension-specific syntax matches
- otherwise delegate to `current.getSuggestions(...)`
- delegate `applyCompletion(...)` unless you need custom insertion behavior

```typescript
pi.on("session_start", (_event, ctx) => {
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
          { value: "#2983", label: "#2983", description: "Extension API for registering custom @ autocomplete providers" },
          { value: "#2753", label: "#2753", description: "Reload stale resource settings" },
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

See [github-issue-autocomplete.ts](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/examples/extensions/github-issue-autocomplete.ts) for a complete example that preloads the latest open GitHub issues with `gh issue list` and filters them locally for fast `#...` completion. It requires GitHub CLI (`gh`) and a GitHub repository checkout.

### Custom Components

For complex UI, use `ctx.ui.custom()`. This temporarily replaces the editor with your component until `done()` is called:

```typescript
import { Text, type Component } from "@earendil-works/pi-tui";

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

The callback receives:
- `tui` - TUI instance (for screen dimensions, focus management)
- `theme` - Current theme for styling
- `keybindings` - App keybinding manager (for checking shortcuts)
- `done(value)` - Call to close component and return value

Pass `{ signal }` to dismiss the custom UI if an operation is aborted; the returned promise rejects with the signal reason.

Pass `{ title }` to say what the prompt asks. It is carried on the `ui_prompt_start` and `ui_prompt_end` events as `title`, the same way `select()`, `confirm()`, `input()`, and `editor()` carry theirs, so status reporters and notifications can name the question instead of only reporting that a custom prompt is open. The built-in `ask_user_question` dialog passes its first question, cut to 120 characters. Without it, observers see `kind: "custom"` and no title.

Custom component `handleInput` methods must return `true` when they consume an input and `false` or `undefined` when they do not. In fullscreen mode, an unhandled viewport key continues to the transcript; remote components also fall through on a failed or timed-out reply. Return `true` for a handled key so it is not applied twice.

A handler that returns a promise is judged when it settles: only a resolved `true` consumes the key, while `false`, `undefined`, and a rejection fall through to the viewport. A component with no `handleInput` declines everything, so viewport keys still scroll the transcript behind it.

Pass `{ handlesCtrlC: true }` when the component binds Ctrl+C itself (cancel, skip, close). In isolated interactive sessions the host otherwise closes a component that owns input on the first Ctrl+C, so that a component which never resolves cannot trap the keyboard. See [Interactive callback isolation](/extensions#interactive-callback-isolation).

See [TUI components](/tui) for the full component API.

#### Overlay Mode (Experimental)

Pass `{ overlay: true }` to render the component as a floating modal on top of existing content, without clearing the screen:

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

For advanced positioning (anchors, margins, percentages, responsive visibility), pass `overlayOptions`. Use `onHandle` to control visibility programmatically:

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

A component mounted with `reserveTranscriptRows` always releases configured fullscreen transcript actions and vertical wheel input to the host viewport, including while a nested input has focus. The component keeps all other keyboard and mouse input, including text editing, arrows, confirmation, cancellation, and clicks. This rule applies only to reserving overlays; other focused overlays still receive page and wheel input first and can keep it by returning `true`.

Embed `OVERLAY_ACTIVE_ROW_MARKER` once per frame on the line that should stay visible when the dialog is cropped, usually the selected row. The first marked line wins, even with `maxHeight: 1`; the marker has zero visible width and is removed before terminal output. Focused inputs also keep their cursor row visible.

```typescript
import { OVERLAY_ACTIVE_ROW_MARKER } from "@bastani/atomic";

render(width: number): string[] {
  return this.items.map((item, index) =>
    index === this.selected ? `${this.row(item, width)}${OVERLAY_ACTIVE_ROW_MARKER}` : this.row(item, width),
  );
}
```

### Custom Editor

Replace the main input editor with a custom implementation (vim mode, emacs mode, etc.):

```typescript
import { CustomEditor, type ExtensionAPI } from "@bastani/atomic";
import { matchesKey } from "@earendil-works/pi-tui";

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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**Key points:**
- Extend `CustomEditor` (not base `Editor`) to get app keybindings (escape to abort, ctrl+d, model switching)
- Call `super.handleInput(data)` for keys you don't handle
- Editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to opt into the editor-border spinner.
- Factory receives `tui`, `theme`, and `keybindings` from the app
- Use `ctx.ui.getEditorComponent()` before `setEditorComponent()` to wrap the previously configured custom editor
- Pass `undefined` to restore default: `ctx.ui.setEditorComponent(undefined)`
- When a custom editor installed through `ctx.ui.setEditorComponent()` exposes `setAutocompleteMaxVisible()`, Atomic initializes it from the active `autocompleteMaxVisible` setting.

To compose with another extension that already replaced the editor, capture the previous factory before setting yours:

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

See [TUI components](/tui) Pattern 7 for a complete example with mode indicator.

### Message Rendering

Register a custom renderer for messages with your `customType`:

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, outputPad, 0);
});
```

Messages are sent via `pi.sendMessage()`:

```typescript
pi.sendMessage({
  customType: "my-extension",  // Matches registerMessageRenderer
  content: "Status update",
  display: true,               // Show in TUI
  details: { ... },            // Available in renderer
});
```

### Theme Colors

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

## Next steps

Try the runnable [extension examples](/extensions/examples), and use the [Extension API reference](/extensions/api-reference) for context and method contracts.
