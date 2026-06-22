export interface GraphTheme {
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  text: string;
  textMuted: string;
  textDim: string;
  primary: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  border: string;
  borderActive: string;
}

export const theme: GraphTheme = {
  background:        "#1e1e2e",
  backgroundPanel:   "#181825",
  backgroundElement: "#11111b",
  text:              "#cdd6f4",
  textMuted:         "#a6adc8",
  textDim:           "#585b70",
  primary:           "#89b4fa",
  success:           "#a6e3a1",
  error:             "#f38ba8",
  warning:           "#f9e2af",
  info:              "#cba6f7",
  border:            "#313244",
  borderActive:      "#45475a",
};

// ─── Status Helpers ─────────────────────────────

export function color(status: string): string {
  return { running: theme.warning, complete: theme.success, pending: theme.textDim, error: theme.error }[status] ?? theme.textDim;
}

export function label(status: string): string {
  return { running: "running", complete: "done", pending: "waiting", error: "failed" }[status] ?? status;
}

// ─── Icons ──────────────────────────────────────

export function icon(status: string): string {
  return { running: "●", complete: "✓", pending: "○", error: "✗" }[status] ?? "○";
}

// ─── Color Interpolation ────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  );
}

// ─── Data ───────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  status: string;
  duration: string;
  tmux: string;
  parent: string | null;
  error?: string;
}

//                     orchestrator
//                    /            \
//              planner          deploy-agent
//            /    |    \
//  frontend  backend  reviewer
//  -writer   -writer  (error)
//               |
//          test-runner

export const SESSIONS: Session[] = [
  { id: "orch",       name: "orchestrator",    status: "running",  duration: "5m 02s", tmux: "@0", parent: null },
  { id: "planner",    name: "planner",         status: "complete", duration: "1m 23s", tmux: "@1", parent: "orch" },
  { id: "frontend",   name: "frontend-writer", status: "running",  duration: "2m 45s", tmux: "@2", parent: "planner" },
  { id: "backend",    name: "backend-writer",  status: "running",  duration: "3m 12s", tmux: "@3", parent: "planner" },
  { id: "reviewer",   name: "reviewer",        status: "error",    duration: "0m 43s", tmux: "@5", parent: "planner", error: "lint failed: src/index.ts" },
  { id: "testrunner", name: "test-runner",     status: "pending",  duration: "—",      tmux: "@4", parent: "backend" },
  { id: "deploy",     name: "deploy-agent",    status: "pending",  duration: "—",      tmux: "@6", parent: "orch" },
];

// ─── Layout ─────────────────────────────────────

export const NODE_W = 36;
export const NODE_H = 4;
export const ERR_H  = 4;
export const H_GAP  = 6;
export const V_GAP  = 3;
export const PAD    = 3;

export function nodeH(status: string): number {
  return status === "error" ? ERR_H : NODE_H;
}

export interface LayoutNode {
  id: string;
  name: string;
  status: string;
  duration: string;
  tmux: string;
  error?: string;
  children: LayoutNode[];
  depth: number;
  x: number;
  y: number;
}

