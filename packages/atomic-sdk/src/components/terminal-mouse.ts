const MOUSE_REPORTING_MODES = new Set([
  "9",
  "1000",
  "1001",
  "1002",
  "1003",
  "1005",
  "1006",
  "1015",
  "1016",
]);

/** Disable all common xterm-compatible terminal mouse reporting modes. */
export const TERMINAL_MOUSE_REPORTING_DISABLE_SEQUENCE = [
  "\x1b[?9l",
  "\x1b[?1000l",
  "\x1b[?1001l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?1016l",
].join("");

const PRIVATE_MODE_SEQUENCE_RE = /\x1b\[\?([0-9;:]*)([hl])/g;
const SGR_MOUSE_INPUT_SEQUENCE_RE = /^\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]$/;
const BASIC_MOUSE_INPUT_SEQUENCE_RE = /^\x1b\[M[\s\S]{3,}$/;
const URXVT_MOUSE_INPUT_SEQUENCE_RE = /^\x1b\[[0-9]+;[0-9]+;[0-9]+M$/;

type TerminalMouseModeFinal = "h" | "l";

interface TerminalMouseModeChange {
  final: TerminalMouseModeFinal;
  modes: string[];
}

function splitTrailingIncompleteEscapeSequence(output: string): { complete: string; pending: string } {
  const lastEscapeIndex = output.lastIndexOf("\x1b");
  if (lastEscapeIndex === -1) return { complete: output, pending: "" };

  const tail = output.slice(lastEscapeIndex);
  if (tail === "\x1b") {
    return { complete: output.slice(0, lastEscapeIndex), pending: tail };
  }

  if (!tail.startsWith("\x1b[")) {
    return { complete: output, pending: "" };
  }

  for (let index = 2; index < tail.length; index++) {
    const code = tail.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return { complete: output, pending: "" };
    }
  }

  return { complete: output.slice(0, lastEscapeIndex), pending: tail };
}

function readTerminalMouseModeChanges(output: string): TerminalMouseModeChange[] {
  const changes: TerminalMouseModeChange[] = [];
  PRIVATE_MODE_SEQUENCE_RE.lastIndex = 0;

  let match = PRIVATE_MODE_SEQUENCE_RE.exec(output);
  while (match !== null) {
    const rawParams = match[1] ?? "";
    const final = match[2] as TerminalMouseModeFinal;
    const modes = rawParams
      .split(/[;:]/)
      .filter((param) => MOUSE_REPORTING_MODES.has(param));

    if (modes.length > 0) {
      changes.push({ final, modes });
    }

    match = PRIVATE_MODE_SEQUENCE_RE.exec(output);
  }

  return changes;
}

/** True for raw xterm-compatible mouse input sequences parsed by OpenTUI. */
export function isTerminalMouseInputSequence(sequence: string): boolean {
  return SGR_MOUSE_INPUT_SEQUENCE_RE.test(sequence)
    || BASIC_MOUSE_INPUT_SEQUENCE_RE.test(sequence)
    || URXVT_MOUSE_INPUT_SEQUENCE_RE.test(sequence);
}

/**
 * Tracks whether the attached agent has requested terminal mouse reporting.
 *
 * Direct chat and workflow pane attaches stream the agent's ANSI output to the
 * real terminal while OpenTUI owns stdin for the pinned footer. We therefore
 * let the agent's DECSET/DECRST mouse mode sequences pass through unchanged,
 * but track them so raw mouse input can be forwarded to the PTY only while the
 * agent believes mouse reporting is active.
 */
export class TerminalMouseReportingTracker {
  private readonly activeModes = new Set<string>();
  private pending = "";

  update(output: string): boolean {
    const next = this.pending + output;
    const { complete, pending } = splitTrailingIncompleteEscapeSequence(next);
    this.pending = pending;

    for (const change of readTerminalMouseModeChanges(complete)) {
      for (const mode of change.modes) {
        if (change.final === "h") {
          this.activeModes.add(mode);
        } else {
          this.activeModes.delete(mode);
        }
      }
    }

    return this.enabled;
  }

  get enabled(): boolean {
    return this.activeModes.size > 0;
  }

  reset(): void {
    this.pending = "";
    this.activeModes.clear();
  }
}
