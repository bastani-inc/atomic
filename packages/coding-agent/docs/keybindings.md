---
title: "Keybindings"
description: "Default keyboard shortcuts and custom ~/.atomic/agent/keybindings.json actions."
---

# Keybindings

Customize keyboard shortcuts in `~/.atomic/agent/keybindings.json`. Each action accepts one key or an array of keys (pass `[]` to unbind).

The config file uses the same namespaced action IDs that Atomic uses internally and that extensions pass to `keyHint()` and injected `keybindings` managers. Older configs using pre-namespaced names such as `cursorUp` or `expandTools` migrate automatically on startup.

After editing `keybindings.json`, run `/reload` to apply changes without restarting. Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/keybindings.schema.json"` for editor completion and validation (Atomic ignores `$schema` at load time).

## Key format

Write keys as `modifier+key` using any combination of `ctrl`, `shift`, `alt`, and `super`:

- **Letters.** `a` to `z`
- **Digits.** `0` to `9`
- **Special.** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function.** `f1` to `f12`
- **Symbols.** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Examples: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `ctrl+super+x`, `ctrl+1`. Support for `super` depends on your terminal.

## All actions

### TUI editor cursor movement

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
| `tui.editor.cursorLineStart` | `home`, `ctrl+a` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e` | Move to line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Scroll down by page |

Dedicated history actions switch prompt history entries regardless of cursor line in a multiline prompt. While the main editor has focus, explicit history bindings override ordinary app shortcuts (such as binding `tui.editor.historyPrevious` to `ctrl+p` or `tui.editor.historyNext` to `ctrl+n`) without changing those keys inside selectors. Prompt history follows whichever agent you are viewing (`main` or a subagent).

### TUI editor deletion

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |

### TUI input

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | Insert new line |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab / autocomplete |

### TUI kill ring

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-` (`ctrl+z` on native Windows, `alt+z` on WSL) | Undo last edit |

### TUI clipboard and selection

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | Copy selection |
| `tui.select.up` | `up` | Move selection up |
| `tui.select.down` | `down` | Move selection down |
| `tui.select.pageUp` | `pageUp` | Page up in list |
| `tui.select.pageDown` | `pageDown` | Page down in list |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

Local copy requires a working clipboard utility (`wl-clipboard` on Wayland, `xclip` or `xsel` on X11, or Termux:API on Termux). Atomic forwards copies through OSC 52 over SSH, Mosh, and Rex and as a headless Linux fallback; set `ATOMIC_CLIPBOARD_OSC52=1` (legacy `PI_CLIPBOARD_OSC52=1`) to force OSC 52 after local copy. See [Terminal setup](/terminal-setup) for terminal clipboard and mouse configuration.

### TUI fullscreen viewport

Interactive sessions run in fullscreen with a scrollable transcript above the docked composer. `app.tools.expand` (`Ctrl+O` by default) expands or collapses all tool and summary blocks in the displayed transcript.

**Clicking blocks:**

- Clicking any expandable block (title, preview, `... +N lines`, or its inline `(ctrl+o to expand)` hint) opens or folds that single block on `main` or a subagent, including grouped-call summaries, finished-agent cards, `!` shell blocks, Intercom messages, task notices, skill blocks, branch summaries, and compaction boundaries.
- Single clicks wait half a second after release so double-clicks, triple-clicks, and drags select text without toggling blocks. Clicking a link opens the link.
- A block stays in its clicked state until `Ctrl+O` resets every block together. Thinking blocks toggle separately with `app.thinking.toggle`.

**Clicking key hints:**

- Clicking a key hint under the prompt, at the bottom of `/tasks`, in dialogs or pickers, in the `?` overlay, or inside notices triggers that key for the active view (except inline `(ctrl+o to expand)` inside a block, which toggles only that block).
- In multi-key hints (`pgup/pgdn scroll`, `↑↓ select`, `1-4 pick`), click the specific key; the trailing label triggers the last key. Slash-command hints such as `/tasks to manage` run the command while preserving your prompt draft.
- Empty-prompt keys such as `?` and `↓` work when clicked even if the prompt holds text. Dragging across a hint selects text; hints behind an open dialog stay inactive.

**Scrolling and mouse selection:**

- The mouse wheel scrolls the region under the pointer (and scrolls the transcript when over the editor or footer). Hold `Alt` while scrolling to move five times as far when your terminal forwards Alt with mouse wheel events.
- When scrolled up, a centered `↓ jump to bottom · ctrl+end` pill appears above the editor (counting new messages as they arrive) and the current turn's opening prompt stays pinned at the top. Viewed subagent transcripts and `/tasks` shell views scroll independently without moving `main`.
- Drag to select characters, double-click for a word or path, and triple-click for a line. Selection copies automatically unless `fullscreenCopyOnSelect` is `false`. On Windows, pressing the secondary mouse button pastes clipboard text into the focused component. See [Terminal setup](/terminal-setup) for mouse and trackpad behavior.

