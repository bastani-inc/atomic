import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
import type { QuestionnaireAction } from "./key-router.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import { computeFocusedOptionHasPreview } from "./selectors/derivations.ts";
import type { QuestionnaireState } from "./state.ts";

/** Session-lifetime constants. No live-component reads — peripheral values live on canonical state. */
export interface ApplyContext {
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
}

/**
 * Declarative side-effects emitted by `reduce`. The runtime executes them after
 * committing the new state, then asks the props-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
	| { kind: "set_input_buffer"; value: string; caret: number }
	| { kind: "set_notes_value"; value: string }
	| { kind: "set_notes_focused"; focused: boolean }
	| { kind: "forward_notes_keystroke"; data: string }
	| { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
	state: QuestionnaireState;
	effects: readonly Effect[];
}

function orderedAnswers(state: QuestionnaireState, questions: readonly QuestionData[]): QuestionAnswer[] {
	const out: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const a = state.answers.get(i);
		if (a) out.push(a);
	}
	return out;
}

function withFocusedOptionHasPreview(
	state: QuestionnaireState,
	questions: readonly QuestionData[],
): QuestionnaireState {
	const focusedOptionHasPreview = computeFocusedOptionHasPreview(questions, state.currentTab, state.optionIndex);
	if (state.focusedOptionHasPreview === focusedOptionHasPreview) return state;
	return { ...state, focusedOptionHasPreview };
}

function syncMultiSelectFromAnswers(
	answers: ReadonlyMap<number, QuestionAnswer>,
	questions: readonly QuestionData[],
	tab: number,
): ReadonlySet<number> {
	const q = questions[tab];
	if (!q?.multiSelect) return new Set();
	const saved = answers.get(tab);
	const labels = saved?.selected ?? [];
	const indices = new Set<number>();
	for (let i = 0; i < q.options.length; i++) {
		if (labels.includes(q.options[i]!.label)) indices.add(i);
	}
	return indices;
}

function persistMultiSelectAnswer(state: QuestionnaireState, ctx: ApplyContext): ReadonlyMap<number, QuestionAnswer> {
	const q = ctx.questions[state.currentTab];
	if (!q?.multiSelect) return state.answers;
	const selected: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) selected.push(q.options[i]!.label);
	}
	const out = new Map(state.answers);
	if (selected.length === 0) {
		out.delete(state.currentTab);
		return out;
	}
	const pendingNotes = state.notesByTab.get(state.currentTab);
	out.set(state.currentTab, {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "multi",
		answer: null,
		selected,
		...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
	});
	return out;
}

function clampCaret(value: string, caret: number | undefined): number {
	if (caret === undefined || !Number.isFinite(caret)) return value.length;
	return Math.max(0, Math.min(caret, value.length));
}

function customDraftValue(state: QuestionnaireState): string {
	const draft = state.customDraftByTab.get(state.currentTab);
	if (draft !== undefined) return draft;
	const prior = state.answers.get(state.currentTab);
	return prior?.kind === "custom" && typeof prior.answer === "string" ? prior.answer : "";
}

function hydrateCustomInputResult(state: QuestionnaireState): ApplyResult {
	const value = customDraftValue(state);
	const caret = clampCaret(value, state.customCaretByTab.get(state.currentTab));
	const customDraftByTab = new Map(state.customDraftByTab);
	const customCaretByTab = new Map(state.customCaretByTab);
	customDraftByTab.set(state.currentTab, value);
	customCaretByTab.set(state.currentTab, caret);
	return {
		state: { ...state, customDraftByTab, customCaretByTab },
		effects: [{ kind: "set_input_buffer", value, caret }],
	};
}

function switchTabResult(state: QuestionnaireState, nextTab: number, ctx: ApplyContext): ApplyResult {
	const notesValue = state.notesByTab.get(nextTab) ?? state.answers.get(nextTab)?.notes ?? "";
	const transitioned: QuestionnaireState = {
		...state,
		currentTab: nextTab,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		chatFocused: false,
		submitChoiceIndex: 0,
		multiSelectChecked: syncMultiSelectFromAnswers(state.answers, ctx.questions, nextTab),
		notesDraft: notesValue,
	};
	const finalState = withFocusedOptionHasPreview(transitioned, ctx.questions);
	return {
		state: finalState,
		effects: [
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: notesValue },
		],
	};
}

function doneFor(state: QuestionnaireState, ctx: ApplyContext, cancelled: boolean): ApplyResult {
	const result: QuestionnaireResult = { answers: orderedAnswers(state, ctx.questions), cancelled };
	return { state, effects: [{ kind: "done", result }] };
}

/**
 * Per-kind handler signature: action payload narrows to the matching union member
 * via `Extract`, so handlers consume fully-typed actions without `as` casts.
 */
