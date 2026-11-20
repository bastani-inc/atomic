# Keybindings

All keyboard shortcuts can be customized via `~/.atomic/agent/keybindings.json`. Each action can be bound to one or more keys.

The config file uses the same namespaced keybinding ids that Atomic uses internally and that extension authors use in `keyHint()` and injected `keybindings` managers.

Older configs using pre-namespaced ids such as `cursorUp` or `expandTools` are migrated automatically to the namespaced ids on startup.

After editing `keybindings.json`, run `/reload` in Atomic to apply the changes without restarting the session.

For editor completion of every action id and validation of key syntax, add `"$schema": "https://raw.githubusercontent.com/bastani-inc/atomic/main/packages/coding-agent/schemas/keybindings.schema.json"` to `keybindings.json`. Atomic ignores `$schema` when it loads your bindings.

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
| `tui.editor.cursorLineStart` | `home`, `ctrl+a` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e` | Move to line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Scroll down by page |

The dedicated history actions always change history entries, regardless of the cursor position in a multiline prompt. Explicit history bindings take precedence over ordinary application action handlers while the main editor is focused, so binding `tui.editor.historyPrevious` to `ctrl+p` or `tui.editor.historyNext` to `ctrl+n` overrides those app actions without changing the same keys in selectors. Prompt history (`↑`/`↓`, `tui.editor.historyPrevious`/`Next`, and `Ctrl+R`) follows the agent you are viewing: the main chat's history on `main`, or the viewed subagent's own delivered prompts and what you send while viewing it.

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

Local copy operations require a working native clipboard or platform command. On Linux, install `wl-clipboard` for Wayland, `xclip` or `xsel` for X11, or the Termux:API app and `termux-api` package for Termux. Fullscreen selection shows a backend-specific failure message for five seconds. Atomic forwards copies through OSC 52 in SSH, Mosh, and Rex sessions and uses it as a fallback on headless Linux. Set `ATOMIC_CLIPBOARD_OSC52=1`, or its legacy alias `PI_CLIPBOARD_OSC52=1`, to force forwarding after the local clipboard attempt. The terminal must support clipboard forwarding; an OSC 52 write does not confirm a successful local copy.

### TUI Fullscreen Viewport

Tool output uses compact state-marked blocks. `app.tools.expand` (Ctrl+O by default) expands or collapses every block in the displayed transcript, including grouped calls. Consecutive finished reads, searches and directory listings share a summary row. A viewed subagent's transcript also groups finished shell calls; the main chat keeps their individual output previews.

In fullscreen mode, a click anywhere on a block that Ctrl+O expands opens or folds just that block: its title, its output, the `… +N lines` row and its `(ctrl+o to expand)` hint alike. This works whether you are viewing the main chat or a subagent, for tool calls, grouped-call summaries, finished-agent cards, your `!` shell commands, Intercom messages, task notices, skill blocks, branch summaries and compaction boundaries. A click on a summary such as `Read 2 files` shows the calls it groups, and a click on any of them folds them again. Tool calls that start after a click open as Ctrl+O last set them. One that joins a group you opened appears as its own folded block, which a click opens on its own, until Ctrl+O sets every block again. A block with nothing more to show stays as it is.

A click takes effect after you release and at least half a second after the press, once it cannot be the start of a double-click. Holding the second press of a double-click does not turn it into a single click. The click uses the block’s current output and width, even if you resize while it waits. If there are no extra rows to show, the block stays as it was and the chat keeps following new output. Double- and triple-clicks select a word or a line without opening anything, a drag selects text, and a click on a link opens the link. Ctrl+O still sets every block at once and cancels earlier block clicks that haven’t taken effect. When a click expands a block while the chat follows the latest output, the view stays on that block; the jump-to-latest pill takes you back. A block keeps the state you clicked it to until Ctrl+O sets every block again. Thinking blocks are shown or hidden with their own key (`app.thinking.toggle`), not by a click.

In fullscreen mode, a click on a key hint presses its key. This covers the hint rows under the prompt and at the bottom of `/tasks`, dialogs and pickers, the `?` keys overlay, and hints inside tool blocks and notices. The exception is a Ctrl+O hint inside a block, such as `(ctrl+o to expand)`: it is part of the block, so a click on it opens or folds that block alone, as described above, while the `ctrl+o expand` hint under the prompt still expands every block. The key goes to the view that has the keyboard, so a click does what the key does and asks for confirmation where the key asks. In a hint that names two keys, such as `pgup/pgdn scroll` or `↑↓ select`, click the key you want; the label belongs to the last key. The same applies to a numbered hint: in `1-4 pick`, clicking `1` or `-` presses 1, and clicking `4` or `pick` presses 4. A `/` between key names, with or without surrounding spaces, belongs to the first key. If you bind an action to `/`, clicking that slash presses the key even when it is next to a `/` separator. In `esc / / pick`, the first slash belongs to `esc`, and the last slash and `pick` both press `/`. Counts such as `3/5` and paths such as `a/file.txt` in ordinary text are not shortcuts. A hint that wraps onto the next row works from every row it covers. A hint that names a slash command, such as `/tasks to manage`, runs the command and keeps what you typed in the prompt. Keys that act only on an empty prompt when typed, such as `?` and `↓`, act on a click whatever the prompt holds. A drag across a hint selects its text, and a double-click runs it once. Hints drawn behind an open dialog do nothing until the dialog closes. Clicks need the fullscreen renderer's mouse reporting; keyboard behavior is unchanged.

Interactive sessions use a fullscreen transcript. The wheel scrolls the region under the pointer; over the fixed editor, status, or footer it scrolls the transcript. When scrolled up, one centered, highlighted pill above the composer reads `↓ jump to bottom · ctrl+end`, or counts new messages as they arrive. Click it or use `tui.altScreen.bottom` to return to live output. The key label follows your binding; a narrow terminal drops the padding before shortening the label. While scrolled up, the first line of the prompt that started the turn you are reading stays pinned at the top, marked `↑`. Viewed subagent transcripts and `/tasks` shell output views show the same jump row; other OSC 8 links open in the default handler.

While viewing a subagent on the chat screen, every transcript scroll action (`pageUp`/`pageDown`, `halfPageUp`/`halfPageDown`, `lineUp`/`lineDown` when bound, `previousPrompt`/`nextPrompt`, `top`/`bottom`, and the mouse wheel with `fullscreenWheelScrollLines` and Alt+wheel) scrolls that subagent's transcript without moving main's position. Shell output views opened from `/tasks` or a nested shell row scroll with the wheel, `pageUp`/`pageDown`, `halfPageUp`/`halfPageDown`, `top`, and `bottom` (their scrollbar shows position and cannot be dragged).

Dragging selects and copies text by default. Set `fullscreenCopyOnSelect: false` to highlight without copying. See [Terminal setup](/terminal-setup) for mouse and trackpad behavior.

Hold Alt while using the mouse wheel to scroll five times as far in fullscreen mode. This requires the terminal to forward the Alt modifier in mouse events; focused components may still consume the wheel input themselves.

Drag with the primary button to select characters, double-click for a word or path, and triple-click for a line. Changing focus or clicking elsewhere clears the selection.

While the main editor has focus, fullscreen transcript bindings take precedence. `home` and `end` stay with the editor; `ctrl+home` and `ctrl+end` jump to the transcript top and bottom. `pageUp` and `pageDown` control the transcript, while their `ctrl` variants control the editor. While an overlay or a scrollable list such as autocomplete, `/settings`, or the model selector has focus, the scrolling actions go to it instead of the transcript, so `tui.select.pageUp` and `tui.select.pageDown` move the list selection.

| Key | Editor action | Fullscreen action |
|-----|---------------|------------------|
| `home`, `end` | Editor | Editor |
| `ctrl+home`, `ctrl+end` | *(none)* | Transcript |
| `pageUp`, `pageDown` | Editor | Transcript |
| `ctrl+pageUp`, `ctrl+pageDown` | Editor | Editor |

This routing remains configurable through the ordinary action bindings. For example, `"tui.altScreen.pageUp": "ctrl+pageUp"` makes `pageUp` control the editor and `ctrl+pageUp` control the transcript in fullscreen mode. Bind `tui.altScreen.halfPageUp` and `tui.altScreen.halfPageDown` for half-page steps, or `tui.altScreen.lineUp` and `tui.altScreen.lineDown` for single-line steps, while keeping the full-page bindings. Setting `"tui.altScreen.pageUp": []` disables that transcript shortcut entirely. User bindings replace the defaults for that action.
A focused custom component may consume viewport keys and mouse input before the transcript. Extension authors should follow the [input handling contract](/extensions/ui#custom-components).

The blocking `ask_user_question` dialog is a bottom-pinned overlay. Opening it does not shrink the transcript viewport or change the page step. `pageUp`, `pageDown`, `ctrl+home`, `ctrl+end`, and the wheel still reach every scrollback line, including the newest ones, in the visible strip above the dialog.

These transcript actions also work while Notes is open. Notes keeps ordinary text and edit actions, including the default `home` and `end`. A key moves the transcript instead only when configured for a `tui.altScreen.*` action.

Inside the dialog, ↑↓ move between options, `enter` chooses one (in a multi-select question, `enter` or `space` toggles a box and `enter` on **Next** moves on), typing on **Type something.** writes your own answer, `n` adds a note to an option with a preview, `tab` or ←→ move to the next or previous question when there are several, and `esc` cancels the whole dialog. The hint line under the dialog lists the keys of the current step. A custom answer must contain non-whitespace text; its Enter hint appears when it can be submitted. In narrow terminals its descriptions shorten so the selection, notes, question-switching and cancellation keys stay visible. The step line at the top shows every question and **Review**, with the current question counted, such as `2/3`.

On short terminals, the dialog is bounded to preserve that visible strip. The active questionnaire row stays visible as you move through single-select and multi-select choices, Next, Submit, Cancel, and inline inputs. The dialog keeps its own arrow, `enter`, `tab`, `space`, `esc`, click, and selection input.

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

On Windows, pressing the secondary mouse button in fullscreen pastes text from the system clipboard into the focused component.

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Abort active or queued work and restore still-queued steering/follow-up messages to the editor; the session remains paused until an ordinary submission. A message the agent already picked up is answered instead of restored. While viewing a subagent, pauses that subagent (never main) and returns its queued messages to the prompt; sending a message continues it. On an empty prompt with the viewed subagent not working, shows `main` (without counting toward main's double-Esc) |
| `app.clear` | `ctrl+c` | Clear the editor when it has text; otherwise interrupt active or queued work, or terminate an unresponsive interactive engine; on an empty, idle editor, the first press shows "Press Ctrl+C again to exit" and a second press within 0.8 s exits. While viewing a subagent, an empty prompt's Ctrl+C pauses its running work (never main's) and shows `main` in one press, and never offers to exit |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.suspend` | `ctrl+z` (`alt+z` on Windows) | Suspend to background; on Windows, open a PowerShell subshell |
| `app.editor.external` | `ctrl+g` | Open in external editor (`$VISUAL` or `$EDITOR`) |
| `app.history.search` | `ctrl+r` | Search the viewed agent's past prompts (main chat or viewed subagent): newest first, type to filter, Enter puts the prompt in the composer without sending it |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v`, `ctrl+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard |

