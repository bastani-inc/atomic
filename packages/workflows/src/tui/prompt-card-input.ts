import { Key, decodePrintableKey, matchesKey } from "./text-helpers.js";
import {
  type KeybindingsLike,
  TUI_ACTION,
  lineEnd,
  lineStart,
  matchesAction,
  wordLeft,
  wordRight,
} from "./keybindings-adapter.js";
import type { PromptCardAction, PromptCardState } from "./prompt-card-state.js";
import {
  applyDeleteRange,
  caretLineDown,
  caretLineUp,
  insertText,
  isPrintableText,
  matchesAnyKey,
  matchesTextAction,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "./prompt-card-text.js";
import {
  matchesSelectSubmit,
  normalizeSelectIndex,
  selectMovementDelta,
} from "./prompt-card-select.js";

export function handlePromptCardInput(
  data: string,
  state: PromptCardState,
  keybindings?: KeybindingsLike,
): PromptCardAction {
  if (matchesKey(data, Key.ctrl("c"))) {
    return { kind: "cancel" };
  }
  // The Escape key shares its leading byte with arrow/navigation sequences in
  // terminal raw mode. Treat Escape as a consumed no-op for prompt cards so a
  // split prefix can never resolve a prompt to its default response; Ctrl+C is
  // the explicit skip/default key for this surface.
  if (isPromptEscapeInput(data)) {
    return { kind: "noop" };
  }

  switch (state.prompt.kind) {
    case "confirm":
      return handleConfirm(data, state);
    case "select":
      return handleSelect(data, state, keybindings);
    case "input":
      return handleInput(data, state, keybindings);
    case "editor":
      return handleEditor(data, state, keybindings);
    case "custom":
      return { kind: "noop" };
  }
}

export function isPromptEscapeInput(data: string): boolean {
  return matchesKey(data, Key.escape);
}

function handleConfirm(
  data: string,
  state: PromptCardState,
): PromptCardAction {
  if (matchesAnyKey(data, [Key.left, Key.right, Key.space, Key.tab])) {
    state.confirmValue = !state.confirmValue;
    return { kind: "noop" };
  }
  if (matchesAnyKey(data, ["y", Key.shift("y")])) {
    return { kind: "submit", response: true };
  }
  if (matchesAnyKey(data, ["n", Key.shift("n")])) {
    return { kind: "submit", response: false };
  }
  if (matchesKey(data, Key.enter)) {
    return { kind: "submit", response: state.confirmValue };
  }
  return { kind: "noop" };
}

function handleSelect(
  data: string,
  state: PromptCardState,
  keybindings: KeybindingsLike | undefined,
): PromptCardAction {
  const choices = state.prompt.choices ?? [];
  if (choices.length === 0) {
    if (matchesSelectSubmit(data, keybindings)) {
      return { kind: "submit", response: "" };
    }
    return { kind: "noop" };
  }

  state.selectedIndex = normalizeSelectIndex(state.selectedIndex, choices.length);
  const movement = selectMovementDelta(data, keybindings, choices.length);
  if (movement !== 0) {
    state.selectedIndex = normalizeSelectIndex(state.selectedIndex + movement, choices.length);
    return { kind: "noop" };
  }
  if (matchesSelectSubmit(data, keybindings)) {
    return { kind: "submit", response: choices[state.selectedIndex] ?? choices[0] };
  }
  return { kind: "noop" };
}

function handleInput(
  data: string,
  state: PromptCardState,
  keybindings: KeybindingsLike | undefined,
): PromptCardAction {
  if (matchesTextAction(keybindings, data, TUI_ACTION.inputSubmit, Key.enter)) {
    return { kind: "submit", response: state.rawText };
  }
  if (matchesAction(keybindings, data, "tui.input.newLine")) {
    insertText(state, "\n");
    return { kind: "noop" };
  }
  return applyTextEdit(data, state, keybindings, { multiline: true });
}

function handleEditor(
  data: string,
  state: PromptCardState,
  keybindings: KeybindingsLike | undefined,
): PromptCardAction {
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
    state.editorSubmitFocused = !state.editorSubmitFocused;
    return { kind: "noop" };
  }
  if (state.editorSubmitFocused) {
    if (matchesTextAction(keybindings, data, TUI_ACTION.inputSubmit, Key.enter)) {
      return { kind: "submit", response: state.rawText };
    }
    return { kind: "noop" };
  }
  if (
    matchesTextAction(keybindings, data, TUI_ACTION.inputSubmit, Key.enter) ||
    matchesAction(keybindings, data, "tui.input.newLine")
  ) {
    insertText(state, "\n");
    return { kind: "noop" };
  }
  return applyTextEdit(data, state, keybindings, { multiline: true });
}

function applyTextEdit(
  data: string,
  state: PromptCardState,
  keybindings: KeybindingsLike | undefined,
  opts: { multiline: boolean },
): PromptCardAction {
  const caret = Math.max(0, Math.min(state.caret, state.rawText.length));
  state.caret = caret;

  if (opts.multiline && matchesAction(keybindings, data, TUI_ACTION.editorCursorUp)) {
    const nextCaret = caretLineUp(state.rawText, caret);
    if (nextCaret !== null) state.caret = nextCaret;
    return { kind: "noop" };
  }
  if (opts.multiline && matchesAction(keybindings, data, TUI_ACTION.editorCursorDown)) {
    const nextCaret = caretLineDown(state.rawText, caret);
    if (nextCaret !== null) state.caret = nextCaret;
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.cursorWordLeft")) {
    state.caret = wordLeft(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.cursorWordRight")) {
    state.caret = wordRight(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.cursorLineStart")) {
    state.caret = lineStart(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.cursorLineEnd")) {
    state.caret = lineEnd(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesTextAction(keybindings, data, TUI_ACTION.editorCursorLeft, Key.left)) {
    state.caret = previousGraphemeBoundary(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesTextAction(keybindings, data, TUI_ACTION.editorCursorRight, Key.right)) {
    state.caret = nextGraphemeBoundary(state.rawText, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.deleteWordBackward")) {
    applyDeleteRange(state, wordLeft(state.rawText, caret), caret, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.deleteWordForward")) {
    applyDeleteRange(state, caret, wordRight(state.rawText, caret), caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.deleteToLineStart")) {
    applyDeleteRange(state, lineStart(state.rawText, caret), caret, caret);
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.deleteToLineEnd")) {
    applyDeleteRange(state, caret, lineEnd(state.rawText, caret), caret);
    return { kind: "noop" };
  }
  if (matchesTextAction(keybindings, data, "tui.editor.deleteCharBackward", Key.backspace)) {
    if (caret > 0) {
      applyDeleteRange(state, previousGraphemeBoundary(state.rawText, caret), caret, caret);
    }
    return { kind: "noop" };
  }
  if (matchesAction(keybindings, data, "tui.editor.deleteCharForward")) {
    if (caret < state.rawText.length) {
      applyDeleteRange(state, caret, nextGraphemeBoundary(state.rawText, caret), caret);
    }
    return { kind: "noop" };
  }

  const printable = decodePrintableKey(data) ?? data;
  if (isPrintableText(printable)) {
    insertText(state, printable);
    return { kind: "noop" };
  }
  return { kind: "noop" };
}
