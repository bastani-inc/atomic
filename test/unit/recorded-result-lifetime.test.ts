import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import type { TaskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import { taskCompletionMessage } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type { Sequence } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { recordStageWaitToolResults } from "../../packages/workflows/src/shared/stage-wait.js";
import { taskRecord } from "../helpers/task-record.js";

function exposedGc(): () => void {
	if (globalThis.gc) return globalThis.gc;
	setFlagsFromString("--expose-gc");
	try {
		return runInNewContext("gc") as () => void;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}

const gc = exposedGc();
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function retainedBytes(): Promise<number> {
	for (let i = 0; i < 4; i++) {
		await turn();
		gc();
	}
	const { heapUsed, external } = process.memoryUsage();
	return heapUsed + external;
}

function completedMessage(index: number) {
	const bytes = Buffer.alloc(2 * 1024 * 1024, 65 + index);
	bytes[450] = 10;
	const title = bytes.toString("latin1").slice(50, 950);
	const task = { ...taskRecord("child"), title, agentName: "worker" };
	return taskCompletionMessage(
		{
			completionId: "done",
			taskId: task.ref.taskId,
			ownerId: task.ref.ownerId,
			terminalSequence: "1" as Sequence,
			result: { kind: "completed", output: task.output },
			taskKind: "agent",
			display: false,
		},
		task,
		undefined,
	);
}

test("retaining completed notices does not pin the discarded title buffers (#5690)", async () => {
	const baseline = await retainedBytes();
	const saved = Array.from({ length: 16 }, (_, index) => completedMessage(index));
	const retained = (await retainedBytes()) - baseline;
	for (const [i, message] of saved.entries())
		assert.equal(
			(message.details.notification as TaskCompletionNotice).line?.subject,
			String.fromCharCode(65 + i).repeat(240),
		);
	assert.ok(retained < 12 * 1024 * 1024, `the short subjects retained ${retained} bytes`);
});

test("a fitting stage result releases earlier objects before a later conversion (#5691)", async () => {
	const refs: WeakRef<object>[] = [];
	const early = Array.from({ length: 32 }, (_, id) => {
		const entry = { id };
		refs.push(new WeakRef(entry));
		return entry;
	});
	const details = {
		early,
		report: Object.defineProperty({}, "toJSON", {
			value() {
				early.length = 0;
				for (let i = 0; i < 5; i++) gc();
				return { active: refs.filter((ref) => ref.deref() !== undefined).length };
			},
		}),
	};
	await turn(); // WeakRefs created in this turn keep their targets until the next one.
	const [answer] = recordStageWaitToolResults([
		{ toolCallId: "id", toolName: "watch", isError: false, result: { content: [], details } },
	]);
	assert.ok(answer && !answer.isError);
	const recorded = answer.details as { early: { id: number }[]; report: { active: number } };
	assert.deepEqual(
		recorded.early.map(({ id }) => id),
		Array.from({ length: 32 }, (_, id) => id),
	);
	// A runtime can keep its last loop temporary alive; it must not keep the serialized collection.
	assert.ok(recorded.report.active <= 1, `the conversion recorded ${recorded.report.active} active entries`);
});
