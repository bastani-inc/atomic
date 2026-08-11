import type { RunSnapshot } from "../shared/store-types.js";
import { hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { GraphViewGraphRenderer } from "./graph-view-graph-render.js";
import { GRAPH_HEADER_ROWS, GraphViewLayout, graphLayoutNaturalHeight } from "./graph-view-layout.js";
import type { GraphViewOpts } from "./graph-view-types.js";
import { renderHeader, renderOutlinePill } from "./header.js";
import { NODE_H } from "./layout.js";
import { renderPromptCard } from "./prompt-card.js";
import { renderSwitcher } from "./switcher.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

/**
 * `renderLayoutFrame` wraps each painted row with its segment reset. The
 * layout bridge records which rows were painted, so content that was not
 * wrapped cannot be mistaken for a layout seam during normalization.
 */
const LAYOUT_OSC_RESET = "\x1b[0m\x1b]8;;\x07";

function stripLayoutWrapper(line: string): string {
	const startsWithWrapper = line.startsWith(LAYOUT_OSC_RESET);
	const endsWithWrapper = line.endsWith(LAYOUT_OSC_RESET);
	const start = startsWithWrapper ? LAYOUT_OSC_RESET.length : 0;
	const end = endsWithWrapper ? line.length - LAYOUT_OSC_RESET.length : line.length;
	return line.slice(start, Math.max(start, end));
}
/** Overlay/widget rendering orchestration for GraphView. */
export abstract class GraphViewRenderer extends GraphViewGraphRenderer {
	protected readonly graphLayout: GraphViewLayout;
	private lastOverlayFrameHeight = 0;
	private hasReportedViewportRows = false;
	private renderRun: RunSnapshot | null | undefined;

	constructor(opts: GraphViewOpts) {
		super(opts);
		this.graphLayout = new GraphViewLayout({
			renderHeader: (width) => this._renderHeader(width),
			renderBody: (width, top, rows, contentRows) => this._renderBody(width, top, rows, contentRows),
			renderFooter: (width) => this._renderStatusline(width),
			bodyContentHeight: (_width, viewportRows) => this._graphBodyContentHeight(viewportRows),
			beforeFrame: (scrollView, viewportRows, contentRows, width) =>
				this._prepareGraphScroll(scrollView, viewportRows, contentRows, width),
			requestRender: () => this.requestRender?.(),
		});
	}
	protected override _graphScrollTop(): number {
		return this.graphLayout.scrollView.scrollTop;
	}

	/** Render to string lines. width = terminal columns. */
	render(width: number): string[] {
		if (this.mode === "widget") return this._renderWidget(width);
		return this._renderOverlay(width);
	}

	override dispose(): void {
		this.graphLayout.dispose();
		super.dispose();
	}

	protected _renderWidget(width: number): string[] {
		const run = this._getCurrentRun();
		if (!run) return [`${hexToAnsi(this.graphTheme.dim)}no active workflow${RESET}`];
		const displayStages = this._displayStages(run);
		const headerLines = renderHeader({ ...run, stages: displayStages }, { width, theme: this.graphTheme });
		const counts = this._counts(displayStages);
		const trailer =
			`${hexToAnsi(this.graphTheme.dim)}` +
			`${counts.completed}/${displayStages.length} done` +
			(counts.running > 0 ? ` · ${counts.running} running` : "") +
			(counts.failed > 0 ? ` · ${counts.failed} failed` : "") +
			(counts.blocked > 0 ? ` · ${counts.blocked} blocked` : "") +
			RESET;
		return [...headerLines, ` ${trailer}`];
	}

	protected _renderOverlay(width: number): string[] {
		const frameWidth = Math.max(40, width);
		const run = this._getCurrentRun();
		this.renderRun = run;
		try {
			const frameHeight = this._overlayFrameHeight(run);
			const layoutFrame = this.graphLayout.render(frameWidth, frameHeight);
			const lines = this._normalizeLayoutLines(
				layoutFrame.frame.lines,
				layoutFrame.wrappedRows,
				frameWidth,
				frameHeight,
				layoutFrame.topMarginRows,
				layoutFrame.bottomMarginRows,
			);
			const bodyStart = layoutFrame.bodyBox?.rect.y ?? layoutFrame.topMarginRows + GRAPH_HEADER_ROWS;
			const bodyRows = layoutFrame.bodyBox?.rect.height ?? this.graphLayout.viewportRows;
			if (run) {
				this._recordGraphNodeHitRects(bodyStart + this.lastGraphTopPad, this.lastGraphVisibleRows);
				this._renderSwitcherOverlay(lines, run, frameWidth, bodyStart, bodyRows);
				this._renderPromptOverlay(lines, frameWidth, bodyStart, bodyRows);
			} else {
				this.graphNodeHitRects = [];
				this.lastGraphViewport = null;
			}
			this.graphLayout.paintScrollbar(lines, frameWidth);

			return lines;
		} finally {
			this.renderRun = undefined;
		}
	}

	protected _overlayFrameHeight(run: RunSnapshot | null = this._currentRenderRun()): number {
		const reported = this.piTui?.terminal?.rows;
		if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
			this.hasReportedViewportRows = true;
			this.lastOverlayFrameHeight = Math.max(1, Math.floor(reported));
			return this.lastOverlayFrameHeight;
		}
		// A custom overlay may lose its terminal while the host tears down the
		// TUI. Keep the last hosted frame until a new row count arrives, so the
		// disappearing overlay does not jump to a different natural height.
		if (this.hasReportedViewportRows && this.lastOverlayFrameHeight > 0) return this.lastOverlayFrameHeight;

		const bodyRows = run ? Math.max(1, this.cachedRenderGeometry.totalRows) : 2;
		this.lastOverlayFrameHeight = graphLayoutNaturalHeight(bodyRows);
		return this.lastOverlayFrameHeight;
	}

	private _currentRenderRun(): RunSnapshot | null {
		return this.renderRun !== undefined ? this.renderRun : this._getCurrentRun();
	}

	private _graphBodyContentHeight(viewportRows: number): number {
		const rows = Math.max(0, Math.floor(viewportRows));
		if (!this._currentRenderRun() || this.cachedRenderGeometry.totalRows <= 0) return rows;
		return Math.max(rows, this.cachedRenderGeometry.totalRows);
	}

	private _prepareGraphScroll(
		scrollView: GraphViewLayout["scrollView"],
		viewportRows: number,
		_contentRows: number,
		width: number,
	): void {
		const run = this._currentRenderRun();
		if (viewportRows <= 0) return;
		if (!run || this.cachedRenderGeometry.totalRows <= 0) {
			scrollView.scrollToStart();
			this.pendingEnsureFocusedVisible = false;
			return;
		}

		if (this.pendingEnsureFocusedVisible) {
			const node = this.cachedLayout[this.focusedIndex];
			if (node) {
				let next = scrollView.scrollTop;
				if (node.y < next) next = node.y;
				else if (node.y + NODE_H > next + viewportRows) next = node.y + NODE_H - viewportRows;
				scrollView.scrollTo(next);

				const graphInner = Math.max(1, width - 4);
				const leftMargin = Math.max(
					2,
					this.cachedRenderGeometry.canvasWidth <= graphInner
						? Math.floor((graphInner - this.cachedRenderGeometry.canvasWidth) / 2)
						: 2,
				);
				const viewportWidth = Math.max(1, width - leftMargin);
				const fullCanvasWidth = Math.max(this.cachedRenderGeometry.canvasWidth, viewportWidth);
				this._scrollFocusedColumnIntoView(viewportWidth, fullCanvasWidth);
			}
			this.pendingEnsureFocusedVisible = false;
		}
	}

	private _renderHeader(width: number): string[] {
		const run = this._currentRenderRun();
		if (run) return renderHeader({ ...run, stages: this._displayStages(run) }, { width, theme: this.graphTheme });

		const t = this.graphTheme;
		const muted = hexToAnsi(t.textMuted);
		const chromeBg = hexBg(t.backgroundPanel);
		const { top, mid, bot, visibleWidth: pillW } = renderOutlinePill("ORCHESTRATOR", t.accent, chromeBg);
		const fillerVisible = Math.max(0, width - 1 - pillW - 6 - 2);
		const filler = " ".repeat(fillerVisible);
		return [
			`${chromeBg} ${RESET}${top}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
			`${chromeBg} ${RESET}${mid}${chromeBg}  ${muted}idle${RESET}${filler}${" ".repeat(2)}${RESET}`,
			`${chromeBg} ${RESET}${bot}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
		];
	}

	private _renderBody(width: number, top: number, rows: number, _contentRows: number): string[] {
		const run = this._currentRenderRun();
		const raw = run ? this._renderGraph(width, top, rows, run) : this._renderEmptyBody(width, rows);
		return raw.map((line) => this._canvasRow(line, width));
	}

	private _renderEmptyBody(width: number, rows: number): string[] {
		const body = [
			this._centerCanvasContent(`  ${hexToAnsi(this.graphTheme.textMuted)}No active workflow run.${RESET}`, width),
			this._centerCanvasContent(
				`  ${hexToAnsi(this.graphTheme.dim)}Start one with ${hexToAnsi(this.graphTheme.accent)}/workflow <name>${RESET}${hexToAnsi(this.graphTheme.dim)} or press ${hexToAnsi(this.graphTheme.accent)}F2${RESET}${hexToAnsi(this.graphTheme.dim)} on an active run.${RESET}`,
				width,
			),
		];
		const lines = Array.from({ length: rows }, () => "");
		const topPad = Math.max(0, Math.floor((rows - body.length) / 2));
		for (let index = 0; index < body.length; index++) {
			const target = topPad + index;
			if (target < lines.length) lines[target] = body[index]!;
		}
		return lines;
	}

	protected _normalizeLayoutLines(
		lines: readonly string[],
		wrappedRows: readonly boolean[],
		width: number,
		height: number,
		topMarginRows: number,
		bottomMarginRows: number,
	): string[] {
		return Array.from({ length: height }, (_, row) => {
			if (row < topMarginRows || row >= height - bottomMarginRows) return " ".repeat(width);
			const source = lines[row] ?? "";
			const clean = wrappedRows[row] === true ? stripLayoutWrapper(source) : source;
			if (visibleWidth(clean) === 0) return this._blankRow(width);
			if (visibleWidth(clean) > width) return truncateToWidth(clean, width, "…", true);
			return `${clean}${" ".repeat(width - visibleWidth(clean))}`;
		});
	}

	private _renderSwitcherOverlay(
		lines: string[],
		run: RunSnapshot,
		frameWidth: number,
		bodyStart: number,
		bodyRows: number,
	): void {
		if (!this.switcherOpen) return;
		const bodyEnd = bodyStart + bodyRows;
		for (let row = bodyStart; row < bodyEnd; row++) lines[row] = this._blankRow(frameWidth);
		const switcherWidth = Math.min(60, Math.max(40, frameWidth - 8));
		const switcherLines = renderSwitcher(this._displayStages(run), this.switcherState, {
			width: switcherWidth,
			theme: this.graphTheme,
			canOpenStageChat: (stage) => this._stageChatTarget(stage) !== undefined,
		});
		const insertAt = Math.max(bodyStart, bodyStart + Math.min(2, Math.floor((bodyRows - switcherLines.length) / 3)));
		const switcherLeft = Math.max(2, Math.floor((frameWidth - switcherWidth) / 2));
		for (let index = 0; index < switcherLines.length; index++) {
			const lineIndex = insertAt + index;
			if (lineIndex >= bodyEnd) break;
			lines[lineIndex] = this._overlayCard(
				lines[lineIndex] ?? this._blankRow(frameWidth),
				switcherLines[index]!,
				switcherLeft,
				frameWidth,
			);
		}
	}

	private _renderPromptOverlay(lines: string[], frameWidth: number, bodyStart: number, bodyRows: number): void {
		if (!this.promptState || this.switcherOpen) return;
		const run = this._currentRenderRun();
		const cardWidth = Math.min(72, Math.max(40, frameWidth - 6));
		const cardLines = renderPromptCard({
			state: this.promptState,
			theme: this.graphTheme,
			width: cardWidth,
			cursorOn: ((Date.now() / 530) | 0) % 2 === 0,
			identity: run ? { runId: run.id, name: run.name } : undefined,
			maxRows: bodyRows,
		});
		const bodyEnd = bodyStart + bodyRows;
		const slot = Math.max(bodyStart, bodyStart + Math.floor((bodyRows - cardLines.length) / 2));
		if (cardLines.length > bodyRows || slot + cardLines.length > bodyEnd) return;
		const leftPad = Math.max(0, Math.floor((frameWidth - cardWidth) / 2));
		for (let index = 0; index < cardLines.length; index++) {
			const lineIndex = slot + index;
			lines[lineIndex] = this._overlayCard(
				lines[lineIndex] ?? this._blankRow(frameWidth),
				cardLines[index]!,
				leftPad,
				frameWidth,
			);
		}
	}
}
