/**
 * The worker-side attempt binding of the shared pool (#4822): each request a worker makes for its attempt carries
 * that attempt, is sent again only while it is still that attempt's to make, and ends the attempt on a refusal only
 * while the worker still holds it. The pool's own checks (`superseded`, stale-heartbeat refusal) are not involved.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/errors.js";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import {
	isWorkAttemptFencedError,
	StaleWorkLeaseError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import {
	AttemptRequests,
	type WorkerRequestBody,
	type WorkerRequestSender,
	workerRequestSender,
} from "../../packages/workflows/src/workers/attempt-requests.js";
import type { WorkerReply, WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import type { PendingWorkerRequest, WorkerReplyState } from "../../packages/workflows/src/workers/worker-replies.js";

const work = (generation: number): PoolWork => ({ id: "work", generation }) as PoolWork;

function outage(): StorageTransientError {
	return new StorageTransientError(
		{ adapter: "libsql", location: "http://db" },
		{ code: "connection-lost", outcome: "not-applied", attempts: 1 },
		new Error("fetch failed"),
	);
}

interface Sent {
	readonly kind: string;
	readonly outageTolerant: boolean | undefined;
	readonly attempt: { readonly workId: string; readonly generation: number } | undefined;
}

/** An {@link AttemptRequests} whose sender answers each send with the next of `answers`, run on what was sent. */
function harness(
	answers: ((sent: Sent, requests: AttemptRequests) => Promise<WorkerReply["value"]>)[],
	options: { leaseLeft?: () => boolean; outageHandoffMs?: number } = {},
) {
	const sent: Sent[] = [];
	const replies: WorkerReplyState = { attemptFenced: false, rootLeaseLost: false, retired: false };
	let requests: AttemptRequests;
	const request: WorkerRequestSender = (message, _deliver, outageTolerant, attempt) => {
		const record = { kind: message.kind, outageTolerant, attempt };
		sent.push(record);
		const answer = answers.shift();
		if (answer === undefined) return Promise.reject(new Error("no answer scripted"));
		return answer(record, requests);
	};
	requests = new AttemptRequests({
		request,
		replies,
		leaseLeft: options.leaseLeft ?? (() => true),
		outageHandoffMs: options.outageHandoffMs ?? Number.POSITIVE_INFINITY,
	});
	return { sent, replies, requests };
}

const heartbeat: WorkerRequestBody = { kind: "heartbeat", reports: [] };
const commit: WorkerRequestBody = {
	kind: "commit",
	operation: "op",
	mutation: { kind: "session-append" } as never,
};

test("every send of an attempt's request, its resend included, carries that attempt and tolerates an outage (#4822)", async () => {
	const h = harness([() => Promise.reject(outage()), async () => "ok"]);
	h.requests.hold(work(4));
	assert.equal(await h.requests.send(heartbeat), "ok");
	const expected = { kind: "heartbeat", outageTolerant: true, attempt: { workId: "work", generation: 4 } };
	assert.deepEqual(h.sent, [expected, expected]);
	assert.equal(h.replies.attemptFenced, false);
});

test("a refused request is not sent again once the worker holds another attempt, nor does it fence that one (#4822)", async () => {
	const refusal = outage();
	const h = harness([
		(_sent, requests) => {
			requests.hold(work(5));
			return Promise.reject(refusal);
		},
	]);
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => error === refusal);
	assert.equal(h.sent.length, 1, "the displaced attempt's resend never goes out");
	assert.equal(h.replies.attemptFenced, false);
	assert.deepEqual(
		h.requests.end({ kind: "fenced" }),
		{ kind: "fenced" },
		"nothing of it reaches the attempt held now",
	);
});

test("a request made with no attempt to own it is refused as fenced and never sent (#4822)", async () => {
	const h = harness([]);
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => {
		assert.ok(isWorkAttemptFencedError(error), String(error));
		assert.deepEqual([error.workId, error.generation], ["", 0]);
		return true;
	});
	assert.deepEqual(h.sent, []);
	assert.equal(h.replies.attemptFenced, false);
});

test.each([commit, { kind: "session-sync", sessionId: "stage-session" } satisfies WorkerRequestBody])(
	"$kind belongs to the attempt that may still write, other requests to the attempt held (#4822, #5344)",
	async (message) => {
		const h = harness([async () => "acknowledged"]);
		h.requests.hold(work(4));
		h.requests.held = undefined;
		assert.equal(await h.requests.send(message), "acknowledged");
		assert.deepEqual(h.sent[0]?.attempt, { workId: "work", generation: 4 });
		await assert.rejects(h.requests.send(heartbeat), (error: unknown) => isWorkAttemptFencedError(error));

		const cut = harness([]);
		cut.requests.hold(work(4));
		cut.requests.writable = undefined;
		await assert.rejects(cut.requests.send(message), (error: unknown) => isWorkAttemptFencedError(error));
		assert.deepEqual(cut.sent, [], "an attempt whose writes were cut off sends no write or read barrier");
	},
);

