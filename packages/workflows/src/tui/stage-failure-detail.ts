import type { SerializedError } from "../shared/error-codec.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import { boundedToolTitleText, sanitizeToolDisplayText, sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, wrapPlainText } from "./text-helpers.js";

export interface StageFailureDetailOpts {
	theme: GraphTheme;
	width: number;

	logs: boolean;
}

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
	const name = sanitizeToolTitleText(error.name);
	const code = error.code ? sanitizeToolTitleText(error.code) : undefined;
	const lines = [`${indent}${name}${code ? ` (${code})` : ""}: ${error.message}`];
	if (error.hint) lines.push(`${indent}hint: ${error.hint}`);
	if (error.cause) lines.push(`${indent}caused by:`, ...serializedErrorLines(error.cause, depth + 1));
	if (error.cleanupCause)
		lines.push(`${indent}during cleanup:`, ...serializedErrorLines(error.cleanupCause, depth + 1));
	for (const member of error.errors ?? []) lines.push(...serializedErrorLines(member, depth + 1));
	return lines;
}

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
	const title = `${indent}${error}${BOLD}✗ ${boundedToolTitleText(stage.name, width * 4)}${RESET}${muted} · failed${after}${RESET}`;
	if (opts.logs) {
		const body = stageFailureLogLines(stage).flatMap((line) =>
			line
				.split(/\r?\n/)
				.flatMap((part) => (part.length === 0 ? [""] : wrapPlainText(sanitizeToolDisplayText(part), room))),
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
	const reason = wrapPlainText(sanitizeToolTitleText(stageFailureReason(stage)), reasonRoom);
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
