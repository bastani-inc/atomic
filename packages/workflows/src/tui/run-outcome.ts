import { stripVTControlCharacters } from "node:util";
import { clickableHintText, sliceHead } from "@bastani/atomic";
import type { WorkflowArtifact } from "../shared/authoring-contract-stage.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import {
	boundedToolPayloadRecord,
	boundedToolPayloadText,
	boundedToolText,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
	TOOL_PAYLOAD_VALUE_LIMIT,
	type ToolPayloadValue,
} from "../shared/tool-payload-bounds.js";
import type { RunsById } from "../shared/workflow-run-ownership.js";
import { boldOn, colorsOff, hexToAnsi, RESET } from "./color-utils.js";
import { inertDisplayLine, inertDisplayText, NO_FAILURE_REASON, summarizeFailureText } from "./display-text.js";
import type { GraphTheme } from "./graph-theme.js";
import {
	findWaitingInTree,
	firstPromptLine,
	isTerminalOrBlockedRun,
	isWaitingStage,
	runFailureText,
	validChildRunForStage,
	type WaitingRunTarget,
} from "./run-display-state.js";
import { stageFailureLogLines } from "./stage-failure-detail.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

export { summarizeFailureText, withoutStackFrames } from "./display-text.js";
export { findWaitingInTree, runFailureText, type WaitingRunTarget };

export type RunOutcomeState = "completed" | "failed" | "stopped" | "paused" | "waiting" | "blocked" | "running";

export interface RunOutcomeOutput {
	readonly key: string;
	readonly value: string;
}

export interface RunOutcomeArtifact {
	readonly kind: WorkflowArtifact["kind"];
	readonly path: string;
	readonly stage: string;
	readonly detail?: string;
}

export interface RunOutcomeBlocker {
	readonly kind: "awaiting_input" | "failed" | "blocked";
	readonly node: "stage" | "tool";
	readonly id: string;
	readonly name: string;
	readonly reason: string;
	readonly action: string;
}

export interface RunOutcomeEvent {
	readonly at: number;
	readonly tone: "success" | "error" | "muted" | "info" | "warning";
	readonly text: string;
}

export interface RunOutcome {
	readonly runId: string;
	readonly name: string;
	readonly state: RunOutcomeState;
	readonly elapsedMs: number;
	readonly reason?: string;
	readonly exitReason?: string;
	readonly outputs: readonly RunOutcomeOutput[];
	readonly artifacts: readonly RunOutcomeArtifact[];
	readonly blockers: readonly RunOutcomeBlocker[];
	readonly events: readonly RunOutcomeEvent[];
	readonly log: readonly string[];
}

const MAX_EVENTS = 12;
const MAX_VALUE_LINES = 3;
const MAX_LOG_ROWS = 256;

function firstLineOf(text: string): string {
	const nl = text.indexOf("\n");
	const cr = text.indexOf("\r");
	const end = nl < 0 ? cr : cr < 0 ? nl : Math.min(nl, cr);
	return end < 0 ? text : text.slice(0, end);
}

function questionReason(question: string | undefined): string {
	const line = question === undefined ? "" : firstPromptLine(question);
	return line.length > 0 ? inertDisplayLine(line) : "Waiting for your answer.";
}

function padVisible(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? `${text}${" ".repeat(pad)}` : text;
}

