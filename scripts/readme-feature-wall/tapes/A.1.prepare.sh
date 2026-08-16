#!/usr/bin/env bash
# Stage the crash-course keybinding map; the visible capture installs it.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.capture"
cat >"$ws/.capture/keybindings.json" <<'JSON'
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
JSON
