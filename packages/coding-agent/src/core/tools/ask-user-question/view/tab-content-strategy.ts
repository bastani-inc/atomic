import { type Component, Container, type Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionData } from "../tool/types.ts";
import type { ChatRowView } from "./components/chat-row-view.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import {
	type DialogState,
	HINT_PART_CANCEL,
	HINT_PART_ENTER,
	HINT_PART_NAV,
	HINT_PART_NOTES,
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
 * enforces height equality across tabs via `bodyHeight + footerRowCount`.
 */
export interface TabContentStrategy {
	/** Total RENDERED footer rows — MUST equal what `footerRows()` actually emits. Drives residual math. */
	readonly footerRowCount: number;

	/** Variable rows above the body, after top chrome (border + tabBar + Spacer). */
	headingRows(state: DialogState): Component[];

	/** Body Component placed at the body slot. */
	bodyComponent(state: DialogState): Component;

	/** Natural rendered height of `bodyComponent(state)` at given width. */
	bodyHeight(width: number, state: DialogState): number;

	/** Optional rows between body's trailing Spacer and the bottom border. */
	midRows(state: DialogState): Component[];

	/** Footer rows below the bottom border. Rendered row count MUST equal `footerRowCount`. */
	footerRows(state: DialogState): Component[];
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	getPreviewPane: () => StatefulView<PreviewPaneProps>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
	getCurrentBodyHeight: (width: number) => number;
}

export class QuestionTabStrategy implements TabContentStrategy {
	/** Spacer(1) + chatRow(1) + Spacer(1) + Text(hint, 1) = 4 rendered rows. */
	readonly footerRowCount = 4;

	private declare readonly config: QuestionTabStrategyConfig;

	constructor(config: QuestionTabStrategyConfig) {
		this.config = config;
	}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		// In multi-question mode the tab bar already shows the header; suppress the inline badge.
		if (!this.config.isMulti && question?.header && question.header.length > 0) {
			out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
			out.push(new Spacer(1));
		}
		if (question) {
			out.push(new Text(this.config.theme.bold(question.question), 1, 0));
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

	bodyHeight(width: number, _state: DialogState): number {
		return this.config.getCurrentBodyHeight(width);
	}

	midRows(state: DialogState): Component[] {
		if (!state.notesVisible) return [];
		return [new Text(this.config.theme.fg("muted", NOTES_HEADER), 1, 0), this.config.notesInput, new Spacer(1)];
	}

	footerRows(state: DialogState): Component[] {
		const question = this.config.questions[state.currentTab];
		return [
			new Spacer(1),
			this.config.chatRow,
			new Spacer(1),
			new Text(this.config.theme.fg("dim", buildHintText(question, this.config.isMulti, state)), 1, 0),
		];
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
}

export class SubmitTabStrategy implements TabContentStrategy {
	/** Spacer(1) + Text(prompt, 1) + Spacer(1) + submitPicker(2) = 5 rendered rows. Fallback path lands at 5 via 2 trailing Spacer(1)s. */
	readonly footerRowCount = 5;

	private declare readonly config: SubmitTabStrategyConfig;

	constructor(config: SubmitTabStrategyConfig) {
		this.config = config;
	}

	headingRows(_state: DialogState): Component[] {
		return [new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)), 1, 0), new Spacer(1)];
	}

	bodyComponent(state: DialogState): Component {
		const c = new Container();
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			const a = state.answers.get(i);
			if (!a) continue;
			const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
			const answerText = formatAnswerScalar(a, "summary");
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${label}`), 1, 0));
			c.addChild(
				new Text(`   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`, 1, 0),
			);
			if (a.notes && a.notes.length > 0) {
				c.addChild(new Text(this.config.theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
			}
		}
		return c;
	}

	bodyHeight(width: number, state: DialogState): number {
		return this.bodyComponent(state).render(width).length;
	}

	midRows(_state: DialogState): Component[] {
		return [];
	}

	footerRows(state: DialogState): Component[] {
		const missing: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			if (!state.answers.has(i)) {
				missing.push(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`);
			}
		}
		const promptText =
			missing.length === 0
				? this.config.theme.fg("muted", READY_PROMPT)
				: this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`);
		const out: Component[] = [new Spacer(1), new Text(promptText, 1, 0), new Spacer(1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			// Padding when the picker isn't wired — keeps rendered row count at footerRowCount=5.
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		return out;
	}
}

/**
 * Build the controls hint line. Order is fixed so `HINT_SINGLE` / `HINT_MULTI`
 * remain contiguous substrings of the result:
 *   Enter · ↑/↓ [· Space toggle] [· n notes] [· Tab switch] · Esc
 */
export function buildHintText(question: QuestionData | undefined, isMulti: boolean, state: DialogState): string {
	const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
	if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
	if (question && question.multiSelect !== true && state.focusedOptionHasPreview && !state.notesVisible) {
		parts.push(HINT_PART_NOTES);
	}
	if (isMulti) parts.push(HINT_PART_TAB);
	parts.push(HINT_PART_CANCEL);
	return parts.join(" · ");
}
