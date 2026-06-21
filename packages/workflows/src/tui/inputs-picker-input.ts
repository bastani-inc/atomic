import type { WorkflowInputEntry } from "../extension/render-result.js";
import {
  decodePrintableKey,
  Key,
  matchesKey,
} from "./text-helpers.js";
import {
  type KeybindingsLike,
  TUI_ACTION,
  deleteRange,
  lineEnd,
  lineStart,
  matchesAction,
  wordLeft,
  wordRight,
} from "./keybindings-adapter.js";
import {
  coerceValues,
  computeInvalid,
  type InputsPickerAction,
  type InputsPickerState,
} from "./inputs-picker-types.js";
import {
  caretLineDown,
  caretLineUp,
  isPrintableGrapheme,
  nextGraphemeOffset,
  previousGraphemeOffset,
} from "./inputs-picker-editing.js";

export function handleInputsPickerInput(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  keybindings?: KeybindingsLike,
): InputsPickerAction {
  if (fields.length === 0) {
    // Defensive: a workflow with zero declared inputs shouldn't reach the
    // picker (we gate on `fields.length > 0` at the open() site), but if
    // it does, treat any keystroke as a noop and let the host close us.
    if (isCancelKey(key)) return { kind: "cancel" };
    return { kind: "noop" };
  }
  return handleFormKey(key, state, fields, keybindings);
}

