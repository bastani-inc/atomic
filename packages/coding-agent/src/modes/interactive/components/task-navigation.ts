import { matchesKey } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute, TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import type { TaskDetailAction } from "./task-detail.js";

export type TaskFocus =
	| { kind: "composer" }
	| { kind: "tasks" }
	| { kind: "detail" }
	| { kind: "stdin"; taskId: TaskId };
export type TaskNavigationActions = {
	inspect(task: TaskRecord): void;
	transcript(task: TaskRecord): void;
	confirmCancel(task: TaskRecord): Promise<boolean>;
	cancel(task: TaskRecord): void;
	input(task: TaskRecord): void;
	stdinAvailable(task: TaskRecord): boolean;
	openQuestion(route: PromptRoute): void;
};

/** Shared focus state; activity updates never take ownership of editor input. */
export class TaskNavigation {
	focus: TaskFocus = { kind: "composer" };
	selectedTaskId?: TaskId;
	private tasks: TaskRecord[] = [];

	private keys: KeybindingsManager;
	private actions: TaskNavigationActions;
	constructor(keys: KeybindingsManager, actions: TaskNavigationActions) {
		this.keys = keys;
		this.actions = actions;
	}

	update(tasks: readonly TaskRecord[]): void {
		this.tasks = [
			...tasks.filter((task) => task.kind === "agent"),
			...tasks.filter((task) => task.kind === "command"),
		];
		if (!this.tasks.some((task) => task.ref.taskId === this.selectedTaskId))
			this.selectedTaskId = this.tasks[0]?.ref.taskId;
	}

	open(taskId?: TaskId): void {
		if (taskId !== undefined && this.tasks.some((task) => task.ref.taskId === taskId)) this.selectedTaskId = taskId;
		this.focus = { kind: "tasks" };
	}

	async activate(action: TaskDetailAction): Promise<void> {
		const task = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
		if (!task) return;
		if (action === "transcript") return this.actions.transcript(task);
		if (task.execution.kind === "settled") return;
		if (action === "question" && task.attention.kind === "input-needed")
			this.actions.openQuestion(task.attention.route);
		if (action === "cancel" && (await this.actions.confirmCancel(task))) {
			const current = this.tasks.find((candidate) => candidate.ref.taskId === task.ref.taskId);
			if (current && current.execution.kind !== "settled") this.actions.cancel(current);
		}
		if (action === "input" && this.actions.stdinAvailable(task)) {
			this.focus = { kind: "stdin", taskId: task.ref.taskId };
			this.actions.input(task);
		}
	}

	moveSelection(delta: number): void {
		const index = this.tasks.findIndex((task) => task.ref.taskId === this.selectedTaskId);
		this.selectedTaskId = this.tasks[Math.max(0, Math.min(this.tasks.length - 1, index + delta))]?.ref.taskId;
	}

	handleInput(data: string, inputOwner: "composer" | "hil" | "tasks"): boolean {
		if (inputOwner !== "tasks" || this.focus.kind === "composer") return false;
		if (matchesKey(data, "escape")) {
			this.focus =
				this.focus.kind === "stdin" || this.focus.kind === "detail" ? { kind: "tasks" } : { kind: "composer" };
			return true;
		}
		if (this.focus.kind === "stdin") return false;
		if (this.keys.matches(data, "app.tasks.inspect")) {
			const task = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
			if (task) {
				this.focus = { kind: "detail" };
				this.actions.inspect(task);
			}
			return true;
		}
		for (const action of ["cancel", "input"] as const) {
			if (this.keys.matches(data, `app.tasks.${action}`)) {
				void this.activate(action);
				return true;
			}
		}
		const index = this.tasks.findIndex((task) => task.ref.taskId === this.selectedTaskId);
		let next = index;
		if (matchesKey(data, "up")) next--;
		else if (matchesKey(data, "down")) next++;
		else if (matchesKey(data, "home")) next = 0;
		else if (matchesKey(data, "end")) next = this.tasks.length - 1;
		else if (matchesKey(data, "pageUp")) next -= 10;
		else if (matchesKey(data, "pageDown")) next += 10;
		else return false;
		this.selectedTaskId = this.tasks[Math.max(0, Math.min(this.tasks.length - 1, next))]?.ref.taskId;
		return true;
	}
}
