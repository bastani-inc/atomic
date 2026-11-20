import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { isTaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type {
	QueuedTaskMessages,
	TaskMessageDelivery,
	TaskMessageLane,
	TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { bindTaskResumer, type TaskResumer } from "../../packages/coding-agent/src/core/tasks/task-resumer.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { taskFixture } from "../helpers/task-projection.js";

function transcript(
	methods: Partial<Pick<TaskTranscriptSource, "queueMessage" | "clearQueue">> = {},
): TaskTranscriptSource {
	const session = SessionManager.inMemory();
	return { getSessionId: () => session.getSessionId(), getEntries: () => session.getEntries(), ...methods };
}

/** A running agent task bound to `bound`, viewed through its owner's task view. */
async function runningTask(bound?: TaskTranscriptSource) {
	const fixture = taskFixture();
	await fixture.start("Chat target");
	if (bound) fixture.runners[0]!.context.bindTranscript(bound);
	const taskId = fixture.store.tasks[0]!.ref.taskId;
	return { fixture, taskId, source: ownerTaskViewSource(fixture.store) };
}

function resumer(resumed: Array<[TaskId, string]>): TaskResumer {
	return {
		readOnlyReason: () => undefined,
		async resume(taskId, message) {
			resumed.push([taskId, message]);
			return { ok: true };
		},
	};
}

test("a subagent's chat takes its queued messages back from the subagent's own session", async () => {
	const taken: QueuedTaskMessages = { steering: ["first", "second"], followUp: ["later"] };
	let cleared = 0;
	const { fixture, taskId, source } = await runningTask(
		transcript({
			clearQueue: async () => {
				cleared++;
				return taken;
			},
		}),
	);
	try {
		assert.deepEqual(await source.clearTaskQueue!(taskId), { ok: true, value: taken });
		assert.equal(cleared, 1);
		const unknown = await source.clearTaskQueue!("missing" as TaskId);
		assert.equal(unknown.ok, false);
	} finally {
		await fixture.dispose();
	}
});

test("a task whose session keeps no queue has nothing to give back", async () => {
	const { fixture, taskId, source } = await runningTask(transcript());
	try {
		assert.deepEqual(await source.clearTaskQueue!(taskId), { ok: true, value: { steering: [], followUp: [] } });
	} finally {
		await fixture.dispose();
	}
});

test("a message a subagent refused as its run ended resumes it once it has finished, with the message as typed", async () => {
	const resumed: Array<[TaskId, string]> = [];
	const offered: Array<[string, TaskMessageLane]> = [];
	let settle = () => {};
	const { fixture, taskId, source } = await runningTask(
		transcript({
			queueMessage: async (text, lane): Promise<TaskMessageDelivery> => {
				offered.push([text, lane]);
				// The subagent's execution ended as the message arrived: its task settles right after.
				setTimeout(settle, 10);
				return { delivered: false, reason: "ended", detail: "Session is closed" };
			},
		}),
	);
	settle = () => void fixture.settle(0);
	const unbind = bindTaskResumer(fixture.supervisor, resumer(resumed));
	try {
		await source.sendTaskMessage!(taskId, "  one more thing  ", "followUp");
		assert.deepEqual(offered, [["  one more thing  ", "followUp"]]);
		assert.deepEqual(resumed, [[taskId, "  one more thing  "]], "the finished subagent continues with the message");
	} finally {
		unbind();
		await fixture.dispose();
	}
});

test("a message a subagent refused as its run ended goes back to the chat when the subagent cannot be resumed", async () => {
	const { fixture, taskId, source } = await runningTask(
		transcript({
			queueMessage: async () => {
				setTimeout(() => void fixture.settle(0), 10);
				return { delivered: false, reason: "ended", detail: "Session is closed" };
			},
		}),
	);
	try {
		const error = await source.sendTaskMessage!(taskId, "one more thing").then(
			() => undefined,
			(failure: unknown) => failure,
		);
		assert.ok(isTaskMessageError(error));
		assert.equal(error.code, "delivery-refused");
		assert.equal(error.retryable, true, "the chat keeps the text for the reader to send again");
	} finally {
		await fixture.dispose();
	}
});

test.each([
	["started its next turn", true, "running", false],
	["waited in its queue", false, "stopped", true],
] as const)("a message that %s leaves an interrupted subagent %s", async (_what, startedTurn, _shown, stillStopped) => {
	const { fixture, taskId, source } = await runningTask(
		transcript({ queueMessage: async () => ({ delivered: true, startedTurn }) }),
	);
	try {
		// Esc interrupted or paused its turn; a message that only joins its held queue does not end that.
		fixture.store.setTurnInterrupted(taskId, true);
		assert.equal(source.taskStopped!(taskId), true);
		await source.sendTaskMessage!(taskId, "carry on");
		assert.equal(source.taskStopped!(taskId), stillStopped);
	} finally {
		await fixture.dispose();
	}
});
