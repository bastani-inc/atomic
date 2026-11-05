import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import {
	type AnsweredWorkerRequest,
	type AttemptHolder,
	AttemptLeaseExtensions,
	WORKER_REQUEST_LANES,
	type WorkerRequestLane,
	WorkerRequestLanes,
} from "../../packages/workflows/src/workers/worker-request-lanes.js";

/** Lets every queued promise reaction run. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Schedules held requests on one worker's lanes and records when each starts and settles. */
function heldLanes() {
	const lanes = new WorkerRequestLanes();
	const started: string[] = [];
	const settled: string[] = [];
	const holds = new Map<string, PromiseWithResolvers<string>>();
	const send = (label: string, lane: WorkerRequestLane) => {
		const hold = Promise.withResolvers<string>();
		holds.set(label, hold);
		const reply = lanes.run(lane, () => {
			started.push(label);
			return hold.promise;
		});
		void reply.then(
			() => settled.push(label),
			() => settled.push(label),
		);
		return reply;
	};
	const finish = async (label: string, outcome: "answered" | "refused" = "answered") => {
		const hold = holds.get(label)!;
		if (outcome === "answered") hold.resolve(label);
		else hold.reject(new Error(`${label} refused`));
		await drain();
	};
	return { lanes, started, settled, send, finish };
}

test("a worker's admission check and its heartbeat run while its commit is in flight, one heartbeat at a time (#4315)", async () => {
	const { started, settled, send, finish } = heldLanes();
	void send("commit", "commits");
	void send("renew", "heartbeats");
	void send("control", "heartbeats");
	void send("usage", "heartbeats");
	void send("budget", "free");
	void send("activity", "free");
	await drain();
	assert.deepEqual(started, ["commit", "renew", "budget", "activity"]);
	await finish("activity");
	await finish("budget");
	assert.deepEqual(settled, ["activity", "budget"], "free requests are answered as they finish");
	await finish("renew");
	assert.deepEqual(started, ["commit", "renew", "budget", "activity", "control"]);
	await finish("control");
	assert.deepEqual(started, ["commit", "renew", "budget", "activity", "control", "usage"]);
	assert.ok(!settled.includes("commit"), "none of them waited for the commit");
});

test("a worker's commits run one at a time in the order it sent them, a refused one included (#4315)", async () => {
	const { started, send, finish } = heldLanes();
	const first = send("first", "commits");
	const firstRefused = assert.rejects(first, Error);
	void send("second", "commits");
	void send("third", "commits");
	await drain();
	assert.deepEqual(started, ["first"]);
	await finish("first", "refused");
	await firstRefused;
	assert.deepEqual(started, ["first", "second"], "a refused commit still lets the next one start");
	await finish("second");
	assert.deepEqual(started, ["first", "second", "third"]);
});

test("a request that takes or ends an attempt waits for every earlier request and holds back every later one (#4315)", async () => {
	const { started, send, finish } = heldLanes();
	void send("commit", "commits");
	void send("budget", "free");
	void send("complete", "barrier");
	void send("claim", "barrier");
	void send("renew", "heartbeats");
	void send("next commit", "commits");
	await drain();
	assert.deepEqual(started, ["commit", "budget"]);
	await finish("budget");
	assert.deepEqual(started, ["commit", "budget"], "the barrier also waits for the commit in flight");
	await finish("commit");
	assert.deepEqual(started, ["commit", "budget", "complete"]);
	await finish("complete");
	assert.deepEqual(started, ["commit", "budget", "complete", "claim"], "barriers run one at a time");
	await finish("claim");
	assert.deepEqual(started, ["commit", "budget", "complete", "claim", "renew", "next commit"]);
});

test("a worker's exit cleanup waits for every request it sent except its deliveries (#4315)", async () => {
	const { lanes, send, finish } = heldLanes();
	void send("commit", "commits");
	void send("usage", "heartbeats");
	void send("delivery", "detached");
	let cleaned = false;
	void lanes.settled().then(() => {
		cleaned = true;
	});
	await finish("commit");
	assert.equal(cleaned, false, "the usage report is still in flight");
	await finish("usage");
	assert.equal(cleaned, true, "a delivery waits on the worker's own acknowledgements, not the other way round");
	await finish("delivery");
});

test("requests that take or end an attempt are barriers, and commits and heartbeat requests each run in order (#4315)", () => {
	const lanes = (lane: WorkerRequestLane) =>
		(Object.keys(WORKER_REQUEST_LANES) as AnsweredWorkerRequest[]).filter(
			(kind) => WORKER_REQUEST_LANES[kind] === lane,
		);
	assert.deepEqual(lanes("barrier"), ["ready", "claim", "fenced", "recycle", "complete"]);
	assert.deepEqual(lanes("commits"), ["commit"]);
	assert.deepEqual(lanes("heartbeats"), ["heartbeat", "control", "controlled"]);
	assert.deepEqual(lanes("free"), ["budget", "activity", "route"]);
	assert.deepEqual(lanes("detached"), ["delivery", "delivery-ready"]);
});

/** An attempt of work `id`, with the lease it holds until `expiresAt`. */
function attempt(id: string, generation: number, expiresAt: number): PoolWork {
	return {
		id,
		generation,
		expiresAt,
		worker: "worker",
		epoch: 1,
		renewedAt: 0,
		state: "leased",
		boundaryId: `${id}-boundary`,
		scope: `${id}-scope`,
		childRunId: `${id}-run`,
		definition: "child.ts#child",
		digest: "digest",
		inputs: {},
		execution: {},
	};
}

