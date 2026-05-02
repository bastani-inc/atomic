// ─── Connectors ───────────────────────────────────

import type { GraphTheme } from "./graph-theme.ts";
import { NODE_W, NODE_H, type LayoutNode } from "./layout.ts";

export interface ConnectorResult {
  text: string;
  col: number;
  row: number;
  width: number;
  height: number;
  color: string;
  backgroundColor: string;
}

/** Fan-out connector: one parent branching down to one or more tree children. */
export function buildConnector(
  parent: LayoutNode,
  rowH: Record<number, number>,
  theme: GraphTheme,
): ConnectorResult | null {
  if (parent.children.length === 0) return null;

  const pcx = parent.x + Math.floor(NODE_W / 2);
  const parentBottom = parent.y + (rowH[parent.depth] ?? NODE_H);
  const firstChildRow = Math.min(...parent.children.map((c: LayoutNode) => c.y));
  const numRows = firstChildRow - parentBottom;
  if (numRows < 1) return null;

  const childCxs = parent.children.map((c: LayoutNode) => c.x + Math.floor(NODE_W / 2));
  const isStraight = parent.children.length === 1 && childCxs[0] === pcx;

  // Straight drop: single child directly below
  if (isStraight) {
    const text = Array(numRows).fill("│").join("\n");
    return {
      text,
      col: pcx,
      row: parentBottom,
      width: 1,
      height: numRows,
      color: theme.borderActive,
      backgroundColor: theme.background,
    };
  }

  // Branching: horizontal bar connecting all children
  const allCols = [pcx, ...childCxs];
  const minCol = Math.min(...allCols);
  const maxCol = Math.max(...allCols);
  const width = maxCol - minCol + 1;
  const toL = (c: number) => c - minCol;

  const barRow = numRows - 1;
  const grid: string[][] = Array.from({ length: numRows }, () => Array(width).fill(" "));

  // Vertical stem from parent center down to bar
  for (let r = 0; r < barRow; r++) grid[r]![toL(pcx)] = "│";

  // Horizontal bar
  for (let c = 0; c < width; c++) grid[barRow]![c] = "─";

  // Parent junction on bar
  const childAtParent = childCxs.includes(pcx);
  const pl = toL(pcx);
  if (pcx === minCol) {
    grid[barRow]![pl] = childAtParent ? "├" : "╰";
  } else if (pcx === maxCol) {
    grid[barRow]![pl] = childAtParent ? "┤" : "╯";
  } else {
    grid[barRow]![pl] = childAtParent ? "┼" : "┴";
  }

  // Child junctions on bar
  for (const cx of childCxs) {
    if (cx === pcx) continue;
    const cl = toL(cx);
    if (cx === minCol) grid[barRow]![cl] = "╭";
    else if (cx === maxCol) grid[barRow]![cl] = "╮";
    else grid[barRow]![cl] = "┬";
  }

  return {
    text: grid.map((row) => row.join("")).join("\n"),
    col: minCol,
    row: parentBottom,
    width,
    height: numRows,
    color: theme.borderActive,
    backgroundColor: theme.background,
  };
}

/** Fan-in connector: multiple parents converging down to a single merge child. */
export function buildMergeConnector(
  child: LayoutNode,
  rowH: Record<number, number>,
  allNodes: Record<string, LayoutNode>,
  theme: GraphTheme,
): ConnectorResult | null {
  if (child.parents.length < 2) return null;

  const parentNodes = child.parents
    .map((p) => allNodes[p])
    .filter((n): n is LayoutNode => n != null);
  if (parentNodes.length < 2) return null;

  const parentCxs = parentNodes.map((p) => p.x + Math.floor(NODE_W / 2));
  const childCx = child.x + Math.floor(NODE_W / 2);

  const parentBottom = Math.max(
    ...parentNodes.map((p) => p.y + (rowH[p.depth] ?? NODE_H)),
  );
  const childTop = child.y;
  const numRows = childTop - parentBottom;
  if (numRows < 1) return null;

  const allCols = [...parentCxs, childCx];
  const minCol = Math.min(...allCols);
  const maxCol = Math.max(...allCols);
  const width = maxCol - minCol + 1;
  const toL = (c: number) => c - minCol;

  const grid: string[][] = Array.from({ length: numRows }, () => Array(width).fill(" "));

  // Bar at the top row — parents converge here
  const barRow = 0;
  for (let c = 0; c < width; c++) grid[barRow]![c] = "─";

  // Vertical stem from bar down to child
  for (let r = barRow + 1; r < numRows; r++) grid[r]![toL(childCx)] = "│";

  // Junction characters on the bar
  const parentSet = new Set(parentCxs);
  for (const cx of allCols) {
    const cl = toL(cx);
    const hasUp = parentSet.has(cx);
    const hasDown = cx === childCx;
    const isLeft = cx === minCol;
    const isRight = cx === maxCol;

    if (hasUp && hasDown) {
      grid[barRow]![cl] = isLeft ? "├" : isRight ? "┤" : "┼";
    } else if (hasUp) {
      grid[barRow]![cl] = isLeft ? "╰" : isRight ? "╯" : "┴";
    } else if (hasDown) {
      grid[barRow]![cl] = isLeft ? "╭" : isRight ? "╮" : "┬";
    }
  }

  return {
    text: grid.map((row) => row.join("")).join("\n"),
    col: minCol,
    row: parentBottom,
    width,
    height: numRows,
    color: theme.borderActive,
    backgroundColor: theme.background,
  };
}
