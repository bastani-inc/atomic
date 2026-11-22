---
title: "tmux"
description: "Run Atomic inside tmux, including image paste and key forwarding."
---

# tmux setup

Atomic works inside tmux, though tmux strips modifier keys by default. Without configuration, `SHIFT+Enter` and `CTRL+Enter` arrive as plain `Enter`.

For terminal automation, prefer Herdr when available, with tmux or native Windows psmux as fallbacks. See [Computer use](/computer-use#terminal-automation-with-herdr) for tool selection and session control. This page covers Atomic's keyboard and clipboard setup inside tmux.

## Recommended configuration

Add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Then restart tmux completely:

```bash
tmux kill-server
tmux
```

Atomic requests extended key reporting automatically when the Kitty keyboard protocol is unavailable. With `extended-keys-format csi-u`, tmux forwards modified keys in CSI-u format. The `extended-keys-format` option requires tmux 3.5 or later.

## Why `csi-u` is recommended

With only `set -g extended-keys on`, tmux defaults to `extended-keys-format xterm`, which sends modified keys in xterm `modifyOtherKeys` format:

- `CTRL+C` sends `\x1b[27;5;99~`
- `CTRL+D` sends `\x1b[27;5;100~`
- `CTRL+Enter` sends `\x1b[27;5;13~`

With `extended-keys-format csi-u`, tmux sends the same keys as CSI-u sequences:

- `CTRL+C` sends `\x1b[99;5u`
- `CTRL+D` sends `\x1b[100;5u`
- `CTRL+Enter` sends `\x1b[13;5u`

Atomic parses both formats, and `csi-u` is the most reliable choice.

## What this fixes

Without extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extended keys | With `csi-u` |
| --- | --- | --- |
| `Enter` | `\r` | `\r` |
| `SHIFT+Enter` | `\r` | `\x1b[13;2u` |
| `CTRL+Enter` | `\r` | `\x1b[13;5u` |
| `Alt/Option+Enter` | `\x1b\r` | `\x1b[13;3u` |

Enabling extended keys restores the default `SHIFT+Enter` newline shortcut and any custom modified-Enter bindings.

## Image paste

Inside tmux on macOS, paste clipboard images with `Ctrl+V` instead of `Cmd+V`. On Linux, `Ctrl+V` pastes images as usual; on Windows and WSL, use `Alt+V` or `Ctrl+V`. See [Keybindings](/keybindings) for clipboard shortcuts.

## Requirements

- tmux 3.5 or later for `extended-keys-format csi-u` (check with `tmux -V`)
- A terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, or Windows Terminal)

With tmux 3.2 through 3.4, omit `extended-keys-format csi-u`; Atomic supports tmux's default xterm `modifyOtherKeys` format.

## Known issues

| Issue | Affects | Remedy |
| --- | --- | --- |
| Text such as `c0c/0c0c/0c0c` appears in the editor at startup ([tmux#4749](https://github.com/tmux/tmux/issues/4749)) | tmux 3.6 | Upgrade tmux. tmux 3.6 forwards Atomic's startup color queries and can pass a split reply into the editor as typed text. Changing Atomic's theme does not fix it. |
