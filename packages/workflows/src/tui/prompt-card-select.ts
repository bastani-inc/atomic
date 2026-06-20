import {
  SelectList,
  truncateToWidth,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { GraphTheme } from "./graph-theme.js";
import { paint } from "./color-utils.js";
import { Key, matchesKey } from "./text-helpers.js";
import {
  type KeybindingsLike,
  TUI_ACTION,
  matchesAction,
} from "./keybindings-adapter.js";
import type { PromptCardState } from "./prompt-card-state.js";

export function createPromptSelectList(
  state: PromptCardState,
  theme?: GraphTheme,
  maxVisible = 5,
): SelectList {
  const choices = state.prompt.choices ?? [];
  const items: SelectItem[] = choices.map((choice, idx) => ({
    value: String(idx),
    label: choice,
  }));
  const list = new SelectList(
    items,
    Math.max(1, Math.min(maxVisible, choices.length || 1)),
    createSelectListTheme(theme),
    {
      minPrimaryColumnWidth: 1,
      maxPrimaryColumnWidth: 80,
      truncatePrimary: ({ text, maxWidth, isSelected }) => {
        const clipped = truncateToWidth(text, maxWidth, "");
        if (!theme) return clipped;
        return paint(clipped, isSelected ? theme.text : theme.dim, { bold: isSelected });
      },
    },
  );
  const selectedIndex = normalizeSelectIndex(state.selectedIndex, choices.length);
  list.setSelectedIndex(selectedIndex);
  list.onSelectionChange = (item) => {
    state.selectedIndex = normalizeSelectIndex(Number(item.value), choices.length);
  };
  return list;
}

function createSelectListTheme(theme?: GraphTheme): SelectListTheme {
  if (!theme) {
    return {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    };
  }
  return {
    selectedPrefix: (text) => paint(text, theme.accent, { bold: true }),
    selectedText: (text) => paint(text, theme.text, { bold: true }),
    description: (text) => paint(text, theme.textMuted),
    scrollInfo: (text) => paint(text, theme.dim),
    noMatch: (text) => paint(text, theme.dim),
  };
}

export function normalizeSelectIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((n % length) + length) % length;
}

const SELECT_PAGE_STEP = 5;

export function selectMovementDelta(
  data: string,
  keybindings: KeybindingsLike | undefined,
  choiceCount: number,
): number {
  if (
    matchesAction(keybindings, data, TUI_ACTION.selectUp) ||
    matchesKey(data, Key.up) ||
    matchesKey(data, Key.left)
  ) {
    return -1;
  }
  if (
    matchesAction(keybindings, data, TUI_ACTION.selectDown) ||
    matchesKey(data, Key.down) ||
    matchesKey(data, Key.right)
  ) {
    return 1;
  }
  const pageStep = Math.max(1, Math.min(SELECT_PAGE_STEP, choiceCount));
  if (
    matchesAction(keybindings, data, TUI_ACTION.selectPageUp) ||
    matchesKey(data, "pageUp")
  ) {
    return -pageStep;
  }
  if (
    matchesAction(keybindings, data, TUI_ACTION.selectPageDown) ||
    matchesKey(data, "pageDown")
  ) {
    return pageStep;
  }
  return 0;
}

export function matchesSelectSubmit(
  data: string,
  keybindings: KeybindingsLike | undefined,
): boolean {
  return matchesAction(keybindings, data, TUI_ACTION.selectConfirm) || matchesKey(data, Key.enter);
}
