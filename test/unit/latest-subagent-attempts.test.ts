import assert from "node:assert/strict";
import { test } from "vitest";
import {
	latestSubagentAttempt,
	latestSubagentAttempts,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";

/** A deterministic pseudo-random source, so a failure names its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

/** Only the fields the attempt lookups read: id and owner, kind, launch operation and launch order. */
function record(fields: {
	id: string;
	owner: string;
	kind: "agent" | "command";
	operation?: string;
	ordinal: number;
}): TaskRecord {
	return {
		ref: { taskId: fields.id as TaskId, ownerId: fields.owner },
		kind: fields.kind,
		...(fields.operation === undefined ? {} : { launchOperationId: fields.operation }),
		launchOrdinal: fields.ordinal,
	} as Partial<TaskRecord> as TaskRecord;
}

function taskList(next: () => number): TaskRecord[] {
	const pick = (n: number) => Math.floor(next() * n);
	const tasks: TaskRecord[] = [];
	const count = 1 + pick(14);
	for (let i = 0; i < count; i++) {
		const subagent = pick(4);
		const resumed = pick(3);
		tasks.push(
			record({
				// Repeated ids happen: the first record of an id is the one looked up.
				id: `t${pick(count + 2)}`,
				owner: `o${pick(2)}`,
				kind: pick(5) === 0 ? "command" : "agent",
				...(pick(6) === 0
					? {}
					: { operation: resumed === 0 ? `op${subagent}` : `op${subagent}:resume:${resumed}` }),
				ordinal: pick(4),
			}),
		);
	}
	return tasks;
}

test("one grouping pass answers every attempt lookup exactly as a lookup over the whole list does", () => {
	for (let seed = 1; seed <= 2_000; seed++) {
		const tasks = taskList(random(seed));
		const latestOf = latestSubagentAttempts(tasks);
		const ids = new Set<TaskId>([...tasks.map((task) => task.ref.taskId), "missing" as TaskId]);
		for (const id of ids) assert.equal(latestOf(id), latestSubagentAttempt(tasks, id), `seed ${seed}, ${id}`);
	}
});
