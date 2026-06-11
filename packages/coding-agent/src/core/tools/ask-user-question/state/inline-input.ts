import { ROW_INTENT_META } from "./row-intent.ts";
import type { InlineInputOwner, QuestionnaireState } from "./state.ts";

/**
 * Shared owner-branching accessors/mutator for the two per-owner inline-input
 * map pairs on `QuestionnaireState`:
 * - `"chat"`  → `chatDraftByTab` / `chatCaretByTab`
 * - `"other"` → `customDraftByTab` / `customCaretByTab`
 *
 * Both the pure reducer (`state-reducer.ts`) and the runtime
 * (`questionnaire-session.ts`) read and write these maps. Hoisting the helpers
 * here keeps the `owner === "chat"` branch in exactly one place instead of
 * copying it into each caller (previously `withInlineDraft` was duplicated
 * verbatim and the accessor pairs were near-duplicates split across the two
 * files).
 */

/** Raw draft text persisted for `owner` at the current tab, or undefined when none is stored. */
export function readInlineDraft(state: QuestionnaireState, owner: InlineInputOwner): string | undefined {
	return owner === "chat" ? state.chatDraftByTab.get(state.currentTab) : state.customDraftByTab.get(state.currentTab);
}

/** Raw caret offset persisted for `owner` at the current tab, or undefined when none is stored. */
export function readInlineCaret(state: QuestionnaireState, owner: InlineInputOwner): number | undefined {
	return owner === "chat" ? state.chatCaretByTab.get(state.currentTab) : state.customCaretByTab.get(state.currentTab);
}

/** Immutably persist `value`/`caret` into `owner`'s draft+caret maps for the current tab. */
export function withInlineDraft(
	state: QuestionnaireState,
	owner: InlineInputOwner,
	value: string,
	caret: number,
): QuestionnaireState {
	if (owner === "chat") {
		const chatDraftByTab = new Map(state.chatDraftByTab);
		const chatCaretByTab = new Map(state.chatCaretByTab);
		chatDraftByTab.set(state.currentTab, value);
		chatCaretByTab.set(state.currentTab, caret);
		return { ...state, chatDraftByTab, chatCaretByTab };
	}
	const customDraftByTab = new Map(state.customDraftByTab);
	const customCaretByTab = new Map(state.customCaretByTab);
	customDraftByTab.set(state.currentTab, value);
	customCaretByTab.set(state.currentTab, caret);
	return { ...state, customDraftByTab, customCaretByTab };
}

/**
 * Draft text used to hydrate the inline editor when (re)focusing `owner`: the
 * in-flight draft when present, otherwise the prior committed answer for that
 * owner. The `"chat"` owner excludes the reserved sentinel label so a prior
 * signal-only chat (`"Chat about this"`) does not re-hydrate as editable text.
 */
export function resolveInlineDraftValue(state: QuestionnaireState, owner: InlineInputOwner): string {
	const draft = readInlineDraft(state, owner);
	if (draft !== undefined) return draft;
	const prior = state.answers.get(state.currentTab);
	if (owner === "other") {
		return prior?.kind === "custom" && typeof prior.answer === "string" ? prior.answer : "";
	}
	return prior?.kind === "chat" && typeof prior.answer === "string" && prior.answer !== ROW_INTENT_META.chat.label
		? prior.answer
		: "";
}
