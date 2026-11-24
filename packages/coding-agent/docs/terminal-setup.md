---
title: "Terminal setup"
sidebarTitle: "Terminal setup"
description: "Configure terminal emulators for modified keys, mouse and clipboard behavior, inline images, hyperlinks, and status reporting."
---

## How keyboard detection works

Atomic enables the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) when your terminal supports it and falls back to xterm `modifyOtherKeys` where available. Most modern terminal emulators work out of the box; a few need one setting or keybinding override.

Both `Shift+Enter` and `Ctrl+J` insert a newline by default (`tui.input.newLine`). If your terminal cannot tell `Shift+Enter` apart from `Enter`, press `Ctrl+J` right away without changing any config.

## Terminal emulator settings

### Kitty

Works out of the box, including Kitty inline images, OSC 8 hyperlinks, truecolor, and modified keys.

### iTerm2

Key reporting, iTerm2 inline images, OSC 8 hyperlinks, and truecolor work out of the box. In the fullscreen TUI, Atomic owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling its native scrollback.

iTerm2's default fast-trackpad setting can drop most of an accelerated wheel delta in those reports, making fullscreen scrolling feel slower than native scrolling. If fast trackpad scrolls move only about one line at a time:

1. Open iTerm2 settings and go to **Advanced**.
2. Search for **Trackpad scrolls fast?** and set it to **No**.

This setting applies across iTerm2 and may also affect native trackpad scrolling. See [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

### Apple Terminal

Atomic enables enhanced key reporting when available. If Terminal.app still sends plain Return or `ESC+CR` when you press `Shift+Enter`, Atomic uses a local macOS modifier fallback to recognize `Shift+Enter`. This fallback works only when Atomic runs on the same Mac as Terminal.app, not over remote SSH.

Apple Terminal does not support 24-bit truecolor, so Atomic automatically uses 256-color mode. Because Terminal.app draws gaps between rows of the block-character logo, Atomic displays a text `∀ Atomic` wordmark with version and session details instead.

### Ghostty

Add this line to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux) so `Option+Backspace` or `Alt+Backspace` deletes the previous word cleanly:

```text
keybind = alt+backspace=text:\x1b\x7f
```

Older setups may have added:

```text
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte (`Ctrl+J`), preventing tmux and Atomic from seeing a real `Shift+Enter` key event. Remove it unless another tool still needs it. Because `Ctrl+J` is already bound to `tui.input.newLine` (`["shift+enter", "ctrl+j"]`), keeping it still inserts a newline in Atomic with no change to `~/.atomic/agent/keybindings.json`.

In the fullscreen TUI, links stay clickable, though Ghostty hides its hover underline and lower-left URL preview while Atomic captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

### WezTerm

WezTerm usually works out of the box for `Shift+Enter` via xterm `modifyOtherKeys`. To enable the Kitty keyboard protocol explicitly and forward `Option+Enter` for macOS or Linux follow-up queueing (WezTerm binds `Option+Enter` to fullscreen on macOS by default), configure `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.enable_kitty_keyboard = true

-- Optional on macOS/Linux (Windows and WSL use Ctrl+Q by default):
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}

return config
```

If you already have a `~/.wezterm.lua` or `config.keys` table, merge these settings into your existing file instead of replacing it.

On WSL, WezTerm may need a visible hardware cursor to position CJK IME candidate windows. Set `"showHardwareCursor": true` in `~/.atomic/agent/settings.json`, or set `ATOMIC_HARDWARE_CURSOR=1` (legacy `PI_HARDWARE_CURSOR=1`) before launching Atomic. An explicit `showHardwareCursor` value in `settings.json` takes precedence over the environment variable.

### Alacritty

Alacritty usually works out of the box for `Shift+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To forward `Option+Enter` for follow-up queueing, add this entry to `~/.config/alacritty/alacritty.toml` and restart Alacritty:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

### VS Code (integrated terminal)

VS Code 1.109.5 and newer enable the Kitty keyboard protocol in the integrated terminal by default, so `Shift+Enter` works out of the box.

