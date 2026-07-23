/**
 * `/workflow <name> …` dispatch confirmation — chat surface from
 * ui/dispatch-mockup.html §1 (compact two-row redesign).
 *
 * Visual contract:
 *  - One rounded `DISPATCHED` panel.
 *  - One status-coloured rounded run card:
 *      title: runId8 · workflowName · ● running
 *      body: compact `k=v · k=v · +N more` input summary when present
 *  - One compact next-step hint:
 *      ▸ /workflow connect <id>  see agents working · chat with and steer each stage
 *
 * What we deliberately do NOT emit (was in the legacy 7-row layout):
 *  - the `✓ submitted · /workflow <name>` echo line — pi already shows
 *    the user's slash-input verbatim, with all inputs, on its own row;
 *  - the `[ DISPATCHED ]` band — a single-card surface doesn't need a
 *    band wrapper (bands frame multi-card surfaces like BACKGROUND /
 *    WORKFLOWS);
 *  - the `run id` muted caption beside the tag — the bg-pill chip with
 *    an 8-char hex string visually communicates "identifier";
 *  - the `status starting…` body row — the `● running` badge on row 1
 *    occupies the same semantic slot;
 *  - the second hint row `▸ /workflow status` — that is a separate intent
 *    (list other in-flight runs), already discoverable from a bare `/workflow`
 *    invocation and the picker's confirm panel.
 *
 * Plain mode drops ANSI; the rounded panel/card layout shape is preserved.
 *
 * cross-ref:
 *  - ui/dispatch-mockup.html (before / after side-by-side)
 *  - ui/mockups.html §1 (legacy 6-row layout, preserved for context)
 *  - src/tui/chat-surface.ts shared primitives (renderTaggedCard,
 *    renderHintRows, including the `titleSuffix` slot used here)
 */

import type { GraphTheme } from "./graph-theme.js";
import type { WorkflowInputValues } from "../shared/types.js";
import {
  renderHintRows,
  renderRoundedBox,
  ELLIPSIS,
  chatWidth,
} from "./chat-surface.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import { visibleWidth, truncateToWidth } from "./text-helpers.js";

const INLINE_INPUT_LIMIT = 3;
const SHORT_ID_LEN = 8;

/**
 * Below this many cells, inline inputs on row 1 are unreadable. We wrap
 * to a body row instead. Empirically: shorter than `prompt="x" · +1 more`
 * (≈14 cells) leaves no headroom for the inputs to survive truncation,
 * and the body row's full-width budget is always more useful.
 */
const MIN_INLINE_INPUT_BUDGET = 16;

export interface RenderDispatchConfirmOpts {
  /** Registered workflow name (rendered bold beside the run-id tag on row 1). */
  workflowName: string;
  /** Real run UUID; the renderer surfaces the first 8 chars in the tag. */
  runId: string;
  /** Inputs merged from CLI tokens + picker output. */
  inputs: Readonly<WorkflowInputValues>;
  /** Provide for themed chrome; omit for plain ASCII. */
  theme?: GraphTheme;
  /** Render width (cells). Defaults to `process.stdout.columns`. */
  width?: number;
}

/**
 * Render the post-dispatch confirmation: one rounded panel containing a
 * rounded run card with runId, workflow name, inputs summary, and a
 * `● running` status badge, followed by a workflow-control hint.
 */
