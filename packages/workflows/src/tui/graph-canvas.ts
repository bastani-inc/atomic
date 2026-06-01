/**
 * Sparse character grid used to compose the DAG canvas: edges (low z)
 * are plotted first, then node cards (high z) overwrite the cells they
 * occupy. The final {@link toLines} call materialises the buffer as
 * ANSI-styled strings keyed off each cell's foreground colour.
 *
 * Why not just draw into raw strings? Edges turn corners through the
 * gaps between cards, so we need column-accurate plotting. A sparse map
 * keeps the buffer cheap for wide-but-mostly-empty graph canvases.
 *
 * cross-ref:
 *   - github.com/bastani-inc/atomic packages/atomic-sdk/src/components/connectors.ts
 *   - src/tui/graph-view.ts  _renderGraph
 */

import { hexToAnsi, RESET } from "./color-utils.js";

interface Cell {
  ch: string;
  /** Hex foreground colour, or null for "use default fg" (no ANSI fg set). */
  fg: string | null;
}

type Dir = "u" | "d" | "l" | "r";

function dirsForGlyph(ch: string): Set<Dir> {
  switch (ch) {
    case "│":
      return new Set(["u", "d"]);
    case "─":
      return new Set(["l", "r"]);
    case "╭":
      return new Set(["d", "r"]);
    case "╮":
      return new Set(["d", "l"]);
    case "╰":
      return new Set(["u", "r"]);
    case "╯":
      return new Set(["u", "l"]);
    case "├":
      return new Set(["u", "d", "r"]);
    case "┤":
      return new Set(["u", "d", "l"]);
    case "┬":
      return new Set(["d", "l", "r"]);
    case "┴":
      return new Set(["u", "l", "r"]);
    case "┼":
      return new Set(["u", "d", "l", "r"]);
    default:
      return new Set();
  }
}

function glyphForDirs(dirs: Set<Dir>): string {
  const has = (...want: Dir[]) => want.every((d) => dirs.has(d));
  if (has("u", "d", "l", "r")) return "┼";
  if (has("u", "d", "r")) return "├";
  if (has("u", "d", "l")) return "┤";
  if (has("d", "l", "r")) return "┬";
  if (has("u", "l", "r")) return "┴";
  if (has("u", "d")) return "│";
  if (has("l", "r")) return "─";
  if (has("d", "r")) return "╭";
  if (has("d", "l")) return "╮";
  if (has("u", "r")) return "╰";
  if (has("u", "l")) return "╯";
  if (has("u") || has("d")) return "│";
  if (has("l") || has("r")) return "─";
  return " ";
}

export class GraphCanvas {
  /** rowIdx → colIdx → Cell. Sparse — empty cells render as a single space. */
  private rows: Map<number, Map<number, Cell>> = new Map();
  private maxRow = -1;
  private maxCol = -1;

  setCell(row: number, col: number, ch: string, fg: string | null): void {
    if (row < 0 || col < 0) return;
    let cols = this.rows.get(row);
    if (!cols) {
      cols = new Map();
      this.rows.set(row, cols);
    }
    cols.set(col, { ch, fg });
    if (row > this.maxRow) this.maxRow = row;
    if (col > this.maxCol) this.maxCol = col;
  }

  getCell(row: number, col: number): string | null {
    return this.rows.get(row)?.get(col)?.ch ?? null;
  }

  mergeCell(row: number, col: number, dirs: readonly Dir[], fg: string | null): void {
    if (row < 0 || col < 0) return;
    const existing = this.getCell(row, col);
    const merged = new Set<Dir>([
      ...(existing == null ? [] : dirsForGlyph(existing)),
      ...dirs,
    ]);
    this.setCell(row, col, glyphForDirs(merged), fg);
  }

  /**
   * Paint a single character cell, but only if the target cell is empty.
   * Used by the edge plotter so a corner glyph never clobbers a node-card
   * border that has already been placed at the same coordinate.
   */
  setCellIfEmpty(row: number, col: number, ch: string, fg: string | null): void {
    const cols = this.rows.get(row);
    if (cols?.has(col)) return;
    this.setCell(row, col, ch, fg);
  }

  /**
   * Place a horizontal `─` run from `(row, fromCol)` to `(row, toCol)`
   * inclusive, recolouring each cell with `fg`. Pass `endChar` to use a
   * different glyph at the final column (e.g. `>`-style arrowhead).
   */
  hline(row: number, fromCol: number, toCol: number, fg: string | null): void {
    const lo = Math.min(fromCol, toCol);
    const hi = Math.max(fromCol, toCol);
    for (let c = lo; c <= hi; c++) this.mergeCell(row, c, ["l", "r"], fg);
  }

  vline(col: number, fromRow: number, toRow: number, fg: string | null): void {
    const lo = Math.min(fromRow, toRow);
    const hi = Math.max(fromRow, toRow);
    for (let r = lo; r <= hi; r++) this.mergeCell(r, col, ["u", "d"], fg);
  }

  /** Materialise the canvas as one ANSI-styled string per row. */
  toLines(): string[] {
    if (this.maxRow < 0) return [];
    const lines: string[] = [];
    for (let r = 0; r <= this.maxRow; r++) {
      const cols = this.rows.get(r);
      if (!cols || cols.size === 0) {
        lines.push("");
        continue;
      }
      let buf = "";
      let cursorCol = 0;
      let activeFg: string | null = null;
      const sortedCols = Array.from(cols.keys()).sort((a, b) => a - b);
      for (const c of sortedCols) {
        if (c > cursorCol) {
          // Reset before emitting the gap so trailing styles don't bleed.
          if (activeFg !== null) {
            buf += RESET;
            activeFg = null;
          }
          buf += " ".repeat(c - cursorCol);
          cursorCol = c;
        }
        const cell = cols.get(c)!;
        if (cell.fg !== activeFg) {
          if (activeFg !== null) buf += RESET;
          if (cell.fg !== null) buf += hexToAnsi(cell.fg);
          activeFg = cell.fg;
        }
        buf += cell.ch;
        cursorCol += 1;
      }
      if (activeFg !== null) buf += RESET;
      lines.push(buf);
    }
    return lines;
  }
}
