import type { QuestionAnswer, QuestionData } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	chatFocused: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	/**
	 * Pre-answer notes side-band, keyed by tab index. Decoupled from `answers` so adding
	 * notes does NOT mark a question answered (the Submit-tab missing-check would falsely
	 * pass otherwise). Merged into the answer at confirm time.
	 */
	notesByTab: ReadonlyMap<number, string>;
	/** True iff the focused option carries a non-empty `preview` string. Gates `notes_enter` and the "n to add notes" hint chip. */
	focusedOptionHasPreview: boolean;
	/** Focused row in the Submit-tab picker (0 = Submit, 1 = Cancel). Reset on tab switch. */
	submitChoiceIndex: number;
	/** Canonical mirror of the in-flight notes editor; runtime mirrors after `forward_notes_keystroke`. */
	notesDraft: string;
	/** In-flight custom "Type something." drafts keyed by question tab. Preserved when focus leaves the row. */
	customDraftByTab: ReadonlyMap<number, string>;
	/** Caret offsets for in-flight custom drafts keyed by question tab. */
	customCaretByTab: ReadonlyMap<number, number>;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state. Held separately
 * because `keybindings` / `inputBuffer` must never reach view setProps consumers.
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
}