export function renderDispatchConfirm(opts: RenderDispatchConfirmOpts): string {
  const width = effectiveWidth(opts.width);
  const theme = opts.theme;
  const accent = theme?.warning ?? "#000000";
  const tag = shortRunId(opts.runId);

  // Status badge — anchored to the right of row 1, in the running hue.
  // Mirrors the `● running` glyph used by every other live-run surface.
  const trailing = theme
    ? { text: "● running", fg: theme.warning }
    : { text: "● running" };

  // Decide whether the inputs ride row 1 (inline suffix beside the
  // workflow name) or wrap to a body row. Budget math mirrors
  // `renderTaggedCard`'s row-1 chrome accounting:
  //
  //   " "(1)  (1) " "(1) [tag](tag.length + 2) "  "(2) title(titleW)
  //   "  "(2) suffix(suffixW) gap(≥1) trailing(trailingW) " "(1)
  //
  // Solve for the max suffix width that still leaves room for the
  // bold workflow name + status badge at the right edge.
  const STRIPE_PREFIX_W = 2;
  const TAG_PILL_PAD = 2;
  const TITLE_MARGIN = 2;
  const SUFFIX_SEP = 2;
  const TRAILING_GAP = 1; // min cells between suffix and trailing badge
  const END_PAD = 1;
  const tagW = tag.length + TAG_PILL_PAD;
  const titleW = visibleWidth(opts.workflowName);
  const trailingW = visibleWidth(trailing.text);
  const inlineBudget = Math.max(
    0,
    width
      - STRIPE_PREFIX_W
      - tagW
      - TITLE_MARGIN
      - titleW
      - SUFFIX_SEP
      - TRAILING_GAP
      - trailingW
      - END_PAD,
  );

  const hasInputs = Object.keys(opts.inputs).length > 0;
  let titleSuffix: string | undefined;
  const bodyRows: string[] = [];

  if (hasInputs && inlineBudget >= MIN_INLINE_INPUT_BUDGET) {
    const inline = renderInputsSegment(opts.inputs, inlineBudget, theme);
    if (inline && inline.fitted) {
      titleSuffix = inline.rendered;
    }
  }

  // Body row is the overflow path: either the inline budget was too
  // tight, or the rendered inputs spilled past it. Either way, we use
  // the full body interior (width - body chrome) as the wider canvas.
  if (hasInputs && titleSuffix === undefined) {
    const BODY_PREFIX_W = 4; // "    " — see renderTaggedCard body prefix
    const bodyBudget = Math.max(0, width - BODY_PREFIX_W - 1);
    const overflowSeg = renderInputsSegment(opts.inputs, bodyBudget, theme);
    if (overflowSeg) bodyRows.push(overflowSeg.rendered);
  }

  const inputRows = bodyRows.length > 0
    ? bodyRows.map((row) => `   ${row} `)
    : [`   ${titleSuffix ?? "started in background"} `];
  const titleLine = ` ●  ${tag}  ${opts.workflowName}  ${trailing.text} `;

  const hints = renderHintRows([
    { command: `/workflow connect ${tag}`, hint: "see agents working · chat with and steer each stage" },
  ], theme)
    .split("\n")
    .map((line) => ` ${line} `);

  return renderRoundedBox({
    title: "DISPATCHED",
    bodyLines: [titleLine, ...inputRows, "", ...hints],
    accent,
    theme,
    width,
  });
}

/** First 8 chars of the run UUID — the canonical short form. */
function shortRunId(runId: string): string {
  return runId.length > SHORT_ID_LEN ? runId.slice(0, SHORT_ID_LEN) : runId;
}

interface InputsSegment {
  /** Pre-styled string; safe to splice directly into a card row. */
  rendered: string;
  /** Visible width (excluding ANSI escapes). */
  visibleWidth: number;
  /**
   * `true` when the natural styled `k=v · k=v · +N more` form fit inside
   * `budget`; `false` when the segment had to fall back to the degraded
   * `k=v, k=v, …` truncated single-line form.
   *
   * The inline (row-1 suffix) path MUST only accept `fitted === true`
   * results — the body row carries a wider budget and is where any
   * unavoidable truncation belongs.
   */
  fitted: boolean;
}

/**
 * Format the inputs as a compact `k=v  ·  k=v  ·  +N more` segment that
 * fits in `budget` visible cells. Returns null when the inputs map is
 * empty.
 *
 * Truncation policy:
 *  - First {@link INLINE_INPUT_LIMIT} entries inline; the remainder
 *    collapsed to `+N more`.
 *  - String values are quoted; long values truncate inside the quotes,
 *    keeping the closing `"`.
 *  - Objects / arrays render as a compact JSON projection clamped to
 *    the same per-pair `valueBudget` derived below.
 *  - If the styled segment would still exceed `budget`, fall back to a
 *    single end-truncated `k=v, k=v, …` line — the same degraded shape
 *    the legacy `inputsRow` emitted, but without the `inputs` column
 *    label.
 */
