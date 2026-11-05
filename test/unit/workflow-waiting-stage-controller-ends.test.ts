import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, describe, test, vi } from "vitest";
import type { InternalStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { isStageReleaseError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	detachingOne,
	endsOnCalls,
	makeResumedRig,
	makeRig,
	names,
	rejection,
	storeUnavailable,
	until,
} from "./waiting-stage-controller-rig.js";

/** Lets every queued callback and promise job run a few times over. */
async function settleTicks(rounds = 50): Promise<void> {
	for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve));
}

describe("a stage's detached calls and reopenings when the run or the stage ends (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("a run aborted while its stage waits inline on a call aborts the call with the run's reason (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = makeRig({ policy: undefined, signal: controller.signal, detachOnPrompt: detachingOne() });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.ci.calls.has("c1"));
		controller.abort(reason);

		assert.equal(await rejection(turn), reason);
		assert.deepEqual(rig.ci.aborts("c1"), [reason]);
	});

	test("a run aborted before a resumed stage's threshold to release has passed aborts its call with the run's reason (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = await makeResumedRig({
			policy: { afterMs: 60_000 },
			signal: controller.signal,
			pendingTurn: true,
			redispatch: (ci) => [ci.call("c1")],
		});

		const turn = rig.ctx.prompt("the original prompt");
		await until(() => rig.ci.calls.has("c1"));
		controller.abort(reason);

		assert.equal(await rejection(turn), reason);
		assert.deepEqual(rig.ci.aborts("c1"), [reason]);
		assert.equal(names(rig.log, "enter:").length, 0);
	});

	test("a run aborted while a reopened session fails to save its results ends the turn without releasing it again (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = makeRig({
			signal: controller.signal,
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 2
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								controller.abort(reason);
								throw storeUnavailable();
							},
						}
					: {},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");

		assert.equal(await rejection(turn), reason);
		assert.deepEqual(names(rig.log, "enter:"), ["enter:tool"]);
	});

	test("a stage disposed while its session fails to save its results fails with that failure, not a retry (#4309)", async () => {
		const failure = storeUnavailable();
		let ctx: InternalStageContext | undefined;
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 2
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								void ctx!.__dispose();
								throw failure;
							},
						}
					: {},
		});
		ctx = rig.ctx;

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");

		assert.equal(await rejection(turn), failure);
		assert.deepEqual(names(rig.log, "enter:"), ["enter:tool"]);
	});

	test("a session that cannot be reopened from a store fails with the store's error when it cannot save its results (#4309)", async () => {
		const failure = storeUnavailable();
		const rig = makeRig({
			withStore: false,
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 1
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								throw failure;
							},
						}
					: {},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.ci.calls.has("c1"));
		rig.ci.finish("c1");

		assert.equal(await rejection(turn), failure);
		assert.equal(rig.created(), 1);
	});

	test("a stage whose tool wait ended without its session reopening still names the session its next use reopens (#4309)", async () => {
		const failure = new Error("the adapter refused the session");
		const controller = new AbortController();
		const rig = makeRig({
			signal: controller.signal,
			detachOnPrompt: detachingOne(),
			failCreation: (number) => (number === 2 ? failure : undefined),
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		const whileReleased = getEventListeners(controller.signal, "abort").length;
		const sessionId = rig.ctx.sessionId;
		rig.ci.finish("c1");

		assert.equal(await rejection(turn), failure);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.ctx.sessionId, sessionId);
		// The stage is no longer released: it listens to the run's abort again, as a resident stage does.
		assert.equal(getEventListeners(controller.signal, "abort").length, whileReleased + 1);
	});

	test("a save of the results that fails on the store is not retried as a prompt: the stage reopens and hands them over again (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		let failures = 0;
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 2
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								failures += 1;
								throw storeUnavailable();
							},
						}
					: {},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await turn;

		assert.equal(failures, 1);
		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:go"]);
		assert.deepEqual(names(rig.log, "resume#"), ["resume#3:c1"]);
	});

	test("a save of the results that fails while the stage is being paused waits for the resume before it reopens (#4309)", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		let ctx: InternalStageContext | undefined;
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 2
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								void ctx!.__requestPause();
								throw storeUnavailable();
							},
						}
					: {},
		});
		ctx = rig.ctx;

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await until(() => names(rig.log, "enter:").length === 2);
		await rig.ctx.__resume();
		await turn;

		assert.deepEqual(names(rig.log, "resume#"), ["resume#3:c1"]);
	});

	test("a run aborted while its stage waits to save its results again leaves the stage neither released nor holding input (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = makeRig({
			signal: controller.signal,
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 2
					? {
							messages: endsOnCalls("c1"),
							async resumeDetachedTurn() {
								throw storeUnavailable();
							},
						}
					: {},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await until(() => names(rig.log, "enter:").length === 2);
		controller.abort(reason);

		assert.equal(await rejection(turn), reason);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.ctx.__holdsInput?.(), false);
	});
});

describe("releasing and disposing a resident stage (#4309)", () => {
	test("a second release made while the first gives the session up returns only once the session is gone (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({
			customize: (number, log) => ({
				async dispose() {
					log.push(`dispose-start#${number}`);
					await gate.promise;
					log.push(`dispose-end#${number}`);
				},
			}),
		});
		await rig.ctx.prompt("plan");

		const first = rig.ctx.release();
		let secondReturned = false;
		const second = rig.ctx.release().then(() => {
			secondReturned = true;
		});
		await settleTicks();
		const returnedBeforeDisposal = secondReturned;
		gate.resolve();
		await first;
		await second;

		assert.equal(returnedBeforeDisposal, false);
		assert.ok(rig.log.includes("dispose-end#1"));
	});

	test("an explicit release while a message is still being delivered is refused as busy (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({
			customize: (number, log) => ({
				async prompt(text: string) {
					log.push(`prompt#${number}:${text}`);
					if (text === "more") await gate.promise;
				},
			}),
		});
		await rig.ctx.prompt("plan");

		const message = rig.ctx.__sendUserMessage("more");
		await until(() => rig.log.includes("prompt#1:more"));
		const refused = await rejection(rig.ctx.release());
		gate.resolve();
		await message;

		assert.ok(isStageReleaseError(refused), String(refused));
		assert.equal(refused.code, "stage-busy");
	});

	test("disposing a stage takes every listener off its session (#4309)", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("plan");
		rig.ctx.subscribe(() => {});
		rig.ctx.subscribe(() => {});

		await rig.ctx.__dispose();

		assert.equal(rig.subscriptions.get(1), 0);
	});

	test("a prompt held by a pause that is resumed without a message sends nothing (#4309)", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("plan");
		await rig.ctx.__requestPause();

		const turn = rig.ctx.prompt("go");
		await settleTicks();
		await rig.ctx.__resume();
		await turn;

		assert.deepEqual(names(rig.log, "prompt#"), ["prompt#1:plan"]);
	});
});