test("a commit refused once its attempt can no longer write is not sent again (#4822)", async () => {
	const refusal = outage();
	const h = harness([
		(_sent, requests) => {
			requests.writable = undefined;
			return Promise.reject(refusal);
		},
	]);
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(commit), (error: unknown) => isWorkAttemptFencedError(error));
	assert.equal(h.sent.length, 1);
});

test("a refusal that is not the store's goes to the caller without fencing the attempt (#4822)", async () => {
	const own = new Error("the request's own failure");
	const stale = new StaleWorkLeaseError({ root: "root", workId: "work", generation: 4, reason: "fenced" });
	const h = harness([() => Promise.reject(own), () => Promise.reject(stale)]);
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => error === own);
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => error === stale);
	assert.equal(h.sent.length, 2, "neither is sent again");
	assert.equal(h.replies.attemptFenced, false);
	assert.deepEqual(h.requests.end({ kind: "fenced" }), { kind: "fenced" });
});

test("a store refusal past the lease fences the held attempt and is forwarded as its fault, not a handoff (#4822)", async () => {
	const refusal = outage();
	const h = harness([() => Promise.reject(refusal)], { leaseLeft: () => false });
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => {
		assert.ok(isWorkAttemptFencedError(error), String(error));
		assert.deepEqual([error.workId, error.generation], ["work", 4]);
		assert.equal(error.cause, refusal);
		return true;
	});
	assert.equal(h.sent.length, 1);
	assert.equal(h.replies.attemptFenced, true);
	const ended = h.requests.end({ kind: "fenced" });
	assert.equal(ended.fault?.name, "StorageTransientError");
	assert.equal(ended.handoff, undefined);
});

test("a store that keeps refusing within the lease hands the child on with the refusal it ended on (#4822)", async () => {
	const h = harness([() => Promise.reject(outage())], { outageHandoffMs: 0 });
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => isWorkAttemptFencedError(error));
	assert.equal(h.replies.attemptFenced, true);
	const ended = h.requests.end({ kind: "fenced" });
	assert.equal(ended.handoff, true);
	assert.equal(ended.fault?.name, "StorageTransientError");
	// A fault the attempt ended on itself is the one the pool names.
	const own = { name: "OwnFault", message: "own" } as never;
	assert.deepEqual(h.requests.end({ kind: "fenced", fault: own }), { kind: "fenced", fault: own, handoff: true });
	h.requests.reset();
	assert.deepEqual(h.requests.end({ kind: "fenced" }), { kind: "fenced" }, "the next attempt starts with neither");
});

test("a store refusal that may not pass ends the attempt as counted even within the lease (#4822)", async () => {
	const h = harness([() => Promise.reject(new WorkflowInfrastructureError("storage_unavailable"))]);
	h.requests.hold(work(4));
	await assert.rejects(h.requests.send(heartbeat), (error: unknown) => isWorkAttemptFencedError(error));
	assert.equal(h.sent.length, 1, "it is not sent again");
	assert.equal(h.replies.attemptFenced, true);
	const ended = h.requests.end({ kind: "fenced" });
	assert.equal(ended.handoff, undefined);
	assert.equal(ended.fault?.name, "WorkflowInfrastructureError");
});

test("a worker's requests are numbered, tolerate an outage only when asked, and carry their attempt (#4822)", async () => {
	const pending = new Map<number, PendingWorkerRequest>();
	const wire: WorkerRequest[] = [];
	let failSend: Error | null = null;
	const request = workerRequestSender(pending, (message, sent) => {
		wire.push(message);
		sent(failSend);
	});
	const deliver = async () => {};
	void request({ kind: "ready" });
	void request(heartbeat, deliver, true, { workId: "work", generation: 4 });
	assert.deepEqual(
		wire.map((message) => [message.id, message.kind]),
		[
			[1, "ready"],
			[2, "heartbeat"],
		],
	);
	assert.equal("outageTolerant" in pending.get(1)!, false, "a request is not outage-tolerant by default");
	assert.equal("attempt" in pending.get(1)!, false);
	assert.equal(pending.get(2)?.outageTolerant, true);
	assert.equal(pending.get(2)?.deliver, deliver);
	assert.deepEqual(pending.get(2)?.attempt, { workId: "work", generation: 4 });
	pending.get(1)?.resolve("answered");
	failSend = new Error("channel closed");
	await assert.rejects(request({ kind: "control" }), (error: unknown) => error === failSend);
});
