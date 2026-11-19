/**
 * The kinds of task an owner runs, and how each is named. Every place that treats tasks differently by kind decides
 * here or with an exhaustive `switch` (ending in {@link unreachableTaskKind}), so a new kind is a compile error at every
 * such place rather than falling through to another kind's handling: a `tool` task has no process (no pid, stdin or
 * terminal) and no session (no transcript, model or resume).
 */

import type { TaskKind, TaskRecord } from "./contracts.js";

/** The compile-time end of an exhaustive `switch` over task kinds. */
export function unreachableTaskKind(kind: never): never {
	throw new Error(`Unknown task kind: ${String(kind)}`);
}

/** The tool a `tool` task runs, as its notices and rows name it: `search`. */
export function toolTaskNoun(task: Pick<TaskRecord, "toolName">): string {
	return task.toolName?.trim() || "tool";
}

/**
 * What a task is called in one word: `subagent`, `shell`, or the tool a tool task runs (`search`). Plural with
 * `count` other than one: `2 shells`, `3 searches`.
 */
export function taskKindNoun(task: { readonly kind: TaskKind; readonly toolName?: string }, count = 1): string {
	switch (task.kind) {
		case "agent":
			return count === 1 ? "subagent" : "subagents";
		case "command":
			return count === 1 ? "shell" : "shells";
		case "tool": {
			const noun = toolTaskNoun(task);
			return count === 1 ? noun : pluralNoun(noun);
		}
		default:
			return unreachableTaskKind(task.kind);
	}
}

/** `search` -> `searches`, `fetch` -> `fetches`, `tool` -> `tools`. */
export function pluralNoun(noun: string): string {
	return /(?:s|sh|ch|x|z)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

/**
 * Whether a task runs outside any agent session, observed like a shell command: a command, or a tool call's in-process
 * work. Such a task has output to read, a completion excerpt, and settles without a transcript.
 */
export function isShellLikeTask(kind: TaskKind | undefined): kind is "command" | "tool" {
	switch (kind) {
		case "command":
		case "tool":
			return true;
		case "agent":
		case undefined:
			return false;
		default:
			return unreachableTaskKind(kind);
	}
}
