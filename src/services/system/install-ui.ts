/**
 * Progress UI primitives for the first-run install flow (auto-sync).
 *
 * Renders an OpenCode-inspired single-line progress bar:
 *
 *     ⠋  ■■■■■■■■■■■■■■■■■■････････････  50%  tmux / psmux
 *
 * The braille spinner animates in-place via a setInterval loop and the
 * bar uses Catppuccin Mocha accent colors (Yellow for progress, Green
 * for success, Red for error) with a per-character true-color gradient
 * that falls back gracefully through 256-color → basic ANSI.
 *
 * Steps are grouped into **phases**. Steps within a phase run in parallel
 * (via `Promise.all`); phases themselves run sequentially. The progress
 * bar advances and the label updates in real-time as individual steps
 * complete within a phase.
 *
 * A final summary (✓/✗ per step) is printed after all steps finish, and
 * any captured stderr/stdout from a failed step is shown beneath it.
 *
 * Kept intentionally small — this is not a general-purpose progress
 * library, just what auto-sync needs to stop being visually noisy.
 */

import { COLORS, PALETTE, paletteRgb, type PaletteKey } from "../../theme/colors.ts";
import {
  supportsTrueColor,
  supports256Color,
} from "./detect.ts";

const BAR_WIDTH = 30;
const BAR_FILLED = "■";
const BAR_EMPTY = "･";

/**
 * Semantic bar states mapped to Catppuccin Mocha colors:
 *   progress → Yellow (warm accent; "in flight")
 *   success  → Green  (universal "completed")
 *   error    → Red    (universal "failed")
 *
 * The empty track stays dim regardless — only the filled portion carries
 * the status signal, which keeps the bar legible while still telegraphing
 * the outcome at a glance.
 */
type BarState = "progress" | "success" | "error";

const BAR_STATE_PALETTE: Record<BarState, PaletteKey> = {
  progress: "warning",
  success: "success",
  error: "error",
};

