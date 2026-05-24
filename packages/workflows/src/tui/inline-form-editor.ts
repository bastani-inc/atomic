/**
 * Custom `EditorComponent` swapped in via `ctx.ui.setEditorComponent` while
 * an inline workflow form is active. Owns ALL keystrokes during fill-out:
 *
 *   tab / shift+tab     — move focus across form fields and the final Submit action
 *   ↑/↓                 — move focus (or caret between logical lines in `text`)
 *   ←/→                 — caret nav (text) | choice cycle (select) | flip (bool)
 *   alt/ctrl+←/→        — word movement in text/string/number fields
 *   home/end (ctrl+a/e) — caret to start/end of the current logical line
 *   backspace           — delete char left of caret
 *   delete / ctrl+d     — delete char right of caret
 *   ctrl+w / alt+bs     — delete word left of caret
 *   alt+d / alt+delete  — delete word right of caret
 *   ctrl+u              — delete to logical line start
 *   ctrl+k              — delete to logical line end
 *   space               — boolean toggle
 *   enter               — newline (text) | otherwise next field
 *   printable ASCII     — insert at caret (text/string/number)
 *   submit action       — ↑/↓ returns to questions; enter submits
 *   esc / ctrl+c        — cancel form
 *
 * Editor-mode keys (cursor movement, word jumps, deletions) route through
 * the Pi `KeybindingsManager` injected by the host at factory time, so any
 * user-configured keybinding overrides surfaces here as well. Form-level
 * keys (tab/shift+tab/esc/ctrl+c) stay as raw byte checks because
 * they are workflow form contract, not Pi-configurable actions.
 *
 * On submit/cancel the editor calls back to the orchestrator which:
 *   1. Marks the form state finalized (renderer flips to frozen view)
 *   2. Restores the previously-installed editor via `setEditorComponent`
 *   3. Resolves the open() promise so the slash command can proceed
 *
 * Render: intentionally returns no rows. The chat-history card is the single
 * visible editing surface; this component is a headless keystroke router so
 * the bottom editor does not duplicate the active argument box. No autocomplete,
 * history, paste markers, or kill-rings — we deliberately skip the heavy
 * `Editor` base class for predictable per-field behaviour.
 *
 * cross-ref:
 *  - src/tui/inputs-picker.ts (handler logic shared, adapted here)
 *  - src/tui/keybindings-adapter.ts (Pi keybindings + edit helpers)
 *  - @earendil-works/pi-tui EditorComponent interface
 */

import type { PiEditorComponent } from "../extension/wiring.js";
import type { GraphTheme } from "./graph-theme.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { InlineFormState } from "./inline-form-store.js";
import { getForm, touch } from "./inline-form-store.js";
import { computeInvalid } from "./inputs-picker.js";
import {
  type KeybindingsLike,
  TUI_ACTION,
  deleteRange,
  isKeybindingsLike,
  lineEnd,
  lineStart,
  matchesAction,
  wordLeft,
  wordRight,
} from "./keybindings-adapter.js";
import { decodePrintableKey, Key, matchesKey, visibleWidth } from "./text-helpers.js";

export type FormEditorOutcome = "submit" | "cancel";

export interface InlineFormEditorOpts {
  formId: string;
  theme: GraphTheme;
  /** Called when the Submit row passes validation or cancel fires. */
  onExit: (outcome: FormEditorOutcome) => void;
  /**
   * Pi's `KeybindingsManager` injected as the third arg of the editor
   * factory. Used to translate raw byte sequences into named Pi actions
   * (`tui.editor.deleteWordBackward`, etc.) so user-configured editor
   * keybindings are honoured inside workflow fields. Optional only for
   * older hosts and tests — production always passes one through.
   */
  keybindings?: KeybindingsLike;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

function previousGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  let prev = 0;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index >= c) break;
    prev = s.index;
  }
  return prev;
}

function nextGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index >= c) return Math.min(text.length, s.index + s.segment.length);
    if (s.index + s.segment.length > c) return s.index + s.segment.length;
  }
  return text.length;
}