On macOS, files copied in Finder paste as their paths, one per line, instead of the file icon. In bash mode (input starting with `!`), the paths are shell-quoted and separated by spaces. When `app.clipboard.pasteImage` finds text rather than files or an image, Atomic inserts that clipboard text into the editor instead of reporting an image-paste failure.

On macOS, native `Cmd+V` also pastes a clipboard image when the copy was image-only. Terminals may deliver that as an empty bracketed-paste event or (with Kitty keyboard protocol, e.g. Ghostty) as `super+v`. Text under `Cmd+V` still goes through normal terminal paste when the terminal sends a paste event. `Cmd+V` is not a configurable Atomic keybinding.

Inside tmux on macOS, `Ctrl+V` is the reliable image-paste shortcut; native `Cmd+V` depends on terminal forwarding. VS Code's terminal may forward the empty bracketed-paste route through tmux, while Ghostty may not forward its Kitty `super+v` route through tmux. This is terminal forwarding behavior, not an Atomic defect.

When the clipboard has both text and an image, behavior depends on the terminal: empty-paste terminals may insert the text on `Cmd+V`, while Kitty-protocol terminals that deliver `super+v` go through the image path (same preference as `Ctrl+V`). `Ctrl+V` always prefers the image. Apple Terminal may send nothing for image-only paste; use Ghostty/iTerm/Kitty or `Ctrl+V` in that case.

