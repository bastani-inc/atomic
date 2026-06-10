# tmux Setup

Atomic works inside tmux, but tmux strips modifier information from certain keys by default. Without configuration, `SHIFT+Enter` and `CTRL+Enter` are usually indistinguishable from plain `Enter`.

## Recommended Configuration

Add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Then restart tmux fully:

```bash
tmux kill-server
tmux
```

Atomic requests extended key reporting automatically when Kitty keyboard protocol is not available. With `extended-keys-format csi-u`, tmux forwards modified keys in CSI-u format, which is the most reliable configuration. The `extended-keys-format` option requires tmux 3.5 or later.

## Why `csi-u` Is Recommended

With only:

```tmux
set -g extended-keys on
```

tmux defaults to `extended-keys-format xterm`. When an application requests extended key reporting, modified keys are forwarded in xterm `modifyOtherKeys` format such as:

- `CTRL+C` → `\x1b[27;5;99~`
- `CTRL+D` → `\x1b[27;5;100~`
- `CTRL+Enter` → `\x1b[27;5;13~`

With `extended-keys-format csi-u`, the same keys are forwarded as:

- `CTRL+C` → `\x1b[99;5u`
- `CTRL+D` → `\x1b[100;5u`
- `CTRL+Enter` → `\x1b[13;5u`

Atomic supports both formats, but `csi-u` is the recommended tmux setup.

## What This Fixes

Without tmux extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extkeys | With `csi-u` |
|-----|-----------------|--------------|
| Enter | `\r` | `\r` |
| SHIFT+Enter | `\r` | `\x1b[13;2u` |
| CTRL+Enter | `\r` | `\x1b[13;5u` |
| Alt/Option+Enter | `\x1b\r` | `\x1b[13;3u` |

This affects the default keybindings (`Enter` to submit, `SHIFT+Enter` for newline) and any custom keybindings using modified Enter.

## Requirements

- tmux 3.5 or later for `extended-keys-format csi-u` (run `tmux -V` to check)
- A terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, Windows Terminal)

With tmux 3.2 through 3.4, omit `extended-keys-format csi-u`; Atomic still supports tmux's default xterm `modifyOtherKeys` format.