function clampGraphemeOffset(text: string, caret: number): number {
  const c = Math.max(0, Math.min(caret, text.length));
  if (c === text.length) return c;
  for (const s of graphemeSegmenter.segment(text)) {
    if (s.index === c) return c;
    if (s.index > c) break;
  }
  return previousGraphemeOffset(text, c);
}

function visualColumn(text: string, caret: number): number {
  return visibleWidth(text.slice(0, clampGraphemeOffset(text, caret)));
}

function offsetAtVisualColumn(text: string, targetCol: number): number {
  let col = 0;
  for (const s of graphemeSegmenter.segment(text)) {
    const w = visibleWidth(s.segment);
    if (col + w > targetCol) return s.index;
    col += w;
  }
  return text.length;
}

function isPrintableGrapheme(data: string): boolean {
  if (data.length === 0 || data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return graphemes(data).length === 1;
}

/**
 * Move the caret one logical line up inside a multi-line text field.
 * Returns the new caret offset, or `null` when the caret is already on
 * the first logical line — that's the boundary signal the caller uses to
 * fall through to focus-prev. The visual cell column is preserved across
 * lines, matching pi-tui Editor behaviour for CJK/emoji-width text.
 */
function caretLineUp(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const lineStart = raw.lastIndexOf("\n", safe - 1) + 1;
  if (lineStart === 0) return null; // first logical line — boundary
  const prevLineEnd = lineStart - 1;
  const prevLineStart = raw.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const colInLine = visualColumn(raw.slice(lineStart, safe), safe - lineStart);
  const prevLine = raw.slice(prevLineStart, prevLineEnd);
  return prevLineStart + offsetAtVisualColumn(prevLine, colInLine);
}

/**
 * Move the caret one logical line down inside a multi-line text field.
 * Returns the new caret offset, or `null` when the caret is already on
 * the last logical line.
 */
function caretLineDown(raw: string, caret: number): number | null {
  const safe = clampGraphemeOffset(raw, caret);
  const nextNl = raw.indexOf("\n", safe);
  if (nextNl === -1) return null; // last logical line — boundary
  const lineStart = raw.lastIndexOf("\n", safe - 1) + 1;
  const colInLine = visualColumn(raw.slice(lineStart, safe), safe - lineStart);
  const nextLineStart = nextNl + 1;
  const nextNlAfter = raw.indexOf("\n", nextLineStart);
  const nextLineEnd = nextNlAfter === -1 ? raw.length : nextNlAfter;
  const nextLine = raw.slice(nextLineStart, nextLineEnd);
  return nextLineStart + offsetAtVisualColumn(nextLine, colInLine);
}

// ── Bracketed paste handling ─────────────────────────────────────────────
// Pi's host terminal enables bracketed paste mode and forwards the wrap
// markers verbatim to our editor. Wrappers from xterm-compatible
// terminals — same constants pi-tui's Editor uses.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * `true` when `data` is a multi-character chunk that looks like raw
 * pasted text (no escape sequences, only printable + LF/TAB). Used as a
 * fallback for hosts that don't enable bracketed paste — bursts of
 * printable input are still treated as paste rather than ignored, while
 * single keystrokes continue to flow through the normal key router.
 */
function isPrintableTextChunk(data: string): boolean {
  if (data.includes("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Minimal `PiEditorComponent` implementation. The pi-tui interface requires
 * `getText` / `setText` / `handleInput` / `render` / `invalidate`. We satisfy
 * them with no-ops where the host doesn't really need them during form mode
 * (no autocomplete, no history, no `onSubmit` handler).
 */
export class InlineFormEditor implements PiEditorComponent {
  /** Required by Focusable; we always have focus during the form. */
  focused = true;

  private readonly tui: { requestRender?: () => void };
  private readonly opts: InlineFormEditorOpts;
  private readonly kb: KeybindingsLike | undefined;

  // EditorComponent optional hooks — we don't use them.
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  onAutocompleteCancel?: () => void;
  onAutocompleteUpdate?: () => void;

  private useTerminalCursor = false;
  private autocompleteMaxVisible = 5;
  private readonly customKeyHandlers = new Map<string, () => void>();

  // Bracketed-paste accumulator. Pi sends paste content wrapped in
  // `\x1b[200~…\x1b[201~`; large pastes split across multiple
  // handleInput calls, so we buffer between `isInPaste` toggles.
  private isInPaste = false;
  private pasteBuffer = "";
  constructor(tui: { requestRender?: () => void }, opts: InlineFormEditorOpts) {
    this.tui = tui;
    this.opts = opts;
    this.kb = isKeybindingsLike(opts.keybindings) ? opts.keybindings : undefined;
  }

  // ── EditorComponent surface ───────────────────────────────────────────

  getText(): string {
    // Used by pi when the user submits via the default editor. We never
    // submit via this path, so return empty.
    return "";
  }

  setText(_text: string): void {
    // Programmatic insertion isn't meaningful for a typed-field editor.
  }

  invalidate(): void {
    // We rebuild from state on every render — nothing to invalidate.
  }

  setUseTerminalCursor(useTerminalCursor: boolean): void {
    this.useTerminalCursor = useTerminalCursor;
  }

  getUseTerminalCursor(): boolean {
    return this.useTerminalCursor;
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.autocompleteMaxVisible = Number.isFinite(maxVisible)
      ? Math.max(3, Math.min(20, Math.floor(maxVisible)))
      : 5;
  }

  getAutocompleteMaxVisible(): number {
    return this.autocompleteMaxVisible;
  }

  setMaxHeight(_maxHeight: number | undefined): void {
    // The inline editor renders no rows; the chat-history card owns height.
  }

  // Called by InteractiveMode.updateEditorTopBorder after a resize. We render
  // zero rows so any border content is visually irrelevant — accept and drop.
  setTopBorder(_content: unknown): void {
    // No-op: host resize-handler contract, not part of the PiEditorComponent shape.
  }

  // Called by InteractiveMode resize handler to size the status-line top border.
  // Our editor draws no chrome (no border glyphs, no padding), so the full
  // terminal width is available. Guard against non-finite/negative inputs.
  getTopBorderAvailableWidth(terminalWidth: number): number {
    // Host resize-handler contract, not part of the PiEditorComponent shape.
    return Number.isFinite(terminalWidth) ? Math.max(0, terminalWidth) : 0;
  }

  setHistoryStorage(_storage: object): void {
    // Field editing is transient and should not pollute prompt history.
  }

  setActionKeys(_action: string, _keys: readonly string[]): void {
    // App-level action key routing is intentionally bypassed during form input.
  }

  setCustomKeyHandler(key: string, handler: () => void): void {
    this.customKeyHandlers.set(key, handler);
  }

  removeCustomKeyHandler(key: string): void {
    this.customKeyHandlers.delete(key);
  }

  clearCustomKeyHandlers(): void {
    this.customKeyHandlers.clear();
  }

  setAutocompleteProvider(_provider: object): void {
    // Autocomplete belongs to the default chat editor, not the field router.
  }

  addToHistory(_text: string): void {
    // Field editing is transient and should not pollute prompt history.
  }

  insertTextAtCursor(text: string): void {
    this.handleInput(text);
  }

  getExpandedText(): string {
    return this.getText();
  }

  dispose?(): void {
    // No resources to release; present for host symmetry with visible editors.
  }

  render(_width: number): string[] {
    // Keep the replacement editor mounted only to receive keyboard input.
    // The inline chat card above is the canonical visual surface for field
    // focus, values, validation, and submission hints. Rendering zero rows
    // removes the duplicate bottom argument box shown by the old editor body.
    return [];
  }

  handleInput(data: string): void {
    const state = getForm(this.opts.formId);
    if (!state || state.status !== "editing") return;

    // Bracketed-paste handling. Pi enables bracketed paste mode on the
    // host terminal, so paste content arrives wrapped in
    // `\x1b[200~…\x1b[201~` and may span multiple `handleInput` calls
    // when large. Mirror pi-tui Editor's strategy: buffer until we see
    // the close marker, then apply the accumulated content as a single
    // edit. cross-ref: pi-tui dist/components/editor.js handleInput.
    if (data.includes(PASTE_START)) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace(PASTE_START, "");
    }
    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIdx = this.pasteBuffer.indexOf(PASTE_END);
      if (endIdx === -1) return; // wait for the close marker
      const content = this.pasteBuffer.slice(0, endIdx);
      const remaining = this.pasteBuffer.slice(endIdx + PASTE_END.length);
      this.isInPaste = false;
      this.pasteBuffer = "";
      if (content.length > 0 && this.applyPaste(content, state)) {
        touch(state);
        this.tui.requestRender?.();
      }
      if (remaining.length > 0) this.handleInput(remaining);
      return;
    }

    // Fallback for hosts without bracketed paste: a multi-character
    // chunk of printable text (no escape bytes) is treated as paste.
    // Single-char input still flows through the routeKey path so the
    // existing keystroke handlers (arrows, paste, etc.) keep working.
    if (data.length > 1 && isPrintableTextChunk(data)) {
      if (this.applyPaste(data, state)) {
        touch(state);
        this.tui.requestRender?.();
      }
      return;
    }

    const consumed = this.routeKey(data, state);
    if (consumed) {
      touch(state);
      this.tui.requestRender?.();
    }
  }

  /**
   * Insert `content` at the focused field's caret, normalising line
   * endings and respecting per-field-type rules. Returns `true` when the
   * field's raw text actually changed so the caller can flush a render.
   *
   *   - `text`        : multi-line accepted as-is.
   *   - `string` / `number` / `integer` : first logical line only.
   *   - `select` / `boolean`            : ignored (pasting onto a radio /
   *     toggle has no meaningful semantics).
   */
  private applyPaste(content: string, state: InlineFormState): boolean {
    const field = state.fields[state.focusedIdx];
    if (!field) return false;
    if (field.type === "select" || field.type === "boolean") return false;
    // Normalise CR / CRLF to LF, then strip non-printable control bytes.
    // We keep `\n` (LF) and `\t` (TAB) since prompt-style content uses
    // both; everything else (NUL, BEL, ESC residues, DEL, etc.) is
    // dropped to avoid breaking the rendered card.
    // eslint-disable-next-line no-control-regex
    let text = content
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (field.type !== "text") {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(0, nl);
      text = text.replace(/\t/g, " ");
    }
    if (text.length === 0) return false;
    const name = field.name;
    const cur = state.rawText[name] ?? "";
    const caret = Math.max(0, Math.min(state.caret, cur.length));
    state.rawText[name] = cur.slice(0, caret) + text + cur.slice(caret);
    state.caret = caret + text.length;
    return true;
  }

  // ── Key routing ───────────────────────────────────────────────────────

  /**
   * Returns true when the key was meaningful (consumed) and the host
   * should re-render. False for unknown keys that we silently drop —
   * pi-tui has no parent editor to forward to, and the heavy default
   * editor's behaviours (autocomplete, kill-rings) aren't appropriate
   * for a typed-field form.
   */
  private routeKey(data: string, state: InlineFormState): boolean {
    // Globals first. Workflow form contract — these are NOT Pi-configurable
    // editor actions, so they stay as raw byte checks:
    //   esc        (\x1b)        — cancel form
    //   ctrl+c     (\x03)        — cancel form
    //   tab        (\t)          — focus next field / final Submit action
    //   shift+tab  (\x1b[Z)      — focus previous field / final Submit action
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      this.opts.onExit("cancel");
      return true;
    }
    if (matchesKey(data, Key.tab)) {
      this.moveFocus(state, +1);
      return true;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.moveFocus(state, -1);
      return true;
    }

    if (state.focusedIdx === state.fields.length) return this.handleSubmit(data, state);

    const field = state.fields[state.focusedIdx];
    if (!field) return false;

    if (field.type === "select") return this.handleSelect(data, field, state);
    if (field.type === "boolean") return this.handleBoolean(data, field, state);
    return this.handleText(data, field, state);
  }

  private handleSubmit(data: string, state: InlineFormState): boolean {
    if (matchesAction(this.kb, data, TUI_ACTION.selectUp) || matchesAction(this.kb, data, TUI_ACTION.editorCursorUp)) {
      this.moveFocus(state, -1);
      return true;
    }
    if (matchesAction(this.kb, data, TUI_ACTION.selectDown) || matchesAction(this.kb, data, TUI_ACTION.editorCursorDown)) {
      this.moveFocus(state, +1);
      return true;
    }
    if (
      matchesKey(data, Key.enter) ||
      matchesAction(this.kb, data, TUI_ACTION.selectConfirm) ||
      matchesAction(this.kb, data, TUI_ACTION.inputSubmit)
    ) {
      return this.submitOrFocusInvalid(state);
    }
    return false;
  }

  private submitOrFocusInvalid(state: InlineFormState): boolean {
    if (this.allValid(state)) this.opts.onExit("submit");
    else this.focusFirstInvalid(state);
    return true;
  }

  private handleSelect(
    data: string,
    field: WorkflowInputEntry,
    state: InlineFormState,
  ): boolean {
    const choices = field.choices ?? [];
    if (choices.length === 0) return false;
    const cur = state.rawText[field.name] ?? choices[0]!;
    const i = Math.max(0, choices.indexOf(cur));
    if (matchesAction(this.kb, data, TUI_ACTION.selectUp) || matchesAction(this.kb, data, TUI_ACTION.editorCursorLeft)) {
      state.rawText[field.name] = choices[(i - 1 + choices.length) % choices.length]!;
      return true;
    }
    if (
      matchesAction(this.kb, data, TUI_ACTION.selectDown) ||
      matchesAction(this.kb, data, TUI_ACTION.editorCursorRight) ||
      matchesKey(data, Key.space)
    ) {
      state.rawText[field.name] = choices[(i + 1) % choices.length]!;
      return true;
    }
    if (matchesAction(this.kb, data, TUI_ACTION.selectConfirm) || matchesAction(this.kb, data, TUI_ACTION.inputSubmit)) {
      this.moveFocus(state, +1);
      return true;
    }
    return false;
  }

  private handleBoolean(
    data: string,
    field: WorkflowInputEntry,
    state: InlineFormState,
  ): boolean {
    if (
      matchesKey(data, Key.space) ||
      matchesAction(this.kb, data, TUI_ACTION.selectUp) ||
      matchesAction(this.kb, data, TUI_ACTION.selectDown) ||
      matchesAction(this.kb, data, TUI_ACTION.editorCursorLeft) ||
      matchesAction(this.kb, data, TUI_ACTION.editorCursorRight)
    ) {
      state.rawText[field.name] = state.rawText[field.name] === "true" ? "false" : "true";
      return true;
    }
    if (matchesAction(this.kb, data, TUI_ACTION.selectConfirm) || matchesAction(this.kb, data, TUI_ACTION.inputSubmit)) {
      this.moveFocus(state, +1);
      return true;
    }
    return false;
  }

  private handleText(
    data: string,
    field: WorkflowInputEntry,
    state: InlineFormState,
  ): boolean {
    const name = field.name;
    const cur = state.rawText[name] ?? "";
    const caret = Math.max(0, Math.min(state.caret, cur.length));

    // Vertical navigation — text fields walk between logical lines first,
    // single-line scalars advance focus immediately.
    if (matchesAction(this.kb, data, TUI_ACTION.editorCursorUp)) {
      if (field.type === "text") {
        const newCaret = caretLineUp(cur, caret);
        if (newCaret !== null) {
          state.caret = newCaret;
          return true;
        }
      }
      this.moveFocus(state, -1);
      return true;
    }
    if (matchesAction(this.kb, data, TUI_ACTION.editorCursorDown)) {
      if (field.type === "text") {
        const newCaret = caretLineDown(cur, caret);
        if (newCaret !== null) {
          state.caret = newCaret;
          return true;
        }
      }
      this.moveFocus(state, +1);
      return true;
    }

    // Word movement. cursorWordLeft / cursorWordRight come BEFORE the
    // single-char left/right checks because Pi's default bindings include
    // overlapping prefixes — e.g. ctrl+b is bound to both `cursorLeft`
    // (char) and `cursorWordLeft` is `alt+b` / `alt+left` / `ctrl+left`,
    // so order matters only when bindings get remapped to the same key.
    if (matchesAction(this.kb, data, "tui.editor.cursorWordLeft")) {
      state.caret = wordLeft(cur, caret);
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.cursorWordRight")) {
      state.caret = wordRight(cur, caret);
      return true;
    }

    // Line jumps.
    if (matchesAction(this.kb, data, "tui.editor.cursorLineStart")) {
      state.caret = lineStart(cur, caret);
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.cursorLineEnd")) {
      state.caret = lineEnd(cur, caret);
      return true;
    }

    // Character cursor movement.
    if (matchesAction(this.kb, data, TUI_ACTION.editorCursorLeft)) {
      state.caret = previousGraphemeOffset(cur, caret);
      return true;
    }
    if (matchesAction(this.kb, data, TUI_ACTION.editorCursorRight)) {
      state.caret = nextGraphemeOffset(cur, caret);
      return true;
    }

    // Deletion. Word/line variants come before plain char deletion because
    // their key sequences (ctrl+w, alt+backspace, ctrl+u, ctrl+k) are
    // distinct from raw backspace; the order is defensive against user
    // remaps that collapse them.
    if (matchesAction(this.kb, data, "tui.editor.deleteWordBackward")) {
      const start = wordLeft(cur, caret);
      const r = deleteRange(cur, start, caret, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.deleteWordForward")) {
      const end = wordRight(cur, caret);
      const r = deleteRange(cur, caret, end, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.deleteToLineStart")) {
      const start = lineStart(cur, caret);
      const r = deleteRange(cur, start, caret, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.deleteToLineEnd")) {
      const end = lineEnd(cur, caret);
      const r = deleteRange(cur, caret, end, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.deleteCharBackward")) {
      if (caret > 0) {
        const r = deleteRange(cur, previousGraphemeOffset(cur, caret), caret, caret);
        state.rawText[name] = r.text;
        state.caret = r.caret;
      }
      return true;
    }
    if (matchesAction(this.kb, data, "tui.editor.deleteCharForward")) {
      if (caret < cur.length) {
        const r = deleteRange(cur, caret, nextGraphemeOffset(cur, caret), caret);
        state.rawText[name] = r.text;
        state.caret = r.caret;
      }
      return true;
    }

    // Enter — text fields insert a real `\n` at the caret; non-text scalars
    // treat it as "advance focus". `tui.input.newLine` (shift+enter) is
    // explicitly equivalent to plain Enter in our form contract; both
    // insert a newline in text fields and advance focus elsewhere.
    if (
      matchesAction(this.kb, data, TUI_ACTION.inputSubmit) ||
      matchesAction(this.kb, data, "tui.input.newLine")
    ) {
      if (field.type === "text") {
        state.rawText[name] = cur.slice(0, caret) + "\n" + cur.slice(caret);
        state.caret = caret + 1;
      } else {
        this.moveFocus(state, +1);
      }
      return true;
    }

    // Printable insertion — accept raw graphemes and terminal-encoded
    // printable keys (CSI-u / Kitty). VSCode's integrated terminal can emit
    // printable keys as escape sequences when modifyOtherKeys is active.
    // Numeric fields accept the same printable range as text; per-field
    // validation catches non-numeric content at submit time.
    const printable = decodePrintableKey(data) ?? data;
    if (isPrintableGrapheme(printable)) {
      state.rawText[name] = cur.slice(0, caret) + printable + cur.slice(caret);
      state.caret = caret + printable.length;
      return true;
    }
    return false;
  }

  private moveFocus(state: InlineFormState, delta: number): void {
    const n = state.fields.length + 1;
    if (n <= 1) return;
    state.focusedIdx = (state.focusedIdx + delta + n) % n;
    if (state.focusedIdx === state.fields.length) {
      state.caret = 0;
      state.submitChoiceIdx = 0;
      return;
    }
    const next = state.fields[state.focusedIdx]!;
    state.caret = (state.rawText[next.name] ?? "").length;
  }

  private focusFirstInvalid(state: InlineFormState): void {
    const [idx] = computeInvalid(state.fields, state.rawText);
    if (idx === undefined) return;
    state.submitChoiceIdx = 0;
    state.focusedIdx = idx;
    state.caret = (state.rawText[state.fields[idx]!.name] ?? "").length;
  }

  private allValid(state: InlineFormState): boolean {
    return computeInvalid(state.fields, state.rawText).length === 0;
  }
}