type Handler<K extends QuestionnaireAction["kind"]> = (
	state: QuestionnaireState,
	action: Extract<QuestionnaireAction, { kind: K }>,
	ctx: ApplyContext,
) => ApplyResult;

const navHandler: Handler<"nav"> = (state, action, ctx) => {
	const items = ctx.itemsByTab[state.currentTab] ?? [];
	const item = items[action.nextIndex];
	const inputMode = item ? ROW_INTENT_META[item.kind].activatesInputMode : false;
	const next = withFocusedOptionHasPreview({ ...state, optionIndex: action.nextIndex, inputMode }, ctx.questions);
	return inputMode ? hydrateCustomInputResult(next) : { state: next, effects: [] };
};

const tabSwitchHandler: Handler<"tab_switch"> = (state, action, ctx) => switchTabResult(state, action.nextTab, ctx);

const confirmHandler: Handler<"confirm"> = (state, action, ctx) => {
	let answer = action.answer;
	if (answer.kind === "option" && answer.answer) {
		const q = ctx.questions[answer.questionIndex];
		const matched = q?.options.find((o) => o.label === answer.answer);
		if (matched?.preview && matched.preview.length > 0) {
			answer = { ...answer, preview: matched.preview };
		}
	}
	const pendingNotes = state.notesByTab.get(answer.questionIndex);
	if (pendingNotes && pendingNotes.length > 0) {
		answer = { ...answer, notes: pendingNotes };
	}
	const answers = new Map(state.answers);
	answers.set(answer.questionIndex, answer);
	const next: QuestionnaireState = { ...state, answers };
	if (answer.kind === "chat") return doneFor(next, ctx, false);
	if (action.autoAdvanceTab !== undefined) return switchTabResult(next, action.autoAdvanceTab, ctx);
	return doneFor(next, ctx, false);
};

const toggleHandler: Handler<"toggle"> = (state, action, ctx) => {
	const checked = new Set(state.multiSelectChecked);
	if (checked.has(action.index)) checked.delete(action.index);
	else checked.add(action.index);
	const intermediate: QuestionnaireState = { ...state, multiSelectChecked: checked };
	const answers = persistMultiSelectAnswer(intermediate, ctx);
	return { state: { ...intermediate, answers }, effects: [] };
};

const multiConfirmHandler: Handler<"multi_confirm"> = (state, action, ctx) => {
	const q = ctx.questions[state.currentTab];
	if (!q) return { state, effects: [] };
	const pendingNotes = state.notesByTab.get(state.currentTab);
	const answers = new Map(state.answers);
	answers.set(state.currentTab, {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "multi",
		answer: null,
		selected: action.selected,
		...(pendingNotes && pendingNotes.length > 0 ? { notes: pendingNotes } : {}),
	});
	const synced: QuestionnaireState = {
		...state,
		answers,
		multiSelectChecked: syncMultiSelectFromAnswers(answers, ctx.questions, state.currentTab),
	};
	if (action.autoAdvanceTab !== undefined) return switchTabResult(synced, action.autoAdvanceTab, ctx);
	return doneFor(synced, ctx, false);
};