function renderInputsSegment(
  inputs: Readonly<WorkflowInputValues>,
  budget: number,
  theme?: GraphTheme,
): InputsSegment | null {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return null;

  const text = theme ? hexToAnsi(theme.text) : "";
  const faint = theme ? hexToAnsi(theme.dim) : "";
  const dim = faint;
  const reset = theme ? RESET : "";

  const visible = entries.slice(0, INLINE_INPUT_LIMIT);
  const overflow = entries.length - visible.length;
  const numPairs = visible.length;

  // Per-pair `valueBudget` allocation. The legacy heuristic (`width *
  // 0.5` regardless of pair count) would let any single value claim
  // more than the whole row, dragging the styled `k=v · k=v · +N more`
  // form through the comma-truncated fallback whenever ≥2 pairs had
  // non-trivial values.
  //
  // Instead, subtract the fixed cost of the row (keys + `=`, separators,
  // overflow marker) and split the remainder evenly across the visible
  // pairs, with a floor so any single value still renders something
  // meaningful.
  const SEP_W = 5; // visible width of "  ·  "
  const overflowText = overflow > 0 ? `+${overflow} more` : "";
  const overflowCost = overflow > 0 ? SEP_W + overflowText.length : 0;
  const keysCost = visible.reduce((sum, [k]) => sum + k.length + 1, 0);
  const sepCost = Math.max(0, numPairs - 1) * SEP_W;
  const fixedCost = keysCost + sepCost + overflowCost;
  const availableForValues = Math.max(0, budget - fixedCost);
  const valueBudget = Math.max(
    10,
    Math.floor(availableForValues / Math.max(numPairs, 1)),
  );

  // Render every visible value once; reuse the result for both the
  // styled output and the visible-width measurement.
  const renderedValues = visible.map(([, v]) => renderInputValue(v, valueBudget));
  const renderedSegs = visible.map(([k], i) => {
    const v = renderedValues[i];
    if (!theme) return `${k}=${v}`;
    return `${text}${k}${reset}${faint}=${reset}${text}${v}${reset}`;
  });
  const segWidths = visible.map(([k], i) => k.length + 1 + visibleWidth(renderedValues[i] ?? ""));

  const sep = theme ? `  ${faint}·${reset}  ` : "  ·  ";

  let rendered = renderedSegs.join(sep);
  let totalW =
    segWidths.reduce((a, b) => a + b, 0) +
    Math.max(0, visible.length - 1) * SEP_W;

  if (overflow > 0) {
    const moreText = `+${overflow} more`;
    rendered += theme
      ? `${sep}${dim}${moreText}${reset}`
      : `${sep}${moreText}`;
    totalW += SEP_W + moreText.length;
  }

  if (totalW <= budget) {
    return { rendered, visibleWidth: totalW, fitted: true };
  }

  // Overflow fallback — drop per-pair ANSI, emit an end-truncated plain
  // join. Matches the legacy `inputsRow` degraded path, minus the
  // `inputs` column label. Body-row callers tolerate this; the inline
  // suffix path rejects it via `fitted === false` and falls through to
  // the body-row layout instead.
  const flat = entries
    .map(([k, v]) => `${k}=${renderInputValue(v, valueBudget)}`)
    .join(", ");
  const cut = truncateToWidth(flat, Math.max(8, budget), ELLIPSIS);
  if (!theme) return { rendered: cut, visibleWidth: visibleWidth(cut), fitted: false };
  return {
    rendered: `${text}${cut}${reset}`,
    visibleWidth: visibleWidth(cut),
    fitted: false,
  };
}

function renderInputValue(value: unknown, budget: number): string {
  if (typeof value === "string") {
    // Reserve 2 cells for the surrounding quotes; truncate the interior.
    const interior = Math.max(0, budget - 2);
    const trimmed = truncateToWidth(value, interior, ELLIPSIS);
    return `"${trimmed}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  // Objects / arrays — show a compact JSON projection within budget.
  const json = JSON.stringify(value);
  return truncateToWidth(json ?? "", budget, ELLIPSIS);
}

/**
 * Resolve the render width for the dispatch surface. Delegates to the
 * shared `chatWidth()` helper which already accounts for the chat host's
 * 2-cell horizontal padding when no explicit width is supplied.
 */
function effectiveWidth(width?: number): number {
  return chatWidth(width);
}
