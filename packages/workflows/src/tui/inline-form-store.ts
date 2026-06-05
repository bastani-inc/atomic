/**
 * Shared state store for inline workflow input forms.
 *
 * One entry per active or historical form, keyed by `formId` (uuid).
 * The custom message renderer (chat-history card) and the custom editor
 * (bottom-of-screen input) both read/write through this module so a single
 * keystroke updates both views via `tui.requestRender()`.
 *
 * Lifecycle:
 *   `createForm(id, …)`          → status = "editing"
 *   editor mutates fields        → status stays "editing"
 *   `finalizeForm(id, "submit")` → status = "submitted", values frozen
 *   `finalizeForm(id, "cancel")` → status = "cancelled"
 *
 * After finalize the state stays in the map for the lifetime of the session.
 * The renderer reads it to display the historical card. On a session boundary
 * (`session_start`: new/resume/fork/reload) the store is cleared via
 * {@link clearForms}, so a rehydrated `workflows:input-form` message has no
 * backing state and its renderer suppresses output (returns null) — the input
 * widget never reappears in chat after `/resume`.
 *
 * Why a global registry instead of closure capture: the message renderer is
 * registered ONCE at factory time and called many times for any number of
 * future messages. It can't close over per-invocation state. The formId in
 * `message.details` is the only stable link between a chat-history entry and
 * its mutable backing record.
 */

import type { WorkflowInputEntry } from "../extension/render-result.js";

export type FormStatus = "editing" | "submitted" | "cancelled";

export interface InlineFormState {
  formId: string;
  workflowName: string;
  fields: readonly WorkflowInputEntry[];
  /** Raw string per field; mirrors `inputs-picker.ts` semantics. */
  rawText: Record<string, string>;
  focusedIdx: number;
  /** Reserved for older form snapshots; Submit is now a single final action. */
  submitChoiceIdx: number;
  caret: number;
  status: FormStatus;
  /** Tick counter; bumped on every mutation so renderers can hash-dedupe. */
  version: number;
}

const FORMS = new Map<string, InlineFormState>();

export function createForm(init: Omit<InlineFormState, "version">): InlineFormState {
  const state: InlineFormState = { ...init, version: 0 };
  FORMS.set(state.formId, state);
  return state;
}

export function getForm(formId: string): InlineFormState | undefined {
  return FORMS.get(formId);
}

/**
 * Mutate the form in place and bump version. Returns the same state so
 * callers can chain. Mutating directly + bumping centrally keeps every code
 * path consistent — every keystroke handler closes with `touch(state)`.
 */
export function touch(state: InlineFormState): InlineFormState {
  state.version += 1;
  return state;
}

export function finalizeForm(formId: string, outcome: "submit" | "cancel"): void {
  const s = FORMS.get(formId);
  if (!s) return;
  s.status = outcome === "submit" ? "submitted" : "cancelled";
  touch(s);
}

/**
 * Clear all inline form state. Called on `session_start` so a resumed or
 * replaced session never renders a stale live form, and so a rehydrated
 * `workflows:input-form` message resolves to no backing state (its renderer
 * then returns null and the host renders nothing).
 */
export function clearForms(): void {
  FORMS.clear();
}

/** Test helper — clear the registry between tests. */
export function _resetForms(): void {
  clearForms();
}
