import { type Component, Container, type Input, Spacer } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../../modes/interactive/components/index.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.js";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.js";
import type { ChatRowView } from "./components/chat-row-view.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { TabBar } from "./components/tab-bar.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.ts";

export const HINT_PART_ENTER = "enter select";
export const HINT_PART_NAV = "↑/↓ navigate";
export const HINT_PART_TOGGLE = "space toggle";
export const HINT_PART_NOTES = "n add notes";
export const HINT_PART_TAB = "tab switch questions";
export const HINT_PART_CANCEL = "esc cancel";
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_TAB, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTISELECT_SUFFIX = ` · ${HINT_PART_TOGGLE}`;
export const HINT_NOTES_SUFFIX = ` · ${HINT_PART_NOTES}`;
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

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
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

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
	}

	render(width: number): string[] {
		const terminalWidth = this.config.getTerminalWidth();
		const frame = this.frame;
		if (frame?.width === width && frame.terminalWidth === terminalWidth) return frame.lines;
		const onSubmit = this.config.isMulti && this.liveProps.state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;
		const lines = this.buildContainerFromStrategy(strategy, width).render(width);
		this.frame = { width, terminalWidth, lines };
		return lines;
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy, width: number): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));
		// Rendered once; its row count is the current height the residual below is measured against.
		const body = strategy.bodyComponent(state).render(width);

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		for (const c of strategy.headingRows(state)) container.addChild(c);
		container.addChild({ render: () => body, invalidate: () => {} });
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		// Residual rows equalize total height across tabs and strategies; rendered AFTER the bottom border.
		const maxHeight = this.config.getBodyHeight(width) + this.maxFooterRowCount;
		container.addChild(new Spacer(Math.max(0, maxHeight - body.length - strategy.footerRowCount)));
		return container;
	}
}
