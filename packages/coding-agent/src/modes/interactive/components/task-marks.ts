/** A state's mark: one terminal cell, and a colour so the state reads with colour too. */
export interface TaskMark {
	readonly glyph: string;
	readonly color: "muted" | "dim" | "accent" | "success" | "error" | "warning";
}

/** The states a task is shown in, as the agent panel names them, and `shell` for a shell that is running. */
export type TaskMarkState =
	| "running"
	| "shell"
	| "input"
	| "paused"
	| "queued"
	| "stopping"
	| "waiting"
	| "done"
	| "failed"
	| "stopped";

/**
 * The one mark of each state of a subagent or background task, wherever it is shown: the agent panel, `/tasks`, a
 * chat's task rows, completion notices, launch cards, subagent results, and the `wait` and `kill` status lines. An
 * open circle while the work runs (grey, still), a filled one once it is done, and an open circle in the error colour
 * once it was stopped; a running shell shows an hourglass. `paused` is a subagent whose turn was paused with Esc (it
 * still runs, and a message continues it); a subagent paused or quit until it is resumed is stopped. `waiting` is a
 * subagent released while it waits on a call, which wakes by itself when that call finishes.
 */
export const TASK_MARKS: Readonly<Record<TaskMarkState, TaskMark>> = {
	running: { glyph: "◯", color: "muted" },
	shell: { glyph: "⧗", color: "accent" },
	input: { glyph: "◆", color: "warning" },
	paused: { glyph: "‖", color: "warning" },
	queued: { glyph: "○", color: "dim" },
	stopping: { glyph: "◼", color: "warning" },
	waiting: { glyph: "◌", color: "dim" },
	done: { glyph: "●", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "◯", color: "error" },
};

/** A task's mark in a state: the hourglass for a running shell, otherwise the state's mark. */
export function taskMark(state: Exclude<TaskMarkState, "shell">, shell = false): TaskMark {
	return state === "running" && shell ? TASK_MARKS.shell : TASK_MARKS[state];
}
