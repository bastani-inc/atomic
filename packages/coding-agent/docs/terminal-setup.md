---
title: "Terminal setup"
description: "Configure terminals for Kitty keyboard protocol, modifier keys, mouse behavior, and program status reporting."
---

# Terminal setup

Atomic uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, though some need extra configuration.

## Kitty

Works out of the box.

## iTerm2

Key reporting works out of the box. In the fullscreen TUI, Atomic owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling its native scrollback.

iTerm2's default fast-trackpad behavior can drop most of an accelerated wheel delta in those reports, which makes fullscreen scrolling slower than native scrolling.

If fast mouse-wheel gestures move only about one line at a time in Atomic:

1. Open iTerm2 settings and go to **Advanced**.
2. Search for **Trackpad scrolls fast?** and set it to **No**.

This setting applies across iTerm2 and may also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Atomic enables enhanced key reporting when available. If Terminal.app still sends plain Return for `SHIFT+Enter`, Atomic uses a local macOS modifier fallback to treat that Return as `SHIFT+Enter`.

This fallback works only when Atomic runs on the same Mac as Terminal.app; it cannot inspect the local keyboard over remote SSH.

Because Terminal.app draws gaps between rows of the block-character logo in the startup header, Atomic shows a text `∀ Atomic` wordmark with the version and session details instead.

## Ghostty

Add to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux):

```text
keybind = alt+backspace=text:\x1b\x7f
```

Older terminal setups may have added this Ghostty mapping:

```text
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte (`CTRL+J`), so tmux and Atomic do not receive a real `shift+enter` key event. Remove it unless another tool in your setup still needs it. Because `ctrl+j` is already bound to `tui.input.newLine` by default (`["shift+enter", "ctrl+j"]`), keeping that mapping still inserts a newline in Atomic with no change to `~/.atomic/agent/keybindings.json`.

In the fullscreen TUI, links stay clickable, though Ghostty does not show its hover underline or lower-left URL preview while Atomic captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

## WezTerm

WezTerm usually works out of the box for `SHIFT+Enter` through xterm `modifyOtherKeys`. To enable the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

On macOS, WezTerm binds `Option+Enter` to fullscreen by default. To forward `Option+Enter` for Atomic follow-up queueing, add this override:

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

On WSL, WezTerm may need a visible hardware cursor to position CJK IME candidate windows. Set `ATOMIC_HARDWARE_CURSOR=1` before running Atomic, or set `"showHardwareCursor": true` in settings. The legacy `PI_HARDWARE_CURSOR=1` alias also works.

## Alacritty

Alacritty usually works out of the box for `SHIFT+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To forward `Option+Enter` for Atomic follow-up queueing, add to `~/.config/alacritty/alacritty.toml`:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after saving the change.

## VS Code (integrated terminal)

VS Code 1.109.5 and newer enable the Kitty keyboard protocol in the integrated terminal by default, so `SHIFT+Enter` works out of the box.

Older VS Code versions need an explicit terminal keybinding in `keybindings.json`:

- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\Code\User\keybindings.json`

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Zed (integrated terminal)

Add these bindings to your Zed `keymap.json`:

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

Add a `shift+enter` action to `settings.json` (press `CTRL+SHIFT+,` or open **Settings**, then **Open JSON file**) so `SHIFT+Enter` inserts a new line:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    }
  ]
}
```

On Windows and WSL, follow-up queueing defaults to `Ctrl+Q` (`Alt+Q` to dequeue), so you do not need to remap `ALT+Enter` for default keybindings. If you manually bind an Atomic action to `alt+enter`, add a matching `sendInput` action for `"keys": "alt+enter"` with `"input": "\u001b[13;3u"` to override Windows Terminal's default fullscreen shortcut.

If you already have an `actions` array, append the entry to it. Fully close and reopen Windows Terminal if the old behavior persists.

## xfce4-terminal and terminator

These terminals have limited escape-sequence support. Modified Enter keys such as `CTRL+Enter` and `SHIFT+Enter` cannot be distinguished from plain `Enter`, so custom bindings such as `"tui.input.submit": ["ctrl+enter"]` will not work.

For full keybinding support, use a terminal with Kitty keyboard protocol support:

- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty) (when built with Kitty protocol support)

## IntelliJ IDEA (integrated terminal)

The built-in terminal has limited escape-sequence support and cannot distinguish `SHIFT+Enter` from `Enter`.

To show the hardware cursor, set `ATOMIC_HARDWARE_CURSOR=1` (legacy alias `PI_HARDWARE_CURSOR=1`) before starting Atomic; the hardware cursor is hidden by default for compatibility. Use a dedicated terminal emulator for full keybinding support.

## Program status

Atomic reports its state with the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status), so supporting terminals and dashboards can show whether it is working, waiting for you, done, or failed:

| State | When |
| --- | --- |
| `working` | An agent run or compaction is in progress. The message is the session name, or `Compacting context`. |
| `blocked` | A dialog, question, or login waits for you. |
| `done` | The agent run finished successfully. The message is the session name. |
| `error` | A run ended with an error that is not retried. The message is the first line of the error. |
| `idle` | Atomic started, or you cancelled the run. |

Reports never include prompts or model output. Atomic sends them only after the terminal answers the protocol's support query; tmux and screen do not forward them. Set `ATOMIC_PROGRAM_STATUS=1` to send reports without querying, or `ATOMIC_PROGRAM_STATUS=0` to disable them (`PI_PROGRAM_STATUS` is a legacy alias).

## Moved sections

<a id="startup-typing" />

Startup typing moved to [Interactive use](/usage#startup-typing).