function pendingRunPromptInTree(
	run: RunSnapshot,
	rootRunId: string,
	runsById: RunsById,
	visited = new Set<string>(),
): string | undefined {
	if (visited.has(run.id) || isTerminalOrBlockedRun(run)) return undefined;
	visited.add(run.id);
	if (run.pendingPrompt !== undefined) return run.pendingPrompt.message;
	for (const stage of run.stages) {
		const child = validChildRunForStage(stage, run, rootRunId, runsById, visited);
		if (child !== undefined) {
			const found = pendingRunPromptInTree(child, rootRunId, runsById, visited);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function hasWaitingInTree(
	run: RunSnapshot,
	rootRunId: string,
	runsById: RunsById,
	visited = new Set<string>(),
): boolean {
	return findWaitingInTree(run, runsById, rootRunId, visited) !== undefined;
}

function outcomeState(run: RunSnapshot, runsById: RunsById): RunOutcomeState {
	switch (effectiveRunStatus(run)) {
		case "completed":
		case "skipped":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
		case "killed":
			return "stopped";
		case "blocked":
			return "blocked";
		case "paused":
			return run.quitAt !== undefined ? "stopped" : "paused";
		default:
			return hasWaitingInTree(run, run.id, runsById) ? "waiting" : "running";
	}
}

export function outputValueLine(value: ToolPayloadValue, limit = TOOL_PAYLOAD_VALUE_LIMIT): string {
	if (typeof value === "string") {
		const line = firstLineOf(value);
		return inertDisplayLine(line.length > limit ? sliceHead(line, limit) : line);
	}
	try {
		const json = value === undefined ? String(value) : boundedToolPayloadText(value, limit);
		return inertDisplayLine(json);
	} catch {
		return inertDisplayLine(String(value));
	}
}

function outputsOf(run: RunSnapshot): RunOutcomeOutput[] {
	const result = run.result;
	if (result === undefined || result === null || typeof result !== "object") return [];
	return Object.entries(boundedToolPayloadRecord(result)).map(([key, value]) => ({
		key: inertDisplayLine(key),
		value: outputValueLine(value),
	}));
}

function artifactDetail(artifact: WorkflowArtifact): string | undefined {
	if (artifact.captureError !== undefined)
		return `not captured: ${summarizeFailureText(artifact.captureError).reason}`;
	const size: string[] = [];
	if (artifact.filesChanged !== undefined)
		size.push(`${artifact.filesChanged} ${artifact.filesChanged === 1 ? "file" : "files"}`);
	if (artifact.insertions !== undefined || artifact.deletions !== undefined)
		size.push(`+${artifact.insertions ?? 0} \u2212${artifact.deletions ?? 0}`);
	if (size.length > 0) return size.join(" \u00b7 ");
	return artifact.diffStat === undefined ? undefined : firstLineOf(artifact.diffStat);
}

function artifactsOf(run: RunSnapshot): RunOutcomeArtifact[] {
	return run.stages.flatMap((stage) =>
		(stage.artifacts ?? []).map((artifact) => {
			const detail = artifactDetail(artifact);
			return {
				kind: artifact.kind,
				path: inertDisplayLine(artifact.path),
				stage: inertDisplayLine(stage.name),
				...(detail === undefined ? {} : { detail: inertDisplayLine(detail) }),
			};
		}),
	);
}

function stageReason(stage: Pick<StageSnapshot, "error" | "failureMessage">): string {
	return summarizeFailureText(stage.error ?? stage.failureMessage).reason;
}

function stageBlockerOf(stage: StageSnapshot, id: string): RunOutcomeBlocker | undefined {
	if (isWaitingStage(stage)) {
		const question = stage.pendingPrompt?.message ?? stage.inputRequest?.questions[0]?.question;
		return {
			kind: "awaiting_input",
			node: "stage",
			id,
			name: inertDisplayLine(stage.name),
			reason: questionReason(question),
			action: "enter answer in the stage chat",
		};
	}
	if (stage.status === "failed") {
		return {
			kind: "failed",
			node: "stage",
			id,
			name: inertDisplayLine(stage.name),
			reason: stageReason(stage),
			action: "enter retry, fork, transcript or logs",
		};
	}
	if (stage.status === "blocked") {
		return {
			kind: "blocked",
			node: "stage",
			id,
			name: inertDisplayLine(stage.name),
			reason: stageReason(stage),
			action: "enter open the stage chat to resume it",
		};
	}
	return undefined;
}

function blockersOf(
	run: RunSnapshot,
	state: RunOutcomeState,
	runsById: ReadonlyMap<string, RunSnapshot>,
): RunOutcomeBlocker[] {
	if (state === "completed" || state === "stopped") return [];
	const blockers: RunOutcomeBlocker[] = [];
	const visited = new Set<string>();

	const visitRun = (cur: RunSnapshot, isRoot: boolean): void => {
		if (visited.has(cur.id)) return;
		visited.add(cur.id);

		for (const stage of cur.stages) {
			const id = isRoot ? stage.id : `${cur.id}:${stage.id}`;
			const child = validChildRunForStage(stage, cur, run.id, runsById, visited);
			if (child !== undefined && child.stages.length + child.toolNodes.length > 0) {
				const before = blockers.length;
				visitRun(child, false);
				if (blockers.length === before) {
					const fallback = stageBlockerOf(stage, id);
					if (fallback !== undefined) blockers.push(fallback);
				}
				continue;
			}
			const blocker = stageBlockerOf(stage, id);
			if (blocker !== undefined) blockers.push(blocker);
		}

		for (const tool of cur.toolNodes as readonly ToolNodeSnapshot[]) {
			if (tool.status !== "failed") continue;
			blockers.push({
				kind: "failed",
				node: "tool",
				id: isRoot ? tool.id : `${cur.id}:${tool.id}`,
				name: inertDisplayLine(tool.name),
				reason: summarizeFailureText(tool.error).reason,
				action: "enter open the tool's detail",
			});
		}
	};

	visitRun(run, true);
	return blockers;
}

function stageEndEvent(stage: StageSnapshot): Omit<RunOutcomeEvent, "at"> | undefined {
	const name = inertDisplayLine(stage.name);
	switch (stage.status) {
		case "completed":
			return { tone: "success", text: `${name} completed` };
		case "failed":
			return { tone: "error", text: `${name} failed: ${stageReason(stage)}` };
		case "skipped":
			return { tone: "muted", text: `${name} skipped` };
		case "blocked":
			return { tone: "warning", text: `${name} blocked: ${stageReason(stage)}` };
		default:
			return undefined;
	}
}

function runEndText(name: string, state: RunOutcomeState): string {
	if (state === "failed") return `${name} failed`;
	if (state === "stopped") return `${name} stopped`;
	if (state === "blocked") return `${name} ended blocked`;
	return `${name} completed`;
}

function eventsOf(run: RunSnapshot, state: RunOutcomeState): RunOutcomeEvent[] {
	const events: Array<RunOutcomeEvent & { order: number }> = [];
	let order = 0;
	const push = (at: number | undefined, event: Omit<RunOutcomeEvent, "at">): void => {
		if (at === undefined) return;
		events.push({ at, ...event, order: order++ });
	};
	const runName = inertDisplayLine(run.name);
	push(run.startedAt, { tone: "info", text: `${runName} started` });
	for (const stage of run.stages) {
		push(stage.startedAt, { tone: "info", text: `${inertDisplayLine(stage.name)} started` });
		const end = stageEndEvent(stage);
		if (end !== undefined) push(stage.endedAt, end);
	}
	for (const tool of run.toolNodes) {
		const toolName = inertDisplayLine(tool.name);
		push(tool.startedAt, { tone: "info", text: `${toolName} started` });
		if (tool.status === "completed") push(tool.endedAt, { tone: "success", text: `${toolName} completed` });
		else if (tool.status === "failed")
			push(tool.endedAt, { tone: "error", text: `${toolName} failed: ${summarizeFailureText(tool.error).reason}` });
		else if (tool.status === "cancelled") push(tool.endedAt, { tone: "muted", text: `${toolName} stopped` });
	}
	push(run.pausedAt, { tone: "warning", text: `${runName} ${run.quitAt !== undefined ? "stopped" : "paused"}` });
	if (run.resumedAt !== undefined && (run.pausedAt === undefined || run.resumedAt > run.pausedAt))
		push(run.resumedAt, { tone: "info", text: `${runName} resumed` });
	if (state === "completed" || state === "failed" || state === "blocked" || (state === "stopped" && !run.quitAt))
		push(run.endedAt, {
			tone: state === "failed" ? "error" : state === "completed" ? "success" : "muted",
			text: runEndText(runName, state),
		});
	events.sort((a, b) => a.at - b.at || a.order - b.order);
	return events.map(({ order: _order, ...event }) => event);
}

export function buildRunOutcome(run: RunSnapshot, now = Date.now(), runs: readonly RunSnapshot[] = [run]): RunOutcome {
	const runsById = new Map(runs.map((candidate) => [candidate.id, candidate]));
	if (!runsById.has(run.id)) runsById.set(run.id, run);
	const state = outcomeState(run, runsById);
	const blockers = blockersOf(run, state, runsById);
	const failedBlockerReason = blockers.find(
		(blocker) => blocker.kind === "failed" || blocker.kind === "blocked",
	)?.reason;
	const failureText = runFailureText(run);
	const pendingRunQuestion = state === "waiting" ? pendingRunPromptInTree(run, run.id, runsById) : undefined;
	const reason =
		state === "failed" || state === "blocked"
			? failureText !== undefined
				? summarizeFailureText(failureText).reason
				: (failedBlockerReason ?? NO_FAILURE_REASON)
			: pendingRunQuestion !== undefined
				? questionReason(pendingRunQuestion)
				: undefined;
	return {
		runId: run.id,
		name: inertDisplayLine(run.name),
		state,
		elapsedMs: elapsedRunMs(run, now),
		...(reason === undefined ? {} : { reason }),
		...(run.exitReason === undefined ? {} : { exitReason: inertDisplayLine(run.exitReason) }),
		outputs: outputsOf(run),
		artifacts: artifactsOf(run),
		blockers,
		events: eventsOf(run, state),
		log: runOutcomeLogLines(run, runs),
	};
}

export function runOutcomeLogLines(run: RunSnapshot, runs: readonly RunSnapshot[] = [run]): string[] {
	const lines: string[] = [];
	const message = run.failureMessage ?? run.error;
	const boundedMessage = message === undefined ? undefined : boundedToolText(message, TOOL_PAYLOAD_VALUE_LIMIT);
	if (boundedMessage !== undefined && boundedMessage.length > 0) {
		lines.push(...inertDisplayText(boundedMessage.replace(/\r\n/g, "\n")).split("\n"));
	}
	const trimmedMessage = boundedMessage?.trim();
	const repeatsRun = (text: string | undefined): boolean =>
		trimmedMessage !== undefined &&
		text !== undefined &&
		boundedToolText(text, TOOL_PAYLOAD_VALUE_LIMIT).trim() === trimmedMessage;
	const runsById = new Map(runs.map((candidate) => [candidate.id, candidate]));
	if (!runsById.has(run.id)) runsById.set(run.id, run);
	const visited = new Set<string>();
	const visitRun = (cur: RunSnapshot): void => {
		if (visited.has(cur.id)) return;
		visited.add(cur.id);
		for (const stage of cur.stages) {
			const child = validChildRunForStage(stage, cur, run.id, runsById, visited);
			if (
				(stage.status === "failed" || stage.status === "blocked") &&
				(!repeatsRun(stage.failureMessage ?? stage.error) || stage.failureDetail !== undefined)
			) {
				if (lines.length > 0) lines.push("");
				lines.push(
					`${inertDisplayLine(stage.name)}:`,
					...stageFailureLogLines(stage).map((line) => (line ? `  ${inertDisplayLine(line)}` : line)),
				);
			}
			if (child !== undefined) visitRun(child);
		}
		for (const tool of cur.toolNodes) {
			if (tool.status !== "failed" || tool.error === undefined || repeatsRun(tool.error)) continue;
			if (lines.length > 0) lines.push("");
			const boundedTool = boundedToolText(tool.error, TOOL_PAYLOAD_VALUE_LIMIT).replace(/\r\n/g, "\n");
			lines.push(
				`${inertDisplayLine(tool.name)}:`,
				...inertDisplayText(boundedTool)
					.split("\n")
					.map((line) => `  ${line}`),
			);
		}
	};
	visitRun(run);
	if (lines.length === 0) lines.push("No log was recorded for this run.");
	return lines;
}

export interface RunOutcomeRenderOpts {
	readonly theme?: GraphTheme;
	readonly width: number;
	readonly logs: boolean;
	readonly selected: number;
}

const STATE_GLYPH: Record<RunOutcomeState, string> = {
	completed: "\u2713",
	failed: "\u2717",
	stopped: "\u25fc",
	paused: "\u275a\u275a",
	waiting: "\u25c6",
	blocked: "\u2191",
	running: "\u2200",
};

const BLOCKER_GLYPH: Record<RunOutcomeBlocker["kind"], string> = {
	awaiting_input: "\u25c6",
	failed: "\u2717",
	blocked: "\u2191",
};

function headline(outcome: RunOutcome): string {
	const elapsed = fmtDuration(outcome.elapsedMs);
	switch (outcome.state) {
		case "completed":
			return `completed in ${elapsed}`;
		case "failed":
			return `failed after ${elapsed}`;
		case "stopped":
			return `stopped after ${elapsed}`;
		case "paused":
			return `paused at ${elapsed}`;
		case "waiting":
			return `needs input · ${elapsed}`;
		case "blocked":
			return `blocked · ${elapsed}`;
		default:
			return `running · ${elapsed}`;
	}
}

function wrapOutcomeLogLine(line: string, room: number): string[] {
	if (line.length === 0) return [""];
	const limit = Math.min(TOOL_PAYLOAD_VALUE_LIMIT, room * MAX_LOG_ROWS);
	const bounded = line.length > limit ? boundedToolText(line, limit) : line;
	const trimmed = bounded.trimStart();
	if (trimmed.length === 0) return [""];
	let leadingSpaces = 0;
	while (leadingSpaces < bounded.length && bounded.charCodeAt(leadingSpaces) === 0x20) {
		leadingSpaces += 1;
	}
	const indentCols = Math.min(leadingSpaces, Math.max(0, room - 1));
	if (indentCols === 0) return wrapPlainText(trimmed, room);
	const lineIndent = " ".repeat(indentCols);
	return wrapPlainText(trimmed, room - indentCols).map((part) => `${lineIndent}${part}`);
}

export function renderRunOutcomeLines(outcome: RunOutcome, opts: RunOutcomeRenderOpts): string[] {
	return renderRunOutcome(outcome, opts).lines;
}

export function renderRunOutcome(
	outcome: RunOutcome,
	opts: RunOutcomeRenderOpts,
): { lines: string[]; selectedRow?: number } {
	const width = Math.max(1, Math.floor(opts.width));
	const t = colorsOff() ? undefined : opts.theme;
	const paint = (color: string | undefined, text: string, bold = false): string =>
		t === undefined || color === undefined ? text : `${hexToAnsi(color)}${bold ? boldOn() : ""}${text}${RESET}`;
	const stateColor: Record<RunOutcomeState, string | undefined> = {
		completed: t?.success,
		failed: t?.error,
		stopped: t?.textMuted,
		paused: t?.warning,
		waiting: t?.info,
		blocked: t?.warning,
		running: t?.accent,
	};
	const toneColor = (tone: RunOutcomeEvent["tone"]): string | undefined =>
		tone === "success"
			? t?.success
			: tone === "error"
				? t?.error
				: tone === "info"
					? t?.text
					: tone === "warning"
						? t?.warning
						: t?.textMuted;
	const indent = "  ";
	const room = Math.max(1, width - indent.length);
	const fit = (line: string): string => {
		const cut = truncateToWidth(line, width, "\u2026");
		return t === undefined ? stripVTControlCharacters(cut) : cut;
	};
	const section = (title: string): string => fit(`${indent}${paint(t?.textMuted, title, true)}`);
	const keyed = (key: string, keyWidth: number, value: string, valueColor?: string): string[] => {
		const valueRoom = Math.max(1, room - keyWidth - 2);
		const charLimit = Math.max(512, valueRoom * (MAX_VALUE_LINES + 2));
		const sliced = value.length > charLimit ? sliceHead(value, charLimit) : value;
		let wrapped = wrapPlainText(sliced, valueRoom);
		if (sliced.length < value.length && wrapped.length <= MAX_VALUE_LINES) {
			const trimmed = value.trimStart();
			const head = trimmed.length > charLimit * 4 ? sliceHead(trimmed, charLimit * 4) : trimmed;
			const compact = head.trimEnd().replace(/\s+/g, " ");
			const resliced = compact.length > charLimit ? sliceHead(compact, charLimit) : compact;
			wrapped = wrapPlainText(resliced, valueRoom);
		}
		const parts = wrapped.slice(0, MAX_VALUE_LINES);
		if (wrapped.length > MAX_VALUE_LINES)
			parts[MAX_VALUE_LINES - 1] =
				`${truncateToWidth(parts[MAX_VALUE_LINES - 1] ?? "", Math.max(1, valueRoom - 1), "")}\u2026`;
		return parts.map((part, index) =>
			fit(
				`${indent}${paint(t?.textMuted, padVisible(index === 0 ? key : "", keyWidth))}  ${paint(valueColor ?? t?.text, part)}`,
			),
		);
	};

	const glyph = STATE_GLYPH[outcome.state];
	const title = fit(
		`${indent}${paint(stateColor[outcome.state], `${glyph} ${outcome.name}`, true)}${paint(t?.textMuted, ` \u00b7 ${headline(outcome)}`)}`,
	);
	const lines = [title];

	if (opts.logs) {
		lines.push("", section("Log"));
		const wrappedLog: string[] = [];
		let truncatedLog = false;
		for (const line of outcome.log) {
			if (line.length === 0) {
				if (wrappedLog.length >= MAX_LOG_ROWS) {
					truncatedLog = true;
					break;
				}
				wrappedLog.push("");
				continue;
			}
			for (const part of wrapOutcomeLogLine(line, room)) {
				if (wrappedLog.length >= MAX_LOG_ROWS) {
					truncatedLog = true;
					break;
				}
				wrappedLog.push(fit(`${indent}${paint(t?.text, part)}`));
			}
			if (truncatedLog) break;
		}
		if (truncatedLog && wrappedLog.length > 0) {
			wrappedLog[wrappedLog.length - 1] = fit(
				`${indent}${paint(t?.text, truncateToWidth(TOOL_PAYLOAD_TRUNCATION_MARKER, room, "\u2026"))}`,
			);
		}
		lines.push(...wrappedLog);
		return { lines };
	}
	let selectedRow: number | undefined;

	if (outcome.reason !== undefined) lines.push("", ...keyed("Reason", 6, outcome.reason));
	if (outcome.exitReason !== undefined) lines.push(...keyed("Exit", 6, outcome.exitReason));

	if (outcome.blockers.length > 0) {
		lines.push("", section(`Blockers \u00b7 ${outcome.blockers.length}`));
		const nameWidth = Math.min(18, Math.max(...outcome.blockers.map((blocker) => visibleWidth(blocker.name))));
		const selected = Math.max(0, Math.min(opts.selected, outcome.blockers.length - 1));
		outcome.blockers.forEach((blocker, index) => {
			const marker = index === selected ? paint(t?.accent, "\u276f") : " ";
			const color = blocker.kind === "failed" ? t?.error : blocker.kind === "awaiting_input" ? t?.info : t?.warning;
			const name = padVisible(truncateToWidth(blocker.name, nameWidth, "\u2026"), nameWidth);
			lines.push(
				fit(
					`${indent}${marker} ${paint(color, BLOCKER_GLYPH[blocker.kind])} ${paint(t?.text, name)}  ${paint(t?.textMuted, blocker.reason)}`,
				),
			);
			if (index === selected) {
				selectedRow = lines.length - 1;
				// Enter acts on the selected blocker, so a click on its action line runs Enter on it.
				const action = t === undefined ? blocker.action : clickableHintText(blocker.action);
				lines.push(fit(`${indent}    ${paint(t?.dim, action)}`));
			}
		});
	}

	if (outcome.outputs.length > 0) {
		lines.push("", section("Outputs"));
		const keyWidth = Math.min(16, Math.max(...outcome.outputs.map((output) => visibleWidth(output.key))));
		for (const output of outcome.outputs)
			lines.push(...keyed(truncateToWidth(output.key, keyWidth, "\u2026"), keyWidth, output.value));
	} else if (outcome.state === "completed") {
		lines.push("", section("Outputs"), fit(`${indent}${paint(t?.dim, "This workflow declared no outputs.")}`));
	}

	if (outcome.artifacts.length > 0) {
		lines.push("", section("Artifacts"));
		for (const artifact of outcome.artifacts) {
			const value = `${artifact.path}${artifact.detail ? ` \u00b7 ${artifact.detail}` : ""}`;
			lines.push(...keyed(artifact.kind, 6, value).slice(0, 1));
		}
	}

	if (outcome.events.length > 0) {
		lines.push("", section("Events"));
		const shown = outcome.events.slice(-MAX_EVENTS);
		if (shown.length < outcome.events.length)
			lines.push(fit(`${indent}${paint(t?.dim, `\u2026 ${outcome.events.length - shown.length} earlier`)}`));
		const start = outcome.events[0]?.at ?? 0;
		for (const event of shown) {
			const offset = `+${fmtDuration(event.at - start)}`.padStart(7);
			lines.push(fit(`${indent}${paint(t?.dim, offset)}  ${paint(toneColor(event.tone), event.text)}`));
		}
	}
	return selectedRow === undefined ? { lines } : { lines, selectedRow };
}