Older VS Code versions need an explicit terminal keybinding in `keybindings.json` (`~/Library/Application Support/Code/User/keybindings.json` on macOS, `~/.config/Code/User/keybindings.json` on Linux, `%APPDATA%\Code\User\keybindings.json` on Windows):

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

### Zed (integrated terminal)

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

### Windows Terminal

On native Windows, Atomic checks the native Shift modifier on Return automatically. Add this `shift+enter` action to `settings.json` (press `Ctrl+Shift+,` or open **Settings**, then **Open JSON file**) when using WSL, SSH into Linux, or explicit CSI-u reporting:

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

On Windows and WSL, follow-up queueing defaults to `Ctrl+Q` and dequeue defaults to `Alt+Q`, so you do not need to remap `Alt+Enter` for default shortcuts. Only add an `alt+enter` action (`"input": "\u001b[13;3u"`) if you bind an Atomic action to `alt+enter` yourself. If you already have an `actions` array, append the entry to it and fully reopen Windows Terminal.

### xfce4-terminal and terminator

These terminals have limited escape-sequence support and cannot distinguish `Ctrl+Enter` or `Shift+Enter` from plain `Enter`. Use `Ctrl+J` to insert newlines right away, or switch to a terminal with Kitty keyboard protocol support such as [Kitty](https://sw.kovidgoyal.net/kitty/), [Ghostty](https://ghostty.org/), [WezTerm](https://wezfurlong.org/wezterm/), [iTerm2](https://iterm2.com/), or [Alacritty](https://github.com/alacritty/alacritty) for full modified-key bindings.

### IntelliJ IDEA (integrated terminal)

The built-in terminal cannot distinguish `Shift+Enter` from `Enter`; press `Ctrl+J` to insert newlines, or use a dedicated terminal emulator for full keybinding support.

The hardware cursor is hidden by default for compatibility. To show it, set `"showHardwareCursor": true` in settings or launch with `ATOMIC_HARDWARE_CURSOR=1` (legacy `PI_HARDWARE_CURSOR=1`).

## Clipboard and mouse behavior

### Clipboard and OSC 52

Atomic writes to your local clipboard using the platform tool (`pbcopy` on macOS, `clip` on Windows, `wl-copy` from `wl-clipboard` on Wayland, `xclip` or `xsel` on X11, or `termux-clipboard-set` in Termux).

- **Remote and headless sessions:** Over SSH, Mosh, or Rex (when `SSH_CONNECTION`, `SSH_CLIENT`, `MOSH_CONNECTION`, or `REX_SESSION` is set), and on headless Linux without `DISPLAY` or `WAYLAND_DISPLAY`, Atomic automatically sends copies through OSC 52 so your local client terminal receives the text.
- **WSL:** Inside Windows Terminal (`WT_SESSION`), Atomic prefers OSC 52 and falls back to Windows clipboard interop.
- **Forcing OSC 52:** Set `ATOMIC_CLIPBOARD_OSC52=1` (legacy `PI_CLIPBOARD_OSC52=1`) to also emit OSC 52 after local clipboard writes, which helps inside remote multiplexers or IDE daemons that do not set SSH environment variables.
- **Size limit and terminal support:** OSC 52 payloads are capped at 100,000 base64 characters (about 75 KB of UTF-8 text). Larger copies fail with a size-limit error when no local clipboard is available. Ensure your terminal emulator allows clipboard writes through OSC 52.

### Mouse, trackpad, and text selection

In the fullscreen TUI, Atomic captures mouse input for clicking expandable blocks and key hints, wheel scrolling (`Alt+wheel` scrolls five times as far when your terminal forwards Alt with wheel events), and drag, double-click, or triple-click selection.

- **Auto-copy and scroll settings:** Text selection copies automatically on mouse release unless `"fullscreenCopyOnSelect": false` is set in [Settings](/settings). Adjust wheel speed with `fullscreenWheelScrollLines` (`"auto"` or `1` to `100`) and scrollbar visibility with `fullscreenScrollbar` (`"auto"`, `"always"`, or `"hidden"`).
- **Windows right-click paste:** On native Windows outside VS Code's integrated terminal, an unmodified secondary mouse click pastes clipboard text into the focused input.
- **Multiplexers:** Inside tmux, GNU Screen, and Zellij, Atomic uses button-motion mouse reporting (`1002h`) instead of all-motion reporting (`1003h`) to keep terminal traffic light while preserving clicks, scrolling, and drag selection.
- **Native terminal override:** Hold `Shift` (or `Shift+Command` on macOS / `Shift+Ctrl` on Linux in Ghostty) to bypass Atomic's mouse capture and use your terminal emulator's own selection or link handling.

## Inline images, hyperlinks, and colors

Atomic detects terminal capabilities automatically:

| Terminal | Inline images | OSC 8 hyperlinks | Color mode |
| --- | --- | --- | --- |
| Kitty, Ghostty, WezTerm, Warp, [Herdr](/herdr), Rex, Orca (`ORCA_IMAGE_PROTOCOL=kitty`) | Kitty protocol | Yes | Truecolor |
| iTerm2 | iTerm2 protocol | Yes | Truecolor |
| Windows Terminal (`WT_SESSION`), Alacritty, VS Code, Zed | No | Yes | Truecolor |
| IntelliJ IDEA (`JetBrains-JediTerm`), Windows consoles without `WT_SESSION` | No | No | Truecolor |
| Apple Terminal, GNU Screen (without `COLORTERM=truecolor`) | No | No | 256-color |
| tmux | Off by default | Only when `hyperlinks` is in `client_termfeatures` | Truecolor when `COLORTERM=truecolor`/`24bit` or `TERM` ends in `-direct` |

Override detected capabilities in `~/.atomic/agent/settings.json` (settings take precedence over environment variables) or with environment variables:

- **Inline images:** `terminal.images` (`"kitty"`, `"iterm2"`, `"auto"`, or `false`) or `ATOMIC_IMAGE_PROTOCOL` (`kitty`, `iterm2`, `none`, `0`, or `auto`). Control visibility and width with `terminal.showImages` and `terminal.imageWidthCells`.
- **OSC 8 hyperlinks:** `terminal.hyperlinks` (`true`, `false`, or `"auto"`) or `ATOMIC_HYPERLINKS` (`1`, `0`, or `auto`).
- **24-bit color:** `terminal.trueColor` (`true`, `false`, or `"auto"`) or `ATOMIC_TRUE_COLOR` (`1`, `0`, or `auto`).

See [tmux setup](/tmux) for multiplexer-specific image and hyperlink details.

## SSH and Escape key delay

When Atomic receives a lone `ESC` byte, it waits briefly to tell whether you pressed `Escape` or started an `Alt`/escape sequence. The default wait is `10` ms locally and `100` ms when `SSH_CONNECTION` or `SSH_TTY` is set.

Over high-latency SSH connections, increase this wait with `ATOMIC_TUI_ESC_TIMEOUT` (legacy `PI_TUI_ESC_TIMEOUT`) if `Alt` combinations register as `Escape`:

```bash
ATOMIC_TUI_ESC_TIMEOUT=150 atomic
```

## Program status

Atomic reports its state using the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status) so supporting terminals and dashboards can show whether it is working, waiting for input, done, or failed:

| State | When |
| --- | --- |
| `working` | An agent run or compaction is in progress. The message is the session name, or `Compacting context`. |
| `blocked` | A dialog, question, or login waits for you. Project trust prompts do not report `blocked` through OSC 7501. |
| `done` | An agent run or manual `/compact` finished successfully. The message is the session name. |
| `error` | A run or manual `/compact` ended with an error that is not retried. The message is the first line of the error. |
| `idle` | Atomic started, or you cancelled the run or compaction. |

Reports never include prompts or model output. Status messages are capped at 2,048 UTF-8 bytes and control characters are replaced with spaces. On normal exit or `Ctrl+Z` suspend, Atomic sends `state=clear` to remove the indicator (and re-sends its status on resume).

Atomic sends reports only after the terminal answers its support query; tmux and GNU Screen do not forward OSC 7501. Set `ATOMIC_PROGRAM_STATUS=1` to force reports without querying, or `ATOMIC_PROGRAM_STATUS=0` to disable them (`PI_PROGRAM_STATUS` is a legacy alias). Any other value queries the terminal normally.
