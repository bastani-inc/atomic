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
};

/** Shared focus state; activity updates never take ownership of editor input. */
export class TaskNavigation {
	focus: TaskFocus = { kind: "composer" };
	selectedTaskId?: TaskId;
	private tasks: TaskRecord[] = [];
	/** Every selectable row's id in display order: task ids and other sources' item ids, such as workflow runs. */
	private order: string[] = [];
	/** `x` stops a task only when pressed again on the same task within three seconds. */
	readonly stopConfirm: TwoPressConfirm;
	/**
	 * A task that finished while its stop waited for the second `x`: the wait ends, and this names it until the next
	 * key, so a second `x` never dismisses a row whose finished state the reader has not seen.
	 */
	finishedWhileArmed?: TaskRecord;
	/** The press after a {@link finishedWhileArmed} task finished was swallowed; the next one dismisses it. */
	finishedAcknowledged = false;

	private keys: KeybindingsManager;
	private actions: TaskNavigationActions;
	constructor(keys: KeybindingsManager, actions: TaskNavigationActions, now: () => number = Date.now) {
		this.keys = keys;
		this.actions = actions;
		this.stopConfirm = new TwoPressConfirm(now);
	}

	/**
	 * The tasks, and every row's id in the order the list shows them. Rows that are not tasks (another source's items)
	 * can be selected, but the task actions ignore them; their owner handles their keys.
	 */
	update(
		tasks: readonly TaskRecord[],
		order: readonly string[] = [
			...tasks.filter((task) => task.kind === "agent"),
			...tasks.filter((task) => task.kind === "command"),
		].map((task) => task.ref.taskId),
	): void {
		this.tasks = [...tasks];
		this.order = [...order];
		if (!this.order.includes(this.selectedTaskId ?? "")) this.selectedTaskId = this.order[0] as TaskId | undefined;
		const armed = this.stopConfirm.pending();
		const settled = this.tasks.find((task) => task.ref.taskId === armed && task.execution.kind === "settled");
		if (settled !== undefined) {
			this.stopConfirm.reset();
			this.finishedWhileArmed = settled;
			this.finishedAcknowledged = false;
		}
	}

	open(taskId?: TaskId): void {
		if (taskId !== undefined && this.order.includes(taskId)) this.selectedTaskId = taskId;
		this.focus = { kind: "tasks" };
	}

	async activate(action: TaskDetailAction): Promise<void> {
		const task = this.tasks.find((task) => task.ref.taskId === this.selectedTaskId);
		if (!task) return;
		if (action === "transcript") return this.actions.transcript(task);
		if (task.execution.kind === "settled") {
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

	/** The selected row's id, which is a task id only when the row is a task. */
	get selectedId(): string | undefined {
		return this.selectedTaskId;
	}
	select(id: string): void {
		if (this.order.includes(id)) this.selectedTaskId = id as TaskId;
	}

	moveSelection(delta: number): void {
		const index = this.order.indexOf(this.selectedTaskId ?? "");
		this.selectedTaskId = this.order[Math.max(0, Math.min(this.order.length - 1, index + delta))] as
			| TaskId
			| undefined;
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
				if (this.keys.matches(data, "app.list.open")) this.actions.openChat(task);
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
		const index = this.order.indexOf(this.selectedTaskId ?? "");
		let next = index;
		if (matchesKey(data, "up")) next--;
		else if (matchesKey(data, "down")) next++;
		else if (matchesKey(data, "home")) next = 0;
		else if (matchesKey(data, "end")) next = this.order.length - 1;
		else if (matchesKey(data, "pageUp")) next -= 10;
		else if (matchesKey(data, "pageDown")) next += 10;
		else return false;
		this.selectedTaskId = this.order[Math.max(0, Math.min(this.order.length - 1, next))] as TaskId | undefined;
		return true;
	}
}
