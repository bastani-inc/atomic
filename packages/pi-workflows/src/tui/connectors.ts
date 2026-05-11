/**
 * Box-drawing connector helpers for DAG edges.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/connectors.ts
 */

export interface ConnectorLine {
  /** zero-indexed column of chars in the connector band */
  chars: string;
}

export interface ConnectorResult {
  lines: ConnectorLine[];
}

/** Single straight connector: ─── between two nodes in the same row */
export function buildConnector(fromX: number, toX: number): ConnectorResult {
  const left = Math.min(fromX, toX);
  const right = Math.max(fromX, toX);
  const len = right - left;
  if (len <= 0) {
    return { lines: [{ chars: "" }] };
  }
  return {
    lines: [{ chars: "─".repeat(len) }],
  };
}

/** Merge connector: multiple sources fan in to one target */
export function buildMergeConnector(fromXs: number[], toX: number): ConnectorResult {
  if (fromXs.length === 0) return { lines: [] };
  if (fromXs.length === 1) {
    return buildConnector(fromXs[0]!, toX);
  }

  const minX = Math.min(...fromXs, toX);
  const maxX = Math.max(...fromXs, toX);
  const width = maxX - minX + 1;

  // Line 0: top row connecting sources with ─, ┬ at source positions
  // Line 1: vertical drop │ from each source down to target row
  // Line 2: bottom row ─ connecting to target with ┴ at source positions, └─┘ style

  const fromSet = new Set(fromXs.map((x) => x - minX));
  const targetCol = toX - minX;

  // Build top line: horizontal bar through all sources
  const topChars = Array<string>(width).fill(" ");
  const botChars = Array<string>(width).fill(" ");

  const leftMost = Math.min(...fromXs) - minX;
  const rightMost = Math.max(...fromXs) - minX;

  // Fill horizontal span on top line
  for (let i = leftMost; i <= rightMost; i++) {
    topChars[i] = "─";
  }
  // Mark source positions with ┬
  for (const fx of fromSet) {
    topChars[fx] = "┬";
  }

  // Build bottom line: fan-in to target
  const botLeft = Math.min(leftMost, targetCol);
  const botRight = Math.max(rightMost, targetCol);
  for (let i = botLeft; i <= botRight; i++) {
    botChars[i] = "─";
  }
  // Mark source positions with ┴
  for (const fx of fromSet) {
    botChars[fx] = "┴";
  }
  // Mark target with └ or ┘ or ┴ depending on position
  botChars[targetCol] = "┴";

  // Middle line: vertical bars at each source position
  const midChars = Array<string>(width).fill(" ");
  for (const fx of fromSet) {
    midChars[fx] = "│";
  }

  return {
    lines: [
      { chars: topChars.join("") },
      { chars: midChars.join("") },
      { chars: botChars.join("") },
    ],
  };
}
