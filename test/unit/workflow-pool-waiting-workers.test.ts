import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { RunSnapshot, StageSnapshot, ToolNodeStatus } from "../../packages/workflows/src/shared/store-types.js";
import { isLocalWorkerPoolError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	AttemptPlace,
	attemptWaitsReleased,
	PoolPlaces,
	WaitingWorkerReserve,
} from "../../packages/workflows/src/workers/waiting-workers.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

function stage(status: StageSnapshot["status"], wait?: StageWaitKind): StageSnapshot {
	return {
		id: `stage-${status}-${wait ?? "none"}`,
		name: "stage",
		status,
		parentIds: [],
		toolEvents: [],
		...(wait === undefined ? {} : { wait: { kind: wait, since: 0 } }),
	} as StageSnapshot;
}

function runOf(stages: StageSnapshot[], toolNodes: ToolNodeStatus[] = []): RunSnapshot {
	return {
		id: "child",
		stages,
		toolNodes: toolNodes.map((status, index) => ({ id: `tool-${index}`, status })),
	} as unknown as RunSnapshot;
}

describe("whether a pooled attempt waits released (#4374)", () => {
	test("waits when every live stage waits on a tool result or an answer, across all its runs (#4374)", () => {
		assert.equal(attemptWaitsReleased([runOf([stage("suspended", "tool")])]), true);
		assert.equal(attemptWaitsReleased([runOf([stage("awaiting_input", "tool")])]), true);
		assert.equal(attemptWaitsReleased([runOf([stage("awaiting_input", "prompt")])]), true);
		assert.equal(
			attemptWaitsReleased([
				runOf([stage("completed"), stage("suspended", "tool")], ["completed", "cached"]),
				runOf([stage("failed"), stage("skipped"), stage("paused", "prompt")]),
			]),
			true,
		);
	});

	test("does not wait while anything of it can still run (#4374)", () => {
		const cases: [string, RunSnapshot[]][] = [
			["no run", []],
			["no live stage", [runOf([stage("completed"), stage("failed"), stage("skipped")])]],
			["a running stage", [runOf([stage("suspended", "tool"), stage("running")])]],
			["a pending stage", [runOf([stage("suspended", "tool"), stage("pending")])]],
			["a stage asking without a release", [runOf([stage("awaiting_input")])]],
			["a stage the workflow released", [runOf([stage("suspended", "release")])]],
			["an idle stage", [runOf([stage("suspended", "idle")])]],
			["a running durable tool call", [runOf([stage("suspended", "tool")], ["completed", "running"])]],
			["a second run still running", [runOf([stage("suspended", "tool")]), runOf([stage("running")])]],
		];
		for (const [name, runs] of cases) assert.equal(attemptWaitsReleased(runs), false, name);
	});
});

describe("the workers a pool adds while attempts wait (#4374)", () => {
	test("starts one worker per waiting attempt, at most the pool's count, and none twice (#4374)", () => {
		const reserve = new WaitingWorkerReserve();

		const started = [
			reserve.grow(0, 2),
			reserve.grow(1, 2),
			reserve.grow(1, 2),
			reserve.grow(3, 2),
			reserve.grow(5, 2),
		];

		assert.deepEqual(started, [0, 1, 0, 1, 0]);
		assert.equal(reserve.size, 2);
	});

	test("starts none, and keeps the ones it started, when fewer attempts wait than it started workers for (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(3, 4);

		assert.deepEqual([reserve.grow(1, 4), reserve.grow(0, 4), reserve.size], [0, 0, 3]);
	});

	test("ends one idle worker at a time once fewer attempts wait, down to none (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(3, 3);

		const ended = [
			reserve.shrink(3, 3),
			reserve.shrink(2, 3),
			reserve.shrink(2, 3),
			reserve.shrink(0, 3),
			reserve.shrink(0, 3),
		];
		const afterwards = [reserve.size, reserve.shrink(0, 3)];

		assert.deepEqual(ended, [false, true, false, true, true]);
		assert.deepEqual(afterwards, [0, false]);
	});

	test("keeps its extra workers while the pool still has more waiting attempts than its count (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(4, 1);

		assert.deepEqual([reserve.shrink(4, 1), reserve.shrink(1, 1), reserve.size], [false, false, 1]);
	});

	test("a worker that could not start no longer counts, and is started again for the next waiting attempt (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(2, 2);

		reserve.lost();
		const restarted = reserve.grow(2, 2);
		reserve.lost();
		reserve.lost();
		reserve.lost();

		assert.deepEqual([restarted, reserve.size, reserve.grow(1, 2)], [1, 0, 1]);
	});
});

