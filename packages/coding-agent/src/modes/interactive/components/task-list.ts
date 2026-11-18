import { type Component, truncateToWidth } from "@bastani/atomic-tui";
import { agentPanelTaskId, taskPanelItems } from "../../../core/tasks/agent-panel-source.ts";
import { supersededReleasedAttempts, waitingReleasedTools } from "../../../core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { type TaskElapsedClocks, taskClockOf, taskClockRunning } from "../../../core/tasks/live-elapsed.js";
import { pluralNoun, toolTaskNoun } from "../../../core/tasks/task-kind.js";
import { theme } from "../theme/theme.js";
import { AGENT_PANEL_IDLE_ROWS, panelShellHintSegments, renderAgentPanelRows } from "./agent-panel.ts";
import { countTasksBy, TaskRow, taskLabel, taskSiblings, taskTitle } from "./task-row.js";

const labelAndTitle = (task: TaskRecord): string => JSON.stringify([taskLabel(task), taskTitle(task)]);

/** Complete projection; viewport owners, not this list, decide how much to mount. */
export class TaskList implements Component {
	private readonly tasks: readonly TaskRecord[];
	private readonly expanded: boolean;
	constructor(tasks: readonly TaskRecord[], expanded = false) {
		this.tasks = tasks;
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const siblings = taskSiblings(this.tasks);
		const copies = countTasksBy(siblings, labelAndTitle);
		return siblings.flatMap((task) => {
			const duplicate = (copies.get(labelAndTitle(task)) ?? 0) > 1;
			return new TaskRow(task, { expanded: this.expanded, duplicate, siblings }).render(width);
		});
	}
}
export type TaskListSection = { title: string; tasks: TaskRecord[] };

function statusRank(task: TaskRecord): number {
	const execution = task.execution;
	if (execution.kind === "running") return task.attention.kind === "none" ? 1 : 0;
	if (execution.kind === "cancelling") return 2;
	if (execution.kind === "queued") return 3;
	return { failed: 4, cancelled: 5, completed: 6 }[execution.result.kind];
}

/**
 * Sections list running work first, then stopping, queued, failed, cancelled and completed tasks.
 * Within a status, the latest launch comes first; settled tasks use the latest settlement when known,
 * and fall back to launch order when their settlement sequences tie.
 */
export function taskListSections(
	tasks: readonly TaskRecord[],
	settlementOrder: ReadonlyMap<TaskId, bigint> = new Map(),
): TaskListSection[] {
	const launchOrder = new Map(tasks.map((task, index) => [task.ref.taskId, index]));
	const newerFirst = (a: TaskRecord, b: TaskRecord) => {
		const settledA = a.execution.kind === "settled" ? settlementOrder.get(a.ref.taskId) : undefined;
		const settledB = b.execution.kind === "settled" ? settlementOrder.get(b.ref.taskId) : undefined;
		if (settledA !== undefined && settledB !== undefined && settledA !== settledB)
			return settledB > settledA ? 1 : -1;
		return (launchOrder.get(b.ref.taskId) ?? 0) - (launchOrder.get(a.ref.taskId) ?? 0);
	};
	const ordered = [...tasks].sort((a, b) => statusRank(a) - statusRank(b) || newerFirst(a, b));
	const sections: TaskListSection[] = [];
	const agents = ordered.filter((task) => task.kind === "agent");
	if (agents.length) sections.push({ title: "Agents", tasks: agents });
	const shells = ordered.filter((task) => task.kind === "command");
	if (shells.length) sections.push({ title: "Shells", tasks: shells });
	// A tool call's background work is listed beside the shells, one section per tool: `Searches`.
	const tools = new Map<string, TaskRecord[]>();
	for (const task of ordered) {
		if (task.kind !== "tool") continue;
		const noun = toolTaskNoun(task);
		tools.set(noun, [...(tools.get(noun) ?? []), task]);
	}
	for (const [noun, selected] of tools) {
		const plural = pluralNoun(noun);
		sections.push({ title: plural.charAt(0).toUpperCase() + plural.slice(1), tasks: selected });
	}
	return sections;
}
/**
 * Terminal results remain inspectable but no longer advertise active work. A subagent released while it waits is not
 * terminal: it wakes by itself, so it is listed, as waiting.
 */
export function isActiveBackgroundTask(task: TaskRecord): boolean {
	if (task.execution.kind !== "settled") return task.observation.kind === "background";
	// A released subagent's observation already ended with its run; it was launched in the background.
	return (
		(task.wasBackground === true || task.observation.kind === "background") &&
		waitingReleasedTools(task) !== undefined
	);
}

/**
 * A chat's own active tasks below its prompt, as the main chat's agent panel shows them: subagents as rows, and running
 * shells, which are not rows, counted on a line of their own in the main chat's hint wording.
 */
export function renderTaskFooter(tasks: readonly TaskRecord[], width: number, clocks?: TaskElapsedClocks): string[] {
	const input: TaskRecord[] = [];
	const running: TaskRecord[] = [];
	const other: TaskRecord[] = [];
	let total = 0;
	let shells = 0;
	const superseded = supersededReleasedAttempts(tasks);
	for (let index = tasks.length - 1; index >= 0; index--) {
		const task = tasks[index]!;
		if (!isActiveBackgroundTask(task) || superseded.has(task.ref.taskId)) continue;
		// Only subagents are rows; shells, and a tool call's background work, are not.
		if (task.kind !== "agent") {
			if (task.kind === "command") shells++;
			continue;
		}
		total++;
		if (task.execution.kind === "running") {
			if (task.attention.kind === "none") {
				if (input.length + running.length < AGENT_PANEL_IDLE_ROWS) running.push(task);
			} else if (input.length < AGENT_PANEL_IDLE_ROWS) {
				input.push(task);
			}
		} else if (input.length + running.length + other.length < AGENT_PANEL_IDLE_ROWS) {
			other.push(task);
		}
	}
	const shellHint = panelShellHintSegments(shells, total > 0);
	const shellLine =
		shellHint.length === 0
			? []
			: [
					truncateToWidth(
						`  ${shellHint.map((segment) => theme.fg("muted", segment)).join(theme.fg("dim", " · "))}`,
						Math.max(1, width),
					),
				];
	if (total === 0) return shellLine;
	const shownTasks = [...input, ...running, ...other].slice(0, AGENT_PANEL_IDLE_ROWS);
	const now = Date.now();
	const items = taskPanelItems({ backgroundTasks: shownTasks }, new Set(), { topLevelOnly: false }).map((row) => {
		if (row.state === "queued") return row;
		const itemClocks = taskClockOf(row) ?? clocks;
		if (itemClocks === undefined) return row;
		const taskId = agentPanelTaskId(row.id) ?? row.id;
		const elapsedMs = itemClocks.elapsedMs(taskId, row.elapsedMs, taskClockRunning(row.state), now);
		return elapsedMs === undefined || elapsedMs === row.elapsedMs || (row.elapsedMs === undefined && elapsedMs < 1000)
			? row
			: { ...row, elapsedMs };
	});
	const rows = renderAgentPanelRows(
		items,
		width,
		{
			dim: (text) => theme.fg("dim", text),
			text: (text) => theme.fg("text", text),
			muted: (text) => theme.fg("muted", text),
			border: (text) => theme.fg("borderMuted", text),
			bold: (text) => theme.bold(text),
			accent: (text) => theme.fg("accent", text),
			success: (text) => theme.fg("success", text),
			error: (text) => theme.fg("error", text),
			warning: (text) => theme.fg("warning", text),
		},
		{ hiddenBelow: total - items.length },
	);
	return [...rows, ...shellLine];
}
