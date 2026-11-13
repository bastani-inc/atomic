import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.js";
import type { StatefulView } from "../../stateful-view.ts";
import type { OptionListView } from "../option-list-view.ts";
import type { PreviewBlockRenderer } from "./preview-block-renderer.ts";
import {
	bodyWidths,
	columnWidths,
	decideLayout,
	PREVIEW_PADDING_LEFT,
	type PreviewLayoutMode,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

// ----- Re-exports for test imports — keep `./preview-pane.js` as the public surface -----
export {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
export { NOTES_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.ts";
export {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	BOX_MIN_CONTENT_WIDTH,
	renderBorderedBox,
	stripFenceMarkers,
} from "./preview-box-renderer.ts";
export {
	PREVIEW_COLUMN_GAP,
	PREVIEW_MIN_WIDTH,
	PREVIEW_PADDING_LEFT,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

/**
 * Per-tick projection of PreviewPane state. Replaces the prior
 * `setNotesVisible(boolean)` sliver-setter and the sibling reads of
 * `optionListView.getSelectedIndex()` / `isFocused()`. The pane now reads
 * `selectedIndex` and `focused` from its own props — both derived from
 * canonical state via `selectPreviewPaneProps`. `OptionListView` and
 * `PreviewPane` see the same source of truth without the cross-component
 * live read.
 */
export interface PreviewPaneProps {
	notesVisible: boolean;
	selectedIndex: number;
	focused: boolean;
	/** Saved notes for the active question; shown on the affordance row while notes mode is closed. */
	notes: string;
}

export interface PreviewPaneConfig {
	question: QuestionData;
	getTerminalWidth: () => number;
	optionListView: OptionListView;
	previewBlock: PreviewBlockRenderer;
}

/**
 * Thin layout composer. Receives `selectedIndex` / `focused` / `notesVisible`
 * via `setProps` per tick (computed by `selectPreviewPaneProps` from canonical
 * state). Delegates option-side rendering to `OptionListView` (which still
 * owns its render-time state — input buffer, confirmedIndex) and preview-side
 * rendering to `PreviewBlockRenderer` (which owns the markdown cache and
 * bordered-box composition).
 *
 * `maxNaturalHeight` reads both children's heights from their cached layouts;
 * `render` combines them via `decideLayout` (mode threaded into both calls —
 * never re-derived).
 */
export class PreviewPane implements StatefulView<PreviewPaneProps>, Component {
	private readonly question: QuestionData;
	private readonly getTerminalWidth: () => number;
	private readonly optionListView: OptionListView;
	private readonly previewBlock: PreviewBlockRenderer;
	private props: PreviewPaneProps;
	/**
	 * Cross-tab max left-width getter. Set exactly once by `buildQuestionnaire.injectGlobalLeftWidth`
	 * before any render. Initialized to a throwing sentinel so missing injection is a hard fail
	 * rather than a silent fallback to a magic constant — render is illegal until injected.
	 */
	private globalLeftWidth: (paneWidth: number) => number = () => {
		throw new Error("PreviewPane.setGlobalLeftWidth must be called before render()");
	};

	constructor(config: PreviewPaneConfig) {
		this.question = config.question;
		this.getTerminalWidth = config.getTerminalWidth;
		this.optionListView = config.optionListView;
		this.previewBlock = config.previewBlock;
		this.props = { notesVisible: false, selectedIndex: 0, focused: false, notes: "" };
	}

	setGlobalLeftWidth(getter: (paneWidth: number) => number): void {
		this.globalLeftWidth = getter;
	}

	private getAdaptiveLeft(paneWidth: number): number {
		return this.globalLeftWidth(paneWidth);
	}

	setProps(props: PreviewPaneProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.previewBlock.invalidate();
		this.optionListView.invalidate();
	}

	render(width: number): string[] {
		if (this.question.multiSelect === true) return this.optionListView.render(width);
		// Spec: hide the preview pane entirely when no option carries a `preview`.
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width);

		const mode = decideLayout(this.getTerminalWidth(), width);
		if (mode === "side-by-side") return this.renderSideBySide(width, mode);

		// Stacked: options + blank gap + preview block.
		return [
			...this.optionListView.render(width),
			...Array(STACKED_GAP_ROWS).fill(""),
			...this.previewBlock.renderBlock(
				width,
				this.props.selectedIndex,
				mode,
				this.props.focused,
				this.props.notesVisible,
				this.props.notes,
			),
		];
	}

	maxNaturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.height(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.height(width);
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.height(optionsWidth);
		let maxPreviewBlock = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const h = this.previewBlock.blockHeight(previewWidth, i, mode);
			if (h > maxPreviewBlock) maxPreviewBlock = h;
		}
		if (mode === "side-by-side") return Math.max(optionsHeight, maxPreviewBlock);
		return optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
	}

	private renderSideBySide(width: number, mode: PreviewLayoutMode): string[] {
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth, rightWidth, gap } = columnWidths(width, adaptiveLeft);
		const leftLines = this.optionListView.render(leftWidth);
		const rightLines = this.renderPaddedPreviewLines(rightWidth, mode);
		const rows = Math.max(leftLines.length, rightLines.length);
		const gapStr = " ".repeat(gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const leftRaw = leftLines[i] ?? "";
			const rightRaw = rightLines[i] ?? "";
			const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
			const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
			const joined = `${leftClamped}${leftPad}${gapStr}${rightRaw}`;
			out.push(truncateToWidth(joined, width, ""));
		}
		return out;
	}

	private renderPaddedPreviewLines(colWidth: number, mode: PreviewLayoutMode): string[] {
		const inner = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.previewBlock.renderBlock(
			inner,
			this.props.selectedIndex,
			mode,
			this.props.focused,
			this.props.notesVisible,
			this.props.notes,
		);
		const pad = " ".repeat(PREVIEW_PADDING_LEFT);
		return contentLines.map((l) => (l === "" ? "" : `${pad}${l}`));
	}
}
