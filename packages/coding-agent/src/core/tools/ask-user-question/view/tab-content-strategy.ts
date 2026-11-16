import { type Component, Container, Input, Spacer, Text, truncateToWidth } from "@bastani/atomic-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.js";
import { terminalDisplayText } from "../../../../utils/terminal-text.ts";
import { fieldTone, styleFieldTone } from "../state/selectors/field-tone.ts";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import {
	type DialogState,
	HINT_PART_CANCEL,
	HINT_PART_ENTER,
	HINT_PART_NAV,
	HINT_PART_NOTES,
	HINT_PART_NOTES_CLOSE,
	HINT_PART_NOTES_TYPE,
	HINT_PART_REVIEW_TAB,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-builder.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";

const NOTES_HEADER = "Notes:";

/**
 * Per-tab content provider. Pure functional — closes over construction-time
 * config; per-tick state threads through method args. The chrome wrapper
 * enforces height equality across tabs from the rendered body's row count
 * plus `footerRowCount`.
 */
export interface TabContentStrategy {
	/**
	 * Total RENDERED footer rows: what `footerRows()` emits inside the frame plus the hint line under it. Drives
	 * residual math.
	 */
	readonly footerRowCount: number;

	/** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
	headingRows(state: DialogState): Component[];

	/** Body Component placed at the body slot. */
	bodyComponent(state: DialogState): Component;

	/** Optional rows between body's trailing Spacer and the bottom border. */
	midRows(state: DialogState): Component[];

	/** Footer rows inside the frame, below the rule. With the hint line they MUST render `footerRowCount` rows. */
	footerRows(state: DialogState): Component[];

	/** The one hint line under the frame: exactly the keys that work on this step. */
	hintText(state: DialogState): string;
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	getPreviewPane: () => StatefulView<PreviewPaneProps>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
}

export class QuestionTabStrategy implements TabContentStrategy {
	private readonly notesDisplayInput = new Input();
	/** chatRow(1) inside the frame + the hint line (1) = 2 rendered rows. */
	readonly footerRowCount = 2;

	private declare readonly config: QuestionTabStrategyConfig;

	constructor(config: QuestionTabStrategyConfig) {
		this.config = config;
	}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		// In multi-question mode the tab bar already shows the header; suppress the inline badge.
		if (!this.config.isMulti && question?.header && question.header.length > 0) {
			out.push(new Text(this.config.theme.bg("selectedBg", ` ${terminalDisplayText(question.header)} `), 0, 0));
			out.push(new Spacer(1));
		}
		if (question) {
			out.push(new Text(this.config.theme.bold(terminalDisplayText(question.question)), 0, 0));
			out.push(new Spacer(1));
		}
		return out;
	}

	bodyComponent(state: DialogState): Component {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso;
		return this.config.getPreviewPane();
	}

	midRows(state: DialogState): Component[] {
		if (!state.notesVisible) return [];
		const { theme, notesInput } = this.config;
		// Notes mode open means the notes field has focus, so this resolves to `editing`.
		const tone = fieldTone(state.notesVisible, state.notesDraft);
		const notesField: Component = {
			render: (width) => {
				const raw = notesInput.getValue();
				const safe = terminalDisplayText(raw);
				let display = notesInput;
				if (safe !== raw) {
					display = this.notesDisplayInput;
					display.setValue(safe);
					display.focused = notesInput.focused;
					const cursor = terminalDisplayText(raw.slice(0, notesInput.getCursor())).length;
					Reflect.set(display, "cursor", Math.min(cursor, safe.length));
				}
				return display.render(width).map((line) => styleFieldTone(theme, tone, line));
			},
			invalidate: () => notesInput.invalidate(),
		};
		return [new Text(theme.fg("muted", NOTES_HEADER), 0, 0), notesField, new Spacer(1)];
	}

	footerRows(_state: DialogState): Component[] {
		return [this.config.chatRow];
	}

	hintText(state: DialogState): string {
		return buildHintText(this.config.questions[state.currentTab], this.config.isMulti, state);
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
}

export class SubmitTabStrategy implements TabContentStrategy {
	/**
	 * Spacer(1) + Text(prompt, 1) + Spacer(1) + submitPicker(2) = 5 rendered rows inside the frame, plus the hint line.
	 * The fallback path lands at 5 via 2 trailing Spacer(1)s.
	 */
	readonly footerRowCount = 6;

	private declare readonly config: SubmitTabStrategyConfig;

	constructor(config: SubmitTabStrategyConfig) {
		this.config = config;
	}

	headingRows(_state: DialogState): Component[] {
		return [new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)), 0, 0), new Spacer(1)];
	}

	bodyComponent(state: DialogState): Component {
		const c = new Container();
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			const a = state.answers.get(i);
			if (!a) continue;
			const label = terminalDisplayText(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`);
			const answerText = terminalDisplayText(formatAnswerScalar(a, "summary"));
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${label}`), 1, 0));
			const { theme } = this.config;
			c.addChild(new Text(`   ${theme.fg("muted", "→")} ${styleFieldTone(theme, "answered", answerText)}`, 1, 0));
			if (a.notes && a.notes.length > 0) {
				c.addChild(
					new Text(
						`     ${theme.fg("muted", "notes:")} ${styleFieldTone(theme, "answered", terminalDisplayText(a.notes))}`,
						1,
						0,
					),
				);
			}
		}
		return c;
	}

	midRows(_state: DialogState): Component[] {
		return [];
	}

	footerRows(state: DialogState): Component[] {
		const missing: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			if (!state.answers.has(i)) {
				missing.push(terminalDisplayText(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`));
			}
		}
		const promptText =
			missing.length === 0
				? this.config.theme.fg("muted", READY_PROMPT)
				: this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
		// One line, so the footer keeps its fixed height however many questions are left.
		const prompt: Component = { render: (width) => [truncateToWidth(promptText, width, "…")], invalidate: () => {} };
		const out: Component[] = [new Spacer(1), prompt, new Spacer(1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		return out;
	}

	hintText(_state: DialogState): string {
		return [HINT_PART_NAV, HINT_PART_ENTER, HINT_PART_REVIEW_TAB, HINT_PART_CANCEL].join(" · ");
	}
}

/**
 * Build the controls hint line: exactly the keys that work on this question, in the shared hint order
 *   ↑↓ select · enter choose | enter/space toggle [· n add notes] [· tab next question] · esc cancel
 */
export function buildHintText(question: QuestionData | undefined, isMulti: boolean, state: DialogState): string {
	// While the notes field is open, enter and esc both close it and keep the note.
	if (state.notesVisible) return [HINT_PART_NOTES_TYPE, HINT_PART_NOTES_CLOSE].join(" · ");
	const onOption = question !== undefined && !state.chatFocused && state.optionIndex < question.options.length;
	const parts: string[] = [
		HINT_PART_NAV,
		question?.multiSelect === true && onOption ? HINT_PART_TOGGLE : HINT_PART_ENTER,
	];
	if (question && question.multiSelect !== true && onOption && !state.inputMode && state.focusedOptionHasPreview) {
		parts.push(HINT_PART_NOTES);
	}
	if (isMulti && (!state.inputMode || state.chatFocused)) parts.push(HINT_PART_TAB);
	parts.push(HINT_PART_CANCEL);
	return parts.join(" · ");
}
