import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { getKeybindings, type Input } from "@earendil-works/pi-tui";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.ts";
import { buildQuestionnaire } from "./build-questionnaire.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import { type QuestionnaireAction, routeKey } from "./key-router.ts";
import { computeFocusedOptionHasPreview } from "./selectors/derivations.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.ts";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.ts";

function readInputCursor(input: Input): number {
	const value = input.getValue();
	const raw = Reflect.get(input, "cursor");
	return typeof raw === "number" && Number.isFinite(raw)
		? Math.max(0, Math.min(raw, value.length))
		: value.length;
}

function writeInputCursor(input: Input, cursor: number): void {
	const value = input.getValue();
	Reflect.set(input, "cursor", Math.max(0, Math.min(cursor, value.length)));
}

export interface QuestionnaireSessionConfig {
	tui: { terminal: { columns: number }; requestRender(): void };
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		chatFocused: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		customDraftByTab: new Map(),
		customCaretByTab: new Map(),
	};
}

/**
 * Slim runtime: owns the canonical state cell, the input-buffer cell, the
 * two-pass `notesVisible` dispatch loop, and the effect runner. State
 * transitions go through the pure `reduce` reducer; UI fan-out goes through
 * the `QuestionnairePropsAdapter` produced by `buildQuestionnaire`.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Input;
	private readonly inlineInput: Input;
	private readonly viewAdapter: QuestionnairePropsAdapter;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];

	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		// Seed from the focused option at start; the reducer keeps it in sync via withFocusedOptionHasPreview.
		this.state = { ...this.state, focusedOptionHasPreview: computeFocusedOptionHasPreview(this.questions, 0, 0) };

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		this.component = {
			render: built.render,
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
		};

		this.viewAdapter.apply(this.state);
	}

	dispatch(data: string): void {
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		this.state = this.mirrorInlineInputDraft(this.state);
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		const draft = this.notesInput.getValue();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private mirrorInlineInputDraft(s: QuestionnaireState): QuestionnaireState {
		if (!s.inputMode) return s;
		const value = this.inlineInput.getValue();
		const caret = readInputCursor(this.inlineInput);
		if (s.customDraftByTab.get(s.currentTab) === value && s.customCaretByTab.get(s.currentTab) === caret) {
			return s;
		}
		const customDraftByTab = new Map(s.customDraftByTab);
		const customCaretByTab = new Map(s.customCaretByTab);
		customDraftByTab.set(s.currentTab, value);
		customCaretByTab.set(s.currentTab, caret);
		return { ...s, customDraftByTab, customCaretByTab };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setValue(effect.value);
				writeInputCursor(this.inlineInput, effect.caret);
				return;
			case "set_notes_value":
				this.notesInput.setValue(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/**
	 * Per-keystroke `ignore` fast path: delegates to the headless `inlineInput`
	 * Input so bracketed-paste accumulator (`input.js:33-63`) and Kitty CSI-u
	 * decode (`input.js:155-163`) take effect. Cursor is NOT force-reset here —
	 * doing so would corrupt split-chunk pastes (a `\x05` byte mid-paste lands
	 * verbatim in `pasteBuffer` and survives `handlePaste`'s narrow strip).
	 * Cursor advances naturally via `insertCharacter` on typing/paste; cursor-
	 * movement keys (Left/Right/Home/End/word-jumps) are now functional, and
	 * the live buffer/caret are mirrored into canonical state so rendering can
	 * draw the same thick cursor at the editing caret. `viewAdapter.apply` is
	 * called directly without a reducer round-trip — preserves the D3 fast-path
	 * latency profile from Phase 11.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.state = this.mirrorInlineInputDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		return {
			keybindings: getKeybindings(),
			inputBuffer: this.inlineInput.getValue(),
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		if (this.state.chatFocused) return { kind: "chat", label: ROW_INTENT_META.chat.label };
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		if (this.state.optionIndex < arr.length) return arr[this.state.optionIndex];
		return { kind: "chat", label: ROW_INTENT_META.chat.label };
	}
}
