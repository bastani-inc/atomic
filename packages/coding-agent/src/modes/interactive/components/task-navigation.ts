import { matchesKey } from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute, TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { TwoPressConfirm } from "./nav-keys.ts";
import type { TaskDetailAction } from "./task-detail.js";

export type TaskFocus =
	| { kind: "composer" }
	| { kind: "tasks" }
	| { kind: "detail" }
	| { kind: "stdin"; taskId: TaskId };
export type TaskNavigationActions = {
	inspect(task: TaskRecord): void;
	transcript(task: TaskRecord): void;
	/** The first `x` on a running task: it asks for the second press that stops it. */
	armStop(task: TaskRecord): void;
	cancel(task: TaskRecord): void;
	/** `x` on a finished task: it leaves the list. */
	dismiss(task: TaskRecord): void;
	input(task: TaskRecord): void;
	stdinAvailable(task: TaskRecord): boolean;
	openQuestion(route: PromptRoute): void;
};

/** Shared focus state; activity updates never take ownership of editor input. */
export class TaskNavigation {
	focus: TaskFocus = { kind: "composer" };
	selectedTaskId?: TaskId;
	private tasks: TaskRecord[] = [];
	/** `x` stops a task only when pressed again on the same task within three seconds. */
	readonly stopConfirm: TwoPressConfirm;

	private keys: KeybindingsManager;
	private actions: TaskNavigationActions;
	constructor(keys: KeybindingsManager, actions: TaskNavigationActions, now: () => number = Date.now) {
		this.keys = keys;
		this.actions = actions;
		this.stopConfirm = new TwoPressConfirm(now);
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
		if (task.execution.kind === "settled") {
			if (action === "cancel") this.actions.dismiss(task);
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
		if (this.keys.matches(data, "app.list.open")) {
			const task = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
			if (task) {
				this.focus = { kind: "detail" };
				this.actions.inspect(task);
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
