import { sliceHead } from "@bastani/atomic";
import { MAX_CAUSE_DEPTH } from "../shared/error-cause-chain.js";
import type { SerializedError } from "../shared/error-codec.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import {
	boundedToolText,
	boundedToolTitleText,
	sanitizeToolDisplayText,
	sanitizeToolTitleText,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
} from "../shared/tool-payload-bounds.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

const MAX_FAILURE_REASON_ROWS = 3;
const MAX_FAILURE_LOG_ROWS = 256;
const MAX_FAILURE_LOG_MESSAGE_CHARS = 4_096;
const MAX_SERIALIZED_ERROR_DEPTH = MAX_CAUSE_DEPTH - 1;
const MAX_SERIALIZED_ERROR_NODES = 32;
const MAX_SERIALIZED_ERROR_CHARS = Math.floor(TOOL_PAYLOAD_VALUE_LIMIT / 2);
const MAX_SERIALIZED_ERROR_LINES = Math.floor(MAX_FAILURE_LOG_ROWS / 2);
const MAX_SERIALIZED_ERROR_FIELD_CHARS = 512;

export interface StageFailureDetailOpts {
	theme: GraphTheme;
	width: number;

	logs: boolean;
}

function trimLeadingWhitespace(value: string): string {
	const start = value.search(/\S/);
	return start < 0 ? "" : start === 0 ? value : value.slice(start);
}

function capLogLines(lines: string[], maxLines: number): string[] {
	if (lines.length <= maxLines) return lines;
	const capped = lines.slice(0, maxLines);
	const lastIndex = capped.length - 1;
	const lastLine = capped[lastIndex];
	if (lastLine !== undefined && !lastLine.endsWith(TOOL_PAYLOAD_TRUNCATION_MARKER)) {
		capped[lastIndex] = `${lastLine}${TOOL_PAYLOAD_TRUNCATION_MARKER}`;
	}
	return capped;
}

export function stageFailureReason(stage: Pick<StageSnapshot, "error" | "failureMessage">): string {
	const text = boundedToolText(
		trimLeadingWhitespace(stage.error ?? stage.failureMessage ?? ""),
		TOOL_PAYLOAD_VALUE_LIMIT,
	);
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

function canVisitChildError(
	child: SerializedError | undefined,
	depth: number,
	heading: string,
	state: SerializedErrorFormatState,
): child is SerializedError {
	return (
		child !== undefined &&
		depth <= MAX_SERIALIZED_ERROR_DEPTH &&
		!state.seen.has(child) &&
		state.nodesRemaining > 0 &&
		state.charsRemaining > heading.length + 1
	);
}

function visitSerializedError(error: SerializedError, depth: number, state: SerializedErrorFormatState): void {
	if (state.nodesRemaining <= 0 || state.charsRemaining <= 0) return;
	state.nodesRemaining -= 1;
	if (depth > MAX_SERIALIZED_ERROR_DEPTH || state.seen.has(error)) return;
	state.seen.add(error);
	const indent = "  ".repeat(depth);
	const name = boundedToolTitleText(error.name, 240);
	const code = error.code ? boundedToolTitleText(error.code, 240) : undefined;
	const message = boundedToolTitleText(
		trimLeadingWhitespace(error.message),
		Math.min(MAX_SERIALIZED_ERROR_FIELD_CHARS, Math.max(1, state.charsRemaining)),
	);
	pushBoundedErrorLine(state, `${indent}${name}${code ? ` (${code})` : ""}: ${message}`);
	if (error.hint && state.charsRemaining > 0) {
		const hint = boundedToolTitleText(
			trimLeadingWhitespace(error.hint),
			Math.min(MAX_SERIALIZED_ERROR_FIELD_CHARS, Math.max(1, state.charsRemaining)),
		);
		pushBoundedErrorLine(state, `${indent}hint: ${hint}`);
	}
	const causeHeading = `${indent}caused by:`;
	if (canVisitChildError(error.cause, depth + 1, causeHeading, state)) {
		pushBoundedErrorLine(state, causeHeading);
		visitSerializedError(error.cause, depth + 1, state);
	}
	const cleanupHeading = `${indent}during cleanup:`;
	if (canVisitChildError(error.cleanupCause, depth + 1, cleanupHeading, state)) {
		pushBoundedErrorLine(state, cleanupHeading);
		visitSerializedError(error.cleanupCause, depth + 1, state);
	}
	for (const member of error.errors ?? []) {
		if (state.nodesRemaining <= 0 || state.charsRemaining <= 0) break;
		visitSerializedError(member, depth + 1, state);
	}
}

function serializedErrorLines(error: SerializedError, charLimit = TOOL_PAYLOAD_VALUE_LIMIT): string[] {
	const state: SerializedErrorFormatState = {
		nodesRemaining: MAX_SERIALIZED_ERROR_NODES,
		charsRemaining: charLimit,
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
	const message = trimLeadingWhitespace(stage.failureMessage ?? stage.error ?? "");
	const detailLines = stage.failureDetail
		? capLogLines(
				serializedErrorLines(
					stage.failureDetail,
					message.length > 0 ? MAX_SERIALIZED_ERROR_CHARS : TOOL_PAYLOAD_VALUE_LIMIT,
				).flatMap((line) => line.split(/\r?\n/)),
				message.length > 0 ? MAX_SERIALIZED_ERROR_LINES : MAX_FAILURE_LOG_ROWS,
			)
		: [];
	if (message.length > 0) {
		const detailChars = detailLines.join("\n").length;
		const messageCharLimit =
			detailLines.length > 0
				? Math.min(
						MAX_FAILURE_LOG_MESSAGE_CHARS,
						Math.max(1, TOOL_PAYLOAD_VALUE_LIMIT - detailChars - 2 - TOOL_PAYLOAD_TRUNCATION_MARKER.length),
					)
				: MAX_FAILURE_LOG_MESSAGE_CHARS;
		const messageLineLimit = detailLines.length > 0 ? MAX_SERIALIZED_ERROR_LINES : MAX_FAILURE_LOG_ROWS;
		lines.push(...capLogLines(boundedToolText(message, messageCharLimit).split(/\r?\n/), messageLineLimit));
	}
	if (detailLines.length > 0) lines.push("", ...detailLines);
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
		const partLimit = Math.min(TOOL_PAYLOAD_VALUE_LIMIT, room * MAX_FAILURE_LOG_ROWS);
		const body = boundedLogs
			.split(/\r?\n/)
			.flatMap((part) =>
				part.length === 0
					? [""]
					: wrapPlainText(
							boundedToolText(sanitizeToolDisplayText(boundedToolText(part, partLimit)), partLimit),
							room,
						),
			);
		const markerRow = truncateToWidth(TOOL_PAYLOAD_TRUNCATION_MARKER, room, "…");
		const cappedBody =
			body.length <= MAX_FAILURE_LOG_ROWS
				? body
				: stage.failureDetail
					? [
							...body.slice(0, MAX_SERIALIZED_ERROR_LINES - 1),
							markerRow,
							...body.slice(-(MAX_FAILURE_LOG_ROWS - MAX_SERIALIZED_ERROR_LINES)),
						]
					: [...body.slice(0, MAX_FAILURE_LOG_ROWS - 1), markerRow];
		return [
			truncateToWidth(title, width),
			"",
			`${indent}${muted}Log${RESET}`,
			...cappedBody.map((line) => {
				const row = `${indent}${text}${line}${RESET}`;
				return width > indent.length + 1 && line.length <= room ? row : truncateToWidth(row, width);
			}),
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