function handleFormKey(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  // ── Global navigation (workflow form contract, not Pi actions) ──
  if (isCancelKey(key)) return { kind: "cancel" };
  if (matchesKey(key, Key.tab)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (matchesKey(key, Key.shift("tab"))) {
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (state.focusedIdx === fields.length) return handleSubmitKey(key, state, fields, kb);

  const field = fields[state.focusedIdx]!;
  const name = field.name;
  const cur = state.rawText[name] ?? "";

  // ── Per-type edits ──
  if (field.type === "select") {
    return handleSelectKey(key, field, state, fields, kb);
  }
  if (field.type === "boolean") {
    return handleBooleanKey(key, field, state, fields, kb);
  }

  // string / text / number — text editing semantics. All editor-mode keys
  // (cursor, word jump, line jump, deletions) route through Pi's
  // KeybindingsManager so user-configured bindings work uniformly.
  const caret = Math.max(0, Math.min(state.caret, cur.length));

  if (matchesAction(kb, key, TUI_ACTION.editorCursorUp)) {
    if (field.type === "text") {
      const nextCaret = caretLineUp(cur, caret);
      if (nextCaret !== null) {
        state.caret = nextCaret;
        return { kind: "noop" };
      }
    }
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorDown)) {
    if (field.type === "text") {
      const nextCaret = caretLineDown(cur, caret);
      if (nextCaret !== null) {
        state.caret = nextCaret;
        return { kind: "noop" };
      }
    }
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorWordLeft")) {
    state.caret = wordLeft(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorWordRight")) {
    state.caret = wordRight(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorLineStart")) {
    state.caret = lineStart(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.cursorLineEnd")) {
    state.caret = lineEnd(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorLeft)) {
    state.caret = previousGraphemeOffset(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.editorCursorRight)) {
    state.caret = nextGraphemeOffset(cur, caret);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteWordBackward")) {
    const start = wordLeft(cur, caret);
    const r = deleteRange(cur, start, caret, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteWordForward")) {
    const end = wordRight(cur, caret);
    const r = deleteRange(cur, caret, end, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteToLineStart")) {
    const start = lineStart(cur, caret);
    const r = deleteRange(cur, start, caret, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteToLineEnd")) {
    const end = lineEnd(cur, caret);
    const r = deleteRange(cur, caret, end, caret);
    state.rawText[name] = r.text;
    state.caret = r.caret;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteCharBackward")) {
    if (caret > 0) {
      const r = deleteRange(cur, previousGraphemeOffset(cur, caret), caret, caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
    }
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, "tui.editor.deleteCharForward")) {
    if (caret < cur.length) {
      const r = deleteRange(cur, caret, nextGraphemeOffset(cur, caret), caret);
      state.rawText[name] = r.text;
      state.caret = r.caret;
    }
    return { kind: "noop" };
  }
  if (
    matchesAction(kb, key, TUI_ACTION.inputSubmit) ||
    matchesAction(kb, key, "tui.input.newLine")
  ) {
    if (field.type === "text") {
      state.rawText[name] = cur.slice(0, caret) + "\n" + cur.slice(caret);
      state.caret = caret + 1;
    } else {
      moveFocus(state, fields, +1);
    }
    return { kind: "noop" };
  }
  // Printable insert. Accept raw graphemes and terminal-encoded printable
  // keys (CSI-u / Kitty). VSCode's integrated terminal can emit printable
  // keys as escape sequences when modifyOtherKeys is active.
  const printable = decodePrintableKey(key) ?? key;
  if (isPrintableGrapheme(printable)) {
    state.rawText[name] = cur.slice(0, caret) + printable + cur.slice(caret);
    state.caret = caret + printable.length;
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleSelectKey(
  key: string,
  field: WorkflowInputEntry,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  const choices = field.choices ?? [];
  if (choices.length === 0) return { kind: "noop" };
  const current = state.rawText[field.name] ?? choices[0]!;
  const idx = Math.max(0, choices.indexOf(current));
  if (matchesAction(kb, key, TUI_ACTION.selectUp) || matchesAction(kb, key, TUI_ACTION.editorCursorLeft)) {
    state.rawText[field.name] = choices[(idx - 1 + choices.length) % choices.length]!;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectDown) || matchesAction(kb, key, TUI_ACTION.editorCursorRight)) {
    state.rawText[field.name] = choices[(idx + 1) % choices.length]!;
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectConfirm) || matchesAction(kb, key, TUI_ACTION.inputSubmit)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleBooleanKey(
  key: string,
  field: WorkflowInputEntry,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  if (
    matchesKey(key, Key.space) ||
    matchesAction(kb, key, TUI_ACTION.selectUp) ||
    matchesAction(kb, key, TUI_ACTION.selectDown) ||
    matchesAction(kb, key, TUI_ACTION.editorCursorLeft) ||
    matchesAction(kb, key, TUI_ACTION.editorCursorRight)
  ) {
    state.rawText[field.name] = state.rawText[field.name] === "true" ? "false" : "true";
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectConfirm) || matchesAction(kb, key, TUI_ACTION.inputSubmit)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  return { kind: "noop" };
}

function handleSubmitKey(
  key: string,
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  kb: KeybindingsLike | undefined,
): InputsPickerAction {
  if (matchesAction(kb, key, TUI_ACTION.selectUp) || matchesAction(kb, key, TUI_ACTION.editorCursorUp)) {
    moveFocus(state, fields, -1);
    return { kind: "noop" };
  }
  if (matchesAction(kb, key, TUI_ACTION.selectDown) || matchesAction(kb, key, TUI_ACTION.editorCursorDown)) {
    moveFocus(state, fields, +1);
    return { kind: "noop" };
  }
  if (
    matchesKey(key, Key.enter) ||
    matchesAction(kb, key, TUI_ACTION.selectConfirm) ||
    matchesAction(kb, key, TUI_ACTION.inputSubmit)
  ) {
    return attemptPickerSubmit(state, fields);
  }
  return { kind: "noop" };
}

function isCancelKey(key: string): boolean {
  return matchesKey(key, Key.ctrl("c")) || matchesKey(key, Key.escape);
}

function attemptPickerSubmit(
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
): InputsPickerAction {
  const invalid = computeInvalid(fields, state.rawText);
  if (invalid.length > 0) {
    state.invalidIndices = invalid;
    state.submitChoiceIdx = 0;
    state.focusedIdx = invalid[0]!;
    state.caret = (state.rawText[fields[state.focusedIdx]!.name] ?? "").length;
    return { kind: "noop" };
  }
  state.invalidIndices = [];
  return { kind: "run", values: coerceValues(fields, state.rawText) };
}

function moveFocus(
  state: InputsPickerState,
  fields: readonly WorkflowInputEntry[],
  delta: number,
): void {
  const n = fields.length + 1;
  if (n <= 1) return;
  state.focusedIdx = (state.focusedIdx + delta + n) % n;
  if (state.focusedIdx === fields.length) {
    state.caret = 0;
    state.submitChoiceIdx = 0;
    return;
  }
  const next = fields[state.focusedIdx]!;
  state.caret = (state.rawText[next.name] ?? "").length;
}