Ctrl+X does not copy messages or selections, and it no longer moves between chats. Followed by Ctrl+K it is the stop-all chord (see [Navigation](#navigation)); the scoped-model selector clears its local selection with Ctrl+X. `/copy` copies the last assistant message of the viewed agent (main chat or viewed subagent).

On OAuth sign-in screens, Ctrl+X copies the sign-in URL, including long URLs that wrap across lines. This also works in `/mcp login`. Customize this shortcut with `app.auth.copyUrl`; it does not change Ctrl+X behavior outside sign-in screens. Remote sessions use OSC 52 clipboard forwarding as described above.

A held paused queue by itself is idle for Ctrl+C handling. After an interruption settles, Ctrl+C on an empty editor shows the exit hint without releasing or dequeuing the hold, and a second quick press exits normally. Clearing text or interrupting work never counts toward exiting.

In interactive sessions the agent runs in a supervised engine child (see [Extensions](/extensions#interactive-callback-isolation)). Escape there requests the engine's cooperative cancellation and waits for it with no deadline; it never terminates or replaces the engine.

Both keys are recognized by their physical identity, not by the configured `app.clear` action, so rebinding `app.clear` cannot make Escape stop the engine or take the host route away from Ctrl+C.

Ctrl+C is the host's escape hatch whenever an engine-owned `ctx.ui.custom()` component or overlay holds input: those forward every key to the engine, so a component that never resolves would swallow Ctrl+C. Which component gets the press is decided per mount, in this order:

1. If the engine stops answering, the first press terminates and replaces it. This includes a queue clear or cancellation of chat, a shell command, compaction, or a retry unanswered for over one second, a failed clear or cancellation, a replacement waiting over one second for readiness, or a failed replacement. Engine heartbeats do not disarm recovery for a stalled control request. A failed replacement keeps Ctrl+C available for another attempt; a control failure never triggers an automatic restart.
2. Otherwise, if the component declared `handlesCtrlC` when it was mounted, it receives the press and keeps its own Skip, Close, or cancel behavior. If the same component is still holding input on the next press, that press closes it.
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

While viewing a subagent, `app.session.new`, `app.session.tree` and `app.session.fork` ask first (**Cancel** is listed first and selected) and then act on the main conversation; the subagent stays shown unless the key starts or forks a new main session. `app.session.resume` opens its picker in place.

### Models and Thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` | Cycle to previous model |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |

Interactive model and thinking choices automatically become startup defaults. There is no save-default shortcut. While viewing a subagent, `app.model.select`, `app.model.cycleForward`, `app.model.cycleBackward`, and `app.thinking.cycle` are refused with a notice; switch to `main` to change the main conversation's model or thinking level. `app.thinking.toggle` applies to the viewed transcript.

### Display and Message Queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool detail in the viewed transcript (main chat or subagent) |
| `app.auth.copyUrl` | `ctrl+x` | Copy the URL on an OAuth sign-in screen |
| `app.message.followUp` | `alt+enter` | Queue follow-up message |
| `app.message.dequeue` | `alt+up` | Restore queued messages to editor |

The message queue keys work the same whether you are viewing the main chat or a subagent: while the viewed agent works, Enter queues a steering message and `app.message.followUp` a follow-up, each shown as a `Steering:` or `Follow-up:` row above the prompt until the agent reads it, and `app.message.dequeue` brings every queued message back into the prompt.

### Navigation

Atomic uses one chat screen for the main chat and its subagents, with the agent panel below the prompt:

- **Switching agents:** Press **↓** (`app.agents.focus`) on an empty prompt to focus the agent panel. Select a subagent row and press **Enter** or **→** (or click it) to swap the transcript to that subagent and point the same prompt at it; the panel marks the viewed agent with `●` and returns focus to the prompt. Select `main` and press **Enter** (or click `main`) to switch back to the main chat.
- **Esc** interrupts the main chat's turn when viewing `main`, pauses the viewed subagent when it works (returning its queued messages to the prompt), cancels a pending switch, closes a dialog, or deselects the panel. On an empty prompt while the viewed subagent is not working, Esc shows `main`; that press never counts as the first of main's double-Esc. **Ctrl+C** on an empty prompt while viewing a subagent pauses it if it works and shows `main`.
- **Lists (`/tasks` and the focused agent panel):** **↑↓** select, **Enter** or **→** switches the chat screen to a subagent (or opens a shell's output page), **Space** peeks at a task's detail card in `/tasks` (or switches to a subagent waiting on input), **x** stops the selected subagent or nested shell (press it again within 3 seconds to confirm; on a finished item one press dismisses the row), and **Esc** or **←** closes the list or returns focus to the prompt. If an item finishes between the two presses of `x`, the stop is called off and the list says `<name> finished · x to acknowledge`; that press acknowledges the change, and a later `x` dismisses the row after its finished state is painted.
- **← (`app.nav.back`)** goes back one level inside `/tasks` (from a detail or shell output page to the list, or from a nested shell output back to the focused agent panel) and from a shell's empty input prompt back to the list.
- **Ctrl+X Ctrl+K** stops every running background subagent and shell of the session, from any view except a dialog that uses Ctrl+X itself (OAuth sign-in, the scoped-model selector). Press it twice within 3 seconds; the first press says what it will do, and any other key calls it off. Stopped subagents stay resumable: viewing one shows `Stopped · send to resume`, and sending a message resumes it.
- **?** on an empty prompt, or in a list, shows the keys of the current screen; typed after text, `?` is just a character. Esc or `?` closes it.
- A finished subagent stays open to messages when viewed: sending one continues it in its own session, in the same `/tasks` row. A subagent stopped for good, or one no longer kept, is read-only when viewed (the prompt placeholder explains why and typing is ignored, while scrolling still works).
- A shell's input prompt keeps Esc from clearing or leaving it; `←` on its empty input returns to the list, and a draft is kept when you leave.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.nav.back` | `left` | Go back one level in `/tasks`, shell output, or the focused panel |
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

On macOS, Alt+W reaches Atomic only when the terminal sends Option as Meta: turn on **Use Option as Meta key** (Terminal.app), set **Left/Right Option key** to **Esc+** (iTerm2), or set `macos-option-as-alt` (Ghostty) or `macos_option_as_alt both` (kitty, then restart it). Otherwise Option+W types `œ`; remap `app.tasks.openWaited` to another key instead. If you bound Alt+W to another action yourself, such as moving the cursor a word forward, the two collide: while viewing a waiting subagent and on its `/tasks` row, Alt+W opens the shell instead. Give one of them a different key.

**Migrating from earlier versions:** `app.tasks.inspect` is now `app.list.open` and `app.tasks.cancel` is now `app.list.stop`; existing `keybindings.json` entries are migrated on startup. Focus the agent panel (`↓`) and press `Enter` on `main` to return from a viewed subagent to the main chat, or press `Esc` on an empty prompt while it is not working; `Esc` pauses a working subagent. Stopping a task asked for `y`; press `x` a second time instead.

Mounted human-input prompts and the composer retain priority. Escape leaves stdin
or task detail before leaving task focus. Unbound actions have no key hint.

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

Used inside the scoped models selector (opened via `/scoped-models`). Enter switches the selected model on or off, typing filters, and Esc or Ctrl+C clears the search before it closes the selector. Search matches model and provider names, not the reasoning level shown beside a model. Changes are saved automatically.

| Keybinding id | Default | Description |
|--------|---------|-------------|
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

On native Windows, `app.suspend` opens an interactive PowerShell subshell with `alt+z`, leaving `ctrl+z` available for editor undo. Type `exit` to return to the same Atomic session. Atomic and its owned background tasks continue running; this is not process suspension. Ctrl+C in the subshell does not clear or exit Atomic. PowerShell 7 (`pwsh.exe`) is preferred, with Windows PowerShell (`powershell.exe`) as fallback; see [Windows](/windows) for the locations checked. In WSL, the normal Linux `ctrl+z`/`fg` behavior still applies.

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
