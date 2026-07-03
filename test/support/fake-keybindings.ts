/**
 * Structural `KeybindingsManager` fake for tests.
 *
 * Production wiring receives a real `KeybindingsManager` from Pi via the
 * editor / overlay factory's third argument. Unit tests can't construct a
 * real one — pi-tui's keybindings module transitively loads the
 * `pi-natives` addon, which fails to initialise in many CI hosts (no
 * shared TLS slot, missing baseline build).
 *
 * This module returns a small structural fake matching the
 * `KeybindingsLike` shape. The default action → key-sequence table is a
 * subset of pi-tui's `TUI_KEYBINDINGS` defaults (see
 * node_modules/@earendil-works/pi-tui/src/keybindings.ts) — exactly the actions
 * the workflow input surfaces consume. Use `makeFakeKeybindings()` to
 * accept defaults, or pass overrides for per-test remaps.
 */

import type { KeybindingsLike } from "../../packages/workflows/src/tui/keybindings-adapter.ts";

/**
 * Per-action defaults the production form/picker rely on. Multiple keys
 * per action mirror pi-tui's resolved defaults — e.g. cursorLeft accepts
 * both the literal arrow CSI sequence and ctrl+b (readline-style).
 */
const DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "app.tools.expand": ["\x0f"],
  "tui.editor.cursorUp": ["\x1b[A"],
  "tui.editor.cursorDown": ["\x1b[B"],
  // ctrl+b — readline backward-char (default pi-tui binding for cursorLeft)
  "tui.editor.cursorLeft": ["\x1b[D", "\x02"],
  // ctrl+f — readline forward-char (default pi-tui binding for cursorRight)
  "tui.editor.cursorRight": ["\x1b[C", "\x06"],
  // alt+left / ctrl+left / alt+b
  "tui.editor.cursorWordLeft": ["\x1b[1;3D", "\x1b[1;5D", "\x1bb"],
  // alt+right / ctrl+right / alt+f
  "tui.editor.cursorWordRight": ["\x1b[1;3C", "\x1b[1;5C", "\x1bf"],
  // home / ctrl+a
  "tui.editor.cursorLineStart": ["\x1b[H", "\x1b[1~", "\x1bOH", "\x01"],
  // end / ctrl+e
  "tui.editor.cursorLineEnd": ["\x1b[F", "\x1b[4~", "\x1bOF", "\x05"],
  // backspace (DEL on most terminals; \b on Windows Terminal)
  "tui.editor.deleteCharBackward": ["\x7f", "\b"],
  // delete / ctrl+d
  "tui.editor.deleteCharForward": ["\x1b[3~", "\x04"],
  // ctrl+w, alt+backspace, ctrl+backspace
  "tui.editor.deleteWordBackward": ["\x17", "\x1b\x7f", "\x1b\b"],
  // alt+delete, alt+d
  "tui.editor.deleteWordForward": ["\x1b[3;3~", "\x1bd"],
  // ctrl+u
  "tui.editor.deleteToLineStart": ["\x15"],
  // ctrl+k
  "tui.editor.deleteToLineEnd": ["\x0b"],
  // Enter — both CR and LF resolve to submit (pi-tui matches \r and \n)
  "tui.input.submit": ["\r", "\n"],
  // Shift+Enter in legacy + Kitty terminals
  "tui.input.newLine": ["\x1b[13;2u", "\x1b\r"],
  "tui.input.tab": ["\t"],
  // Select/list actions mirror pi-tui's SelectList bindings.
  "tui.select.up": ["\x1b[A"],
  "tui.select.down": ["\x1b[B"],
  "tui.select.pageUp": ["\x1b[5~"],
  "tui.select.pageDown": ["\x1b[6~"],
  "tui.select.confirm": ["\r", "\n"],
};

/**
 * Build a structural `KeybindingsLike` fake.
 *
 *   makeFakeKeybindings()                            — defaults
 *   makeFakeKeybindings({ "tui.editor.cursorLeft": ["h"] })
 *                                                    — remap a single action
 *
 * Unknown actions resolve to `false` (no match), matching real Pi
 * behaviour for unbound action ids.
 */
export function makeFakeKeybindings(
  overrides: Record<string, readonly string[]> = {},
): KeybindingsLike {
  const map: Record<string, readonly string[]> = { ...DEFAULTS, ...overrides };
  return {
    matches(data: string, action: string): boolean {
      const keys = map[action];
      if (!keys) return false;
      return keys.includes(data);
    },
  };
}
