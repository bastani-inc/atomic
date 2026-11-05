import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { PoolControl } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { WorkerControl } from "../../packages/workflows/src/workers/worker-control.js";
import { startWorkerHeartbeat, tolerantHeartbeat } from "../../packages/workflows/src/workers/worker-heartbeat.js";

const INTERVAL_MS = 1_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
});

test("a worker heartbeat beats once per interval and starts at once only when asked (#4313)", async () => {
	let beats = 0;
	const heartbeat = startWorkerHeartbeat(INTERVAL_MS, async () => {
		beats++;
	});
	assert.equal(beats, 0, "the first beat waits one interval");
	await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
	assert.equal(beats, 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(beats, 1);
	await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
	assert.equal(beats, 4);
	await heartbeat.stop();
	await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
	assert.equal(beats, 4, "a stopped heartbeat beats no more");

	let immediate = 0;
	const eager = startWorkerHeartbeat(
		INTERVAL_MS,
		async () => {
			immediate++;
		},
		{ immediate: true },
	);
	assert.equal(immediate, 1, "an immediate heartbeat beats before its first interval");
	await vi.advanceTimersByTimeAsync(INTERVAL_MS);
	assert.equal(immediate, 2);
	await eager.stop();
});

test("a slow heartbeat answer delays the next beat instead of queueing missed ones behind it (#4313)", async () => {
	let beats = 0;
	let inFlight = 0;
	let mostInFlight = 0;
	const answers: (() => void)[] = [];
	const heartbeat = startWorkerHeartbeat(INTERVAL_MS, async () => {
		beats++;
		inFlight++;
		mostInFlight = Math.max(mostInFlight, inFlight);
		await new Promise<void>((resolve) => answers.push(resolve));
		inFlight--;
	});
	await vi.advanceTimersByTimeAsync(INTERVAL_MS);
	assert.equal(beats, 1);
	await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
	assert.equal(beats, 1, "ticks while the answer is outstanding send nothing");
	answers.shift()!();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(beats, 1, "the missed ticks are not replayed when the answer arrives");
	await vi.advanceTimersByTimeAsync(INTERVAL_MS);
	assert.equal(beats, 2, "the next tick after the answer beats again");
	assert.equal(mostInFlight, 1);
	let stopped = false;
	const stopping = heartbeat.stop().then(() => {
		stopped = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(stopped, false, "stopping waits for the beat in flight");
	answers.shift()!();
	await stopping;
	assert.equal(stopped, true);
});

interface Recorded {
	readonly applied: PoolControl[];
	readonly settled: PoolControl[];
}

function recordingControl(slow?: Promise<void>): { control: WorkerControl } & Recorded {
	const applied: PoolControl[] = [];
	const settled: PoolControl[] = [];
	const control = new WorkerControl({
		async apply(next) {
			if (next.state === "paused") await slow;
			applied.push(next);
		},
		async applied(next) {
			settled.push(next);
		},
	});
	return { control, applied, settled };
}

test("worker control ignores a revision it already applied or passed (#4313)", async () => {
	const { control, applied, settled } = recordingControl();
	assert.equal(control.state, "running", "a worker runs until told otherwise");
	await control.offer({ state: "running", revision: 0 });
	await control.offer({ state: "paused", revision: 2 });
	assert.equal(control.state, "paused");
	await control.offer({ state: "running", revision: 1 });
	await control.offer({ state: "paused", revision: 2 });
	assert.equal(control.state, "paused", "a stale reply does not undo a newer push");
	assert.deepEqual(applied, [
		{ state: "running", revision: 0 },
		{ state: "paused", revision: 2 },
	]);
	assert.deepEqual(settled, applied, "each applied revision is acknowledged once");
	await control.offer({ state: "quit", revision: 3 });
	assert.equal(control.state, "quit");
});

test("a resume offered during a slow pause applies after it, never before (#4313)", async () => {
	const pause = Promise.withResolvers<void>();
	const { control, applied } = recordingControl(pause.promise);
	const pausing = control.offer({ state: "paused", revision: 1 });
	const resuming = control.offer({ state: "running", revision: 2 });
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(applied.length, 0, "the resume waits for the pause offered before it");
	assert.equal(control.state, "running");
	pause.resolve();
	await Promise.all([pausing, resuming]);
	assert.deepEqual(
		applied.map((entry) => entry.state),
		["paused", "running"],
	);
	assert.equal(control.state, "running", "the newer resume is the state the worker keeps");
	await control.settled();
});

test("worker control settles only once every offered control was applied (#4313)", async () => {
	const pause = Promise.withResolvers<void>();
	const { control, applied } = recordingControl(pause.promise);
	void control.offer({ state: "paused", revision: 1 });
	let settled = false;
	const settling = control.settled().then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(settled, false, "the pause is still being applied");
	pause.resolve();
	await settling;
	assert.deepEqual(applied, [{ state: "paused", revision: 1 }]);
});

test("a failed application rejects only its own offer and leaves the revision to retry (#4313)", async () => {
	const failure = new Error("acknowledgement refused");
	let refuse = true;
	const acknowledged: number[] = [];
	const control = new WorkerControl({
		async apply() {},
		async applied(next) {
			if (refuse) throw failure;
			acknowledged.push(next.revision);
		},
	});
	await assert.rejects(control.offer({ state: "paused", revision: 1 }), failure);
	assert.equal(control.state, "paused", "the state was applied before its acknowledgement failed");
	await control.settled();
	refuse = false;
	await control.offer({ state: "paused", revision: 1 });
	assert.deepEqual(acknowledged, [], "an applied revision is not acknowledged twice");
	await control.offer({ state: "running", revision: 2 });
	assert.deepEqual(acknowledged, [2], "later controls still apply after a failure");
});

test("a control whose apply fails keeps the worker's previous revision (#4313)", async () => {
	const failure = new Error("pause failed");
	let fail = true;
	const states: PoolControl["state"][] = [];
	const control = new WorkerControl({
		async apply(next) {
			if (fail) throw failure;
			states.push(next.state);
		},
		async applied() {},
	});
	await assert.rejects(control.offer({ state: "paused", revision: 1 }), failure);
	assert.equal(control.state, "running", "nothing was applied");
	fail = false;
	await control.offer({ state: "paused", revision: 1 });
	assert.deepEqual(states, ["paused"], "the same revision is applied when offered again");
});

test("a tolerant heartbeat passes expected refusals silently and reports the first other one once (#4313)", async () => {
	class Fenced extends Error {}
	const failures: Error[] = [new Fenced("fenced"), new Error("journal unavailable"), new Error("still unavailable")];
	const reported: Error[] = [];
	let sent = 0;
	const beat = tolerantHeartbeat(
		async () => {
			sent++;
			const failure = failures.shift();
			if (failure !== undefined) throw failure;
		},
		(error) => error instanceof Fenced,
		(error) => reported.push(error),
	);
	await beat();
	assert.equal(reported.length, 0, "an expected refusal is not reported");
	await beat();
	assert.deepEqual(
		reported.map((error) => error.message),
		["journal unavailable"],
	);
	await beat();
	await beat();
	assert.equal(reported.length, 1, "a later failure is not reported again");
	assert.equal(sent, 4, "every beat is sent");
});
