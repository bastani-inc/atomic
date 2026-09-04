# Keybindings

All keyboard shortcuts can be customized via `~/.atomic/agent/keybindings.json`. Each action can be bound to one or more keys.

The config file uses the same namespaced keybinding ids that Atomic uses internally and that extension authors use in `keyHint()` and injected `keybindings` managers.

Older configs using pre-namespaced ids such as `cursorUp` or `expandTools` are migrated automatically to the namespaced ids on startup.

After editing `keybindings.json`, run `/reload` in Atomic to apply the changes without restarting the session.

## Key Format

`modifier+key` where modifiers are `ctrl`, `shift`, `alt`, or `super` (combinable) and keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Modifier combinations: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `ctrl+super+x`, `ctrl+1`, etc. `super` depends on terminal support.

## All Actions

### TUI Editor Cursor Movement

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.cursorUp` | `up` | Move cursor up |
| `tui.editor.cursorDown` | `down` | Move cursor down |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Move cursor left |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Move cursor right |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Move cursor word left |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right |
| `tui.editor.historyPrevious` | *(none)* | Select the previous prompt history entry |
| `tui.editor.historyNext` | *(none)* | Select the next prompt history entry |
| `tui.editor.cursorLineStart` | `home`, `ctrl+home`, `ctrl+a` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+end`, `ctrl+e` | Move to line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Scroll down by page |

The dedicated history actions always change history entries, regardless of the cursor position in a multiline prompt. Explicit history bindings take precedence over ordinary application action handlers while the main editor is focused, so binding `tui.editor.historyPrevious` to `ctrl+p` or `tui.editor.historyNext` to `ctrl+n` overrides those app actions without changing the same keys in selectors.

### TUI Editor Deletion

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |

### TUI Input

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | Insert new line |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab / autocomplete |

### TUI Kill Ring

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-` | Undo last edit |

### TUI Clipboard and Selection

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | Copy selection |
| `tui.select.up` | `up` | Move selection up |
| `tui.select.down` | `down` | Move selection down |
| `tui.select.pageUp` | `pageUp` | Page up in list |
| `tui.select.pageDown` | `pageDown` | Page down in list |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

### TUI Fullscreen Viewport

Interactive sessions always use this fullscreen viewport for the primary transcript scroll region. Mouse-wheel input scrolls the region under the pointer, falling back to the transcript over the fixed editor/status/footer dock. While the main transcript is scrolled up, a clickable "Jump to latest message" label on its bottom row shows the `tui.altScreen.bottom` shortcut; clicking it returns that transcript to its live end. An attached workflow stage chat keeps its own "Jump to latest message" OSC 8 link with the same shortcut, which returns the stage chat to its live end. Clicking other OSC 8 hyperlinks opens them in the default handler. Dragging with the primary mouse button selects text and, by default, copies it to the clipboard. Set `fullscreenCopyOnSelect` to `false` to retain selections for explicit Ctrl+X copying. See [Terminal setup](/terminal-setup) for terminal-specific mouse and trackpad behavior.


Fullscreen text selection comes from the installed pi-tui 0.85.0 renderer. Drag with the primary button to select characters; double-click selects a word, including complete slash-delimited paths and kebab-case names, and triple-click selects a line. Focus changes and non-drag clicks clear transient selection state, preventing a stale highlight from appearing. A drag release reported with the generic SGR button code also ends the selection. The renderer also reduces mouse tracking in tmux, Zellij, and GNU Screen.
Fullscreen transcript bindings take precedence over editor bindings while the main editor has focus. The default unmodified navigation keys therefore control the transcript, while their `ctrl` variants continue to control the editor. When a fullscreen overlay or inline custom component has focus, Atomic sends matching viewport bindings to that component first. Returning `true` keeps the key local. For an in-process component, returning `false`, `undefined`, or `void` lets transcript scrolling handle it. A remote component's correlated reply falls through on `false`, failure, or timeout; `undefined` after disposal is dropped because that component no longer owns focus.

| Key | Editor action | Fullscreen action |
|-----|---------------|------------------|
| `home`, `end` | Editor | Transcript |
| `ctrl+home`, `ctrl+end` | Editor | Editor |
| `pageUp`, `pageDown` | Editor | Transcript |
| `ctrl+pageUp`, `ctrl+pageDown` | Editor | Editor |

This routing remains configurable through the ordinary action bindings. For example, `"tui.altScreen.pageUp": "ctrl+pageUp"` makes `pageUp` control the editor and `ctrl+pageUp` control the transcript in fullscreen mode. Bind `tui.altScreen.halfPageUp` and `tui.altScreen.halfPageDown` for half-page steps, or `tui.altScreen.lineUp` and `tui.altScreen.lineDown` for single-line steps, while keeping the full-page bindings. Setting `"tui.altScreen.pageUp": []` disables that transcript shortcut entirely. User bindings replace the defaults for that action.
When a fullscreen overlay or inline custom component owns focus, it receives matching `pageUp`, `pageDown`, `home`, `end`, and custom `tui.altScreen.*` bindings before transcript scrolling. Its handler returns `true` when it consumes the key; an unhandled result lets transcript scrolling proceed. Remote components receive a correlated reply and have a bounded fallback if the engine stalls. Mouse-wheel and click sequences follow the same focused-component route, so workflow graphs and stage chats can consume them before unhandled events fall through to the fullscreen viewport.
The blocking `ask_user_question` dialog is pinned to the bottom of the screen as an overlay rather than measured into the layout, so opening it does not shrink the transcript viewport or the page step: `pageUp`, `pageDown`, `home`, `end`, and the wheel move by the same amount and reach every line of the scrollback, including the newest ones, in the strip that stays visible above the dialog. Those transcript actions still work while the Notes editor is open. Notes keeps ordinary text and edit actions, including the default `ctrl+home` and `ctrl+end`; a key moves the transcript instead only when configured for a `tui.altScreen.*` action. The dialog is bounded so the visible strip survives on a short terminal, and the active questionnaire row stays visible inside the bound as you move through single-select choices, multi-select choices, Next, Submit, Cancel, and inline inputs. It keeps its own arrow, `enter`, `tab`, `space`, `esc`, click, and selection input.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.altScreen.pageUp` | `pageUp` | Scroll the transcript up by one page |
| `tui.altScreen.pageDown` | `pageDown` | Scroll the transcript down by one page |
| `tui.altScreen.halfPageUp` | *(none)* | Scroll the transcript up by half a page |
| `tui.altScreen.halfPageDown` | *(none)* | Scroll the transcript down by half a page |
| `tui.altScreen.lineUp` | *(none)* | Scroll the transcript up by one line |
| `tui.altScreen.lineDown` | *(none)* | Scroll the transcript down by one line |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up` | Jump to the previous marked message |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down` | Jump to the next marked message |
| `tui.altScreen.top` | `home` | Scroll to the beginning of the transcript |
| `tui.altScreen.bottom` | `end` | Scroll to the transcript end and follow new output |