export function computeLayout(sessions: Session[]) {
  const map: Record<string, LayoutNode> = {};
  const roots: LayoutNode[] = [];

  for (const s of sessions) {
    map[s.id] = { ...s, children: [], depth: 0, x: 0, y: 0 };
  }
  for (const s of sessions) {
    if (s.parent && map[s.parent]) map[s.parent]!.children.push(map[s.id]!);
    else roots.push(map[s.id]!);
  }

  function setDepth(n: LayoutNode, d: number) {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  }
  for (const r of roots) setDepth(r, 0);

  const rowH: Record<number, number> = {};
  for (const n of Object.values(map)) {
    rowH[n.depth] = Math.max(rowH[n.depth] ?? 0, nodeH(n.status));
  }

  function yAt(d: number): number {
    let y = 0;
    for (let i = 0; i < d; i++) y += (rowH[i] ?? NODE_H) + V_GAP;
    return y;
  }

  let cursor = 0;

  function place(n: LayoutNode) {
    if (n.children.length === 0) {
      n.x = cursor;
      n.y = yAt(n.depth);
      cursor += NODE_W + H_GAP;
    } else {
      for (const c of n.children) place(c);
      const first = n.children[0]!;
      const last = n.children[n.children.length - 1]!;
      n.x = Math.round((first.x + last.x) / 2);
      n.y = yAt(n.depth);
    }
  }

  let firstRoot = true;
  for (const r of roots) {
    if (!firstRoot) cursor += H_GAP;
    place(r);
    firstRoot = false;
  }

  for (const n of Object.values(map)) {
    n.x += PAD;
    n.y += PAD;
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of Object.values(map)) {
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + nodeH(n.status));
  }

  return { roots, map, rowH, width: maxX + PAD, height: maxY + PAD };
}

// ─── Connectors ─────────────────────────────────
// With V_GAP=3: 3-row connector between parent and children.
// Rows 0..barRow-1: vertical stem from parent center.
// Row barRow: horizontal bar with junction characters.
// Proportional rhythm — stem gives visual flow, bar shows branching.

export interface ConnectorResult {
  text: string;
  col: number;
  row: number;
  width: number;
  height: number;
  color: string;
}

export function buildConnector(
  parent: LayoutNode,
  rowH: Record<number, number>,
): ConnectorResult | null {
  if (parent.children.length === 0) return null;

  const pcx = parent.x + Math.floor(NODE_W / 2);
  const parentBottom = parent.y + (rowH[parent.depth] ?? NODE_H);
  const firstChildRow = Math.min(...parent.children.map(c => c.y));
  const numRows = firstChildRow - parentBottom;
  if (numRows < 1) return null;

  const childCxs = parent.children.map(c => c.x + Math.floor(NODE_W / 2));
  const isStraight = parent.children.length === 1 && childCxs[0] === pcx;

  // Straight drop: single child directly below — always solid
  if (isStraight) {
    const text = Array(numRows).fill("│").join("\n");
    return {
      text, col: pcx, row: parentBottom, width: 1, height: numRows,
      color: theme.borderActive,
    };
  }

  // Branching: horizontal bar connecting all children
  const allCols = [pcx, ...childCxs];
  const minCol = Math.min(...allCols);
  const maxCol = Math.max(...allCols);
  const width = maxCol - minCol + 1;
  const toL = (c: number) => c - minCol;

  // Compact: bar at last row, stem fills rows above
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
    grid[barRow]![pl] = childAtParent ? "├" : (barRow === 0 ? "╰" : "╰");
  } else if (pcx === maxCol) {
    grid[barRow]![pl] = childAtParent ? "┤" : (barRow === 0 ? "╯" : "╯");
  } else {
    grid[barRow]![pl] = childAtParent ? "┼" : "┴";
  }

  // Child junctions on bar
  for (const cx of childCxs) {
    if (cx === pcx) continue;
    const cl = toL(cx);
    if (cx === minCol)      grid[barRow]![cl] = "╭";
    else if (cx === maxCol) grid[barRow]![cl] = "╮";
    else                    grid[barRow]![cl] = "┬";
  }

  return {
    text: grid.map(row => row.join("")).join("\n"),
    col: minCol, row: parentBottom, width, height: numRows,
    color: theme.borderActive,
  };
}

// ─── Duration Helpers ───────────────────────────

export function parseDur(s: string): number | null {
  if (s === "—") return null;
  const m = s.match(/(\d+)m\s*(\d+)s/);
  return m ? parseInt(m[1]!) * 60 + parseInt(m[2]!) : null;
}

export function fmtDur(sec: number | null): string {
  if (sec === null) return "—";
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

// ─── Components ─────────────────────────────────

