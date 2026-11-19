import { renderNavKeyOverlay } from "@bastani/atomic";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { colorLevelKey, fillBackground, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { GraphViewGraphRenderer } from "./graph-view-graph-render.js";
import { GRAPH_HEADER_ROWS, GraphViewLayout, graphLayoutNaturalHeight } from "./graph-view-layout.js";
import { toolExpandKey } from "./graph-view-render-helpers.js";
import type { GraphViewOpts } from "./graph-view-types.js";
import { renderHeader, renderOutlinePill } from "./header.js";
import { isKeybindingsLike } from "./keybindings-adapter.js";
import { NODE_H } from "./layout.js";
import { type RunOutcome, renderRunOutcome } from "./run-outcome.js";
import { runStateColor, runStateIndicator } from "./run-state-indicator.js";
import { renderStageFailureDetailLines } from "./stage-failure-detail.js";
import { renderSwitcher } from "./switcher.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";
import { renderToolDetailLines } from "./tool-detail.js";

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
/** Unpainted canvas between the orchestrator bars and the painted card. */
const TOOL_DETAIL_VIEWPORT_PAD = 1;

function toolDetailViewportPad(rows: number): number {
	return rows >= TOOL_DETAIL_VIEWPORT_PAD * 2 + 1 ? TOOL_DETAIL_VIEWPORT_PAD : 0;
}

/** One frame's tool-message geometry, derived once and shared by both callbacks. */
interface ToolDetailFrame {
	readonly width: number;
	readonly blockWidth: number;
	readonly leftPad: number;
	readonly lines: readonly string[];
	readonly selectedRow?: number;
	/** The color level the lines were painted in; see {@link colorLevelKey}. */
	readonly colorLevel: string;
}

/** Overlay/widget rendering orchestration for GraphView. */
export abstract class GraphViewRenderer extends GraphViewGraphRenderer {
	protected readonly graphLayout: GraphViewLayout;
	private lastOverlayFrameHeight = 0;
	private hasReportedViewportRows = false;
	private renderRun: RunSnapshot | null | undefined;
	private headerRun?: RunSnapshot;
	private detailFrame: ToolDetailFrame | null = null;

	private stageDetailFrame: {
		frame: ToolDetailFrame;
		stage: object;
		modelAttempts: StageSnapshot["modelAttempts"];
		logs: boolean;
	} | null = null;
	private runDetailFrame: {
		frame: ToolDetailFrame;
		run: object;
		outcome: RunOutcome;
		logs: boolean;
		selected: number;
		elapsedSecond: number;
	} | null = null;
	constructor(opts: GraphViewOpts) {
		super(opts);
		this.graphLayout = new GraphViewLayout({
			renderHeader: (width) => this._renderHeader(width),
			renderBody: (width, top, rows, contentRows) => this._renderBody(width, top, rows, contentRows),
			renderFooter: (width) => this._renderStatusline(width),
			bodyContentHeight: (width, viewportRows) => this._graphBodyContentHeight(width, viewportRows),
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
		this._syncLayout();
		try {
			if (this.mode === "widget") return this._renderWidget(width);
			this._refreshQueuedNodeHeights();
			return this._renderOverlay(width);
		} finally {
			this.displayBlock = undefined;
			this.headerRun = undefined;
		}
	}

	override dispose(): void {
		this.graphLayout.dispose();
		super.dispose();
	}

	private _headerSnapshot(run: RunSnapshot, stages: StageSnapshot[]): RunSnapshot {
		const header = { ...run, stages };
		// The header samples enumerable fields. Share its marker with the footer and switcher for this paint.
		this.displayBlock = { run, marker: "blockedAt" in header ? header : run };
		return header;
	}

	private _renderRunHeader(run: RunSnapshot, header: RunSnapshot, width: number): string[] {
		return renderHeader(header, {
			width,
			theme: this.graphTheme,
			displayStatus: () => this._runDisplayStatus(run, effectiveRunStatus(header)),
		});
	}

	protected _renderWidget(width: number): string[] {
		const run = this._getCurrentRun();
		if (!run) return [`${hexToAnsi(this.graphTheme.dim)}no active workflow${RESET}`];
		const displayStages = this._displayStages(run);
		const headerLines = this._renderRunHeader(run, this._headerSnapshot(run, displayStages), width);
		const counts = this._counts(displayStages);
		const dim = hexToAnsi(this.graphTheme.dim);
		const runState = runStateIndicator(run, () => this._runDisplayStatus(run));
		const runStateLead =
			runState === undefined
				? ""
				: `${hexToAnsi(runStateColor(runState, this.graphTheme))}${runState.text}${RESET}${dim} · `;
		const trailer =
			`${dim}${runStateLead}` +
			`${counts.completed}/${displayStages.length} done` +
			(counts.running > 0 ? ` · ${counts.running} running` : "") +
			(counts.failed > 0 ? ` · ${counts.failed} failed` : "") +
			(counts.blocked > 0 ? ` · ${counts.blocked} blocked` : "") +
			RESET;
		return [...headerLines, truncateToWidth(` ${trailer}`, width, "…")];
	}

	protected _renderOverlay(width: number): string[] {
		const frameWidth = Math.max(40, width);
		const run = this._getCurrentRun();
		this.renderRun = run;
		// One frame, one detail layout: the scroll clamp and the painted rows
		// must come from the same line array, and a running node's timing must
		// still advance between frames.
		this.detailFrame = null;
		try {
			if (run) this.headerRun = this._headerSnapshot(run, this._displayStages(run));
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
				if (this._detailOpen()) {
					this.graphNodeHitRects = [];
					this.lastGraphViewport = null;
				} else {
					this._recordGraphNodeHitRects(bodyStart + this.lastGraphTopPad, this.lastGraphVisibleRows);
					this._renderSwitcherOverlay(lines, run, frameWidth, bodyStart, bodyRows);
				}
			} else {
				this.graphNodeHitRects = [];
				this.lastGraphViewport = null;
			}
			this._renderKeysHelpOverlay(lines, frameWidth, bodyStart, bodyRows);
			this.graphLayout.paintScrollbar(lines, frameWidth);
			this._recordPaintedState();

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

	/**
	 * Lay the tool message block out once per frame width.
	 *
	 * The height callback and the body callback are invoked separately by the
	 * layout, and the body may be handed a narrower width when the ScrollView
	 * reserves its scrollbar column. Both go through here, so the rows the
	 * scroll range is clamped to are the rows that were actually produced.
	 */
	private _toolDetailFrame(node: NonNullable<GraphViewRenderer["toolDetail"]>, width: number): ToolDetailFrame {
		const safeWidth = Math.max(1, Math.floor(width));
		const cached = this.detailFrame;
		const colorLevel = colorLevelKey();
		if (cached !== null && cached.width === safeWidth && cached.colorLevel === colorLevel) return cached;
		// Span the same columns as the header/footer bars. Main-chat tool
		// blocks are full width; only the Box(1,1) pad insets the `$` text.
		const frame: ToolDetailFrame = {
			width: safeWidth,
			blockWidth: safeWidth,
			leftPad: 0,
			colorLevel,
			lines: renderToolDetailLines(node, {
				theme: this.graphTheme,
				width: safeWidth,
				expanded: this.toolDetailExpanded,
				expandKey: toolExpandKey(isKeybindingsLike(this.piKeybindings) ? this.piKeybindings : undefined),
			}),
		};
		this.detailFrame = frame;
		return frame;
	}

	private _openDetailFrame(width: number): ToolDetailFrame | null {
		if (this.toolDetail !== null) return this._toolDetailFrame(this.toolDetail, width);
		if (this.runDetail !== null) return this._runDetailFrame(width);
		const stage = this._stageDetailStage();
		if (this.stageDetail === null || stage === undefined) return null;
		const safeWidth = Math.max(1, Math.floor(width));
		const fullAttempts =
			stage.modelAttempts ??
			this.store.run(this.stageDetail.runId)?.stages.find((candidate) => candidate.id === this.stageDetail?.stageId)
				?.modelAttempts;
		const cached = this.stageDetailFrame;
		const colorLevel = colorLevelKey();
		if (
			cached !== null &&
			cached.frame.width === safeWidth &&
			cached.frame.colorLevel === colorLevel &&
			cached.stage === stage &&
			cached.modelAttempts === fullAttempts &&
			cached.logs === this.stageDetail.logs
		)
			return cached.frame;
		const detailStage =
			fullAttempts === undefined || fullAttempts === stage.modelAttempts
				? stage
				: { ...stage, modelAttempts: fullAttempts };
		const frame: ToolDetailFrame = {
			width: safeWidth,
			blockWidth: safeWidth,
			leftPad: 0,
			colorLevel,
			lines: renderStageFailureDetailLines(detailStage, {
				theme: this.graphTheme,
				width: safeWidth,
				logs: this.stageDetail.logs,
			}),
		};
		this.stageDetailFrame = { frame, stage, modelAttempts: fullAttempts, logs: this.stageDetail.logs };
		return frame;
	}

	private _runDetailFrame(width: number): ToolDetailFrame | null {
		const detail = this.runDetail;
		const run = this._currentRenderRun();
		if (detail === null || run === null) return null;
		const safeWidth = Math.max(1, Math.floor(width));
		const outcome = this._runOutcomeFor(run);
		const selected = this._resolveRunDetailSelection(outcome.blockers);
		const elapsedMs = elapsedRunMs(run, Date.now());
		const elapsedSecond = Math.floor(elapsedMs / 1000);
		const cached = this.runDetailFrame;
		const colorLevel = colorLevelKey();
		if (
			cached !== null &&
			cached.frame.width === safeWidth &&
			cached.frame.colorLevel === colorLevel &&
			cached.run === run &&
			cached.outcome === outcome &&
			cached.logs === detail.logs &&
			cached.selected === selected &&
			cached.elapsedSecond === elapsedSecond
		)
			return cached.frame;
		const rendered = renderRunOutcome(
			{ ...outcome, elapsedMs },
			{ theme: this.graphTheme, width: safeWidth, logs: detail.logs, selected },
		);
		const frame: ToolDetailFrame = {
			width: safeWidth,
			blockWidth: safeWidth,
			leftPad: 0,
			colorLevel,
			lines: rendered.lines,
			...(rendered.selectedRow === undefined ? {} : { selectedRow: rendered.selectedRow }),
		};
		this.runDetailFrame = { frame, run, outcome, logs: detail.logs, selected, elapsedSecond };
		return frame;
	}

	private _graphBodyContentHeight(width: number, viewportRows: number): number {
		const rows = Math.max(0, Math.floor(viewportRows));
		const detail = this._openDetailFrame(width);
		if (detail !== null) {
			const pad = toolDetailViewportPad(rows);
			return Math.max(rows, detail.lines.length + pad * 2);
		}
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
		if (this._detailOpen()) {
			if (this.pendingEnsureFocusedVisible) scrollView.scrollToStart();
			this.pendingEnsureFocusedVisible = false;
			if (this.runDetailRevealSelected) {
				this.runDetailRevealSelected = false;
				const selectedRow = this.runDetailFrame?.frame.selectedRow;
				if (selectedRow !== undefined) {
					const innerRows = Math.max(0, viewportRows - toolDetailViewportPad(viewportRows) * 2);
					const bottom = selectedRow + Math.min(2, innerRows);
					let next = scrollView.scrollTop;
					if (selectedRow < next) next = selectedRow;
					else if (bottom > next + innerRows) next = bottom - innerRows;
					scrollView.scrollTo(next);
				}
			}
			return;
		}
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
				else if (node.y + (node.height ?? NODE_H) > next + viewportRows)
					next = node.y + (node.height ?? NODE_H) - viewportRows;
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
		if (this.headerRun && this.renderRun) return this._renderRunHeader(this.renderRun, this.headerRun, width);

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
		].map((line) => fillBackground(line, width, chromeBg));
	}

	private _renderBody(width: number, top: number, rows: number, _contentRows: number): string[] {
		const detail = this._openDetailFrame(width);
		if (detail !== null) {
			const pad = toolDetailViewportPad(rows);
			const inner = Math.max(0, rows - pad * 2);
			const painted = detail.lines
				.slice(top, top + inner)
				.map((line) => this._canvasRow(`${" ".repeat(detail.leftPad)}${line}`, width));
			return [...Array.from({ length: pad }, () => ""), ...painted, ...Array.from({ length: pad }, () => "")];
		}
		const run = this._currentRenderRun();
		const raw = run ? this._renderGraph(width, top, rows, run) : this._renderEmptyBody(width, rows);
		return raw.map((line) => this._canvasRow(line, width));
	}

	private _renderEmptyBody(width: number, rows: number): string[] {
		const body = [
			this._centerCanvasContent(`  ${hexToAnsi(this.graphTheme.textMuted)}No active workflow run.${RESET}`, width),
			this._centerCanvasContent(
				`  ${hexToAnsi(this.graphTheme.dim)}Open ${hexToAnsi(this.graphTheme.accent)}/workflows${RESET}${hexToAnsi(this.graphTheme.dim)} or press ${hexToAnsi(this.graphTheme.accent)}F2${RESET}${hexToAnsi(this.graphTheme.dim)} on an active run.${RESET}`,
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
			if (visibleWidth(clean) > width) return truncateToWidth(clean, width, "…");
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
			runState: runStateIndicator(run, () => this._runDisplayStatus(run)),
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

	private _renderKeysHelpOverlay(lines: string[], frameWidth: number, bodyStart: number, bodyRows: number): void {
		if (!this.keysHelpOpen) return;
		const boxWidth = Math.min(56, Math.max(24, frameWidth - 8));
		const help = renderNavKeyOverlay(
			this.runDetail !== null
				? "keys \u00b7 run details"
				: this._detailOpen()
					? "keys \u00b7 stage detail"
					: "keys \u00b7 workflow graph",
			this._graphKeys(),
			boxWidth,
			this._navKeyStyle(),
			this._navKeybindings(),
		);
		const bodyEnd = bodyStart + bodyRows;
		const insertAt = Math.max(bodyStart, bodyStart + Math.floor((bodyRows - help.length) / 2));
		const left = Math.max(2, Math.floor((frameWidth - boxWidth) / 2));

		for (let index = 0; index < help.length; index++) {
			const lineIndex = insertAt + index;
			if (lineIndex >= bodyEnd) break;
			lines[lineIndex] = this._overlayCard(
				lines[lineIndex] ?? this._blankRow(frameWidth),
				help[index]!,
				left,
				frameWidth,
			);
		}
	}
}
