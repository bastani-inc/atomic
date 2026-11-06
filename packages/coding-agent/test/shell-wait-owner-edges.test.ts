import assert from "node:assert/strict";
import { test } from "vitest";
import { waitingUntilSettled } from "../src/core/agent-session-tasks.js";
import type { TaskId, WaitId, WaitOutcome } from "../src/core/tasks/contracts.js";
import type { SupervisedCommandOwner } from "../src/core/tools/bash-pty-native.js";

const task = "t-1" as TaskId;
const elapsed: WaitOutcome = { kind: "yielded", taskId: task, waitId: "w" as WaitId, reason: "elapsed" };

test("a shell wait whose observation failed returns that failure at once, however the session detaches (#4326)", async () => {
	const calls: number[] = [];
	const failure = { ok: false, error: { code: "unknown-task", message: "no such task" } };
	const owner = {
		supervisor: {},
		owner: {},
		waitForTask: async () => {
			calls.push(1);
			return failure;
		},
	} as unknown as SupervisedCommandOwner;
	assert.deepEqual(await waitingUntilSettled(owner, true).waitForTask?.(task), failure);
	assert.equal(calls.length, 1);
});

test("an owner without its own wait waits through the supervisor, for the owner's task and without a budget (#4326)", async () => {
	const seen: unknown[][] = [];
	const ownerToken = { id: "owner" };
	const registered = () => undefined;
	const owner = {
		supervisor: {
			waitForTaskId: async (...args: unknown[]) => {
				seen.push(args);
				return seen.length === 1
					? { ok: true, value: elapsed }
					: { ok: true, value: { kind: "settled", taskId: task } };
			},
		},
		owner: ownerToken,
	} as unknown as SupervisedCommandOwner;
	const observed = await waitingUntilSettled(owner, true).waitForTask?.(task, undefined, registered);
	assert.deepEqual(observed, { ok: true, value: { kind: "settled", taskId: task } });
	assert.equal(seen.length, 2, "an elapsed yield is waited through");
	for (const args of seen)
		assert.deepEqual(
			[args[0] === ownerToken, args[1], args[2], args[3] === registered],
			[true, task, undefined, true],
		);
});
