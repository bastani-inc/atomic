/**
 * Structural adapter for Pi's injected `KeybindingsManager` plus the
 * string-buffer helpers that the workflow form's editing actions need.
 *
 * Workflow input surfaces (the inline form editor and the fallback overlay
 * picker) receive Pi's keybindings manager as the third argument of their
 * factory. They use it to translate raw terminal byte sequences into named
 * Pi actions (`tui.editor.deleteWordBackward`, etc.) so user-configured
 * keybindings — Ctrl/Cmd+Backspace, Ctrl+W, Ctrl+U, Ctrl+K, Alt+Arrow,
 * Home/End, etc. — work consistently with the rest of the agent's TUI.
 *
 * We intentionally avoid a direct `KeybindingsManager` import from
 * `@earendil-works/pi-tui` here:
 *   - The manager is a runtime singleton owned by the host; constructing
 *     a second one in the extension graph would duplicate state and
 *     fight the host for action resolution.
 *   - The structural `{ matches(data, action): boolean }` shape is all
 *     this code needs and keeps the per-call surface tiny.
 *
 * Rendering primitives are different — `Box`, `Text`, `Spacer`,
 * `Markdown`, etc. from `@earendil-works/pi-tui` are stateless and SHOULD be
 * imported directly in extension code (per pi.dev/docs/latest/tui).
 *
 * cross-ref:
 *   - node_modules/@earendil-works/pi-tui/src/keybindings.ts → KeybindingsManager
 *   - node_modules/@earendil-works/pi-tui/src/components/editor.ts routes through
 *     the same action ids (`tui.editor.cursorWordLeft`, etc.).
 */

/**
 * Minimal shape this codebase needs from Pi's `KeybindingsManager`.
 *
 * `matches(data, action)` returns true when raw terminal bytes in `data`
 * map to the named action under the user's resolved keybindings. Real
 * pi-tui `KeybindingsManager.matches` is fully covariant with this type.
 */
export interface KeybindingsLike {
  matches(data: string, action: string): boolean;
}

export const APP_ACTION = {
  toolsExpand: "app.tools.expand",
} as const;

export const TUI_ACTION = {
  editorCursorUp: "tui.editor.cursorUp",
  editorCursorDown: "tui.editor.cursorDown",
  editorCursorLeft: "tui.editor.cursorLeft",
  editorCursorRight: "tui.editor.cursorRight",
  inputSubmit: "tui.input.submit",
  selectUp: "tui.select.up",
  selectDown: "tui.select.down",
  selectPageUp: "tui.select.pageUp",
  selectPageDown: "tui.select.pageDown",
  selectConfirm: "tui.select.confirm",
} as const;

/** Runtime guard for hosts that wire the keybindings manager. */
export function isKeybindingsLike(kb: unknown): kb is KeybindingsLike {
  return (
    typeof kb === "object" &&
    kb !== null &&
    typeof (kb as { matches?: unknown }).matches === "function"
  );
}

/**
 * Ask Pi whether `data` maps to the named action. Returns `false` when
 * no keybindings manager is wired or the action does not match — there
 * is intentionally no parallel raw-byte fallback table. Hosts are
 * expected to provide a `KeybindingsManager` and tests pass a real or
 * structural fake one.
 */
export function matchesAction(
  kb: KeybindingsLike | undefined,
  data: string,
  action: string,
): boolean {
  if (!kb) return false;
  return kb.matches(data, action);
}

// ── Word boundary helpers ────────────────────────────────────────────────
//
// Emacs/bash-readline semantics: a "word" is a maximal run of non-
// whitespace characters. Word-left/word-right skip the leading
// whitespace gap, then skip the word run. This intentionally diverges
// from pi-tui's Unicode-aware grapheme segmenter (which requires the
// pi-natives addon) — workflow inputs are short prompts where simple
// whitespace-based word boundaries match user intuition and keep the
// helper free of native-module deps so tests run on any host.

function isWordBoundary(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Return the offset to the left of `caret` that lands on the previous
 * word boundary. Mirrors readline's `backward-word`: skip whitespace
 * (and newlines) leftward, then skip non-whitespace leftward. Clamps to
 * the start of the string.
 */
export function wordLeft(text: string, caret: number): number {
  let i = Math.max(0, Math.min(caret, text.length));
  // Skip trailing whitespace (including newlines).
  while (i > 0 && isWordBoundary(text[i - 1]!)) i -= 1;
  // Skip word body.
  while (i > 0 && !isWordBoundary(text[i - 1]!)) i -= 1;
  return i;
}

/**
 * Return the offset to the right of `caret` that lands on the next
 * word boundary. Mirrors readline's `forward-word`: skip whitespace
 * rightward, then skip non-whitespace rightward. Clamps to the end of
 * the string.
 */
export function wordRight(text: string, caret: number): number {
  const len = text.length;
  let i = Math.max(0, Math.min(caret, len));
  while (i < len && isWordBoundary(text[i]!)) i += 1;
  while (i < len && !isWordBoundary(text[i]!)) i += 1;
  return i;
}

// ── Logical-line helpers ─────────────────────────────────────────────────
//
// The form caret is a single integer offset into `rawText[fieldName]`;
// logical lines are split by `\n`. Line-start / line-end resolve to the
// boundaries of the line containing the caret. Line-start is the offset
// of the character AFTER the previous `\n` (or 0). Line-end is the
// offset of the next `\n` (or `text.length`).

export function lineStart(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  return text.lastIndexOf("\n", c - 1) + 1;
}

export function lineEnd(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  const nl = text.indexOf("\n", c);
  return nl === -1 ? text.length : nl;
}

/**
 * Splice `[start, end)` out of `text` and return the new value plus the
 * caret position after the deletion. Both bounds are clamped to the
 * valid range; an empty or inverted range is a no-op (returns original
 * text and `caret`).
 */
export interface DeleteRangeResult {
  text: string;
  caret: number;
}

export function deleteRange(text: string, start: number, end: number, caret: number): DeleteRangeResult {
  const len = text.length;
  const s = Math.max(0, Math.min(start, len));
  const e = Math.max(s, Math.min(end, len));
  if (s === e) return { text, caret };
  const next = text.slice(0, s) + text.slice(e);
  // The caret tracks the user's logical position. Cases:
  //   - caret < s              → unaffected, stays in place
  //   - s <= caret <= e        → collapses to s
  //   - caret > e              → shifts left by the deleted run's length
  let nextCaret: number;
  if (caret <= s) nextCaret = caret;
  else if (caret <= e) nextCaret = s;
  else nextCaret = caret - (e - s);
  return { text: next, caret: nextCaret };
}
