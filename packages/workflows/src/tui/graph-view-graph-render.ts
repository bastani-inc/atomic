import { GraphCanvas } from "./graph-canvas.js";
import { PULSE_PERIOD_MS } from "./graph-view-constants.js";
import { GraphViewRenderHelpers } from "./graph-view-render-helpers.js";
import { NODE_H, NODE_W } from "./layout.js";
import { renderNodeCard } from "./node-card.js";
import { hexBg, hexToAnsi, RESET } from "./color-utils.js";

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
      const dim = hexToAnsi(this.graphTheme.dim);
      return [
        this._centerCanvasContent(
          `${dim}waiting for stage events…${RESET}`,
          width,
        ),
      ];
    }

    const graphInner = Math.max(1, width - 4);
    const canvasWidth = this.cachedLayout.reduce(
      (max, node) => Math.max(max, node.x + NODE_W),
      0,
    );
    // Centre the whole graph horizontally when it fits; otherwise keep a
    // small gutter and reveal focused nodes by horizontally scrolling the
    // graph canvas. Do not switch to a compact list: the orchestrator pane
    // should always preserve the node-card graph view.
    const leftMargin = Math.max(
      2,
      canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2,
    );
    const viewportWidth = Math.max(1, width - leftMargin);
    const fullCanvasWidth = Math.max(canvasWidth, viewportWidth);
    this._clampGraphHorizontalScroll(fullCanvasWidth, viewportWidth);
    if (this.pendingEnsureFocusedVisible) {
      this._scrollFocusedColumnIntoView(viewportWidth, fullCanvasWidth);
    }

    // Pulse phase ∈ [0, 1) derived from wall-clock time so cards lerp
    // their border colour on the same beat regardless of how often
    // render() fires. The animation tick (`ANIMATION_TICK_MS`) only
    // controls render cadence — it does not advance the phase.
    const pulsePhase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;

    // 1. Plot parent → child edges into a sparse char canvas so they
    //    survive crisp through column gaps. Node-card bodies overwrite
    //    edge cells per-row when we compose the final output below.
    const edgeCanvas = new GraphCanvas();
    const edgeColor = this.graphTheme.borderDim;
    const nodeByStageId = new Map(
      this.cachedLayout.map((n) => [n.stage.id, n]),
    );
    for (const node of this.cachedLayout) {
      for (const parentId of node.stage.parentIds) {
        const parent = nodeByStageId.get(parentId);
        if (!parent) continue;
        this._plotEdge(
          edgeCanvas,
          parent.x,
          parent.y,
          node.x,
          node.y,
          edgeColor,
        );
      }
    }
    const edgeLines = edgeCanvas.toLines();

    // 2. Render each node card and record its row span / start column.
    const placements: Map<number, Placement[]> = new Map();
    for (let ni = 0; ni < this.cachedLayout.length; ni++) {
      const node = this.cachedLayout[ni]!;
      const focused = ni === this.focusedIndex;
      const cardLines = renderNodeCard(node.stage, {
        width: NODE_W,
        height: NODE_H,
        focused,
        pulsePhase,
        theme: this.graphTheme,
        stages: this.cachedLayout.map((layoutNode) => layoutNode.stage),
      });
      for (let li = 0; li < cardLines.length; li++) {
        const rowIdx = node.y + li;
        let bucket = placements.get(rowIdx);
        if (!bucket) {
          bucket = [];
          placements.set(rowIdx, bucket);
        }
        bucket.push({ startCol: node.x, width: NODE_W, line: cardLines[li]! });
      }
    }

    // 3. Compose each output row by interleaving edge segments with the
    //    card placements at their assigned columns.
    const totalRows = Math.max(
      edgeLines.length,
      ...this.cachedLayout.map((n) => n.y + NODE_H),
    );
    const composed: string[] = [];
    for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
      const edgeRowChars = this._edgeRowToCells(edgeLines[rowIdx] ?? "");
      const cards = placements.get(rowIdx) ?? [];
      composed.push(this._composeRow(edgeRowChars, cards, edgeColor));
    }

    // Pad the full graph canvas, then crop a horizontal viewport when the
    // fan-out is wider than the terminal. Cards/edges only paint cells they
    // occupy; everywhere else needs explicit bg so default terminal colours
    // never leak through.
    const bg = hexBg(this.graphTheme.bg);
    const leftPad = `${bg}${" ".repeat(leftMargin)}${RESET}`;
    return composed.map((line) => {
      const full = this._padCanvas(line, fullCanvasWidth);
      const sliced = this._sliceColumns(
        full,
        this.graphScrollColOffset,
        this.graphScrollColOffset + viewportWidth,
      );
      return `${leftPad}${this._padCanvas(sliced, viewportWidth)}`;
    });
  }

  protected _visibleGraphLines(
    graphLines: string[],
    frameWidth: number,
    bodyRows: number,
  ): { lines: string[]; topPad: number } {
    if (graphLines.length <= bodyRows) {
      this.graphScrollOffset = 0;
      this.pendingEnsureFocusedVisible = false;
      return {
        lines: graphLines,
        topPad: Math.min(3, Math.max(0, Math.floor((bodyRows - graphLines.length) / 2))),
      };
    }

    this._clampGraphScroll(graphLines.length, bodyRows);
    if (this.pendingEnsureFocusedVisible) {
      this._scrollFocusedIntoView(frameWidth, bodyRows, graphLines.length);
      this.pendingEnsureFocusedVisible = false;
    }
    this._clampGraphScroll(graphLines.length, bodyRows);
    return {
      lines: graphLines.slice(
        this.graphScrollOffset,
        this.graphScrollOffset + bodyRows,
      ),
      topPad: 0,
    };
  }

}
