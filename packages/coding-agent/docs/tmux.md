---
title: "tmux setup"
sidebarTitle: "tmux"
description: "Configure tmux for modified keys, Escape timing, hyperlinks, clipboard copy, mouse scrolling, and image paste with Atomic."
---

Atomic works inside tmux, though tmux strips modifier keys, delays `Escape`, and filters hyperlinks by default. Without configuration, `Shift+Enter` and `Ctrl+Enter` arrive as plain `Enter`.

For terminal automation, prefer [Herdr](/herdr) when available, with tmux or native Windows psmux as fallbacks. See [Computer use](/computer-use#terminal-automation-with-herdr) for tool selection and session control, and invoke the bundled `/skill:tmux` skill ([Bundled skills](/skills#bundled-skills)) when you want Atomic to inspect or drive tmux or psmux sessions, windows, and panes. This page covers running Atomic interactively inside tmux.

## Recommended tmux configuration

Add these lines to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
set -sg escape-time 10
set -g mouse on
set -g set-clipboard on
set -as terminal-features ',*:hyperlinks'
```

Restart tmux completely so the server reloads every option cleanly:

```bash
tmux kill-server
tmux
```

What each setting does:

- **`extended-keys on` (or `always`) and `extended-keys-format csi-u`:** Forwards modified keys such as `Shift+Enter` and `Ctrl+Enter` in CSI-u format. Whenever `$TMUX` is set, Atomic checks `tmux show -gv extended-keys` and `tmux show -gv extended-keys-format` at startup and displays a warning if `extended-keys` is not `on` or `always`, or if `extended-keys-format` is `xterm`. (`extended-keys-format` requires tmux 3.5 or later.)
- **`escape-time 10`:** Lowers tmux's Escape key delay from older defaults (up to 500 ms) to 10 ms so pressing `Escape` cancels runs and closes dialogs without lag. Over high-latency SSH inside tmux, you can also increase `ATOMIC_TUI_ESC_TIMEOUT` if `Alt` keys register as `Escape` ([SSH and Escape key delay](/terminal-setup#ssh-and-escape-key-delay)).
- **`mouse on`:** Forwards clicks, wheel scrolling, and drag selection to Atomic's fullscreen viewport.
- **`set-clipboard on`:** Allows OSC 52 clipboard copies to reach your outer terminal.
- **`terminal-features ',*:hyperlinks'`:** Advertises OSC 8 hyperlink forwarding so Atomic renders clickable links.

## Why `csi-u` is recommended

With only `set -g extended-keys on`, tmux defaults to `extended-keys-format xterm`, which sends modified keys in xterm `modifyOtherKeys` format:

- `Ctrl+C` sends `\x1b[27;5;99~`
- `Ctrl+D` sends `\x1b[27;5;100~`
- `Ctrl+Enter` sends `\x1b[27;5;13~`

With `extended-keys-format csi-u`, tmux sends the same keys as CSI-u sequences:

- `Ctrl+C` sends `\x1b[99;5u`
- `Ctrl+D` sends `\x1b[100;5u`
- `Ctrl+Enter` sends `\x1b[13;5u`

Atomic parses both formats, and `csi-u` is the most reliable choice.

### What extended keys fix

Without extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extended keys | With `csi-u` |
| --- | --- | --- |
| `Enter` | `\r` | `\r` |
| `Shift+Enter` | `\r` | `\x1b[13;2u` |
| `Ctrl+Enter` | `\r` | `\x1b[13;5u` |
| `Alt/Option+Enter` | `\x1b\r` | `\x1b[13;3u` |

Enabling extended keys restores the default `Shift+Enter` newline shortcut and custom modified-Enter bindings. (`Ctrl+J` also inserts a newline out of the box even without extended keys.)

## Inline images, hyperlinks, mouse, and clipboard

- **Inline images:** Atomic disables inline image protocols whenever `$TMUX` is set or `TERM` starts with `tmux`, even if tmux has `allow-passthrough on`. If your outer terminal and tmux configuration support image passthrough, explicitly override the protocol with `terminal.images` in `~/.atomic/agent/settings.json` ([Terminal and images settings](/settings#terminal-and-images)) or `ATOMIC_IMAGE_PROTOCOL=kitty` (or `iterm2`; see [Terminal and display variables](/environment-variables#terminal-and-display-variables)).
- **OSC 8 hyperlinks:** Inside tmux, Atomic runs `tmux display-message -p '#{client_termfeatures}'` (250 ms timeout) and emits clickable hyperlinks only when `hyperlinks` is listed. Add `set -as terminal-features ',*:hyperlinks'` to `~/.tmux.conf`, or force hyperlinks with `"terminal": { "hyperlinks": true }` ([Terminal and images settings](/settings#terminal-and-images)) or `ATOMIC_HYPERLINKS=1` ([Terminal and display variables](/environment-variables#terminal-and-display-variables)).
- **Clipboard over SSH (OSC 52):** Over SSH inside tmux, OSC 52 copies require `set -g set-clipboard on` (and `set -g allow-passthrough on` depending on your tmux version) so copied text reaches your local terminal clipboard. See [Clipboard and mouse behavior](/terminal-setup#clipboard-and-mouse-behavior).
- **Mouse scrolling and selection:** With `set -g mouse on`, Atomic handles clicks, drag selection, and wheel scrolling inside panes. Inside tmux, Atomic uses button-motion mouse reporting (`1002h`) instead of all-motion reporting (`1003h`) to keep terminal traffic light.
- **Program status (OSC 7501):** tmux does not forward OSC 7501 status reports. See [Program status](/terminal-setup#program-status).

## Image paste

Inside tmux on macOS, paste clipboard images with `Ctrl+V` instead of `Cmd+V`. On Linux, `Ctrl+V` pastes images as usual; on Windows and WSL, use `Alt+V` or `Ctrl+V`. See [Keybindings](/keybindings) for clipboard shortcuts.

## Requirements

- tmux 3.5 or later for `extended-keys-format csi-u` (check with `tmux -V`)
- An outer terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, or Windows Terminal)

With tmux 3.2 through 3.4, omit `extended-keys-format csi-u`; Atomic supports tmux's default xterm `modifyOtherKeys` format.

## Known issues

| Issue | Affects | Remedy |
| --- | --- | --- |
| Text such as `c0c/0c0c/0c0c` appears in the editor at startup ([tmux#4749](https://github.com/tmux/tmux/issues/4749)) | tmux 3.6 | Upgrade tmux. tmux 3.6 forwards Atomic's startup color queries and can pass a split reply into the editor as typed text. Changing Atomic's theme does not fix it. |