describe("the pool's places (#4374)", () => {
	function placesOf(count: number) {
		const answers: [string, boolean][] = [];
		const places = new PoolPlaces<string>(() => count);
		const reacquire = (holder: string) => {
			void places.reacquire(holder).then((granted) => answers.push([holder, granted]));
		};
		return { places, answers, reacquire };
	}
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	test("admits a claim while a place is free, and none while every place is held (#4374)", () => {
		const { places } = placesOf(2);

		const claims = [places.claim("a"), places.claim("b"), places.claim("c")];
		places.end("a");
		claims.push(places.claim("c"));

		assert.deepEqual(claims, [true, true, false, true]);
		assert.equal(places.held, 2);
	});

	test("a woken attempt takes its place back once one frees, before any new claim, in the order asked (#4374)", async () => {
		const { places, answers, reacquire } = placesOf(1);
		places.claim("a");
		places.release("a");
		places.claim("b");
		places.release("b");
		places.claim("c");

		reacquire("a");
		reacquire("b");
		await settle();
		const whileFull = [[...answers], places.claim("d"), places.waiting];
		places.end("c");
		await settle();
		const afterFirst = [[...answers], places.claim("d"), places.waiting, places.held];
		places.end("a");
		await settle();

		assert.deepEqual(whileFull, [[], false, 2]);
		assert.deepEqual(afterFirst, [[["a", true]], false, 1, 1]);
		assert.deepEqual(answers, [
			["a", true],
			["b", true],
		]);
		assert.deepEqual([places.claim("d"), places.waiting, places.held], [false, 0, 1]);
	});

	test("a place given back goes at once to a woken attempt that asked for one (#4374)", async () => {
		const { places, answers, reacquire } = placesOf(1);
		places.claim("a");
		places.release("a");
		places.claim("b");
		reacquire("a");

		places.release("b");
		await settle();

		assert.deepEqual(answers, [["a", true]]);
		assert.deepEqual([places.held, places.waiting], [1, 1]);
	});

	test("a claim that found no child frees its place for a woken attempt (#4374)", async () => {
		const { places, answers, reacquire } = placesOf(1);
		places.claim("a");
		places.release("a");
		places.claim("idle");
		reacquire("a");

		places.end("idle");
		await settle();

		assert.deepEqual(answers, [["a", true]]);
	});

	test("an attempt that ends gets no place for its own request, and the next one does (#4374)", async () => {
		const { places, answers, reacquire } = placesOf(1);
		places.claim("a");
		places.release("a");
		places.claim("b");
		places.release("b");
		places.claim("c");
		reacquire("a");
		reacquire("b");

		places.end("a");
		places.end("c");
		await settle();

		assert.deepEqual(answers, [
			["a", false],
			["b", true],
		]);
		assert.deepEqual([places.held, places.waiting], [1, 0]);
	});

	test("an attempt that holds its place takes it again at once, without waiting behind anyone (#4374)", async () => {
		const { places, answers, reacquire } = placesOf(1);
		places.claim("a");

		reacquire("a");
		await settle();

		assert.deepEqual([answers, places.held], [[["a", true]], 1]);
	});

	test("never lets more attempts hold a place than its count, whatever they do (#4374)", async () => {
		const count = 3;
		const { places, reacquire } = placesOf(count);
		const holders = ["a", "b", "c", "d", "e", "f"];
		let seed = 7;
		const next = (bound: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return Math.floor(seed / 65_536) % bound;
		};
		let peak = 0;
		const operations = { claim: 0, release: 0, reacquire: 0, end: 0 };
		for (let step = 0; step < 2_000; step++) {
			const holder = holders[next(holders.length)]!;
			const operation = (["claim", "release", "reacquire", "end"] as const)[next(4)]!;
			operations[operation]++;
			if (operation === "claim") places.claim(holder);
			if (operation === "release") places.release(holder);
			if (operation === "reacquire") reacquire(holder);
			if (operation === "end") places.end(holder);
			await settle();
			peak = Math.max(peak, places.held);
			assert.ok(places.held <= count, `step ${step}: ${places.held} hold a place`);
		}

		assert.equal(peak, count);
		assert.ok(Object.values(operations).every((done) => done > 0));
	});
});

