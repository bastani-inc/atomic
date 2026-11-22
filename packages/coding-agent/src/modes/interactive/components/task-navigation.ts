import { matchesKey } from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { waitingReleasedTools } from "../../../core/tasks/completion.js";
import type { PromptRoute, TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { TwoPressConfirm } from "./nav-keys.ts";
import type { TaskDetailAction } from "./task-detail.js";
import { type ListEntry, type ListSelectionAnchor, resolveListEntry, taskStableKey } from "./task-selection-state.js";

export type TaskFocus =
	| { kind: "composer" }
	| { kind: "tasks" }
	| { kind: "detail" }
	| { kind: "stdin"; taskId: TaskId };
export type TaskNavigationActions = {
	/** Space: the task's detail page, a peek at its status, prompt and result. */
	inspect(task: TaskRecord): void;
	/** Enter or →: the task's chat, or a shell's output, straight from the list. */
	openChat(task: TaskRecord): void;
	transcript(task: TaskRecord): void;
	/** The first `x` on a running task: it asks for the second press that stops it. */
	armStop(task: TaskRecord): void;
	cancel(task: TaskRecord): void;
	/** `x` on a finished task: it leaves the list. */
	dismiss(task: TaskRecord): void;
	input(task: TaskRecord): void;
	stdinAvailable(task: TaskRecord): boolean;
	openQuestion(route: PromptRoute): void;
	currentTask?(taskId: TaskId): TaskRecord | undefined;
};

/** Shared focus state; activity updates never take ownership of editor input. */
export class TaskNavigation {
	focus: TaskFocus = { kind: "composer" };
	selectedTaskId?: TaskId;
	private selectedKey?: string;
	private tasks: TaskRecord[] = [];

	private entries: ListEntry[] = [];
	/** `x` stops a task only when pressed again on the same task within three seconds. */
	readonly stopConfirm: TwoPressConfirm;
	/**
	 * A task that finished while its stop waited for the second `x`: the wait ends, and this names it until the next
	 * key, so a second `x` never dismisses a row whose finished state the reader has not seen.
	 */
	finishedWhileArmed?: TaskRecord;
	/** The press after a {@link finishedWhileArmed} task finished was swallowed; the next one dismisses it. */
	finishedAcknowledged = false;
	private readonly paintedExecution = new Map<TaskId, TaskRecord["execution"]["kind"]>();

	private keys: KeybindingsManager;
	private actions: TaskNavigationActions;
	constructor(keys: KeybindingsManager, actions: TaskNavigationActions, now: () => number = Date.now) {
		this.keys = keys;
		this.actions = actions;
		this.stopConfirm = new TwoPressConfirm(now);
	}

	private syncSelectedKey(): void {
		const selected = this.selectedTaskId;
		if (selected === undefined) {
			this.selectedKey = undefined;
			return;
		}
		const entry = this.entries.find((candidate) => candidate.id === selected);
		if (entry !== undefined) {
			this.selectedKey = entry.key;
			return;
		}
		const task = this.tasks.find((candidate) => candidate.ref.taskId === selected);
		if (task !== undefined) this.selectedKey = taskStableKey(task);
	}

	private toEntries(tasks: readonly TaskRecord[], order: readonly (string | ListEntry)[]): ListEntry[] {
		let taskById: Map<string, TaskRecord> | undefined;
		return order.map((item) => {
			if (typeof item !== "string") return item;
			taskById ??= new Map(tasks.map((task) => [task.ref.taskId, task] as const));
			const task = taskById.get(item);
			return { id: item, key: task === undefined ? item : taskStableKey(task) };
		});
	}

	private syncStopConfirm(): void {
		const armed = this.stopConfirm.pending();
		// A subagent released while it waits is not finished: its stop stays armed.
		const settled = this.tasks.find(
			(task) =>
				task.ref.taskId === armed && task.execution.kind === "settled" && waitingReleasedTools(task) === undefined,
		);
		if (settled !== undefined) {
			this.stopConfirm.reset();
			this.finishedWhileArmed = settled;
			this.finishedAcknowledged = false;
		}
	}

	update(
		tasks: readonly TaskRecord[],
		order: readonly (string | ListEntry)[] = [
			...tasks.filter((task) => task.kind === "agent"),
			...tasks.filter((task) => task.kind === "command"),
		].map((task) => ({ id: task.ref.taskId, key: taskStableKey(task) })),
	): void {
		const previousKeys = this.entries.map((entry) => entry.key);
		const targetKey = this.selectedKey ?? this.selectedTaskId;
		this.tasks = [...tasks];
		const retained = new Set(tasks.map((task) => task.ref.taskId));
		for (const id of this.paintedExecution.keys()) if (!retained.has(id)) this.paintedExecution.delete(id);
		this.entries = this.toEntries(this.tasks, order);
		const resolved = resolveListEntry(targetKey, previousKeys, this.entries);
		this.selectedTaskId = resolved?.id as TaskId | undefined;
		this.selectedKey = resolved?.key;
		this.syncStopConfirm();
	}

	/**
	 * Refresh the live task records while a detail/transcript/waited-shell/stdin view is open,
	 * without resolving `selectedTaskId` against a stale list order.
	 */
	updateTasksWhileAway(tasks: readonly TaskRecord[]): void {
		this.tasks = [...tasks];
		const retained = new Set(tasks.map((task) => task.ref.taskId));
		for (const id of this.paintedExecution.keys()) if (!retained.has(id)) this.paintedExecution.delete(id);
		this.syncSelectedKey();
		this.syncStopConfirm();
	}

	/**
	 * Restore list selection from an anchor captured before leaving the list:
	 * exact stable key -> nearest surviving neighbour key -> head.
	 */
	resolveFromAnchor(
		tasks: readonly TaskRecord[],
		order: readonly (string | ListEntry)[],
		anchor: ListSelectionAnchor,
	): void {
		this.tasks = [...tasks];
		const retained = new Set(tasks.map((task) => task.ref.taskId));
		for (const id of this.paintedExecution.keys()) if (!retained.has(id)) this.paintedExecution.delete(id);
		this.entries = this.toEntries(this.tasks, order);
		const resolved = resolveListEntry(anchor.selectedKey, anchor.orderKeys, this.entries);
		this.selectedTaskId = resolved?.id as TaskId | undefined;
		this.selectedKey = resolved?.key;
		this.syncStopConfirm();
	}

	open(taskId?: TaskId): void {
		if (taskId !== undefined) {
			const entry = this.entries.find((candidate) => candidate.id === taskId);
			if (entry !== undefined) {
				this.selectedTaskId = taskId;
				this.selectedKey = entry.key;
			}
		}
		this.focus = { kind: "tasks" };
	}

	paint(tasks: readonly TaskRecord[]): void {
		for (const task of tasks) this.paintedExecution.set(task.ref.taskId, task.execution.kind);
	}

	async activate(action: TaskDetailAction): Promise<void> {
		const listed = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
		if (!listed) return;
		const task = this.actions.currentTask ? this.actions.currentTask(listed.ref.taskId) : listed;
		if (!task) return;
		if (action === "transcript") return this.actions.transcript(task);
		// A subagent released while it waits is not finished: it wakes by itself, so `x` stops it rather than dismissing it.
		const finished = task.execution.kind === "settled" && waitingReleasedTools(task) === undefined;
		const armed = this.stopConfirm.pending();
		if (action === "cancel" && finished && armed !== undefined && armed !== task.ref.taskId) {
			this.stopConfirm.reset();
			return;
		}
		const paintedKind = this.paintedExecution.get(task.ref.taskId);
		if (action === "cancel" && finished && paintedKind !== "settled") {
			this.stopConfirm.reset();
			this.finishedWhileArmed = task;
			this.finishedAcknowledged = true;
			return;
		}
		if (finished) {
			if (action !== "cancel") return;
			// The second press meant for a stop arrives after the task finished on its own: it only acknowledges the
			// notice, so a row is never dismissed by a press aimed at a running task.
			if (this.finishedWhileArmed?.ref.taskId === task.ref.taskId && !this.finishedAcknowledged) {
				this.finishedAcknowledged = true;
				return;
			}
			this.finishedWhileArmed = undefined;
			this.actions.dismiss(task);
			return;
		}
		if (action === "question" && task.attention.kind === "input-needed")
			this.actions.openQuestion(task.attention.route);
		if (action === "cancel") {
			if (this.stopConfirm.press(task.ref.taskId)) this.actions.cancel(task);
			else this.actions.armStop(task);
		}
		if (action === "input" && this.actions.stdinAvailable(task)) {
			this.focus = { kind: "stdin", taskId: task.ref.taskId };
			this.actions.input(task);
		}
	}

	get selectedId(): string | undefined {
		return this.selectedTaskId;
	}
	get currentStableKey(): string | undefined {
		return this.selectedKey;
	}
	select(id: string): void {
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (entry !== undefined) {
			this.selectedTaskId = id as TaskId;
			this.selectedKey = entry.key;
		}
	}

	moveSelection(delta: number): void {
		const index = this.entries.findIndex((entry) => entry.id === this.selectedTaskId);
		const target = this.entries[Math.max(0, Math.min(this.entries.length - 1, index + delta))];
		this.selectedTaskId = target?.id as TaskId | undefined;
		this.selectedKey = target?.key;
	}

	handleInput(data: string, inputOwner: "composer" | "hil" | "tasks"): boolean {
		if (inputOwner !== "tasks" || this.focus.kind === "composer") return false;
		if (matchesKey(data, "escape")) {
			this.focus =
				this.focus.kind === "stdin" || this.focus.kind === "detail" ? { kind: "tasks" } : { kind: "composer" };
			return true;
		}
		if (this.focus.kind === "stdin") return false;
		if (this.keys.matches(data, "app.list.open") || this.keys.matches(data, "app.list.peek")) {
			const task = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
			if (task) {
				this.focus = { kind: "detail" };
				if (this.keys.matches(data, "app.list.open") || task.attention.kind === "input-needed")
					this.actions.openChat(task);
				else this.actions.inspect(task);
			}
			return true;
		}
		if (this.keys.matches(data, "app.list.stop")) {
			void this.activate("cancel");
			return true;
		}
		if (this.keys.matches(data, "app.tasks.input")) {
			void this.activate("input");
			return true;
		}
		const index = this.entries.findIndex((entry) => entry.id === this.selectedTaskId);
		let next = index;
		if (matchesKey(data, "up")) next--;
		else if (matchesKey(data, "down")) next++;
		else if (matchesKey(data, "home")) next = 0;
		else if (matchesKey(data, "end")) next = this.entries.length - 1;
		else if (matchesKey(data, "pageUp")) next -= 10;
		else if (matchesKey(data, "pageDown")) next += 10;
		else return false;
		const target = this.entries[Math.max(0, Math.min(this.entries.length - 1, next))];
		this.selectedTaskId = target?.id as TaskId | undefined;
		this.selectedKey = target?.key;
		return true;
	}
}