Atomic does not ship a find-in-transcript shortcut. The four `tui.altScreen.search*` actions remain in the keybinding table so an existing `keybindings.json` still validates, but they have no default keys and do nothing.

On Windows, pressing the secondary mouse button in fullscreen pastes text from the system clipboard into the focused component.

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Abort active or queued work and restore still-queued steering/follow-up messages to the editor; the session remains paused until an ordinary submission. A message the agent already picked up is answered instead of restored |
| `app.clear` | `ctrl+c` | Interrupt active or queued work, or terminate an unresponsive interactive engine; once idle, clear the editor (press twice while idle to exit) |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.suspend` | `ctrl+z` (none on Windows) | Suspend to background |
| `app.editor.external` | `ctrl+g` | Open in external editor (`$VISUAL` or `$EDITOR`) |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows) | Paste image or text from clipboard |
| `app.message.copy` | `ctrl+x` | When `fullscreenCopyOnSelect` is `false`, copy the active fullscreen selection; otherwise copy the last assistant message |

When `app.clipboard.pasteImage` finds text rather than an image, Atomic inserts that clipboard text into the editor instead of reporting an image-paste failure.

On macOS, native `Cmd+V` also pastes a clipboard image when the copy was image-only. Terminals may deliver that as an empty bracketed-paste event or (with Kitty keyboard protocol, e.g. Ghostty) as `super+v`. Text under `Cmd+V` still goes through normal terminal paste when the terminal sends a paste event. `Cmd+V` is not a configurable Atomic keybinding.

Inside tmux on macOS, `Ctrl+V` is the reliable image-paste shortcut; native `Cmd+V` depends on terminal forwarding. VS Code's terminal may forward the empty bracketed-paste route through tmux, while Ghostty may not forward its Kitty `super+v` route through tmux. This is terminal forwarding behavior, not an Atomic defect.

When the clipboard has both text and an image, behavior depends on the terminal: empty-paste terminals may insert the text on `Cmd+V`, while Kitty-protocol terminals that deliver `super+v` go through the image path (same preference as `Ctrl+V`). `Ctrl+V` always prefers the image. Apple Terminal may send nothing for image-only paste; use Ghostty/iTerm/Kitty or `Ctrl+V` in that case.

Ctrl+X keeps Atomic's hierarchy precedence. A workflow tool-detail view closes to its graph; the scoped-model selector clears its local selection; an attached workflow stage chat returns to its graph; and a workflow graph returns to main chat. Only the main editor then runs `app.message.copy`. Workflow surfaces recognize the physical Ctrl+X chord directly, including CSI variants, rather than the configurable application action. `/copy` is separate and always copies the last assistant message.

A held paused queue by itself is idle for Ctrl+C handling. After an interruption settles, the next Ctrl+C clears the editor without releasing or dequeuing the hold, and a second quick idle press exits normally.

In interactive sessions the agent runs in a supervised engine child (see [Extensions](/extensions#interactive-callback-isolation)). Escape there requests the engine's cooperative cancellation and waits for it with no deadline; it never terminates or replaces the engine.

Both keys are recognized by their physical identity, not by the configured `app.clear` action, so rebinding `app.clear` cannot make Escape stop the engine or take the host route away from Ctrl+C.

Ctrl+C is the host's escape hatch whenever an engine-owned `ctx.ui.custom()` component or overlay holds input: those forward every key to the engine, so a component that never resolves would swallow Ctrl+C. Which component gets the press is decided per mount, in this order:

1. If the engine is provably not answering, the first press terminates and replaces it — a wedged child cannot run the component's own handler either. "Not answering" means the watchdog has declared it unresponsive, a cooperative abort has gone unanswered past the same one-second threshold, a replacement has been waiting for readiness past it, or a replacement failed. A failed replacement keeps Ctrl+C armed so another press can try again; Atomic never retries on its own.
2. Otherwise, if the component declared `handlesCtrlC` when it was mounted, it receives the press and keeps its own Skip, Close, or cancel behavior. The bundled workflow surfaces declare it. If the same component is still holding input on the next press, that press closes it.
3. Otherwise the first press closes that one component, exactly as if it had been cancelled: its `ctx.ui.custom()` promise resolves with `undefined`, the editor comes back, and the engine — along with everything else it has mounted or is running — is left alone.

`tui.select.cancel` still keeps Ctrl+C as local cancel inside host-native selectors, dialogs, input forms, and session pickers.

### Sessions

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.session.new` | *(none)* | Start a new session (`/new`) |
| `app.session.tree` | *(none)* | Open session tree navigator (`/tree`) |
| `app.session.fork` | *(none)* | Fork current session (`/fork`) |
| `app.session.resume` | *(none)* | Open session resume picker (`/resume`) |
| `app.session.togglePath` | `ctrl+p` | Toggle path display |
| `app.session.toggleSort` | `ctrl+s` | Toggle sort mode |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named-only filter |
| `app.session.rename` | `ctrl+r` | Rename session |
| `app.session.delete` | `ctrl+d` | Delete session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete session when query is empty |

