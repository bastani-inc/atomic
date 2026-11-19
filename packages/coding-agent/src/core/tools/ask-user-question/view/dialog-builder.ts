import { type Component, Container, type Input, Spacer, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { clickableHintText } from "../../../../modes/interactive/components/nav-keys.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.js";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { TabBar } from "./components/tab-bar.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.ts";

export const HINT_PART_NAV = "↑↓ select";
export const HINT_PART_ENTER = "enter choose";
export const HINT_PART_TOGGLE = "enter/space toggle";
export const HINT_PART_NOTES = "n add notes";
export const HINT_PART_NOTES_TYPE = "type a note";
export const HINT_PART_NOTES_CLOSE = "enter/esc close notes";
export const HINT_PART_TAB = "tab next question";
export const HINT_PART_REVIEW_TAB = "tab questions";
export const HINT_PART_CANCEL = "esc cancel";
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

function fitHintText(hint: string, width: number): string {
	if (visibleWidth(hint) <= width) return hint;
	const compact = hint
		.replace(HINT_PART_NAV, "↑↓")
		.replace(HINT_PART_ENTER, "enter")
		.replace(HINT_PART_TOGGLE, "enter/space")
		.replace(HINT_PART_NOTES, "n notes")
		.replace(HINT_PART_TAB, "tab")
		.replace(HINT_PART_REVIEW_TAB, "tab");
	if (visibleWidth(compact) <= width) return compact;
	return compact
		.replace("n notes", "n")
		.replace(HINT_PART_CANCEL, "esc")
		.replace(HINT_PART_NOTES_TYPE, "type")
		.replace(HINT_PART_NOTES_CLOSE, "enter/esc");
}

export type DialogState = QuestionnaireState;

/** Per-tick projection of dialog state. Written by the adapter; read by the strategy thunk. */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** Construction-time config for `DialogView`. Frozen after construction. */
export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Input;
	chatRow: ChatRowView;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	/** Optional so single-question mode and non-submit tests can omit it; SubmitTabStrategy falls back to Spacer rows. */
	submitPicker?: Component;
	/** Worst-case body height across all tabs/options. Determines the stable overall dialog footprint. */
	getBodyHeight: (width: number) => number;
	/** Terminal columns. The preview layout reads them, so a cached frame holds only for the columns it was built at. */
	getTerminalWidth: () => number;
}

/** The last frame built, with the size it was built for. */
interface CachedFrame {
	readonly width: number;
	readonly terminalWidth: number;
	readonly lines: string[];
}

/**
 * The 7th renderable, promoted from a structural literal to a named class so
 * all view-layer components share one explicit `implements StatefulView<P>`
 * contract. `setProps(DialogProps)` writes the live cell read by the
 * strategy thunk during `render()`. `liveProps.activePreviewPane` is a
 * resolved pane reference threaded by the adapter per tick — the dialog
 * itself does not derive it.
 *
 * `render()` reuses the last frame until the dialog's own state or its size
 * changes. Every state change reaches this view through `setProps` (the
 * adapter applies all bindings on each one, this view's included), and
 * `invalidate()` drops the frame on a theme or cache reset, so a repaint
 * requested for any other reason (another component's update, a broadcast
 * refresh) costs no render.
 */
export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private frame: CachedFrame | undefined;
	private readonly config: DialogConfig;
	private readonly questionStrategy: QuestionTabStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;
	private headingMeasurement: { readonly width: number; readonly rows: number } | undefined;
	private chrome:
		| {
				readonly width: number;
				readonly top: string;
				readonly bottom: string;
				readonly side: string;
				readonly rule: string;
		  }
		| undefined;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			chatRow: config.chatRow,
			isMulti: config.isMulti,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
		this.frame = undefined;
	}

	handleInput(_data: string): void {}

	// The adapter's `invalidate()` resets every other renderable alongside this one.
	invalidate(): void {
		this.frame = undefined;
		this.headingMeasurement = undefined;
		this.chrome = undefined;
		this.questionStrategy.invalidate();
	}

	render(width: number): string[] {
		const terminalWidth = this.config.getTerminalWidth();
		const frame = this.frame;
		if (frame?.width === width && frame.terminalWidth === terminalWidth) return frame.lines;
		const onSubmit = this.config.isMulti && this.liveProps.state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;
		const lines = this.buildLines(strategy, width);
		this.frame = { width, terminalWidth, lines };
		return lines;
	}

	private maxHeadingRows(width: number): number {
		if (this.headingMeasurement?.width === width) return this.headingMeasurement.rows;
		const state = this.liveProps.state;
		let max = this.submitStrategy?.headingRows(state).reduce((sum, c) => sum + c.render(width).length, 0) ?? 0;
		for (let tab = 0; tab < this.config.questions.length; tab++) {
			const rows = this.questionStrategy.headingRows({ ...state, currentTab: tab });
			max = Math.max(
				max,
				rows.reduce((sum, c) => sum + c.render(width).length, 0),
			);
		}
		this.headingMeasurement = { width, rows: max };
		return max;
	}

	private buildLines(strategy: TabContentStrategy, width: number): string[] {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const innerWidth = Math.max(1, width - 4);
		if (this.chrome?.width !== width) {
			this.chrome = {
				width,
				top: theme.fg("accent", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
				bottom: theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
				side: theme.fg("accent", "│"),
				rule: theme.fg("borderMuted", "─".repeat(innerWidth)),
			};
		}
		const chrome = this.chrome;
		// Rendered once; its row count is the current height the residual below is measured against.
		const body = strategy.bodyComponent(state).render(innerWidth);

		const inner = new Container();
		if (isMulti && tabBar) {
			inner.addChild(tabBar);
			inner.addChild(new Spacer(1));
		}
		const heading = strategy.headingRows(state).flatMap((c) => c.render(innerWidth));
		inner.addChild({ render: () => heading, invalidate: () => {} });
		inner.addChild({ render: () => body, invalidate: () => {} });
		inner.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) inner.addChild(c);
		inner.addChild({ render: () => [chrome.rule], invalidate: () => {} });
		for (const c of strategy.footerRows(state)) inner.addChild(c);

		const lines = [chrome.top];
		const side = chrome.side;
		for (const line of inner.render(innerWidth)) {
			const lineWidth = visibleWidth(line);
			const fitted = lineWidth > innerWidth ? truncateToWidth(line, innerWidth, "") : line;
			const fittedWidth = lineWidth > innerWidth ? visibleWidth(fitted) : lineWidth;
			lines.push(`${side} ${fitted}${" ".repeat(Math.max(0, innerWidth - fittedWidth))} ${side}`);
		}
		lines.push(chrome.bottom);
		const hint = fitHintText(strategy.hintText(state), Math.max(1, width - 2));
		const hintLine = `  ${theme.fg("dim", clickableHintText(hint, ["n"]))}`;
		lines.push(visibleWidth(hintLine) > width ? truncateToWidth(hintLine, width, "") : hintLine);

		const maxHeight =
			this.config.getBodyHeight(innerWidth) + this.maxFooterRowCount + this.maxHeadingRows(innerWidth);
		const used = heading.length + body.length + strategy.footerRowCount;
		for (let i = Math.max(0, maxHeight - used); i > 0; i--) lines.push("");
		return lines;
	}
}
