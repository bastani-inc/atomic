/**
 * A workflow run's outcome and diagnostics: what it returned, what its stages left behind, what stops it from finishing
 * and what happened in order. Failures read as one-line reasons; the full error, stack frames included, is kept for
 * the log view so the summary never becomes a stack trace.
 */

import { stripVTControlCharacters } from "node:util";
import type { WorkflowArtifact } from "../shared/authoring-contract-stage.js";
import {
	actionableReturnedStatusText,
	effectiveRunStatus,
	structuredRecoverableWorkflowFailure,
} from "../shared/returned-run-status.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import { inertDisplayLine, inertDisplayText } from "./display-text.js";
import type { GraphTheme } from "./graph-theme.js";
import { stageFailureLogLines } from "./stage-failure-detail.js";
import { fmtDuration } from "./status-helpers.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

/** How a run reads at a glance. Failed and stopped never share a glyph or a colour. */
export type RunOutcomeState = "completed" | "failed" | "stopped" | "paused" | "waiting" | "blocked" | "running";

export interface RunOutcomeOutput {
	readonly key: string;
	/** One line: a string's first line, otherwise compact JSON. */
	readonly value: string;
}

export interface RunOutcomeArtifact {
	readonly kind: WorkflowArtifact["kind"];
	readonly path: string;
	readonly stage: string;
	/** A diff's size, or why it could not be captured. */
	readonly detail?: string;
}

/** One stage or tool that stops the run from finishing. */
export interface RunOutcomeBlocker {
	readonly kind: "awaiting_input" | "failed" | "blocked";
	readonly node: "stage" | "tool";
	readonly id: string;
	readonly name: string;
	/** The question for a waiting stage, otherwise the failure's first line. */
	readonly reason: string;
	/** What Enter on this blocker does, in the user's words. */
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
	/** The run's failure in one line, when it failed or is blocked. */
	readonly reason?: string;
	readonly exitReason?: string;
	readonly outputs: readonly RunOutcomeOutput[];
	readonly artifacts: readonly RunOutcomeArtifact[];
	readonly blockers: readonly RunOutcomeBlocker[];
	readonly events: readonly RunOutcomeEvent[];
	/** The full failure text, stack frames included, for the log view. */
	readonly log: readonly string[];
}

const NO_REASON = "No reason was recorded.";
const STACK_FRAME = /^\s*at\s+\S/;
const MAX_EVENTS = 12;
/** The most wrapped lines one output, reason or exit value takes in the run details. */
const MAX_VALUE_LINES = 3;

/** A failure's first message line, without a generic `Error:` prefix, and how many stack frames it hid. */
export function summarizeFailureText(text: string | undefined): { reason: string; frames: number } {
	const lines = (text ?? "").split(/\r?\n/);
	const frames = lines.filter((line) => STACK_FRAME.test(line)).length;
	const first = lines.map((line) => line.trim()).find((line) => line.length > 0 && !STACK_FRAME.test(line));
	if (first === undefined) return { reason: NO_REASON, frames };
	const reason = first.replace(/^(?:Uncaught\s+)?Error:\s*/, "").trim();
	return { reason: inertDisplayLine(reason.length > 0 ? reason : first), frames };
}

/** A failure's lines without its stack frames, and how many frames were dropped. */
export function withoutStackFrames(text: string): { kept: string[]; frames: number } {
	const lines = text.split(/\r?\n/);
	const kept = lines.filter((line) => !STACK_FRAME.test(line));
	return { kept, frames: lines.length - kept.length };
}

/** The state every other surface shows: a returned blocked or failed status and a recoverable block count. */
function outcomeState(run: RunSnapshot): RunOutcomeState {
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
			return run.stages.some(isWaiting) ? "waiting" : "running";
	}
}

function isWaiting(stage: StageSnapshot): boolean {
	return stage.status === "awaiting_input" || stage.pendingPrompt !== undefined || stage.inputRequest !== undefined;
}

/** A declared output's value on one line: a string's first line, otherwise compact JSON. */
export function outputValueLine(value: unknown): string {
	if (typeof value === "string") return inertDisplayLine(value.split(/\r?\n/)[0] ?? "");
	try {
		return inertDisplayLine(JSON.stringify(value) ?? String(value));
	} catch {
		return inertDisplayLine(String(value));
	}
}

