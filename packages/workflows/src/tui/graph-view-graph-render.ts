import type { RunSnapshot } from "../shared/store-types.js";
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

/** Graph body rendering and horizontal canvas management. */
export abstract class GraphViewGraphRenderer extends GraphViewRenderHelpers {
	protected _renderGraph(
		width: number,
		viewportTop: number,
		viewportRows: number,
		renderRun?: RunSnapshot | null,
	): string[] {
		const safeRows = Math.max(0, Math.floor(viewportRows));
		const run = renderRun !== undefined ? renderRun : this._getCurrentRun();
		if (!run || this.cachedLayout.length === 0) {
			this.lastGraphViewport = null;
			this.graphNodeHitRects = [];
			this.lastGraphTopPad = 0;
			this.lastGraphVisibleRows = safeRows;
			const lines = Array.from({ length: safeRows }, () => "");
			if (safeRows > 0) {
				const dim = hexToAnsi(this.graphTheme.dim);
				lines[Math.floor((safeRows - 1) / 2)] = this._centerCanvasContent(
					`${dim}waiting for stage events…${RESET}`,
					width,
				);
			}
			return lines;
		}

		const graphInner = Math.max(1, width - 4);
		const { canvasWidth, totalRows, bands, edges } = this.cachedRenderGeometry;
		const leftMargin = Math.max(2, canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2);
		const viewportWidth = Math.max(1, width - leftMargin);
		const fullCanvasWidth = Math.max(canvasWidth, viewportWidth);
		this.lastGraphViewport = { leftMargin, viewportWidth };

		const safeTop = Math.max(0, Math.min(totalRows, Math.floor(viewportTop)));
		const graphRows = Math.max(0, Math.min(safeRows, totalRows - safeTop));
		const viewportBottom = safeTop + graphRows;
		this._clampGraphHorizontalScroll(fullCanvasWidth, viewportWidth);
		const topPad = safeTop === 0 && totalRows <= safeRows ? Math.min(3, Math.floor((safeRows - totalRows) / 2)) : 0;
		this.lastGraphTopPad = topPad;
		this.lastGraphVisibleRows = graphRows;
		const viewportLeft = this.graphScrollColOffset;
		const viewportRight = viewportLeft + viewportWidth;
		const pulsePhase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
		const edgeCanvas = new GraphCanvas({
			top: safeTop,
			bottom: viewportBottom,
			left: viewportLeft,
			right: viewportRight,
		});
		const edgeColor = this.graphTheme.borderDim;
		for (const edge of edges) {
			if (
				edge.bottom <= safeTop ||
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
		for (let bandIndex = this._firstVisibleLayoutBand(safeTop); bandIndex < bands.length; bandIndex++) {
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
					if (globalRow < safeTop || globalRow >= viewportBottom) continue;
					const localRow = globalRow - safeTop;
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
		const composed = Array.from({ length: safeRows }, () => "");
		for (let localRow = 0; localRow < graphRows; localRow++) {
			const line = this._composeRow(edgeLines[localRow] ?? "", placements.get(localRow) ?? [], edgeColor);
			composed[topPad + localRow] = `${leftPad}${this._padCanvas(line, viewportWidth)}`;
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
		const viewportTop = this._graphScrollTop();
		const viewportBottom = Math.min(this.cachedRenderGeometry.totalRows, viewportTop + visibleRowCount);
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
}