/** Lease extensions whose journal transactions the test answers one by one. */
function heldExtensions(holder: AttemptHolder) {
	const asked: { readonly attempt: PoolWork; readonly answer: PromiseWithResolvers<PoolWork> }[] = [];
	const extensions = new AttemptLeaseExtensions(holder, (work) => {
		const answer = Promise.withResolvers<PoolWork>();
		asked.push({ attempt: work, answer });
		return answer.promise;
	});
	return { extensions, asked };
}

test("requests that need their attempt's lease extended at the same time share one extension (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const renewal = extensions.extend(holder.work!);
	const commit = extensions.extend(holder.work!);
	const budget = extensions.extendHeld();
	assert.equal(asked.length, 1, "one journal transaction for all three");
	asked[0]!.answer.resolve(attempt("work", 1, 200));
	assert.deepEqual(await Promise.all([renewal, commit]), [attempt("work", 1, 200), attempt("work", 1, 200)]);
	await budget;
	assert.deepEqual(holder.work, attempt("work", 1, 200), "the worker takes the extended lease");
	void extensions.extend(holder.work!);
	assert.equal(asked.length, 2, "an extension asked after the last one landed is a new one");
	assert.deepEqual(asked[1]!.attempt, attempt("work", 1, 200), "and starts from the lease the worker took");
});

test("a refused lease extension lets the next request ask for a new one (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const refused = assert.rejects(extensions.extend(holder.work!), Error);
	asked[0]!.answer.reject(new Error("refused"));
	await refused;
	void extensions.extend(holder.work!);
	assert.equal(asked.length, 2);
	assert.deepEqual(holder.work, attempt("work", 1, 100), "a refused extension changes nothing");
});

test("an extension that lands after its attempt ended, or after the worker took another, leaves what the worker holds (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("first", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const ended = extensions.extend(holder.work!);
	holder.work = undefined;
	asked[0]!.answer.resolve(attempt("first", 1, 200));
	assert.deepEqual(await ended, attempt("first", 1, 200));
	assert.equal(holder.work, undefined, "an ended attempt is not taken back");

	holder.work = attempt("second", 1, 100);
	const replaced = extensions.extend(holder.work);
	holder.work = attempt("second", 2, 300);
	asked[1]!.answer.resolve(attempt("second", 1, 400));
	await replaced;
	assert.deepEqual(
		holder.work,
		attempt("second", 2, 300),
		"a replaced attempt's lease never overwrites the new one's",
	);
});

test("an extension of another attempt in flight is not shared with the worker's next attempt (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("first", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	void extensions.extend(holder.work!);
	holder.work = attempt("first", 2, 100);
	void extensions.extendHeld();
	assert.equal(asked.length, 2, "the next attempt asks for its own extension");
	assert.deepEqual(
		asked.map((extension) => extension.attempt.generation),
		[1, 2],
	);
	asked[1]!.answer.resolve(attempt("first", 2, 500));
	asked[0]!.answer.resolve(attempt("first", 1, 900));
	await Promise.all(asked.map((extension) => extension.answer.promise));
	await drain();
	assert.deepEqual(holder.work, attempt("first", 2, 500));
});

test("a longer lease a heartbeat took while an extension was in flight survives the extension landing after it (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const extension = extensions.extend(holder.work!);
	extensions.adopt(attempt("work", 1, 300));
	assert.deepEqual(holder.work, attempt("work", 1, 300), "the heartbeat's lease is taken at once");
	asked[0]!.answer.resolve(attempt("work", 1, 200));
	assert.deepEqual(await extension, attempt("work", 1, 200), "the caller still gets its own answer");
	assert.deepEqual(holder.work, attempt("work", 1, 300), "a shorter lease never replaces it");
});

test("a shorter lease a heartbeat answers after an extension landed does not replace the longer one (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const extension = extensions.extend(holder.work!);
	asked[0]!.answer.resolve(attempt("work", 1, 300));
	await extension;
	extensions.adopt(attempt("work", 1, 200));
	assert.deepEqual(holder.work, attempt("work", 1, 300));
});

test("an extension that lands after a shorter heartbeat lease takes the longer one (#4315)", async () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions, asked } = heldExtensions(holder);
	const extension = extensions.extend(holder.work!);
	extensions.adopt(attempt("work", 1, 150));
	asked[0]!.answer.resolve(attempt("work", 1, 200));
	await extension;
	assert.deepEqual(holder.work, attempt("work", 1, 200));
});

test("a lease of the same expiry is taken, one of an ended or replaced attempt is not (#4315)", () => {
	const holder: AttemptHolder = { work: attempt("work", 1, 100) };
	const { extensions } = heldExtensions(holder);
	const equal = { ...attempt("work", 1, 100), renewedAt: 50 };
	extensions.adopt(equal);
	assert.equal(holder.work, equal, "an equal expiry is the heartbeat's newer record of the same attempt");
	extensions.adopt(attempt("work", 2, 900));
	assert.deepEqual(holder.work, equal, "another generation of the work is not the held attempt");
	extensions.adopt(attempt("other", 1, 900));
	assert.deepEqual(holder.work, equal, "another work is not the held attempt");
	holder.work = undefined;
	extensions.adopt(attempt("work", 1, 900));
	assert.equal(holder.work, undefined, "an ended attempt is not taken back");
});

test("renewing the lease of the attempt a worker holds does nothing while it holds none (#4315)", async () => {
	const holder: AttemptHolder = {};
	const { extensions, asked } = heldExtensions(holder);
	await extensions.extendHeld();
	assert.equal(asked.length, 0);
});