const notesEnterHandler: Handler<"notes_enter"> = (state, _action, _ctx) => {
	const value = state.answers.get(state.currentTab)?.notes ?? "";
	return {
		state: { ...state, notesVisible: true, notesDraft: value },
		effects: [
			{ kind: "set_notes_value", value },
			{ kind: "set_notes_focused", focused: true },
		],
	};
};

const notesExitHandler: Handler<"notes_exit"> = (state, _action, _ctx) => {
	const trimmed = state.notesDraft.trim();
	const notes = new Map(state.notesByTab);
	const answers = new Map(state.answers);
	if (trimmed.length === 0) {
		notes.delete(state.currentTab);
		const prev = answers.get(state.currentTab);
		if (prev?.notes) {
			const stripped = { ...prev };
			delete (stripped as { notes?: string }).notes;
			answers.set(state.currentTab, stripped);
		}
	} else {
		notes.set(state.currentTab, trimmed);
		const prev = answers.get(state.currentTab);
		if (prev) answers.set(state.currentTab, { ...prev, notes: trimmed });
	}
	return {
		state: { ...state, notesByTab: notes, answers, notesVisible: false },
		effects: [{ kind: "set_notes_focused", focused: false }],
	};
};

const focusOptionsHandler: Handler<"focus_options"> = (state, action, ctx) => {
	const items = ctx.itemsByTab[state.currentTab] ?? [];
	const focused = items[action.optionIndex];
	const inputMode = focused ? ROW_INTENT_META[focused.kind].activatesInputMode : false;
	const next = withFocusedOptionHasPreview(
		{ ...state, chatFocused: false, optionIndex: action.optionIndex, inputMode },
		ctx.questions,
	);
	return inputMode ? hydrateCustomInputResult(next) : { state: next, effects: [] };
};

const cancelHandler: Handler<"cancel"> = (s, _a, c) => doneFor(s, c, true);
const submitHandler: Handler<"submit"> = (s, _a, c) => doneFor(s, c, false);
const submitNavHandler: Handler<"submit_nav"> = (s, a, _c) => ({
	state: { ...s, submitChoiceIndex: a.nextIndex },
	effects: [],
});
const focusChatHandler: Handler<"focus_chat"> = (s, _a, _c) => ({
	state: { ...s, chatFocused: true },
	effects: [],
});
const notesForwardHandler: Handler<"notes_forward"> = (s, a, _c) => ({
	state: s,
	effects: [{ kind: "forward_notes_keystroke", data: a.data }],
});
const ignoreHandler: Handler<"ignore"> = (s, _a, _c) => ({ state: s, effects: [] });

/**
 * Compile-time-exhaustive dispatch table. `{ [K in Kind]: Handler<K> }` requires
 * an entry per union member — adding a new `QuestionnaireAction` variant fails to
 * compile here until a handler is registered, mirroring the `Record<RowKind, …>`
 * pattern used by `ROW_INTENT_META`.
 */
const HANDLERS: { [K in QuestionnaireAction["kind"]]: Handler<K> } = {
	nav: navHandler,
	tab_switch: tabSwitchHandler,
	confirm: confirmHandler,
	toggle: toggleHandler,
	multi_confirm: multiConfirmHandler,
	cancel: cancelHandler,
	notes_enter: notesEnterHandler,
	notes_exit: notesExitHandler,
	notes_forward: notesForwardHandler,
	submit: submitHandler,
	submit_nav: submitNavHandler,
	focus_chat: focusChatHandler,
	focus_options: focusOptionsHandler,
	ignore: ignoreHandler,
};

/**
 * Pure reducer: (state, action, ctx) → (state, Effect[]). Mirrors `rpiv-todo`'s `applyTaskMutation`.
 * Delegates to `HANDLERS` — per-kind handlers above are pure, named, and individually testable.
 * `ignore` is also handled outside the reducer by `handleIgnoreInline` in the runtime fast path.
 */
export function reduce(state: QuestionnaireState, action: QuestionnaireAction, ctx: ApplyContext): ApplyResult {
	const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
	return handler(state, action as never, ctx);
}
