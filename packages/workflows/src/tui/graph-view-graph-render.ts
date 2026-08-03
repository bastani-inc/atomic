import { hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { GraphCanvas } from "./graph-canvas.js";
import { PULSE_PERIOD_MS } from "./graph-view-constants.js";
import { GraphViewRenderHelpers } from "./graph-view-render-helpers.js";
import { NODE_H, NODE_W } from "./layout.js";
import { renderNodeCard } from "./node-card.js";

interface Placement {
	startCol: number;
	width: number;
	line: string;
}

/** Graph body rendering and vertical/horizontal viewport management. */
export abstract class GraphViewGraphRenderer extends GraphViewRenderHelpers {
	protected _renderGraph(width: number): string[] {
		const run = this._getCurrentRun();
		if (!run || this.cachedLayout.length === 0) {
			this.lastGraphViewport = null;
			this.graphNodeHitRects = [];
			this.lastGraphTotalRows = 1;
			const dim = hexToAnsi(this.graphTheme.dim);
			return [this._centerCanvasContent(`${dim}waiting for stage events…${RESET}`, width)];
		}

		const graphInner = Math.max(1, width - 4);
		const { canvasWidth, totalRows, bands, edges } = this.cachedRenderGeometry;
		this.lastGraphTotalRows = totalRows;
		const leftMargin = Math.max(2, canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2);
		const viewportWidth = Math.max(1, width - leftMargin);
		const fullCanvasWidth = Math.max(canvasWidth, viewportWidth);
		this.lastGraphViewport = { leftMargin, viewportWidth };
		this._clampGraphHorizontalScroll(fullCanvasWidth, viewportWidth);
		if (this.pendingEnsureFocusedVisible) {
			this._scrollFocusedColumnIntoView(viewportWidth, fullCanvasWidth);
		}

		const bodyRows = this._overlayBodyRows(this._overlayPanelLineCount());
		if (totalRows > bodyRows) {
			this._clampGraphScroll(totalRows, bodyRows);
			if (this.pendingEnsureFocusedVisible) this._scrollFocusedIntoView(width, bodyRows, totalRows);
			this._clampGraphScroll(totalRows, bodyRows);
		} else {
			this.graphScrollOffset = 0;
		}

		const viewportTop = this.graphScrollOffset;
		const viewportBottom = Math.min(totalRows, viewportTop + bodyRows);
		const viewportLeft = this.graphScrollColOffset;
		const viewportRight = viewportLeft + viewportWidth;
		const pulsePhase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
		const edgeCanvas = new GraphCanvas({
			top: viewportTop,
			bottom: viewportBottom,
			left: viewportLeft,
			right: viewportRight,
		});
		const edgeColor = this.graphTheme.borderDim;
		for (const edge of edges) {
			if (
				edge.bottom <= viewportTop ||
				edge.top >= viewportBottom ||
				edge.right <= viewportLeft ||
				edge.left >= viewportRight
			) {
				continue;
			}
			this._plotEdge(edgeCanvas, edge.parentX, edge.parentY, edge.childX, edge.childY, edgeColor);
		}
		const edgeLines = edgeCanvas.toLines();
		const placements = new Map<number, Placement[]>();
		for (let bandIndex = this._firstVisibleLayoutBand(viewportTop); bandIndex < bands.length; bandIndex++) {
			const band = bands[bandIndex]!;
			if (band.top >= viewportBottom) break;
			for (const ni of band.nodeIndices) {
				const node = this.cachedLayout[ni]!;
				if (node.x + NODE_W <= viewportLeft || node.x >= viewportRight) continue;
				const cardLines = renderNodeCard(node.stage, {
					width: NODE_W,
					height: NODE_H,
					focused: ni === this.focusedIndex,
					pulsePhase,
					theme: this.graphTheme,
					stages: this.cachedDisplayStages,
					queuedMessageCount: this._stageQueuedMessageCount(node.stage),
				});
				const visibleLeft = Math.max(node.x, viewportLeft);
				const visibleRight = Math.min(node.x + NODE_W, viewportRight);
				for (let li = 0; li < cardLines.length; li++) {
					const globalRow = node.y + li;
					if (globalRow < viewportTop || globalRow >= viewportBottom) continue;
					const localRow = globalRow - viewportTop;
					let bucket = placements.get(localRow);
					if (!bucket) {
						bucket = [];
						placements.set(localRow, bucket);
					}
					bucket.push({
						startCol: visibleLeft - viewportLeft,
						width: visibleRight - visibleLeft,
						line: this._sliceColumns(cardLines[li]!, visibleLeft - node.x, visibleRight - node.x),
					});
				}
			}
		}

		const bg = hexBg(this.graphTheme.bg);
		const leftPad = `${bg}${" ".repeat(leftMargin)}${RESET}`;
		const composed: string[] = [];
		for (let localRow = 0; localRow < viewportBottom - viewportTop; localRow++) {
			const line = this._composeRow(edgeLines[localRow] ?? "", placements.get(localRow) ?? [], edgeColor);
			composed.push(`${leftPad}${this._padCanvas(line, viewportWidth)}`);
		}
		return composed;
	}

	protected _recordGraphNodeHitRects(graphStartRow: number, visibleRowCount: number): void {
		const viewport = this.lastGraphViewport;
		if (!viewport || visibleRowCount <= 0) {
			this.graphNodeHitRects = [];
			return;
		}

		const visibleTop = graphStartRow;
		const visibleBottom = graphStartRow + visibleRowCount;
		const viewportLeft = viewport.leftMargin;
		const viewportRight = viewport.leftMargin + viewport.viewportWidth;
		const rects: typeof this.graphNodeHitRects = [];
		const viewportTop = this.graphScrollOffset;
		const viewportBottom = viewportTop + visibleRowCount;
		const { bands } = this.cachedRenderGeometry;
		for (let bandIndex = this._firstVisibleLayoutBand(viewportTop); bandIndex < bands.length; bandIndex++) {
			const band = bands[bandIndex]!;
			if (band.top >= viewportBottom) break;
			for (const index of band.nodeIndices) {
				const node = this.cachedLayout[index]!;
				const top = graphStartRow + node.y - viewportTop;
				const bottom = top + NODE_H;
				const left = viewport.leftMargin + node.x - this.graphScrollColOffset;
				const right = left + NODE_W;
				const clippedTop = Math.max(visibleTop, top);
				const clippedBottom = Math.min(visibleBottom, bottom);
				const clippedLeft = Math.max(viewportLeft, left);
				const clippedRight = Math.min(viewportRight, right);
				if (clippedTop >= clippedBottom || clippedLeft >= clippedRight) continue;
				rects.push({ index, top: clippedTop, bottom: clippedBottom, left: clippedLeft, right: clippedRight });
			}
		}
		this.graphNodeHitRects = rects;
	}

	protected _visibleGraphLines(
		graphLines: string[],
		_frameWidth: number,
		bodyRows: number,
	): { lines: string[]; topPad: number } {
		this.pendingEnsureFocusedVisible = false;
		return {
			lines: graphLines,
			topPad:
				this.lastGraphTotalRows <= bodyRows
					? Math.min(3, Math.max(0, Math.floor((bodyRows - this.lastGraphTotalRows) / 2)))
					: 0,
		};
	}
}