function fillColor(state: BarState): string {
  if (supportsTrueColor()) {
    const [r, g, b] = PALETTE[BAR_STATE_PALETTE[state]];
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (supports256Color()) {
    switch (state) {
      case "success":
        return "\x1b[38;5;150m";
      case "error":
        return "\x1b[38;5;211m";
      case "progress":
      default:
        return "\x1b[38;5;222m";
    }
  }
  switch (state) {
    case "success":
      return COLORS.green;
    case "error":
      return COLORS.red;
    case "progress":
    default:
      return COLORS.yellow;
  }
}

type RGB = readonly [number, number, number];

/**
 * Gradient endpoints for the filled bar segment. Each state interpolates
 * from a slightly deeper/warmer tone (left) to the full Catppuccin
 * accent (right), producing a smooth continuous color gradient.
 */
function gradientEndpoints(state: BarState): { start: RGB; end: RGB } {
  switch (state) {
    case "success":
      return { start: paletteRgb("teal"), end: paletteRgb("green") };
    case "error":
      return { start: paletteRgb("maroon"), end: paletteRgb("red") };
    case "progress":
    default:
      return { start: paletteRgb("peach"), end: paletteRgb("yellow") };
  }
}

/**
 * Render a progress bar: gradient-filled ■ + dim empty ･
 *
 * In true-color mode each filled character gets its own interpolated RGB
 * value, producing a smooth continuous gradient. Falls back to a single
 * solid color on 256-color or basic ANSI terminals.
 */
function renderBar(
  completed: number,
  total: number,
  state: BarState,
): string {
  const safeTotal = Math.max(1, total);
  const ratio = Math.max(0, Math.min(1, completed / safeTotal));
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  let filledStr = "";
  if (filled > 0) {
    if (supportsTrueColor()) {
      const { start, end } = gradientEndpoints(state);
      for (let i = 0; i < filled; i++) {
        const t = filled > 1 ? i / (filled - 1) : 1;
        const r = Math.round(start[0] + (end[0] - start[0]) * t);
        const g = Math.round(start[1] + (end[1] - start[1]) * t);
        const b = Math.round(start[2] + (end[2] - start[2]) * t);
        filledStr += `\x1b[38;2;${r};${g};${b}m${BAR_FILLED}`;
      }
      filledStr += COLORS.reset;
    } else {
      filledStr = fillColor(state) + BAR_FILLED.repeat(filled) + COLORS.reset;
    }
  }

  return filledStr + COLORS.dim + BAR_EMPTY.repeat(empty) + COLORS.reset;
}

function formatLine(
  completed: number,
  total: number,
  label: string,
  state: BarState = "progress",
): string {
  const bar = renderBar(completed, total, state);
  const safeTotal = Math.max(1, total);
  const pct = Math.round(
    Math.max(0, Math.min(1, completed / safeTotal)) * 100,
  );
  const percent = `${COLORS.dim}${String(pct).padStart(3)}%${COLORS.reset}`;
  return `${bar}  ${percent}  ${label}`;
}

export interface StepResult {
  label: string;
  ok: boolean;
  /** Error message (if any) surfaced in the final summary. */
  error?: string;
}

export interface Step {
  label: string;
  fn: () => Promise<unknown>;
}

/** A phase is a group of steps that run in parallel. */
export type Phase = Step[];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Runs phases of async steps with a single persistent spinner line
 * showing stepped progress. Steps within each phase run in parallel;
 * phases run sequentially so later phases can depend on earlier ones.
 *
 * Each step's failure is collected rather than thrown, mirroring
 * auto-sync's "best-effort" contract.
 *
 * Returns the per-step results in phase/submission order so the caller
 * can render a summary.
 */
export async function runSteps(phases: Phase[]): Promise<StepResult[]> {
  const total = phases.reduce((n, phase) => n + phase.length, 0);
  const results: StepResult[] = [];
  let completed = 0;
  let frameIdx = 0;
  let currentLabel = phases[0]?.[0]?.label ?? "";
  let animating = true;

  const isTTY = process.stdout.isTTY ?? false;

  if (isTTY) process.stdout.write("\x1b[?25l"); // hide cursor

  // Restore cursor on unexpected exit so the terminal isn't left broken.
  const restoreCursor = () => {
    if (isTTY) process.stdout.write("\x1b[?25h");
  };
  process.once("SIGINT", restoreCursor);
  process.once("SIGTERM", restoreCursor);

  // Animate the braille spinner + progress bar in-place (80 ms/frame).
  const interval = isTTY
    ? setInterval(() => {
        if (!animating) return;
        const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
        const line = formatLine(completed, total, currentLabel);
        process.stdout.write(
          `\r\x1b[2K  ${COLORS.blue}${frame}${COLORS.reset}  ${line}`,
        );
        frameIdx++;
      }, 80)
    : null;

  for (const phase of phases) {
    const inFlight = new Set(phase.map((step) => step.label));
    currentLabel = [...inFlight].join(", ");

    const phaseResults = await Promise.all(
      phase.map(async (step): Promise<StepResult> => {
        try {
          await step.fn();
          completed++;
          inFlight.delete(step.label);
          if (inFlight.size > 0) {
            currentLabel = [...inFlight].join(", ");
          }
          return { label: step.label, ok: true };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          completed++;
          inFlight.delete(step.label);
          if (inFlight.size > 0) {
            currentLabel = [...inFlight].join(", ");
          }
          return { label: step.label, ok: false, error: message };
        }
      }),
    );

    results.push(...phaseResults);
  }

  // Stop animation and render the final line.
  animating = false;
  if (interval) clearInterval(interval);
  process.removeListener("SIGINT", restoreCursor);
  process.removeListener("SIGTERM", restoreCursor);

  const okCount = results.filter((r) => r.ok).length;
  const allOk = okCount === total;
  const finalState: BarState = allOk ? "success" : "error";
  const glyph = allOk
    ? `${fillColor("success")}✓${COLORS.reset}`
    : `${fillColor("error")}✗${COLORS.reset}`;
  const finalLabel = allOk
    ? `${fillColor("success")}Setup complete${COLORS.reset}`
    : `${fillColor("error")}Setup finished with errors${COLORS.reset}`;

  if (isTTY) {
    process.stdout.write(
      `\r\x1b[2K  ${glyph}  ${formatLine(total, total, finalLabel, finalState)}\n`,
    );
    process.stdout.write("\x1b[?25h"); // show cursor
  } else {
    console.log(
      `  ${glyph}  ${formatLine(total, total, finalLabel, finalState)}`,
    );
  }

  return results;
}

/**
 * Print a compact per-step summary after `runSteps`. Successes render as
 * a single dim line; failures render with a red cross and an indented
 * excerpt of the captured error.
 */
export function printSummary(results: StepResult[]): void {
  for (const result of results) {
    if (result.ok) {
      console.log(
        `  ${COLORS.green}✓${COLORS.reset} ${COLORS.dim}${result.label}${COLORS.reset}`,
      );
    } else {
      console.log(
        `  ${COLORS.red}✗${COLORS.reset} ${result.label}`,
      );
      if (result.error) {
        // Indent the first ~4 lines of the error so it reads as a nested
        // block rather than wall-of-text.
        const lines = result.error.split("\n").slice(0, 4);
        for (const line of lines) {
          console.log(`    ${COLORS.dim}${line}${COLORS.reset}`);
        }
      }
    }
  }
}
