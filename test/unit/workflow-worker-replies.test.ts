import assert from "node:assert/strict";
import { test } from "vitest";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	isStaleWorkLeaseError,
	isWorkAttemptFencedError,
	StaleWorkLeaseError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { WorkerLostError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { releasableAdmission } from "../../packages/workflows/src/workers/local-worker.js";
import type { WorkerReply, WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import {
	type PendingWorkerRequest,
	receiveWorkerReply,
	type WorkerReplyState,
} from "../../packages/workflows/src/workers/worker-replies.js";

const attempt = { id: "work", generation: 4 };

function harness() {
	const settled: { id: number; value?: unknown; error?: Error }[] = [];
	const delivered: unknown[] = [];
	const pending = new Map<number, PendingWorkerRequest>();
	const add = (id: number, deliver?: PendingWorkerRequest["deliver"]) =>
		pending.set(id, {
			resolve: (value) => settled.push({ id, value }),
			reject: (error) => settled.push({ id, error }),
			...(deliver === undefined ? {} : { deliver }),
		});
	const state: WorkerReplyState = { attemptFenced: false, rootLeaseLost: false, retired: false };
	const sent: WorkerRequest[] = [];
	const receive = (reply: WorkerReply, held: typeof attempt | "no attempt" = attempt) =>
		receiveWorkerReply(reply, pending, state, held === "no attempt" ? undefined : held, (message) =>
			sent.push(message),
		);
	return { settled, delivered, pending, add, state, sent, receive };
}

test("a reply with a value settles its request and leaves the attempt as it was (#4327)", () => {
	const h = harness();
	h.add(1);
	assert.equal(h.receive({ id: 1, value: "ok" }), undefined);
	assert.deepEqual(h.settled, [{ id: 1, value: "ok" }]);
	assert.equal(h.pending.has(1), false);
	h.receive({ id: 9, value: "late" });
	assert.deepEqual(h.state, { attemptFenced: false, rootLeaseLost: false, retired: false });
	assert.deepEqual(h.sent, []);
});

test("a refused request is decided by its refusal's type: lost root, fenced attempt, or its own failure (#4327)", () => {
	const lost = harness();
	lost.add(1);
	lost.receive({ id: 1, error: serializeError(new StaleLeaseError("root", 1, 2)) });
	assert.deepEqual(lost.state, { attemptFenced: true, rootLeaseLost: true, retired: false });
	const fenced = lost.settled[0]?.error;
	assert.ok(isWorkAttemptFencedError(fenced), String(fenced));
	assert.deepEqual([fenced.workId, fenced.generation], ["work", 4]);

	const stale = harness();
	stale.add(2);
	stale.receive({
		id: 2,
		error: serializeError(new StaleWorkLeaseError({ root: "root", workId: "work", generation: 4, reason: "fenced" })),
	});
	assert.deepEqual(stale.state, { attemptFenced: true, rootLeaseLost: false, retired: false });
	assert.ok(isWorkAttemptFencedError(stale.settled[0]?.error));
	assert.ok(isStaleWorkLeaseError(stale.settled[0]?.error?.cause));

	const own = harness();
	own.add(3);
	own.receive({ id: 3, error: serializeError(new Error("the request's own failure")) });
	assert.deepEqual(own.state, { attemptFenced: false, rootLeaseLost: false, retired: false });
	assert.equal(own.settled[0]?.error?.message, "the request's own failure");
	assert.equal(own.pending.has(3), false);
});

test("a claim reply that retires the worker settles with its value and marks the worker retired, once set for good (#4374)", () => {
	const h = harness();
	h.add(1);
	h.add(2);

	h.receive({ id: 1, retire: true });
	h.receive({ id: 2, value: "ok" });

	assert.deepEqual(h.settled, [
		{ id: 1, value: undefined },
		{ id: 2, value: "ok" },
	]);
	assert.deepEqual(h.state, { attemptFenced: false, rootLeaseLost: false, retired: true });
});

test("a refusal outside an attempt still ends it, rejecting with the refusal itself (#4327)", () => {
	const h = harness();
	h.add(1);
	h.receive({ id: 1, error: serializeError(new WorkerLostError({ phase: "delivery" })) }, "no attempt");
	assert.deepEqual(h.state, { attemptFenced: true, rootLeaseLost: false, retired: false });
	assert.equal(h.settled[0]?.error?.name, "WorkerLostError");
	h.receive({ id: 8, error: serializeError(new StaleLeaseError("root", 1, 2)) });
	assert.equal(h.state.rootLeaseLost, true, "a refusal whose request is gone still counts");
});

test("a delivery runs on the request that asked for it and is acknowledged with its typed failure (#4327)", async () => {
	const h = harness();
	const message = { id: "m", content: "hi" };
	h.add(1, async (from, delivered) => {
		h.delivered.push([from, delivered]);
	});
	h.add(2, async () => {
		throw new StaleWorkLeaseError({ root: "root", workId: "work", generation: 4, reason: "superseded" });
	});
	const delivery = (id: number, deliveryId: string): WorkerReply =>
		({ id, delivery: { id: deliveryId, from: { id: "from" }, message } }) as never as WorkerReply;
	await h.receive(delivery(1, "d1"));
	await h.receive(delivery(2, "d2"));
	await h.receive(delivery(3, "d3"));
	assert.equal(h.delivered.length, 1);
	assert.equal(h.pending.has(1), true, "a delivery does not settle the request that receives it");
	assert.deepEqual(h.sent[0], { id: 0, kind: "delivery-ack", deliveryId: "d1" });
	const failed = h.sent[1] as Extract<WorkerRequest, { kind: "delivery-ack" }>;
	assert.equal(failed.kind, "delivery-ack");
	assert.equal(failed.deliveryId, "d2");
	assert.ok(isStaleWorkLeaseError(rehydrateError(failed.error)));
	const gone = h.sent[2] as Extract<WorkerRequest, { kind: "delivery-ack" }>;
	assert.equal(gone.deliveryId, "d3");
	assert.equal(gone.error?.message, "Worker delivery receiver is gone");
	assert.deepEqual(h.state, { attemptFenced: false, rootLeaseLost: false, retired: false });
});

test("an attempt's admission refuses what a late caller asks once the attempt let go of it (#4327)", async () => {
	const asked: string[] = [];
	const permit = Object.assign(async () => {}, {});
	const admission = releasableAdmission(
		{
			acquire: async (kind) => {
				asked.push(kind);
				return permit;
			},
		},
		{ id: "work", generation: 4 },
	);
	assert.equal(await admission.admission.acquire("session"), permit);
	admission.release();
	await assert.rejects(admission.admission.acquire("process"), (error: unknown) => {
		assert.ok(isWorkAttemptFencedError(error), String(error));
		assert.deepEqual([error.workId, error.generation], ["work", 4]);
		return true;
	});
	assert.deepEqual(asked, ["session"]);
});
