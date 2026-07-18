export type TerminalMouseProtocol = "sgr" | "x10";
export type TerminalMouseAction = "press" | "release";
export type TerminalMouseWheelDirection = "up" | "down" | "left" | "right";

export interface TerminalMouseEvent {
  readonly protocol: TerminalMouseProtocol;
  readonly action: TerminalMouseAction;
  readonly buttonCode: number;
  /** Zero-based terminal column. */
  readonly col: number;
  /** Zero-based terminal row. */
  readonly row: number;
}

/** Parse one complete SGR or legacy X10 terminal mouse sequence. */
export function parseTerminalMouseInput(data: string): TerminalMouseEvent | null {
  const sgr = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (sgr) {
    const oneBasedCol = Number.parseInt(sgr[2]!, 10);
    const oneBasedRow = Number.parseInt(sgr[3]!, 10);
    if (oneBasedCol < 1 || oneBasedRow < 1) return null;
    return {
      protocol: "sgr",
      action: sgr[4] === "M" ? "press" : "release",
      buttonCode: Number.parseInt(sgr[1]!, 10),
      col: oneBasedCol - 1,
      row: oneBasedRow - 1,
    };
  }

  if (!data.startsWith("\x1b[M") || data.length !== 6) return null;
  const buttonCode = data.charCodeAt(3) - 32;
  const col = data.charCodeAt(4) - 33;
  const row = data.charCodeAt(5) - 33;
  if (buttonCode < 0 || col < 0 || row < 0) return null;
  return {
    protocol: "x10",
    action: (buttonCode & (64 | 32)) === 0 && (buttonCode & 3) === 3
      ? "release"
      : "press",
    buttonCode,
    col,
    row,
  };
}

export function terminalMouseWheelDirection(
  event: TerminalMouseEvent,
): TerminalMouseWheelDirection | null {
  if (event.action !== "press" || (event.buttonCode & 64) === 0) return null;
  const direction = event.buttonCode & 3;
  if (direction === 0) return "up";
  if (direction === 1) return "down";
  if (direction === 2) return "left";
  return "right";
}

export function isTerminalLeftMousePress(event: TerminalMouseEvent): boolean {
  return event.action === "press"
    && (event.buttonCode & 64) === 0
    && (event.buttonCode & 32) === 0
    && (event.buttonCode & 3) === 0;
}
