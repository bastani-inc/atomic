---
title: "Run Atomic in tmux"
sidebarTitle: "Run in tmux"
description: "Configure tmux for modified keys, Escape timing, hyperlinks, clipboard copy, mouse scrolling, and image paste with Atomic."
---

Atomic works inside tmux, though tmux strips modifier keys, delays `Escape`, and filters hyperlinks by default. Without configuration, `Shift+Enter` and `Ctrl+Enter` arrive as plain `Enter`.

For terminal automation, prefer [Herdr](/herdr) when available, with tmux or native Windows psmux as fallbacks (see [Computer use](/computer-use#terminal-automation-with-herdr) and the bundled `/skill:tmux` skill in [Bundled skills](/skills#bundled-skills)). This guide covers running Atomic interactively inside tmux.

## Recommended tmux configuration

<Steps>
  <Step title="Add recommended options to ~/.tmux.conf">
    ```tmux
    set -g extended-keys on
    set -g extended-keys-format csi-u
    set -sg escape-time 10
    set -g mouse on
    set -g set-clipboard on
    set -as terminal-features ',*:hyperlinks'
    ```

    If you run tmux 3.2 through 3.4, omit `extended-keys-format csi-u` (it requires tmux 3.5 or later).
  </Step>

  <Step title="Restart the tmux server completely">
    Reloading a running config does not always apply extended-keys and terminal-feature changes to existing sessions. Restart the server cleanly:

    ```bash
    tmux kill-server
    tmux
    ```
  </Step>
</Steps>

What each setting does:

- **`extended-keys on` (or `always`) and `extended-keys-format csi-u`:** Forwards modified keys such as `Shift+Enter` and `Ctrl+Enter` cleanly. Whenever `$TMUX` is set, Atomic checks both options at startup and warns if `extended-keys` is off or if `extended-keys-format` is `xterm`.
- **`escape-time 10`:** Lowers tmux's Escape key delay from older defaults (up to 500 ms) to 10 ms so `Escape` cancels runs and closes dialogs without lag. Over high-latency SSH inside tmux, you can also raise `ATOMIC_TUI_ESC_TIMEOUT` if `Alt` keys register as `Escape` ([SSH and Escape key delay](/terminal-setup#ssh-and-escape-key-delay)).
- **`mouse on`:** Forwards clicks, wheel scrolling, and drag selection to Atomic's fullscreen viewport.
- **`set-clipboard on`:** Allows OSC 52 clipboard copies to reach your outer terminal.
- **`terminal-features ',*:hyperlinks'`:** Advertises OSC 8 hyperlink forwarding so Atomic renders clickable links.

## Why `csi-u` is recommended

With only `set -g extended-keys on`, tmux defaults to `extended-keys-format xterm`, which encodes modified keys using legacy xterm `modifyOtherKeys` sequences. Setting `extended-keys-format csi-u` (tmux 3.5+) switches to unambiguous CSI-u encoding; Atomic parses both formats, and `csi-u` is the most reliable across modern outer terminals.

Without extended keys, modified Enter keys collapse to plain Enter:

| Key | Without extended keys | With extended keys (`csi-u`) |
| --- | --- | --- |
| `Enter` | Submit | Submit |
| `Shift+Enter` | Collapses to plain `Enter` | Distinct `Shift+Enter` (inserts newline) |
| `Ctrl+Enter` | Collapses to plain `Enter` | Distinct `Ctrl+Enter` |
| `Alt/Option+Enter` | Legacy `ESC+Enter` | Distinct `Alt/Option+Enter` |

<Tip>
`Ctrl+J` always inserts a newline out of the box, even without extended keys configured.
</Tip>

## Inline images, hyperlinks, mouse, and clipboard

- **Inline images:** Atomic disables inline image protocols whenever `$TMUX` is set or `TERM` starts with `tmux`, even if tmux has `allow-passthrough on`. If your outer terminal and tmux setup support image passthrough, explicitly override the protocol with `terminal.images` in `~/.atomic/agent/settings.json` ([Terminal and images settings](/settings#terminal-and-images)) or `ATOMIC_IMAGE_PROTOCOL=kitty` (or `iterm2`; see [Terminal and display variables](/environment-variables#terminal-and-display-variables)).
- **OSC 8 hyperlinks:** Inside tmux, Atomic queries `client_termfeatures` (250 ms timeout) and emits clickable hyperlinks only when `hyperlinks` is listed. Add `set -as terminal-features ',*:hyperlinks'` to `~/.tmux.conf`, or force hyperlinks with `"terminal": { "hyperlinks": true }` or `ATOMIC_HYPERLINKS=1`.
- **Clipboard over SSH (OSC 52):** Over SSH inside tmux, OSC 52 copies require `set -g set-clipboard on` (and `set -g allow-passthrough on` depending on your tmux version) so copied text reaches your local clipboard. See [Clipboard and mouse behavior](/terminal-setup#clipboard-and-mouse-behavior).
- **Mouse scrolling and selection:** With `set -g mouse on`, Atomic handles clicks, drag selection, and wheel scrolling inside panes. Inside tmux, Atomic reports mouse movement only while dragging instead of tracking every pointer move, keeping terminal traffic light.
- **Program status (OSC 7501):** tmux does not forward OSC 7501 status reports. See [Program status](/terminal-setup#program-status).

## Image paste

Inside tmux on macOS, paste clipboard images with `Ctrl+V` instead of `Cmd+V`. On Linux, `Ctrl+V` pastes images as usual; on Windows and WSL, use `Alt+V` or `Ctrl+V`. See [Keybindings](/keybindings) for clipboard shortcuts.

## Requirements

- **tmux 3.5 or later** for `extended-keys-format csi-u` (check with `tmux -V`). With tmux 3.2 through 3.4, omit `extended-keys-format csi-u`; Atomic still supports tmux's default `xterm` format.
- An outer terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, or Windows Terminal).

## Known issues

<Warning>
**tmux 3.6 startup text corruption ([tmux#4749](https://github.com/tmux/tmux/issues/4749)):** In tmux 3.6, fragments such as `c0c/0c0c/0c0c` can appear in the editor at startup because tmux 3.6 forwards Atomic's startup color queries and can pass a split reply into the editor as typed text. Changing Atomic's theme does not fix it—upgrade tmux to a fixed release.
</Warning>