describe("an attempt's place, as its worker holds it (#4374)", () => {
	const attempt = { workId: "work-1", generation: 3 };

	function placeWith(answers: { release?: Promise<boolean>; reacquire?: Promise<boolean> } = {}) {
		const ops: string[] = [];
		const failures: Error[] = [];
		const reacquires: PromiseWithResolvers<boolean>[] = [];
		const place = new AttemptPlace(
			(op) => {
				ops.push(op);
				if (op === "release") return answers.release ?? Promise.resolve(true);
				if (answers.reacquire !== undefined) return answers.reacquire;
				const answer = Promise.withResolvers<boolean>();
				reacquires.push(answer);
				return answer.promise;
			},
			attempt,
			(error) => failures.push(error),
		);
		return { place, ops, failures, reacquires };
	}

	const settle = () => new Promise((resolve) => setImmediate(resolve));

	test("holds its place until the attempt waits, then gives it back once (#4374)", async () => {
		const { place, ops } = placeWith();

		place.observe(false);
		const heldWhileRunning = place.holds;
		place.observe(true);
		place.observe(true);
		await settle();

		assert.equal(heldWhileRunning, true);
		assert.equal(place.holds, false);
		assert.deepEqual(ops, ["release"]);
	});

	test("takes a place it holds without asking (#4374)", async () => {
		const { place, ops } = placeWith();

		await place.take();

		assert.deepEqual([ops, place.holds], [[], true]);
	});

	test("asks for its place again only after the pool acknowledged its release, and holds it once granted (#4374)", async () => {
		const release = Promise.withResolvers<boolean>();
		const { place, ops, reacquires } = placeWith({ release: release.promise });
		place.observe(true);

		const taken = place.take();
		await settle();
		const beforeAcknowledged = [...ops];
		release.resolve(true);
		await settle();
		const asked = [...ops];
		reacquires[0]?.resolve(true);
		await taken;

		assert.deepEqual(beforeAcknowledged, ["release"]);
		assert.deepEqual(asked, ["release", "reacquire"]);
		assert.equal(place.holds, true);
	});

	test("gives its place back and takes it again as often as the attempt waits and wakes (#4374)", async () => {
		const { place, ops, reacquires } = placeWith();

		for (let round = 0; round < 2; round++) {
			place.observe(true);
			const taken = place.take();
			await settle();
			reacquires[round]?.resolve(true);
			await taken;
		}

		assert.deepEqual(ops, ["release", "reacquire", "release", "reacquire"]);
		assert.equal(place.holds, true);
	});

	test("asks once for every caller that takes it while it waits for a place, and does not give it back meanwhile (#4374)", async () => {
		const { place, ops, reacquires } = placeWith();
		place.observe(true);

		const first = place.take();
		const second = place.take();
		await settle();
		place.observe(true);
		reacquires[0]?.resolve(true);
		await Promise.all([first, second]);

		assert.deepEqual(ops, ["release", "reacquire"]);
		assert.equal(place.holds, true);
	});

	test("an attempt that ended gets no place: a typed WorkAttemptFencedError that also fails the attempt (#4374)", async () => {
		const { place, failures } = placeWith({ reacquire: Promise.resolve(false) });
		place.observe(true);

		const error = await place.take().then(
			() => undefined,
			(caught: Error) => caught,
		);
		await settle();

		assert.ok(isLocalWorkerPoolError(error), String(error));
		assert.equal(error.code, "work_attempt_fenced");
		assert.equal(error.retryable, true);
		assert.deepEqual([failures.length, failures[0]], [1, error]);
		assert.equal(place.holds, false);
	});

	test("an abort rejects with its reason and keeps the request; a place granted later is held, then given back (#4374)", async () => {
		const { place, ops, reacquires, failures } = placeWith();
		place.observe(true);
		const controller = new AbortController();
		const reason = new Error("stage cancelled");

		const taken = place.take(controller.signal);
		await settle();
		controller.abort(reason);
		const rejected = await taken.then(
			() => undefined,
			(caught: Error) => caught,
		);
		const heldWhenAborted = place.holds;
		reacquires[0]?.resolve(true);
		await settle();
		const heldWhenGranted = place.holds;
		place.observe(true);
		await settle();

		assert.equal(rejected, reason);
		assert.deepEqual([heldWhenAborted, heldWhenGranted, place.holds], [false, true, false]);
		assert.deepEqual(ops, ["release", "reacquire", "release"]);
		assert.deepEqual(failures, []);
	});

	test("a signal aborted before it asks rejects with its reason and asks for nothing (#4374)", async () => {
		const { place, ops } = placeWith();
		place.observe(true);
		const reason = new Error("already cancelled");

		const rejected = await place.take(AbortSignal.abort(reason)).then(
			() => undefined,
			(caught: Error) => caught,
		);

		assert.equal(rejected, reason);
		assert.deepEqual(ops, ["release"]);
	});

	test("a release the pool did not take fails the attempt with its error (#4374)", async () => {
		const refused = new Error("worker has no active attempt");
		const { place, failures } = placeWith({ release: Promise.reject(refused) });

		place.observe(true);
		await settle();

		assert.deepEqual(failures, [refused]);
	});
});
