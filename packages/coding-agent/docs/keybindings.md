---
title: "Keybindings"
sidebarTitle: "Keybindings"
description: "Default keyboard shortcuts, selector controls, extension shortcut rules, and ~/.atomic/agent/keybindings.json configuration."
---

Customize keyboard shortcuts in `~/.atomic/agent/keybindings.json` (relocated by `ATOMIC_CODING_AGENT_DIR`; see [Environment variables](/environment-variables)). Run `/reload` after editing the file to apply changes without restarting. Add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/keybindings.schema.json"` for editor completion and validation (Atomic ignores `$schema` at load time). See [Use interactive mode](/usage) for editor and queue workflows, and [tmux setup](/tmux) if `Shift+Enter` or `Escape` behaves unexpectedly inside tmux.

## Key format

Write keys as `modifier+key` using any combination of `ctrl`, `shift`, `alt`, and `super`:

- **Letters:** `a` to `z`
- **Digits:** `0` to `9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1` to `f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Examples: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `ctrl+super+x`, `ctrl+1`, `ctrl++`. Support for `super` depends on your terminal.

**Key syntax rules:**

- Modifier order does not matter (`ctrl+shift+p` and `shift+ctrl+p` are equivalent), but duplicate modifiers (such as `ctrl+ctrl+x`) are invalid and never match.
- **`escape` and `esc` never match with any modifier.** Bind plain `escape` or `esc` only.
- Binding `+` with modifiers works (`ctrl++`, `alt++`).

<Note>
**Case sensitivity with `$schema`:** At runtime, key names and modifiers are case-insensitive (`CTRL+P` and `pageup` work). However, the published JSON Schema (`keybindings.schema.json`) validates lowercase modifiers and camelCase special keys (`ctrl+p`, `pageUp`, `pageDown`). Use lowercase modifiers and camelCase special keys if your editor validates against `$schema`.
</Note>

## Custom configuration

Create `~/.atomic/agent/keybindings.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/keybindings.schema.json",
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "app.model.cycleForward": []
}
```

**Configuration rules:**

- **Replacement semantics:** Setting an action in `keybindings.json` **completely replaces** its default keys rather than appending to them. Pass an array to keep defaults alongside a new key, or pass `[]` to unbind the action.
- **Invalid config fallback:** Malformed JSON or a non-object top-level value is ignored and all defaults apply with no warning. Unknown action IDs and entries whose value is not a string or string array are also ignored, leaving defaults intact.
- **Windows and WSL defaults:** WSL defaults apply on Linux whenever `WSL_DISTRO_NAME` or `WSL_INTEROP` is set. On native Windows, `app.suspend` defaults to `alt+z` and opens an interactive PowerShell subshell (leaving `ctrl+z` for editor undo; type `exit` to return while background tasks keep running). On WSL, standard Linux `ctrl+z`/`fg` suspension applies and `tui.editor.undo` defaults to `alt+z`. See [Windows](/windows).

<Warning>
**Two gotchas in `keybindings.json`:**
- **Unrecognized key strings unbind defaults.** Setting a valid action ID to an unrecognized key string (such as `"bogus"` or `"ctrl+ctrl+p"`) replaces its default keys and effectively unbinds the action, with no warning, because the string never matches any keypress.
- **Legacy names rewrite the file in place.** If your file contains older pre-namespaced action names (such as `cursorUp`, `expandTools`, `app.tasks.inspect`, or `app.tasks.cancel`), Atomic migrates them automatically on startup and **rewrites `~/.atomic/agent/keybindings.json` in place** (sorting known keys and dropping any legacy key whose current namespaced equivalent is already present).
</Warning>

### Reserved built-in actions and extension shortcuts

Extensions can register custom shortcuts, which interact with built-in actions and `keybindings.json` as follows:

- **17 reserved built-in actions block extension shortcuts.** If an extension registers a key currently bound to any of these actions, Atomic skips the extension shortcut and logs a warning:
  - `app.interrupt`, `app.clear`, `app.exit`, `app.suspend`
  - `app.thinking.cycle`, `app.thinking.toggle`, `app.model.cycleForward`, `app.model.cycleBackward`, `app.model.select`
  - `app.tools.expand`, `app.editor.external`, `app.message.followUp`
  - `tui.input.submit`, `tui.select.confirm`, `tui.select.cancel`, `tui.input.copy`, `tui.editor.deleteToLineEnd`
- **Remapping moves the reservation.** Rebinding a reserved action in `keybindings.json` moves the reservation to its newly bound key and frees the old key for extensions.
- **Non-reserved built-in actions can be overridden.** If an extension claims a key bound to a non-reserved built-in action, Atomic logs a warning and activates the extension's shortcut. When two extensions claim the same key, the later extension wins with a warning.
- **Duplicate bindings in `keybindings.json` do not warn.** Atomic does not display a UI warning if you assign the same key to two actions in `keybindings.json`, so avoid overlapping keys within the same view.

## All actions

### TUI editor cursor movement

| Keybinding id | Default | Description |
| --- | --- | --- |
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
| --- | --- | --- |
| `tui.editor.deleteCharBackward` | `backspace` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |

### TUI input

| Keybinding id | Default | Description |
| --- | --- | --- |
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | Insert new line |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab / autocomplete (also toggles scope in `/model` and `/resume`) |

### TUI kill ring

| Keybinding id | Default | Description |
| --- | --- | --- |
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-` (`ctrl+z` on native Windows, `alt+z` on WSL) | Undo last edit |

