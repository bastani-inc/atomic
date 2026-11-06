import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { describe, test } from "vitest";
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

describe("the stage runner around a wait, at its edges (#4309)", () => {
	test("text sent as parts without an image while the stage waits released reaches the reopened session with no images (#4309)", async () => {
		const rig = makeRig({ detachOnPrompt: detachingOne() });

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		await rig.ctx.__sendUserMessage(
			[
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
			{ deliverAs: "steer" },
		);
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(names(rig.log, "steer#"), ['steer#2:first\nsecond:{"expandPromptTemplates":false}']);
	});

	test("a message sent while a released stage reopens reaches the session only once the reopening has finished (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({ rehydratedGate: gate.promise });
		await rig.ctx.prompt("plan");
		await rig.ctx.release();

		const reopening = rig.ctx.rehydrate();
		await until(() => rig.log.includes("rehydrated:release"));
		const message = rig.ctx.__sendUserMessage("report");
		await settleTicks();
		const beforeReopened = names(rig.log, "prompt#2");
		gate.resolve();
		await reopening;
		await message;

		assert.deepEqual(beforeReopened, []);
		assert.deepEqual(names(rig.log, "prompt#2"), ["prompt#2:report"]);
	});

	test("a resumed turn whose calls cannot be started again continues from no results (#4309)", async () => {
		const handed: number[] = [];
		const rig = await makeResumedRig({
			pendingTurn: true,
			customize: () => ({
				redispatchDetachedToolCalls: undefined,
				async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
					handed.push(results.length);
				},
			}),
		});

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(handed, [0]);
		assert.deepEqual(names(rig.log, "prompt#"), []);
	});

	test("a resumed turn that starts no call again continues from no results (#4309)", async () => {
		const handed: number[] = [];
		const rig = await makeResumedRig({
			pendingTurn: true,
			redispatch: () => [],
			customize: () => ({
				async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
					handed.push(results.length);
				},
			}),
		});

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(handed, [0]);
	});

	test("a stage given no wait hooks fails with the store's own error when its session cannot save its results (#4309)", async () => {
		const failure = storeUnavailable();
		const rig = makeRig({
			noHooks: true,
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
});
