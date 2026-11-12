/**
 * Run-level state shared by every surface that shows a run's state: the graph
 * header and its compact widget trailer, the status and session lists, the
 * connect picker and the stage switcher. One classifier keeps them agreeing.
 *
 * Glyphs and colours come from the status vocabulary in status-helpers.ts
 * (DESIGN.md §1): `↑ blocked`, `❚❚ paused` and `○ quit`.
 */
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunSnapshot, RunStatus } from "../shared/store-types.js";
import { sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import type { GraphTheme } from "./graph-theme.js";
import { statusColor, statusIcon } from "./status-helpers.js";

export type RunStateKind = "blocked" | "paused" | "quit";

export interface RunStateIndicator {
	readonly kind: RunStateKind;
	readonly glyph: string;
	/** Glyph and label, e.g. `↑ blocked`. */
	readonly text: string;
	/** Single-line exit reason of a blocked run, when the workflow gave one. */
	readonly reason?: string;
}

const GLYPH_STATUS: Readonly<Record<RunStateKind, RunStatus>> = {
	blocked: "blocked",
	paused: "paused",
	quit: "pending",
};

const COLOR_STATUS: Readonly<Record<RunStateKind, RunStatus>> = {
	blocked: "blocked",
	paused: "paused",
	quit: "paused",
};

/** A gracefully quit run: paused, still resumable, and not ended. */
export function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

/**
 * The run-level state worth calling out beside a run's stage counts, or
 * `undefined` for a run whose status already says everything (running,
 * including a run that was resumed, pending, or ended without a block).
 *
 * Blocked uses {@link effectiveRunStatus}, so author exits, returned blocked
 * statuses, recoverable provider blocks and the resumable `budget_exceeded`
 * stop all count.
 */
export function runStateIndicator(run: RunSnapshot): RunStateIndicator | undefined {
	if (isQuitRun(run)) return indicator("quit");
	const status = effectiveRunStatus(run);
	if (status === "blocked") return indicator("blocked", blockedReason(run));
	if (status === "paused") return indicator("paused");
	return undefined;
}

export function runStateColor(state: RunStateIndicator, theme: GraphTheme): string {
	return statusColor(COLOR_STATUS[state.kind], theme);
}

function indicator(kind: RunStateKind, reason?: string): RunStateIndicator {
	const glyph = statusIcon(GLYPH_STATUS[kind]);
	return { kind, glyph, text: `${glyph} ${kind}`, ...(reason === undefined ? {} : { reason }) };
}

function blockedReason(run: RunSnapshot): string | undefined {
	const reason = sanitizeToolTitleText(run.exitReason ?? "").trim();
	return reason.length > 0 ? reason : undefined;
}