While the main editor has focus, `home` and `end` stay with the editor, `ctrl+home` and `ctrl+end` jump to the transcript top and bottom, `pageUp` and `pageDown` scroll the transcript, and `ctrl+pageUp` and `ctrl+pageDown` scroll the editor. Focused overlays and scrollable lists (autocomplete, `/settings`, `/model`) capture scrolling actions first.

| Key | Editor action | Fullscreen action |
|-----|---------------|------------------|
| `home`, `end` | Editor | Editor |
| `ctrl+home`, `ctrl+end` | *(none)* | Transcript |
| `pageUp`, `pageDown` | Editor | Transcript |
| `ctrl+pageUp`, `ctrl+pageDown` | Editor | Editor |

Rebind these like any other action: for example `"tui.altScreen.pageUp": "ctrl+pageUp"` keeps `pageUp` in the editor and moves transcript paging to `ctrl+pageUp`, and `[]` unbinds a shortcut. Focused custom components may consume viewport keys first; see the [input handling contract](/extensions/ui#custom-components).

Transcript scroll keys also work while the bottom-pinned `ask_user_question` dialog or Notes is open. Inside `ask_user_question`, use `↑`/`↓` to move between options, `Enter` to pick (`Enter` or `Space` to toggle multi-select boxes), type on **Type something.** for a custom answer, `n` to add a note, `Tab` or `←`/`→` to switch questions, and `Esc` to cancel.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.altScreen.pageUp` | `pageUp` | Scroll the transcript up by one page |
| `tui.altScreen.pageDown` | `pageDown` | Scroll the transcript down by one page |
| `tui.altScreen.halfPageUp` | *(none)* | Scroll the transcript up by half a page |
| `tui.altScreen.halfPageDown` | *(none)* | Scroll the transcript down by half a page |
| `tui.altScreen.lineUp` | *(none)* | Scroll the transcript up by one line |
| `tui.altScreen.lineDown` | *(none)* | Scroll the transcript down by one line |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` alone on Windows and WSL) | Jump to the previous marked message |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` alone on Windows and WSL) | Jump to the next marked message |
| `tui.altScreen.top` | `ctrl+home` | Scroll to the beginning of the transcript |
| `tui.altScreen.bottom` | `ctrl+end` | Scroll to the transcript end and follow new output |

Atomic does not ship a find-in-transcript shortcut. The four `tui.altScreen.search*` actions remain in the keybinding table so an existing `keybindings.json` still validates, but they have no default keys and do nothing.

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Abort active or queued work and restore queued messages to the editor (pauses a viewed subagent without switching to `main`) |
| `app.clear` | `ctrl+c` | Clear editor text, interrupt work, recover an unresponsive engine, or press twice within 0.8 s on an empty idle prompt to exit (while viewing a subagent, pauses it instead of exiting) |
| `app.exit` | `ctrl+d` | Exit when the editor is empty |
| `app.suspend` | `ctrl+z` (`alt+z` on native Windows) | Suspend to background on POSIX and WSL; open a PowerShell subshell on native Windows |
| `app.editor.external` | `ctrl+g` | Open in external editor (`externalEditor`, `$VISUAL`, or `$EDITOR`) |
| `app.history.search` | `ctrl+r` | Search the viewed agent's past prompts and place the chosen one in the editor without sending |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v`, `ctrl+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard |

**Clipboard paste details:**

- On macOS, files copied in Finder paste as paths (one per line, or shell-quoted and space-separated in `!` bash mode). When the clipboard holds text instead of files or an image, `app.clipboard.pasteImage` inserts the text.
- On macOS, native `Cmd+V` (not configurable in `keybindings.json`) pastes images in terminals that forward empty bracketed paste or Kitty `super+v`. Inside tmux on macOS, or when a clipboard holds both text and an image, `Ctrl+V` reliably prefers the image.

**`Ctrl+C`, `Esc`, and `Ctrl+X` routing:**

- `Ctrl+X` does not copy text; paired with `Ctrl+K` it stops all background work ([Navigation](#navigation)), on OAuth sign-in screens it copies the sign-in URL (`app.auth.copyUrl`), and in `/scoped-models` it clears selections. Use `/copy` to copy the viewed agent's last assistant message.
- Physical `Esc` always requests cooperative cancellation without replacing the engine, while physical `Ctrl+C` remains the host's recovery route over stalled controls or stuck custom extension UI (`handlesCtrlC` components receive the first press and close on the second). Rebinding `app.clear` does not change that physical routing. See [Message queue](/usage#message-queue) for full interrupt and recovery rules.

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

While viewing a subagent, `app.session.new`, `app.session.tree`, and `app.session.fork` ask for confirmation before acting on `main`; `app.session.resume` opens its picker in place.

### Models and thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | Cycle to previous model |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |

Interactive model and thinking choices save automatically as startup defaults; there is no separate save-default shortcut. While viewing a subagent, model and thinking-level changes are refused with a notice (switch to `main` to change them); `app.thinking.toggle` applies to the viewed transcript.

### Display and message queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool detail in the viewed transcript (main chat or subagent) |
| `app.auth.copyUrl` | `ctrl+x` | Copy the URL on an OAuth sign-in screen |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | Queue follow-up message |
| `app.message.dequeue` | `alt+up` (`alt+q` on Windows and WSL) | Restore queued messages to editor |

Message queue shortcuts work identically on `main` and while viewing a subagent. See [Message queue](/usage#message-queue).

### Navigation

Atomic shares one chat screen across `main` and its subagents, with the [agent panel](/background-tasks#the-agent-panel) below the prompt and `/tasks` for full task inspection. Press `↓` on an empty prompt to focus the agent panel, `←` on an empty prompt while viewing a subagent to return to `main`, `Ctrl+X` then `Ctrl+K` (twice within 3 seconds) to stop all background work, and `?` on an empty prompt or list to show active keys. See [Background tasks](/background-tasks) for full navigation and stop workflows.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.nav.back` | `left` | Go back one level in `/tasks`, shell output, or the focused panel, and from a viewed subagent's empty prompt to `main`. `Esc` and `Ctrl+C` never act as this key |
| `app.list.open` | `enter`, `right` | Switch to the selected subagent (or `main`), or open the selected shell output |
| `app.list.stop` | `x` | Stop the selected item (press again to confirm); dismiss a finished one |
| `app.list.peek` | `space` | Peek at the selected task |
| `app.list.filter` | `/` | Filter the list by name |
| `app.keys.help` | `?` | Show the keys of the current screen |
| `app.agents.focus` | `down` | Focus the agent panel from an empty prompt |
| `app.agents.chord` | `ctrl+x` | Start a background-work chord in the main chat |
| `app.agents.stopAll` | `ctrl+k` | After the chord key: stop all background subagents and shells (press twice to confirm) |
| `app.tasks.open` | Unbound | Command-only `/tasks` route |
| `app.tasks.input` | Unbound | Focus stdin only when the selected task has writable input |
| `app.tasks.openWaited` | `alt+w` | Open the output of the shell a waiting subagent waits on, while viewing that subagent or from its `/tasks` row |