### Models and Thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` | Cycle to previous model |
| `app.models.save` | `ctrl+s` | Save the selected default model or scoped model configuration to settings |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.save` | `ctrl+s` | Save current thinking level to settings |
| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |

### Display and Message Queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool and workflow-node detail in main chat or an attached workflow stage chat |
| `app.message.followUp` | `alt+enter` | Queue follow-up message |
| `app.message.dequeue` | `alt+up` | Restore queued messages to editor |

### Tree Navigation

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Fold current branch segment, or jump to the previous segment start |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |
| `app.tree.editLabel` | `shift+l` | Edit the label on the selected tree node |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle label timestamps in the tree |
| `app.tree.filter.default` | `ctrl+d` | Set tree filter to default view |
| `app.tree.filter.noTools` | `ctrl+t` | Toggle tree filter that hides tool results |
| `app.tree.filter.userOnly` | `ctrl+u` | Toggle tree filter that shows only user messages |
| `app.tree.filter.labeledOnly` | `ctrl+l` | Toggle tree filter that shows only labeled entries |
| `app.tree.filter.all` | `ctrl+a` | Toggle tree filter that shows all entries |
| `app.tree.filter.cycleForward` | `ctrl+o` | Cycle tree filter forward |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Cycle tree filter backward |

### Scoped Models Selector

Used inside the scoped models selector (opened via `/scoped-models`).

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.models.save` | `ctrl+s` | Save current model selection to settings |
| `app.models.enableAll` | `ctrl+a` | Enable all models (or all matching the current search) |
| `app.models.clearAll` | `ctrl+x` | Clear all models (or all matching the current search) |
| `app.models.toggleProvider` | `ctrl+p` | Toggle all models for the current provider |
| `app.models.reorderUp` | `alt+up` | Move the selected model up in the cycle order |
| `app.models.reorderDown` | `alt+down` | Move the selected model down in the cycle order |

## Custom Configuration

Create `~/.atomic/agent/keybindings.json`:

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

Each action can have a single key or an array of keys. User config overrides defaults.

On native Windows, `app.suspend` has no default binding because Windows terminals do not support Unix job control. If you bind it manually, Atomic shows a status message instead of suspending. In WSL, the normal Linux `ctrl+z`/`fg` behavior still applies.

### Emacs Example

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim Example

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+w"]
}
```