### TUI clipboard and selection

| Keybinding id | Default | Description |
| --- | --- | --- |
| `tui.input.copy` | `ctrl+c` | Reserved editor `Ctrl+C` binding (hands `Ctrl+C` to clear/interrupt/exit rather than editing; does not copy selected text—mouse selection copies automatically in fullscreen mode, and `/copy` copies the last assistant message) |
| `tui.select.up` | `up` | Move selection up |
| `tui.select.down` | `down` | Move selection down |
| `tui.select.pageUp` | `pageUp` | Page up in list |
| `tui.select.pageDown` | `pageDown` | Page down in list |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

Local copy (for `/copy` and mouse auto-copy) requires a working clipboard utility (`wl-clipboard` on Wayland, `xclip` or `xsel` on X11, or Termux:API on Termux). Atomic forwards copies through OSC 52 over SSH, Mosh, and Rex and as a headless Linux fallback; set `ATOMIC_CLIPBOARD_OSC52=1` (legacy `PI_CLIPBOARD_OSC52=1`) to force OSC 52 after local copy. See [Terminal setup](/terminal-setup).

### Fullscreen transcript scrolling {#tui-fullscreen-viewport}

Actions under the `tui.altScreen.*` namespace control scrolling in the fullscreen transcript viewport above the prompt editor. For mouse clicks, text selection, auto-copy, and `ask_user_question` dialog controls, see [Transcript scrolling and mouse](#transcript-scrolling-and-mouse).

While the main editor has focus, `home` and `end` stay with the editor, `ctrl+home` and `ctrl+end` jump to the transcript top and bottom, `pageUp` and `pageDown` scroll the transcript, and `ctrl+pageUp` and `ctrl+pageDown` scroll the editor. Focused overlays and scrollable lists (autocomplete, `/settings`, `/model`) capture scrolling keys first.

| Key | Editor focus | Transcript focus |
| --- | --- | --- |
| `home`, `end` | Editor | Editor |
| `ctrl+home`, `ctrl+end` | *(none)* | Transcript |
| `pageUp`, `pageDown` | Editor | Transcript |
| `ctrl+pageUp`, `ctrl+pageDown` | Editor | Editor |

Rebind these like any other action: for example `"tui.altScreen.pageUp": "ctrl+pageUp"` keeps `pageUp` in the editor and moves transcript paging to `ctrl+pageUp`, and `[]` unbinds a shortcut. Focused custom components may consume viewport keys first; see the [input handling contract](/extensions/ui#custom-components).

| Keybinding id | Default | Description |
| --- | --- | --- |
| `tui.altScreen.pageUp` | `pageUp` | Scroll the transcript up by one page |
| `tui.altScreen.pageDown` | `pageDown` | Scroll the transcript down by one page |
| `tui.altScreen.halfPageUp` | *(none)* | Scroll the transcript up by half a page |
| `tui.altScreen.halfPageDown` | *(none)* | Scroll the transcript down by half a page |
| `tui.altScreen.lineUp` | *(none)* | Scroll the transcript up by one line |
| `tui.altScreen.lineDown` | *(none)* | Scroll the transcript down by one line |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` alone on Windows and WSL) | Jump to the previous message turn (user or assistant message) |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` alone on Windows and WSL) | Jump to the next message turn (user or assistant message) |
| `tui.altScreen.top` | `ctrl+home` | Scroll to the beginning of the transcript |
| `tui.altScreen.bottom` | `ctrl+end` | Scroll to the transcript end and follow new output |

<Note>
Atomic does not ship a find-in-transcript shortcut. Four compatibility action IDs—`tui.altScreen.search`, `tui.altScreen.searchNext`, `tui.altScreen.searchPrevious`, and `tui.altScreen.searchClose`—remain recognized so existing `keybindings.json` files stay valid, but they have no default keys and do nothing.
</Note>

### Application

| Keybinding id | Default | Description |
| --- | --- | --- |
| `app.interrupt` | `escape` | Abort active or queued work and restore queued messages to the editor (pauses a viewed subagent without switching to `main`) |
| `app.clear` | `ctrl+c` | Clear editor text, interrupt work, recover an unresponsive session, or press twice within 0.8 s on an empty idle prompt to exit (while viewing a subagent, pauses it instead of exiting) |
| `app.exit` | `ctrl+d` | Exit when the editor is empty |
| `app.suspend` | `ctrl+z` (`alt+z` on native Windows) | Suspend to background on POSIX and WSL; open a PowerShell subshell on native Windows |
| `app.editor.external` | `ctrl+g` | Open in external editor (`externalEditor`, `$VISUAL`, or `$EDITOR`, falling back to `notepad` on Windows or `nano` on macOS and Linux) |
| `app.history.search` | `ctrl+r` | Search the viewed agent's past prompts and place the chosen one in the editor without sending |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v`, `ctrl+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard |

**Clipboard paste details:**

- On macOS, files copied in Finder paste as paths (one per line, or shell-quoted and space-separated in `!` bash mode). When the clipboard holds text instead of files or an image, `app.clipboard.pasteImage` inserts the text.
- On macOS, native `Cmd+V` (not configurable in `keybindings.json`) pastes images in terminals that forward empty bracketed paste or Kitty `super+v`. Inside tmux on macOS, or when a clipboard holds both text and an image, `Ctrl+V` reliably prefers the image.

**`Ctrl+C`, `Esc`, and `Ctrl+X` routing:**

- `Ctrl+X` does not copy text; paired with `Ctrl+K` it stops all background work ([Navigation](#navigation)), on [OAuth sign-in screens](/providers) it copies the sign-in URL (`app.auth.copyUrl`), and in `/scoped-models` it clears selections. Use `/copy` to copy the viewed agent's last assistant message.
- Physical `Esc` always requests cooperative cancellation without restarting the session. Pressing `Escape` twice within 500 ms on an empty, idle editor triggers `doubleEscapeAction`: `/tree` (`"tree"`, default), `/fork` (`"fork"`), or nothing (`"none"`). Configure it in [Interface and display settings](/settings#interface-and-display).
- Physical `Ctrl+C` closes stuck custom dialogs (dialogs that handle `Ctrl+C` receive the first press and close on the second) and restarts an unresponsive background session process, even if you remap `app.clear`. See [Message queue](/usage#message-queue) for full interrupt and recovery rules.

### Sessions

| Keybinding id | Default | Description |
| --- | --- | --- |
| `app.session.new` | *(none)* | Start a new session (`/new`) |
| `app.session.tree` | *(none)* | Open session tree navigator (`/tree`) |
| `app.session.fork` | *(none)* | Fork current session (`/fork`) |
| `app.session.resume` | *(none)* | Open session resume picker (`/resume`) |
| `app.session.togglePath` | `ctrl+p` | Toggle path display in the session picker |
| `app.session.toggleSort` | `ctrl+s` | Toggle sort mode in the session picker |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named-only filter in the session picker |
| `app.session.rename` | `ctrl+r` | Rename the selected session (interactive `/resume` only) |
| `app.session.delete` | `ctrl+d` | Delete the selected session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete the selected session when the search query is empty |

**Session picker controls and limits (`/resume` and `atomic -r`):**

- `Tab` (`tui.input.tab`) switches between sessions in the current directory and sessions across all directories.
- `Space` (when the search box is empty) toggles a preview pane for the selected session. Press `Esc` to close the preview before cancelling the picker.
- `?` (`app.keys.help`) opens the picker's key overview.
- **Deleting sessions (`Ctrl+D` or `Ctrl+Backspace`):** Requires confirmation (`Enter` confirms; `Esc` or `Ctrl+C` cancels), cannot delete the currently open session, and is **disabled for JSONL session storage**.
- **Renaming sessions (`Ctrl+R`):** Available in interactive `/resume`, **not** in CLI `atomic -r` / `--resume`.
- Cancelling `atomic -r` prints `No session selected` and exits `0`.
- While viewing a subagent, `app.session.new`, `app.session.tree`, and `app.session.fork` ask for confirmation before acting on `main`; `app.session.resume` opens its picker in place.

### Models and thinking

| Keybinding id | Default | Description |
| --- | --- | --- |
| `app.model.select` | `ctrl+l` | Open model selector (`/model`) |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | Cycle to previous model |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |

**`/model` (`Ctrl+L`) selector controls:**

- **`←` / `→`:** Adjust the thinking/effort level of the highlighted reasoning model before selecting it.
- **`Tab` (`tui.input.tab`):** Switch between scoped models and all available models when a model scope (`enabledModels` or `--models`) is active.

Interactive model and thinking choices save automatically as startup defaults; there is no separate save-default shortcut. While viewing a subagent, model and thinking-level changes are refused with a notice (switch to `main` to change them); `app.thinking.toggle` applies to the viewed transcript.

### Display and message queue

| Keybinding id | Default | Description |
| --- | --- | --- |
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool detail in the viewed transcript (main chat or subagent) |
| `app.auth.copyUrl` | `ctrl+x` | Copy the URL on an OAuth sign-in screen |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | Queue follow-up message |
| `app.message.dequeue` | `alt+up` (`alt+q` on Windows and WSL) | Restore queued messages to editor |

Message queue shortcuts work identically on `main` and while viewing a subagent. See [Message queue](/usage#message-queue).

### Navigation

Atomic shares one chat screen across `main` and its subagents, with the [agent panel](/background-tasks#the-agent-panel) below the prompt and `/tasks` for full task inspection. Press `↓` on an empty prompt to focus the agent panel, `←` on an empty prompt while viewing a subagent to return to `main`, `Ctrl+X` then `Ctrl+K` (twice within 3 seconds) to stop all background work, and `?` on an empty prompt or list to show active keys. See [Background tasks](/background-tasks) for full navigation and stop workflows.

| Keybinding id | Default | Description |
| --- | --- | --- |
| `app.nav.back` | `left` | Go back one level in `/tasks`, shell output, or the focused panel, and from a viewed subagent's empty prompt to `main`. `Esc` and `Ctrl+C` never act as this key |
| `app.list.open` | `enter`, `right` | Switch to the selected subagent (or `main`), or open the selected shell output |
| `app.list.stop` | `x` | Stop the selected item (press again to confirm); dismiss a finished one |
| `app.list.peek` | `space` | Peek at the selected task |
| `app.list.filter` | `/` | Filter the list by name |
| `app.keys.help` | `?` | Show the keys of the current screen |
| `app.agents.focus` | `down` | Focus the agent panel from an empty prompt |
| `app.agents.chord` | `ctrl+x` | Start a background-work chord in the main chat |
| `app.agents.stopAll` | `ctrl+k` | After the chord key: stop all background subagents and shells (press twice to confirm) |
| `app.tasks.open` | *(none)* | Reserved for opening the task list (currently has no key handler; use `/tasks` instead) |
| `app.tasks.input` | *(none)* | Open the input box to send standard input to an interactive background shell task in `/tasks` (only when the selected task accepts input) |
| `app.tasks.openWaited` | `alt+w` | Open the output of the shell a waiting subagent waits on, while viewing that subagent or from its `/tasks` row |

On macOS, `Alt+W` requires your terminal to send Option as Meta (enable **Use Option as Meta key** in Terminal.app, set Option to **Esc+** in iTerm2, set `macos-option-as-alt` in Ghostty, or set `macos_option_as_alt both` in kitty). Otherwise remap `app.tasks.openWaited`. Avoid binding `alt+w` to another editor action because `app.tasks.openWaited` takes priority while viewing a waiting subagent or its `/tasks` row.

Open question prompts and the main input box keep keyboard priority; `Esc` leaves task stdin or task detail before leaving task focus, and unbound actions show no key hint.

### Tree navigation

Inside `/tree`, typing filters entries live (automatically unfolding branches), `Backspace` edits the search query, `Esc` clears the search before closing the picker, and `←`/`→` (`tui.editor.cursorLeft` / `tui.editor.cursorRight`) page up and down alongside `PageUp`/`PageDown`.

| Keybinding id | Default | Description |
| --- | --- | --- |
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
| --- | --- | --- |
| `app.models.enableAll` | `ctrl+a` | Enable all models (or all matching the current search) |
| `app.models.clearAll` | `ctrl+x` | Clear all models (or all matching the current search) |
| `app.models.toggleProvider` | `ctrl+p` | Toggle all models for the current provider |
| `app.models.reorderUp` | `alt+up` (`alt+q` on Windows and WSL) | Move the selected model up in the cycle order |
| `app.models.reorderDown` | `alt+down` | Move the selected model down in the cycle order |

### Non-configurable and bundled extension shortcuts

These shortcuts are not configured through `keybindings.json`:

| Shortcut | Scope | Action |
| --- | --- | --- |
| `Shift+Ctrl+D` | Global (non-configurable) | Append a TUI render and unredacted session-message snapshot to `~/.atomic/agent/atomic-debug.log` ([Diagnostics and debugging](/development#debugging)) |
| `Cmd+V` (macOS) | Global (non-configurable) | Paste clipboard images in terminals that forward empty bracketed paste or Kitty `super+v` |
| `Alt+M` | Bundled [Intercom](/intercom) extension | Open the Intercom session list overlay |
| `Ctrl+Shift+S` | Bundled [Web access](/web-access#slash-commands-and-shortcuts) extension | Open the browser search curator while a search runs (configure via `shortcuts.curate` in `~/.atomic/web-search.json`) |
| `Ctrl+Shift+W` | Bundled [Web access](/web-access#slash-commands-and-shortcuts) extension | Toggle the live web-search activity monitor (configure via `shortcuts.activity` in `~/.atomic/web-search.json`) |

## Transcript scrolling and mouse

Interactive sessions run fullscreen with a scrollable transcript above the docked editor. See [Fullscreen transcript scrolling](#tui-fullscreen-viewport) for keyboard paging and jump bindings.

- **Clicking blocks:** Single-click any expandable block (title, preview, `... +N lines`, or its inline `(ctrl+o to expand)` hint) to open or fold that single block on `main` or a subagent—including grouped-call summaries, finished-agent cards, `!` shell blocks, Intercom messages, task notices, skill blocks, branch summaries, and compaction boundaries. Single clicks wait half a second after release so double-clicks, triple-clicks, and drags select text without toggling blocks; clicking a link opens the link. A block keeps its clicked state until `Ctrl+O` resets every block together (thinking blocks toggle separately with `Ctrl+T`).
- **Clicking key hints:** Click a key hint under the prompt, at the bottom of `/tasks`, in dialogs or pickers, in the `?` overlay, or inside notices to trigger that key for the active view. In multi-key hints (`pgup/pgdn scroll`, `↑↓ select`, `1-4 pick`), click the specific key; the trailing label triggers the last key. Slash-command hints such as `/tasks to manage` run the command while preserving your prompt draft, and empty-prompt keys (`?`, `↓`) work when clicked even if the editor holds text. Dragging across a hint selects text; hints behind an open dialog stay inactive.
- **Mouse scrolling and selection:** The mouse wheel scrolls the region under the pointer (and scrolls the transcript when over the editor or footer). Hold `Alt` while scrolling to move five times as far when your terminal forwards Alt with wheel events. While scrolled up, a centered `↓ jump to bottom · ctrl+end` pill appears above the editor and the current turn's opening prompt stays pinned at the top. Viewed subagent transcripts and `/tasks` shell views scroll independently without moving `main`.
- **Auto-copy and Windows right-click paste:** Drag to select characters, double-click for a word or path, and triple-click for a line. Selection copies automatically unless `fullscreenCopyOnSelect` is `false`. On native Windows, pressing the secondary mouse button pastes clipboard text into the focused component, except inside VS Code's integrated terminal (`TERM_PROGRAM=vscode`). See [Terminal setup](/terminal-setup) for mouse and trackpad behavior.

### Dialog controls (`ask_user_question`)

Transcript scroll keys remain active while the bottom-pinned [`ask_user_question`](/tools) dialog or Notes view is open:

- `↑` / `↓` — move between options
- `Enter` — pick an option (`Enter` or `Space` toggles multi-select checkboxes)
- Type on **Type something.** — enter a custom free-text answer
- `n` — add a note
- `Tab` or `←` / `→` — switch between questions
- `Esc` — cancel the dialog

## Preset examples

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