function outputsOf(run: RunSnapshot): RunOutcomeOutput[] {
	const result = run.result;
	if (result === undefined || result === null || typeof result !== "object") return [];
	return Object.entries(result).map(([key, value]) => ({ key: inertDisplayLine(key), value: outputValueLine(value) }));
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
	return artifact.diffStat?.split(/\r?\n/)[0];
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

function blockersOf(run: RunSnapshot, state: RunOutcomeState): RunOutcomeBlocker[] {
	if (state === "completed" || state === "stopped") return [];
	const blockers: RunOutcomeBlocker[] = [];
	for (const stage of run.stages) {
		if (isWaiting(stage)) {
			const question = stage.pendingPrompt?.message ?? stage.inputRequest?.questions[0]?.question;
			blockers.push({
				kind: "awaiting_input",
				node: "stage",
				id: stage.id,
				name: inertDisplayLine(stage.name),
				reason:
					question === undefined ? "Waiting for your answer." : inertDisplayLine(question.split(/\r?\n/)[0] ?? ""),
				action: "enter answer in the stage chat",
			});
		} else if (stage.status === "failed") {
			blockers.push({
				kind: "failed",
				node: "stage",
				id: stage.id,
				name: inertDisplayLine(stage.name),
				reason: stageReason(stage),
				action: "enter retry, fork, transcript or logs",
			});
		} else if (stage.status === "blocked") {
			blockers.push({
				kind: "blocked",
				node: "stage",
				id: stage.id,
				name: inertDisplayLine(stage.name),
				reason: stageReason(stage),
				action: "enter open the stage chat to resume it",
			});
		}
	}
	for (const tool of run.toolNodes as readonly ToolNodeSnapshot[]) {
		if (tool.status !== "failed") continue;
		blockers.push({
			kind: "failed",
			node: "tool",
			id: tool.id,
			name: inertDisplayLine(tool.name),
			reason: summarizeFailureText(tool.error).reason,
			action: "enter open the tool's detail",
		});
	}
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

/** The run's own end; a failure's reason is on the Reason line above, so it is not repeated here. */
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

/** Everything the run detail shows, from the run's snapshot alone. */
export function buildRunOutcome(run: RunSnapshot, now = Date.now()): RunOutcome {
	const state = outcomeState(run);
	// A run that returned a failed or blocked status says why in its own result; a recoverable block carries its error.
	const failureText =
		run.error ??
		run.failureMessage ??
		run.stages.find((stage) => stage.id === run.failedStageId)?.error ??
		run.stages.find((stage) => stage.status === "failed")?.error ??
		structuredRecoverableWorkflowFailure(run)?.error ??
		actionableReturnedStatusText(run.result);
	const reason = state === "failed" || state === "blocked" ? summarizeFailureText(failureText).reason : undefined;
	return {
		runId: run.id,
		name: inertDisplayLine(run.name),
		state,
		elapsedMs: elapsedRunMs(run, now),
		...(reason === undefined ? {} : { reason }),
		...(run.exitReason === undefined ? {} : { exitReason: inertDisplayLine(run.exitReason) }),
		outputs: outputsOf(run),
		artifacts: artifactsOf(run),
		blockers: blockersOf(run, state),
		events: eventsOf(run, state),
		log: runOutcomeLogLines(run),
	};
}

/** Every recorded line of the run's failure, then each failed stage's, for the log view. */
export function runOutcomeLogLines(run: RunSnapshot): string[] {
	const lines: string[] = [];
	const message = run.failureMessage ?? run.error;
	if (message) lines.push(...inertDisplayText(message).split(/\r?\n/));
	// A node that failed with the run's own message adds nothing the run's lines don't already show.
	const repeatsRun = (text: string | undefined): boolean => message !== undefined && text?.trim() === message.trim();
	for (const stage of run.stages) {
		if (stage.status !== "failed" && stage.status !== "blocked") continue;
		if (repeatsRun(stage.failureMessage ?? stage.error) && stage.failureDetail === undefined) continue;
		if (lines.length > 0) lines.push("");
		lines.push(
			`${inertDisplayLine(stage.name)}:`,
			...stageFailureLogLines(stage).map((line) => (line ? `  ${inertDisplayLine(line)}` : line)),
		);
	}
	for (const tool of run.toolNodes) {
		if (tool.status !== "failed" || tool.error === undefined || repeatsRun(tool.error)) continue;
		if (lines.length > 0) lines.push("");
		lines.push(
			`${inertDisplayLine(tool.name)}:`,
			...inertDisplayText(tool.error)
				.split(/\r?\n/)
				.map((line) => `  ${line}`),
		);
	}
	if (lines.length === 0) lines.push("No log was recorded for this run.");
	return lines;
}

export interface RunOutcomeRenderOpts {
	/** Omit for plain text. */
	readonly theme?: GraphTheme;
	readonly width: number;
	/** Show the full log instead of the summary. */
	readonly logs: boolean;
	/** The selected blocker, which Enter acts on. */
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

/** The run detail's rows, already styled (when themed) and cut to `width`. */
export function renderRunOutcomeLines(outcome: RunOutcome, opts: RunOutcomeRenderOpts): string[] {
	return renderRunOutcome(outcome, opts).lines;
}

/** The run detail's rows, and the row of the selected blocker so a scrolled view can keep it in sight. */
export function renderRunOutcome(
	outcome: RunOutcome,
	opts: RunOutcomeRenderOpts,
): { lines: string[]; selectedRow?: number } {
	const width = Math.max(1, Math.floor(opts.width));
	const t = opts.theme;
	const paint = (color: string | undefined, text: string, bold = false): string =>
		t === undefined || color === undefined ? text : `${hexToAnsi(color)}${bold ? BOLD : ""}${text}${RESET}`;
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
		const wrapped = wrapPlainText(value, valueRoom);
		const parts = wrapped.slice(0, MAX_VALUE_LINES);
		// A value cut at its last shown line says so instead of ending mid-thought.
		if (wrapped.length > MAX_VALUE_LINES)
			parts[MAX_VALUE_LINES - 1] =
				`${truncateToWidth(parts[MAX_VALUE_LINES - 1] ?? "", Math.max(1, valueRoom - 1), "")}\u2026`;
		return parts.map((part, index) =>
			fit(
				`${indent}${paint(t?.textMuted, (index === 0 ? key : "").padEnd(keyWidth))}  ${paint(valueColor ?? t?.text, part)}`,
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
		for (const line of outcome.log) {
			if (line.length === 0) lines.push("");
			else for (const part of wrapPlainText(line, room)) lines.push(fit(`${indent}${paint(t?.text, part)}`));
		}
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
			const name = truncateToWidth(blocker.name, nameWidth, "\u2026").padEnd(nameWidth);
			lines.push(
				fit(
					`${indent}${marker} ${paint(color, BLOCKER_GLYPH[blocker.kind])} ${paint(t?.text, name)}  ${paint(t?.textMuted, blocker.reason)}`,
				),
			);
			if (index === selected) {
				selectedRow = lines.length - 1;
				lines.push(fit(`${indent}    ${paint(t?.dim, blocker.action)}`));
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
