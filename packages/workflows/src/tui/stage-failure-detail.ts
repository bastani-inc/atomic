/**
 * A failed stage's detail in the graph: what failed, why in one line, and the next actions. The full error, its
 * code, hint and causes, are kept behind the log view so the summary never becomes a stack trace.
 */

import type { SerializedError } from "../shared/error-codec.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, wrapPlainText } from "./text-helpers.js";

export interface StageFailureDetailOpts {
	theme: GraphTheme;
	width: number;
	/** Show the full log instead of the summary. */
	logs: boolean;
}

/** The first non-empty line of the stage's error: the reason the summary shows. */
export function stageFailureReason(stage: Pick<StageSnapshot, "error" | "failureMessage">): string {
	const text = stage.error ?? stage.failureMessage ?? "";
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return line ?? "No reason was recorded.";
}

function serializedErrorLines(error: SerializedError, depth: number): string[] {
	const indent = "  ".repeat(depth);
	const lines = [`${indent}${error.name}${error.code ? ` (${error.code})` : ""}: ${error.message}`];
	if (error.hint) lines.push(`${indent}hint: ${error.hint}`);
	if (error.cause) lines.push(`${indent}caused by:`, ...serializedErrorLines(error.cause, depth + 1));
	if (error.cleanupCause)
		lines.push(`${indent}during cleanup:`, ...serializedErrorLines(error.cleanupCause, depth + 1));
	for (const member of error.errors ?? []) lines.push(...serializedErrorLines(member, depth + 1));
	return lines;
}

/** Every recorded line of the stage's failure, for the log view. */
export function stageFailureLogLines(
	stage: Pick<StageSnapshot, "error" | "failureMessage" | "failureDetail" | "failureCode">,
): string[] {
	const lines: string[] = [];
	const message = stage.failureMessage ?? stage.error;
	if (message) lines.push(...message.split(/\r?\n/));
	if (stage.failureDetail) lines.push("", ...serializedErrorLines(stage.failureDetail, 0));
	if (lines.length === 0) lines.push("No log was recorded for this stage.");
	return lines;
}

/** The detail's body rows, already styled and cut to `width`. */
export function renderStageFailureDetailLines(stage: StageSnapshot, opts: StageFailureDetailOpts): string[] {
	const { theme } = opts;
	const width = Math.max(1, Math.floor(opts.width));
	const error = hexToAnsi(theme.error);
	const text = hexToAnsi(theme.text);
	const muted = hexToAnsi(theme.textMuted);
	const elapsed = elapsedStageMs(stage);
	const after = elapsed === undefined ? "" : ` after ${fmtDuration(elapsed)}`;
	const indent = "  ";
	const room = Math.max(1, width - indent.length);
	const title = `${indent}${error}${BOLD}✗ ${stage.name}${RESET}${muted} · failed${after}${RESET}`;
	if (opts.logs) {
		const body = stageFailureLogLines(stage).flatMap((line) =>
			line.length === 0 ? [""] : wrapPlainText(line, room),
		);
		return [
			truncateToWidth(title, width),
			"",
			`${indent}${muted}Log${RESET}`,
			...body.map((line) => truncateToWidth(`${indent}${text}${line}${RESET}`, width)),
		];
	}
	const label = "Reason";
	const reasonRoom = Math.max(1, room - label.length - 3);
	const reason = wrapPlainText(stageFailureReason(stage), reasonRoom);
	return [
		truncateToWidth(title, width),
		"",
		...reason.map((line, index) =>
			truncateToWidth(
				`${indent}${muted}${index === 0 ? label : " ".repeat(label.length)}${RESET}   ${text}${line}${RESET}`,
				width,
			),
		),
	];
}
