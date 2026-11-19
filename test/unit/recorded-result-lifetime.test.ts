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
	if (typeof Bun !== "undefined") return () => Bun.gc(true);
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

const clippedLengths = [241, 300, 900, 10_000];

function foldedSubject(title: string): string {
	return title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);
}

function completedMessage(title: string) {
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

function subjectOf(message: ReturnType<typeof completedMessage>): string | undefined {
	return (message.details.notification as TaskCompletionNotice).line?.subject;
}

async function retainedBy<T>(build: () => T[], inspect: (saved: T[]) => void): Promise<number> {
	const baseline = await retainedBytes();
	const saved = build();
	const bytes = (await retainedBytes()) - baseline;
	inspect(saved); // Keep the entire batch reachable through the measurement.
	return bytes;
}

test.each(clippedLengths)(
	"retaining subjects alongside a live %i-unit task title needs no extra backing (#5690)",
	async (length) => {
		const title = "x".repeat(length);
		const expected = foldedSubject(title);
		const measure = (write: (title: string) => string | undefined) =>
			retainedBy(
				() => Array.from({ length: 16_384 }, () => write(title)),
				(saved) => {
					for (const subject of saved) assert.equal(subject, expected);
				},
			);
		const reference = await measure(foldedSubject);
		const actual = await measure((text) => subjectOf(completedMessage(text)));
		assert.ok(actual < reference + 2 * 1024 * 1024, `subjects retained ${actual} bytes vs ${reference}`);
	},
);

test("retaining completed notices does not pin more discarded title buffers than their folded subjects (#5690)", async () => {
	function titleAt(i: number): string {
		const length = clippedLengths[i % clippedLengths.length]!;
		const bytes = Buffer.alloc(2 * 1024 * 1024, 65 + i);
		bytes[50 + Math.min(400, length - 1)] = 10; // Fold a control beyond the saved subject.
		return bytes.toString("latin1").slice(50, 50 + length);
	}
	const check = (i: number, subject: string | undefined) =>
		assert.equal(subject, String.fromCharCode(65 + i).repeat(240));
	const reference = await retainedBy(
		() => Array.from({ length: 16 }, (_, i) => foldedSubject(titleAt(i))),
		(saved) => {
			for (const [i, subject] of saved.entries()) check(i, subject);
		},
	);
	const actual = await retainedBy(
		() => Array.from({ length: 16 }, (_, i) => completedMessage(titleAt(i))),
		(saved) => {
			for (const [i, message] of saved.entries()) check(i, subjectOf(message));
		},
	);
	assert.ok(actual < reference + 12 * 1024 * 1024, `the notices retained ${actual} bytes vs ${reference}`);
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
