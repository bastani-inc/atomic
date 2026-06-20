import type { PendingPrompt } from "../shared/store-types.js";

export interface PromptCardState {
  readonly prompt: PendingPrompt;
  /** Raw text buffer for `input`/`editor` prompts. */
  rawText: string;
  /** Caret position within `rawText` (in characters, not visual cells). */
  caret: number;
  /** Selected index for `select` prompts (offset into `prompt.choices`). */
  selectedIndex: number;
  /** Boolean selection for `confirm` prompts (true = yes, false = no). */
  confirmValue: boolean;
  /** For multi-line editor prompts, Tab moves focus to a visible Submit action. */
  editorSubmitFocused: boolean;
}

export function createPromptCardState(prompt: PendingPrompt): PromptCardState {
  const initial = prompt.initial ?? "";
  return {
    prompt,
    rawText: initial,
    caret: initial.length,
    selectedIndex: 0,
    confirmValue: false,
    editorSubmitFocused: false,
  };
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/** Action returned by `handlePromptCardInput`. */
export type PromptCardAction =
  | { kind: "noop" }
  /** User submitted — `response` already shaped to match the prompt's kind. */
  | { kind: "submit"; response: unknown }
  /**
   * User dismissed without responding. Caller decides what to do — for HIL
   * we forward a kind-appropriate default to `store.resolvePendingPrompt`
   * so the workflow body resumes (rather than hanging).
   */
  | { kind: "cancel" };

/**
 * Compute the safe default response when the user dismisses the prompt.
 * Used by the overlay to keep the workflow body unblocked even on cancel.
 */
export function defaultResponseFor(prompt: PendingPrompt): unknown {
  switch (prompt.kind) {
    case "input":
    case "editor":
      return prompt.initial ?? "";
    case "confirm":
      return false;
    case "select":
      return prompt.choices?.[0] ?? "";
    case "custom":
      return undefined;
  }
}
