# Terminal Setup

Atomic uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

## Startup typing

Moved to [Using Atomic](/usage#startup-typing).

## Kitty

Works out of the box.

## iTerm2

Key reporting works out of the box. In the fullscreen TUI, Atomic owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling its native scrollback.

iTerm2's default fast-trackpad behavior can lose most of an accelerated wheel delta in those reports. This makes fullscreen scrolling much slower than native scrolling.

If fast mouse-wheel gestures move only about one line at a time in Atomic:

1. Open **iTerm2 → Settings → Advanced**.
2. Search for **Trackpad scrolls fast?** and set it to **No**.

This is an iTerm2-wide workaround and may also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Atomic enables enhanced key reporting when available. If Terminal.app still sends plain Return for `SHIFT+Enter`, Atomic uses a local macOS modifier fallback to treat that Return as `SHIFT+Enter`.

This fallback only works when Atomic runs on the same Mac as Terminal.app. It cannot detect the local keyboard over remote SSH.

Terminal.app draws gaps between rows of the block-character logo in the startup header. There, Atomic shows a text `∀ Atomic` wordmark with the version and session details instead of the logo.

## Ghostty

Add to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux):

```
keybind = alt+backspace=text:\x1b\x7f
```

Older Claude Code versions may have added this Ghostty mapping:

```
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte. Inside Atomic, that is indistinguishable from `CTRL+J`, so tmux and Atomic no longer see a real `shift+enter` key event.

If you added that mapping only for Claude Code, you can remove it with Claude Code 2.x or newer. Keep it if you use Claude Code in tmux, where the mapping is still required.

If you want `SHIFT+Enter` to keep working in tmux via that remap, add `ctrl+j` to your Atomic `tui.input.newLine` keybinding in `~/.atomic/agent/keybindings.json`:

```json
{
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

In the fullscreen TUI, links remain clickable, but Ghostty does not show its hover underline or lower-left URL preview while Atomic captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

## WezTerm

WezTerm usually works out of the box for `SHIFT+Enter` via xterm modifyOtherKeys. To use the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

On macOS, WezTerm binds `Option+Enter` to fullscreen by default. To use `Option+Enter` for Atomic follow-up queueing, add this key override:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

If you already have a `config.keys` table, add the entry to it.

On WSL, WezTerm may require a visible hardware cursor for IME candidate window positioning. If CJK IME candidates do not follow the text cursor, set `ATOMIC_HARDWARE_CURSOR=1` before running Atomic or set `showHardwareCursor` to `true` in settings. The legacy `PI_HARDWARE_CURSOR=1` alias also works.

## Alacritty

Alacritty usually works out of the box for `SHIFT+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To use `Option+Enter` for Atomic follow-up queueing, add to `~/.config/alacritty/alacritty.toml`:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after changing the config.

## VS Code (Integrated Terminal)

VS Code 1.109.5 and newer enable Kitty keyboard protocol in the integrated terminal by default, so `SHIFT+Enter` should work out of the box.

VS Code versions older than 1.109.5 need an explicit terminal keybinding for `SHIFT+Enter`.

`keybindings.json` locations:
- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

Add to `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Zed (Integrated Terminal)

Add these key bindings to your Zed `keymap.json`:

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Add to `settings.json` (CTRL+SHIFT+, or Settings → Open JSON file) to forward the modified Enter keys Atomic uses:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `SHIFT+Enter` inserts a new line.
- Windows Terminal binds `ALT+Enter` to fullscreen by default. That prevents Atomic from receiving `ALT+Enter` for follow-up queueing.
- Remapping `ALT+Enter` to `sendInput` forwards the real key chord to Atomic instead.

If you already have an `actions` array, add the objects to it. If the old fullscreen behavior persists, fully close and reopen Windows Terminal.

## xfce4-terminal, terminator

These terminals have limited escape sequence support. Modified Enter keys like `CTRL+Enter` and `SHIFT+Enter` cannot be distinguished from plain `Enter`, preventing custom keybindings such as `submit: ["ctrl+enter"]` from working.

For the best experience, use a terminal that supports the Kitty keyboard protocol:
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty) (requires compilation with Kitty protocol support)

## IntelliJ IDEA (Integrated Terminal)

The built-in terminal has limited escape sequence support. SHIFT+Enter cannot be distinguished from Enter in IntelliJ's terminal.

If you want the hardware cursor visible, set `ATOMIC_HARDWARE_CURSOR=1` before running Atomic. The legacy `PI_HARDWARE_CURSOR=1` alias also works; the hardware cursor is disabled by default for compatibility.

Consider using a dedicated terminal emulator for the best experience.

## Program status

Atomic reports its state with the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status), so supporting terminals and dashboards can show whether it is working, waiting for you, done, or failed:

| State | When |
|---|---|
| `working` | An agent run, compaction, or [workflow](/workflows) run is in progress, even when the chat agent is idle. The message is the session name, or `Compacting context`. |
| `blocked` | An extension dialog, login, or workflow run or stage waits for you, even while other stages of that run are still executing. The message is the dialog title, or `Workflow waiting for input` or `Workflow needs attention`. |
| `done` | The agent run and workflow runs finished successfully. The message is the session name. |
| `error` | A run ended with an error that is not retried, or a workflow run failed. The message is the first line of the error, or `Workflow failed`. |
| `idle` | Atomic started, or you cancelled the run. |

A workflow failure stays reported as `error` while the chat agent replies to the run-end notice, until you send your next message. While a workflow run is working or waiting for you, the chat agent finishing a turn does not report `done`.

Reports never contain prompts or model output. Atomic sends them only after the terminal answers the protocol's support query; tmux and screen do not forward them. Set `PI_PROGRAM_STATUS=1` to send reports without asking, or `PI_PROGRAM_STATUS=0` to disable reports.
