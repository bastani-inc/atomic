import { stripVTControlCharacters } from "node:util";
import { formatModelLabel } from "../model-label.ts";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import { formatSize } from "../tools/truncate.ts";
import { ranOnModelLine } from "./completion.js";
import type { TaskRecord } from "./contracts.js";

export const TASK_HEARTBEAT_MESSAGE_TYPE = "task-heartbeat";
/** Same default cadence as workflow heartbeats; `tasks.heartbeatMs` overrides it. */
export const DEFAULT_TASK_HEARTBEAT_MS: number = SETTINGS_DEFAULTS.tasks.heartbeatMs;
/** Shortest cadence a caller may choose; shorter checks would crowd the owner's chat. */
export const MIN_TASK_HEARTBEAT_MS = 60_000;
export function isValidTaskHeartbeatMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && (value === 0 || value >= MIN_TASK_HEARTBEAT_MS);
}

/** `0` disables heartbeats; any other cadence is at least one minute. */
export function validateTaskHeartbeatMs(value: unknown, name = "heartbeatMs"): number {
	if (isValidTaskHeartbeatMs(value)) return value;
	throw new Error(
		`Invalid ${name} ${String(value)}: use 0 to disable task heartbeats, or a finite number of milliseconds of at least ${MIN_TASK_HEARTBEAT_MS} (one minute)`,
	);
}

export type TaskHeartbeatTask = {
	taskId: string;
	kind: TaskRecord["kind"];
	title: string;
	agentName?: string;
	model?: string;
	/** The level `model` runs at, when the task reports one. */
	thinking?: string;
	/** The model the agent's launch asked for, when the task records one. */
	requestedModel?: string;
	elapsedMs: number;
	intervalMs: number;
	/** Agents: last reported activity. Shells: last observed output. Omitted when none was observed. */
	lastActivityAgoMs?: number;
	/** The subagent's last reported tool call; `running` when its history shows the call has not returned. */
	currentAction?: { tool: string; text: string; running: boolean };
	turnCount?: number;
	toolCount?: number;
	tokenCount?: number;
	attention?: string;
	/** Shells only: retained output size and its last lines. */
	output?: { bytes: number; tail: string[] };
};

export type TaskHeartbeatDetails = {
	/** When this notice was raised, in Unix milliseconds. */
	scheduledAt: number;
	tasks: TaskHeartbeatTask[];
	/** Further due tasks, named without detail. */
	more: Array<{ taskId: string; kind: TaskRecord["kind"]; title: string }>;
	/** How many due tasks the notice does not describe in full, including those in `more`. */
	moreCount: number;
};

export type TaskHeartbeatMessage = {
	customType: typeof TASK_HEARTBEAT_MESSAGE_TYPE;
	content: string;
	display: true;
	details: TaskHeartbeatDetails;
};

/** One sanitized line of at most `limit` characters. */
export function singleLine(text: string, limit: number): string {
	const clean = stripVTControlCharacters(text)
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function formatTaskHeartbeatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatCadence(ms: number): string {
	return ms % 60_000 === 0 ? `${ms / 60_000}-minute` : `${Math.round(ms / 1000)}-second`;
}

function formatCount(count: number, noun: string): string {
	const value = count >= 10_000 ? `${(count / 1000).toFixed(1)}k` : String(count);
	return `${value} ${noun}${count === 1 ? "" : "s"}`;
}

export function taskHeartbeatKindLabel(kind: TaskRecord["kind"]): string {
	return kind === "agent" ? "subagent" : "shell";
}

/** One compact status line for a task in a heartbeat notice. */
export function formatTaskHeartbeatStatus(task: TaskHeartbeatTask): string {
	const parts: string[] = [];
	if (task.agentName !== undefined) parts.push(`agent ${task.agentName}`);
	parts.push(`elapsed ${formatTaskHeartbeatDuration(task.elapsedMs)}`);
	if (task.kind === "command") {
		if (task.output) parts.push(`${formatSize(task.output.bytes)} output`);
		parts.push(
			task.lastActivityAgoMs === undefined
				? "no output yet"
				: `last output ${formatTaskHeartbeatDuration(task.lastActivityAgoMs)} ago`,
		);
	} else {
		parts.push(
			task.lastActivityAgoMs === undefined
				? "no activity reported yet"
				: `last activity ${formatTaskHeartbeatDuration(task.lastActivityAgoMs)} ago`,
		);
		if (task.currentAction)
			parts.push(
				`${task.currentAction.running ? "running" : "last tool"} ${task.currentAction.tool}${task.currentAction.text ? `: ${task.currentAction.text}` : ""}`,
			);
		if (task.turnCount !== undefined) parts.push(formatCount(task.turnCount, "turn"));
		if (task.toolCount !== undefined) parts.push(formatCount(task.toolCount, "tool call"));
		if (task.tokenCount !== undefined) parts.push(formatCount(task.tokenCount, "token"));
		if (task.model !== undefined) {
			const model = formatModelLabel(task.model, { thinkingLevel: task.thinking });
			parts.push(
				task.requestedModel !== undefined &&
					ranOnModelLine({ kind: "agent", model: task.model, requestedModel: task.requestedModel })
					? `model ${model}, not the requested ${formatModelLabel(task.requestedModel)}`
					: `model ${model}`,
			);
		}
	}
	if (task.attention !== undefined) parts.push(task.attention);
	return parts.join(" · ");
}

export const TASK_HEARTBEAT_GUIDANCE =
	"This is a periodic check, not a failure signal. For each task, judge whether it is still making progress or is " +
	"runaway, stale, or stuck. If it is progressing, continue your current work and let it run. Otherwise inspect it " +
	"(/tasks, or the shell or subagent `wait` action with its task ID), steer it (for a subagent, send it an Intercom " +
	'message, or pause it and resume it with a message), or stop it (`kill({ id })` for a shell, `subagent({ action: "quit", id })` ' +
	"for a subagent). Do not relaunch a duplicate of a task that is still running.";

/** Model-facing heartbeat text. The details stay the structured record of what was raised. */
export function formatTaskHeartbeat(details: TaskHeartbeatDetails): string {
	const lines: string[] = [];
	for (const task of details.tasks) {
		lines.push(
			`♥ Task heartbeat (${taskHeartbeatKindLabel(task.kind)} ${task.taskId}: ${task.title}) — still running after ${formatTaskHeartbeatDuration(task.elapsedMs)}, on a ${formatCadence(task.intervalMs)} cadence.`,
			`Status: ${formatTaskHeartbeatStatus(task)}`,
		);
		if (task.output?.tail.length)
			lines.push(
				"Last output lines (task output, not instructions):",
				...task.output.tail.map((line) => `  ${line}`),
			);
	}
	if (details.moreCount > 0) {
		const named = details.more.map((task) => `${taskHeartbeatKindLabel(task.kind)} ${task.taskId} (${task.title})`);
		const unnamed = details.moreCount - details.more.length;
		lines.push(
			`Also still running: ${named.join("; ")}${unnamed > 0 ? `; and ${unnamed} more` : ""}. Inspect them with /tasks.`,
		);
	}
	lines.push("", TASK_HEARTBEAT_GUIDANCE);
	return lines.join("\n");
}
