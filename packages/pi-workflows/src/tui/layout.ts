/**
 * DAG layout engine: flat stage list → 2D grid.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/layout.ts
 */
import type { StageSnapshot } from "../store-types.js";

export const NODE_W = 24;
export const NODE_H = 5;

export interface LayoutNode {
  stage: StageSnapshot;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface LayoutOpts {
  colGap?: number;
  rowGap?: number;
}

/**
 * Assign each stage a (col, row) via BFS from roots.
 * Parallel stages share the same column; sequential stages increment column.
 */
export function computeLayout(
  stages: readonly StageSnapshot[],
  opts: LayoutOpts = {},
): LayoutNode[] {
  const colGap = opts.colGap ?? 4;
  const rowGap = opts.rowGap ?? 2;

  if (stages.length === 0) return [];

  const idSet = new Set(stages.map((s) => s.id));

  // Map from id → stage
  const byId = new Map<string, StageSnapshot>();
  for (const s of stages) byId.set(s.id, s);

  // Assign columns via BFS (longest path from root)
  const colMap = new Map<string, number>();

  // Topological BFS: process nodes whose all parents have been assigned
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const s of stages) {
    const validParents = s.parentIds.filter((pid) => idSet.has(pid));
    inDegree.set(s.id, validParents.length);
    for (const pid of validParents) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid)!.push(s.id);
    }
  }

  // Roots: nodes with no valid parents
  const queue: string[] = [];
  for (const s of stages) {
    if (inDegree.get(s.id) === 0) {
      queue.push(s.id);
      colMap.set(s.id, 0);
    }
  }

  // BFS assigning col = max(parent cols) + 1
  const visited = new Set<string>();
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++]!;
    if (visited.has(id)) continue;
    visited.add(id);

    const stage = byId.get(id)!;
    const validParents = stage.parentIds.filter((pid) => idSet.has(pid));
    let myCol = 0;
    for (const pid of validParents) {
      myCol = Math.max(myCol, (colMap.get(pid) ?? 0) + 1);
    }
    colMap.set(id, myCol);

    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      const deg = (inDegree.get(kid) ?? 1) - 1;
      inDegree.set(kid, deg);
      if (deg === 0) queue.push(kid);
    }
  }

  // Handle any nodes not visited (cycles or disconnected) - assign next col
  for (const s of stages) {
    if (!colMap.has(s.id)) colMap.set(s.id, 0);
  }

  // Group by column, assign rows
  const colGroups = new Map<number, string[]>();
  for (const [id, col] of colMap) {
    if (!colGroups.has(col)) colGroups.set(col, []);
    colGroups.get(col)!.push(id);
  }

  const nodes: LayoutNode[] = [];
  for (const s of stages) {
    const col = colMap.get(s.id) ?? 0;
    const group = colGroups.get(col) ?? [];
    const row = group.indexOf(s.id);
    const x = col * (NODE_W + colGap);
    const y = row * (NODE_H + rowGap);
    nodes.push({ stage: s, col, row, x, y });
  }

  return nodes;
}