On macOS, `Alt+W` requires your terminal to send Option as Meta (enable **Use Option as Meta key** in Terminal.app, set Option to **Esc+** in iTerm2, set `macos-option-as-alt` in Ghostty, or set `macos_option_as_alt both` in kitty). Otherwise remap `app.tasks.openWaited`. Avoid binding `alt+w` to another editor action because `app.tasks.openWaited` takes priority while viewing a waiting subagent or its `/tasks` row.

Older configs using `app.tasks.inspect` and `app.tasks.cancel` migrate automatically to `app.list.open` and `app.list.stop`. Mounted human-input prompts and the composer retain priority; `Esc` leaves stdin or task detail before leaving task focus, and unbound actions show no key hint.

### Tree navigation

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

### Scoped models selector

Used inside `/scoped-models`. `Enter` toggles the selected model, typing filters by model or provider name, and `Esc` or `Ctrl+C` clears the search before closing. Changes save automatically.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.models.enableAll` | `ctrl+a` | Enable all models (or all matching the current search) |
| `app.models.clearAll` | `ctrl+x` | Clear all models (or all matching the current search) |
| `app.models.toggleProvider` | `ctrl+p` | Toggle all models for the current provider |
| `app.models.reorderUp` | `alt+up` (`alt+q` on Windows and WSL) | Move the selected model up in the cycle order |
| `app.models.reorderDown` | `alt+down` | Move the selected model down in the cycle order |

## Custom configuration

Create `~/.atomic/agent/keybindings.json`:

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

User entries override defaults. On native Windows, `app.suspend` defaults to `alt+z` and opens an interactive PowerShell subshell (leaving `ctrl+z` for editor undo; type `exit` to return while background tasks keep running). In WSL, standard Linux `ctrl+z`/`fg` suspension applies and editor undo defaults to `alt+z`. See [Windows](/windows).

### Emacs example

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

### Vim example

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+e"]
}
```

This example uses `alt+e` instead of `alt+w` so it does not collide with `app.tasks.openWaited` (`alt+w`).
