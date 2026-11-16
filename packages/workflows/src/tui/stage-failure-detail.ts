import { sliceHead } from "@bastani/atomic";
import type { SerializedError } from "../shared/error-codec.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import {
	boundedToolText,
	boundedToolTitleText,
	sanitizeToolDisplayText,
	sanitizeToolTitleText,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../shared/tool-payload-bounds.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

const MAX_FAILURE_REASON_ROWS = 3;
const MAX_SERIALIZED_ERROR_DEPTH = 6;
const MAX_SERIALIZED_ERROR_NODES = 32;

export interface StageFailureDetailOpts {
	theme: GraphTheme;
	width: number;

	logs: boolean;
}

export function stageFailureReason(stage: Pick<StageSnapshot, "error" | "failureMessage">): string {
	const text = boundedToolText(stage.error ?? stage.failureMessage ?? "", TOOL_PAYLOAD_VALUE_LIMIT);
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return line ?? "No reason was recorded.";
}

interface SerializedErrorFormatState {
	nodesRemaining: number;
	charsRemaining: number;
	seen: Set<object>;
	lines: string[];
}

function pushBoundedErrorLine(state: SerializedErrorFormatState, line: string): void {
	if (state.charsRemaining <= 0) return;
	const bounded = boundedToolText(line, state.charsRemaining);
	state.lines.push(bounded);
	state.charsRemaining -= bounded.length + 1;
}

function visitSerializedError(error: SerializedError, depth: number, state: SerializedErrorFormatState): void {
	if (state.nodesRemaining <= 0 || state.charsRemaining <= 0) return;
	state.nodesRemaining -= 1;
	if (depth > MAX_SERIALIZED_ERROR_DEPTH || state.seen.has(error)) return;
	state.seen.add(error);
	const indent = "  ".repeat(depth);
	const name = boundedToolTitleText(error.name, 240);
	const code = error.code ? boundedToolTitleText(error.code, 240) : undefined;
	const message = boundedToolText(error.message, Math.max(1, state.charsRemaining));
	pushBoundedErrorLine(state, `${indent}${name}${code ? ` (${code})` : ""}: ${message}`);
	if (error.hint && state.charsRemaining > 0) {
		pushBoundedErrorLine(state, `${indent}hint: ${boundedToolText(error.hint, Math.max(1, state.charsRemaining))}`);
	}
	if (error.cause && state.nodesRemaining > 0 && state.charsRemaining > 0) {
		pushBoundedErrorLine(state, `${indent}caused by:`);
		visitSerializedError(error.cause, depth + 1, state);
	}
	if (error.cleanupCause && state.nodesRemaining > 0 && state.charsRemaining > 0) {
		pushBoundedErrorLine(state, `${indent}during cleanup:`);
		visitSerializedError(error.cleanupCause, depth + 1, state);
	}
	for (const member of error.errors ?? []) {
		if (state.nodesRemaining <= 0 || state.charsRemaining <= 0) break;
		visitSerializedError(member, depth + 1, state);
	}
}

function serializedErrorLines(error: SerializedError): string[] {
	const state: SerializedErrorFormatState = {
		nodesRemaining: MAX_SERIALIZED_ERROR_NODES,
		charsRemaining: TOOL_PAYLOAD_VALUE_LIMIT,
		seen: new Set<object>(),
		lines: [],
	};
	visitSerializedError(error, 0, state);
	return state.lines;
}

export function stageFailureLogLines(
	stage: Pick<StageSnapshot, "error" | "failureMessage" | "failureDetail" | "failureCode">,
): string[] {
	const lines: string[] = [];
	const message = stage.failureMessage ?? stage.error;
	if (message) lines.push(...boundedToolText(message, TOOL_PAYLOAD_VALUE_LIMIT).split(/\r?\n/));
	if (stage.failureDetail) lines.push("", ...serializedErrorLines(stage.failureDetail));
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
		const boundedLogs = boundedToolText(stageFailureLogLines(stage).join("\n"), TOOL_PAYLOAD_VALUE_LIMIT);
		const body = boundedLogs
			.split(/\r?\n/)
			.flatMap((part) =>
				part.length === 0
					? [""]
					: wrapPlainText(
							boundedToolText(
								sanitizeToolDisplayText(boundedToolText(part, TOOL_PAYLOAD_VALUE_LIMIT)),
								TOOL_PAYLOAD_VALUE_LIMIT,
							),
							room,
						),
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
	const firstLine = stageFailureReason(stage);
	const slicedReason = sliceHead(firstLine, room * 3);
	const wrappedReason = wrapPlainText(sanitizeToolTitleText(slicedReason), reasonRoom);
	const truncatedReason = slicedReason.length < firstLine.length || wrappedReason.length > MAX_FAILURE_REASON_ROWS;
	const reason = wrappedReason.slice(0, MAX_FAILURE_REASON_ROWS);
	if (truncatedReason && reason.length > 0) {
		const lastIndex = reason.length - 1;
		const lastLine = reason[lastIndex]!;
		reason[lastIndex] =
			reasonRoom <= 1
				? "…"
				: visibleWidth(lastLine) < reasonRoom
					? `${lastLine}…`
					: `${truncateToWidth(lastLine, reasonRoom - 1, "")}…`;
	}
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
