import { GraphCanvas } from "./graph-canvas.js";
import {
  HINT_KEYS,
  MODE_PILL_LABEL,
  OVERLAY_LINE_COUNT,
  OVERLAY_VERTICAL_MARGIN_ROWS,
} from "./graph-view-constants.js";
import { GraphViewState } from "./graph-view-state.js";
import { renderOutlinePill } from "./header.js";
import { NODE_H, NODE_W } from "./layout.js";
import {
  sliceColumns,
  truncateToWidth,
  visibleWidth,
} from "./text-helpers.js";
import { BOLD, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { buildWorkflowLoopSummary, shouldRenderWorkflowLoopSummary } from "./workflow-loop-summary.js";

const MIN_LOOP_STATUSLINE_BUDGET = 10;

/** Low-level overlay geometry, chrome, ANSI canvas, and edge helpers. */
export abstract class GraphViewRenderHelpers extends GraphViewState {
  /**
   * Number of rows the overlay frame must paint. Pi-tui anchors the
   * overlay vertically by counting rendered lines, so to truly fill the
   * terminal under `maxHeight: "100%"` the component must emit
   * approximately `terminal.rows` lines. When a host reports fewer
   * than the legacy 32 rows, honour that shorter viewport where the
   * graph chrome can still fit so the bottom status controls are not
   * clipped by pi-tui's overlay max-height slicing. A host that doesn't
   * surface terminal dimensions keeps the previous stable rectangle.
   */
  protected _overlayLineCount(): number {
    const reported = this.getViewportRows?.();
    if (typeof reported !== "number" || !Number.isFinite(reported)) {
      return OVERLAY_LINE_COUNT;
    }
    // Header (3) + one body row + statusline (3) is the absolute
    // minimum useful frame. Margins are dropped automatically at this
    // size by `_overlayVerticalMarginRows`.
    return Math.max(7, Math.floor(reported));
  }

  /** Rows available for the graph body (between header and statusline). */
  protected _overlayBodyRows(lineCount: number): number {
    return Math.max(1, lineCount - 3 /* header */ - 3 /* statusline */);
  }

  protected _overlayVerticalMarginRows(lineCount = this._overlayLineCount()): number {
    return lineCount >= 9 ? OVERLAY_VERTICAL_MARGIN_ROWS : 0;
  }

  protected _overlayPanelLineCount(): number {
    const lineCount = this._overlayLineCount();
    const margins = this._overlayVerticalMarginRows(lineCount) * 2;
    return Math.max(7, lineCount - margins);
  }

  protected _marginRow(width: number): string {
    return " ".repeat(width);
  }

  protected _withVerticalMargins(panelLines: string[], width: number): string[] {
    const expected = this._overlayLineCount();
    const marginRows = this._overlayVerticalMarginRows(expected);
    const panelTarget = this._overlayPanelLineCount();
    const body = panelLines.slice(0, panelTarget);
    while (body.length < panelTarget) body.push(this._blankRow(width));
    const margins = Array.from({ length: marginRows }, () => this._marginRow(width));
    const lines = [...margins, ...body, ...margins];
    if (lines.length > expected) return lines.slice(0, expected);
    while (lines.length < expected) {
      const insertAt = marginRows > 0 ? Math.max(0, lines.length - marginRows) : lines.length;
      lines.splice(insertAt, 0, this._blankRow(width));
    }
    return lines;
  }

  /**
   * Three-row statusline pinned to the bottom of the overlay. Mirrors
   * the header band: `backgroundPanel` chrome, outlined accent pill
   * flush-left, hints flowing right on the centre row.
   */
  protected _renderStatusline(width: number): string[] {
    const t = this.graphTheme;
    const chromeBg = hexBg(t.backgroundPanel);
    const text = hexToAnsi(t.text);
    const muted = hexToAnsi(t.textMuted);
    const dim = hexToAnsi(t.dim);

    const {
      top,
      mid,
      bot,
      visibleWidth: pillW,
    } = renderOutlinePill(MODE_PILL_LABEL, t.accent, chromeBg);

    // Hints — `<key> <label>` separated by `  ·  `.
    const sep = `${chromeBg}  ${dim}·${RESET}${chromeBg}  `;
    const segments = HINT_KEYS.map(
      ({ key, label }) =>
        `${text}${BOLD}${key}${RESET}${chromeBg} ${muted}${label}${RESET}${chromeBg}`,
    );
    const hintsStyledRaw = segments.join(sep);
    const compactSegments = HINT_KEYS.map(({ key, label }) => {
      const compactLabel = label === "navigate" || label === "attach" ? "" : ` ${label}`;
      return `${text}${BOLD}${key}${RESET}${chromeBg}${muted}${compactLabel}${RESET}${chromeBg}`;
    });
    const hintsStyledCompact = compactSegments.join(sep);

    const leftEdgePad = 1;
    const rightEdgePad = 2;
    const contentBudget = Math.max(0, width - leftEdgePad - pillW - rightEdgePad);
    const currentRun = this._getCurrentRun();
    const displayRun = currentRun
      ? { ...currentRun, stages: this._displayStages(currentRun) }
      : undefined;
    const run = displayRun && shouldRenderWorkflowLoopSummary(displayRun) ? displayRun : undefined;
    const loopGap = run ? 2 : 0;
    const rawHintsWidth = visibleWidth(hintsStyledRaw);
    const compactHintsWidth = visibleWidth(hintsStyledCompact);
    const preferredHints = run
      // With a loop rail, reserve enough room for a useful Loop: fragment.
      ? contentBudget - rawHintsWidth - loopGap >= MIN_LOOP_STATUSLINE_BUDGET
        ? hintsStyledRaw
        : hintsStyledCompact
      // Without a loop rail, keep the full action labels whenever they fit.
      : rawHintsWidth <= contentBudget
        ? hintsStyledRaw
        : hintsStyledCompact;
    const preferredHintsWidth = preferredHints === hintsStyledRaw ? rawHintsWidth : compactHintsWidth;
    const hintsBudgetTarget = Math.min(contentBudget, preferredHintsWidth);
    const loopBudget = run
      ? Math.max(0, contentBudget - hintsBudgetTarget - loopGap)
      : 0;
    const loopText = run && loopBudget >= MIN_LOOP_STATUSLINE_BUDGET
      ? truncateToWidth(
        buildWorkflowLoopSummary({ ...run, stages: this._displayStages(run) }, { width: loopBudget }).oneLine,
        loopBudget,
        "",
      )
      : "";
    const loopStyled = loopText.length > 0
      ? `${text}${loopText}${RESET}${chromeBg}${" ".repeat(loopGap)}`
      : "";
    const usedLoopWidth = visibleWidth(loopStyled);
    const hintsBudget = Math.max(0, contentBudget - usedLoopWidth);
    const hintsStyled = truncateToWidth(preferredHints, hintsBudget, "");
    const hintsVisibleLen = visibleWidth(hintsStyled);
    const fillerVisible = Math.max(0, hintsBudget - hintsVisibleLen);
    const filler = " ".repeat(fillerVisible);
    const blankAcross = " ".repeat(Math.max(0, width - leftEdgePad - pillW));

    return [
      `${chromeBg} ${RESET}${top}${chromeBg}${blankAcross}${RESET}`,
      `${chromeBg} ${RESET}${mid}${chromeBg}${loopStyled}${filler}${hintsStyled}${chromeBg}${" ".repeat(rightEdgePad)}${RESET}`,
      `${chromeBg} ${RESET}${bot}${chromeBg}${blankAcross}${RESET}`,
    ];
  }

  /** Blank canvas row — single line of `bg`. */
  protected _blankRow(width: number): string {
    return `${hexBg(this.graphTheme.bg)}${" ".repeat(width)}${RESET}`;
  }

  protected _centerCanvasContent(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "…", true);
    const leftPad = Math.max(0, Math.floor((width - visibleWidth(truncated)) / 2));
    return `${" ".repeat(leftPad)}${truncated}`;
  }

  /** Wrap content in a canvas-bg row, padded to `width`. Re-emits the
   * bg ANSI right before the trailing fill so any internal `RESET`
   * from cards/edges doesn't let the terminal default bleed through. */
  protected _canvasRow(content: string, width: number): string {
    const bg = hexBg(this.graphTheme.bg);
    const truncated = truncateToWidth(content, width, "…", true);
    const padLen = Math.max(0, width - visibleWidth(truncated));
    return `${bg}${truncated}${bg}${" ".repeat(padLen)}${RESET}`;
  }

  /** Pad pre-styled content out to canvas width without truncation.
   * Re-emits the body bg ANSI right before the trailing fill so any
   * internal RESET inside `content` doesn't leak the terminal default. */
  protected _padCanvas(content: string, width: number): string {
    const bg = hexBg(this.graphTheme.bg);
    const padLen = Math.max(0, width - visibleWidth(content));
    return `${bg}${content}${bg}${" ".repeat(padLen)}${RESET}`;
  }

  /**
   * Compose a pre-styled card line over a canvas row at `leftPad` columns.
   * The base row keeps its `bg` (so background colour matches canvas);
   * the card slice replaces the cells starting at `leftPad`, and the
   * residual columns to the right are repainted with bg.
   *
   * We don't try to keep the parts of `base` that fall *under* the card
   * — pi-tui paints flat lines, not z-buffered cells, so the card's panel
   * background winning is fine.
   */
  protected _overlayCard(
    _base: string,
    cardLine: string,
    leftPad: number,
    totalWidth: number,
  ): string {
    const bg = hexBg(this.graphTheme.bg);
    const cardW = visibleWidth(cardLine);
    const rightPadLen = Math.max(0, totalWidth - leftPad - cardW);
    return `${bg}${" ".repeat(leftPad)}${RESET}${cardLine}${bg}${" ".repeat(rightPadLen)}${RESET}`;
  }

  protected _clampGraphScroll(totalRows: number, bodyRows: number): void {
    const maxOffset = Math.max(0, totalRows - bodyRows);
    this.graphScrollOffset = Math.max(
      0,
      Math.min(maxOffset, this.graphScrollOffset),
    );
  }

  protected _clampGraphHorizontalScroll(totalCols: number, viewportCols: number): void {
    const maxOffset = Math.max(0, totalCols - viewportCols);
    this.graphScrollColOffset = Math.max(
      0,
      Math.min(maxOffset, this.graphScrollColOffset),
    );
  }

  protected _scrollFocusedColumnIntoView(
    viewportCols: number,
    totalCols: number,
  ): void {
    const node = this.cachedLayout[this.focusedIndex];
    if (!node) return;
    const start = node.x;
    const end = node.x + NODE_W - 1;
    if (start < this.graphScrollColOffset) {
      this.graphScrollColOffset = start;
    } else if (end >= this.graphScrollColOffset + viewportCols) {
      this.graphScrollColOffset = end - viewportCols + 1;
    }
    this._clampGraphHorizontalScroll(totalCols, viewportCols);
  }

  protected _scrollFocusedIntoView(
    frameWidth: number,
    bodyRows: number,
    totalRows: number,
  ): void {
    const range = this._focusedGraphRowRange(frameWidth);
    if (!range) return;
    if (range.start < this.graphScrollOffset) {
      this.graphScrollOffset = range.start;
    } else if (range.end >= this.graphScrollOffset + bodyRows) {
      this.graphScrollOffset = range.end - bodyRows + 1;
    }
    this._clampGraphScroll(totalRows, bodyRows);
  }

  protected _focusedGraphRowRange(_frameWidth: number): { start: number; end: number } | null {
    const node = this.cachedLayout[this.focusedIndex];
    if (!node) return null;
    return { start: node.y, end: node.y + NODE_H - 1 };
  }

  /**
   * Plot a parent → child edge for the vertical orientation. The edge
   * exits from the parent's bottom-centre, runs through a horizontal
   * spine half-way down the gap, and re-enters from the child's
   * top-centre. Cells are merged by direction set so fan-out, fan-in,
   * and crossings produce stable orthogonal junctions instead of
   * stacked rounded corners.
   */
  protected _plotEdge(
    canvas: GraphCanvas,
    px: number,
    py: number,
    cx: number,
    cy: number,
    color: string,
  ): void {
    const parentCol = px + Math.floor(NODE_W / 2);
    const childCol = cx + Math.floor(NODE_W / 2);
    const parentExitRow = py + NODE_H; // first row below parent's bottom border
    const childEntryRow = cy - 1; // last row above child's top border
    if (childEntryRow < parentExitRow) return;

    if (parentCol === childCol) {
      canvas.vline(parentCol, parentExitRow, childEntryRow, color);
      return;
    }

    const spineRow = Math.max(
      parentExitRow,
      Math.min(childEntryRow, Math.floor((parentExitRow + childEntryRow) / 2)),
    );

    // Down stub from parent into the spine row.
    if (spineRow > parentExitRow) {
      canvas.vline(parentCol, parentExitRow, spineRow - 1, color);
    }
    this._placeJunction(canvas, spineRow, parentCol, ["u", childCol > parentCol ? "r" : "l"], color);

    // Horizontal spine segment.
    const hloCol = Math.min(parentCol, childCol) + 1;
    const hhiCol = Math.max(parentCol, childCol) - 1;
    if (hhiCol >= hloCol) {
      canvas.hline(spineRow, hloCol, hhiCol, color);
    }
    this._placeJunction(canvas, spineRow, childCol, [childCol > parentCol ? "l" : "r", "d"], color);

    // Down stub from spine into child.
    if (childEntryRow > spineRow) {
      canvas.vline(childCol, spineRow + 1, childEntryRow, color);
    }
  }

  protected _placeJunction(
    canvas: GraphCanvas,
    row: number,
    col: number,
    newDirs: Array<"u" | "d" | "l" | "r">,
    color: string,
  ): void {
    canvas.mergeCell(row, col, newDirs, color);
  }

  /**
   * Split the canvas-rendered edge row at card boundaries into spans of
   * `{ startCol, visibleWidth, content }` so the composer can interleave
   * cards without colliding.
   */
  protected _edgeRowToCells(line: string): string {
    return line;
  }

  /**
   * Interleave a single edge row with the node cards that cross it.
   * Cards take precedence at their column ranges; edge characters fill
   * the gaps. Returns one composed line padded with spaces.
   */
  protected _composeRow(
    edgeRow: string,
    cards: Array<{ startCol: number; width: number; line: string }>,
    _edgeColor: string,
  ): string {
    const bg = hexBg(this.graphTheme.bg);
    const sorted = cards.slice().sort((a, b) => a.startCol - b.startCol);
    let cursor = 0;
    let out = "";
    for (const card of sorted) {
      if (card.startCol > cursor) {
        // Edge segment up to card start — prepend bg so empty cells
        // in this stretch keep the body bg instead of falling back
        // to the terminal default once any prior RESET fired.
        out += `${bg}${this._edgeSegment(edgeRow, cursor, card.startCol)}`;
        cursor = card.startCol;
      }
      out += card.line;
      cursor += card.width;
    }
    // Trailing edge tail — same bg re-priming.
    out += `${bg}${this._edgeSegment(edgeRow, cursor, Math.max(cursor, visibleWidth(edgeRow)))}`;
    return out;
  }

  protected _edgeSegment(line: string, fromCol: number, toCol: number): string {
    if (fromCol >= toCol) return "";
    const segment = this._sliceColumns(line, fromCol, toCol);
    const visible = visibleWidth(segment);
    return `${segment}${" ".repeat(Math.max(0, toCol - fromCol - visible))}`;
  }

  protected _sliceColumns(line: string, fromCol: number, toCol: number): string {
    if (fromCol >= toCol) return "";
    return sliceColumns(line, fromCol, toCol - fromCol, true);
  }
}
