import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { type TaskCompletionEnvelope, TaskCompletionOutbox } from "../src/core/tasks/completion.js";
import type {
	Generation,
	OwnerId,
	Sequence,
	SettlementReceipt,
	TaskId,
	TaskResult,
} from "../src/core/tasks/contracts.js";

const result: TaskResult = { kind: "failed", code: "fixture", message: "done" };

function envelope(completionId: string, taskId: string): TaskCompletionEnvelope {
	return {
		completionId,
		ownerId: "owner-1-0" as OwnerId,
		taskId: taskId as TaskId,
		terminalSequence: "1" as Sequence,
		result,
		display: false,
	};
}

function receipt(completionId: string, taskId: string): SettlementReceipt {
	return {
		taskId: taskId as TaskId,
		cursor: { generation: "1" as Generation, sequence: "2" as Sequence },
		result,
		completionId,
	};
}

interface Probe {
	readonly outbox: TaskCompletionOutbox;
	readonly delivered: string[];
	readonly restoredDelivered: string[];
	readonly admission: { admitting: boolean; failing: boolean };
}

async function probe(history: readonly TaskCompletionEnvelope[] = []): Promise<Probe> {
	const session = await SessionManager.create(new MemorySessionStore(), process.cwd());
	for (const intent of history) await session.appendCustomEntry("task-completion-intent", intent);
	const admission = { admitting: true, failing: false };
	const delivered: string[] = [];
	const restoredDelivered: string[] = [];
	const outbox = new TaskCompletionOutbox(
		session,
		() => true,
		async () => {
			if (admission.failing) throw new Error("not admitted yet");
		},
		(delivery) => delivered.push(delivery.completionId),
		() => admission.admitting,
		(delivery) => restoredDelivered.push(delivery.completionId),
	);
	return { outbox, delivered, restoredDelivered, admission };
}

describe("restored completion notices report their delivery (#4309)", () => {
	test("a notice restored from session history reports to restoredDelivered once, never to delivered", async () => {
		const probed = await probe([envelope("from-history", "task-1-0-0")]);

		assert.equal(await probed.outbox.flushRestored(), 1);
		assert.equal(await probed.outbox.flushRestored(), 0);

		assert.deepEqual(probed.restoredDelivered, ["from-history"]);
		assert.deepEqual(probed.delivered, []);
	});

	test("a notice recorded as restored, as a parked stage's is, reports to restoredDelivered", async () => {
		const probed = await probe();

		probed.outbox.record("owner-1-0" as OwnerId, receipt("parked", "task-1-0-1"), "agent", true);
		await probed.outbox.flush();
		assert.deepEqual(probed.restoredDelivered, []);
		assert.equal(await probed.outbox.flushRestored(), 1);

		assert.deepEqual(probed.restoredDelivered, ["parked"]);
		assert.deepEqual(probed.delivered, []);
	});

	test("a live notice reports to delivered only", async () => {
		const probed = await probe();

		probed.outbox.record("owner-1-0" as OwnerId, receipt("live", "task-1-0-2"));
		await probed.outbox.flush();

		assert.deepEqual(probed.delivered, ["live"]);
		assert.deepEqual(probed.restoredDelivered, []);
	});

	test("a restored notice deferred while admission waits reports once it is admitted", async () => {
		const probed = await probe([envelope("deferred", "task-1-0-3")]);
		probed.admission.admitting = false;

		assert.equal(await probed.outbox.flushRestored(), 0);
		assert.deepEqual(probed.restoredDelivered, []);

		probed.admission.admitting = true;
		assert.equal(await probed.outbox.flushRestored(), 1);
		assert.deepEqual(probed.restoredDelivered, ["deferred"]);
		assert.deepEqual(probed.delivered, []);
	});

	test("a restored notice whose admission failed reports only when a later flush delivers it", async () => {
		const probed = await probe([envelope("refused", "task-1-0-4")]);
		probed.admission.failing = true;

		assert.equal(await probed.outbox.flushRestored(), 0);
		assert.deepEqual(probed.restoredDelivered, []);

		probed.admission.failing = false;
		assert.equal(await probed.outbox.flushRestored(), 1);
		assert.deepEqual(probed.restoredDelivered, ["refused"]);
	});
});
