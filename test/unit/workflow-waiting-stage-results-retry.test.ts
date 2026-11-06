import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import type { StageSessionRuntime } from "./stage-runner-helpers.js";
import {
	detachingOne,
	endsOnCalls,
	makeResumedRig,
	makeRig,
	names,
	REPLAY_KEY,
	recordedResult,
	rejection,
	storeUnavailable,
	until,
} from "./waiting-stage-controller-rig.js";

type Messages = StageSessionRuntime["messages"];

/** Longer than the backoff before the second attempt to hand the results over, whatever its jitter. */
const RETRY_BACKOFF_BOUND_MS = 10_000;

function savedResult(toolCallId: string): Messages[number] {
	return { role: "toolResult", toolCallId, toolName: "wait_for_ci", content: [], isError: false, timestamp: 0 };
}

describe("handing a turn's results over again after the store failed to save them (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("a host that fails to record the stage waiting to hand its results over again fails the turn with that failure, and the stage does not reopen (#4309)", async () => {
		const failure = new Error("the host could not record the wait");
		const rig = await makeResumedRig({
			pendingTurn: true,
			durableReplayKey: REPLAY_KEY,
			enterFails: failure,
			customize: (number) => {
				const messages = endsOnCalls("c1");
				return {
					messages,
					async resumeDetachedTurn(_results: readonly DetachedToolResult[]) {
						if (number === 1) throw storeUnavailable();
						messages.push(savedResult("c1"));
					},
				};
			},
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("c1", "c1 passed before the stop")]);

		assert.equal(await rejection(rig.ctx.prompt("the original prompt")), failure);
		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "enter:"), ["enter:tool"]);
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("a stage on an explicit model records no failed model attempt for a save the store failed and a reopened session made (#4309)", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			stageOptions: { model: "anthropic/primary" },
			customize: (number) => {
				if (number === 1) return {};
				const messages = endsOnCalls("c1");
				return {
					messages,
					async resumeDetachedTurn(_results: readonly DetachedToolResult[]) {
						if (number === 2) throw storeUnavailable();
						messages.push(savedResult("c1"));
					},
				};
			},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await until(() => rig.created() === 2);
		await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BOUND_MS);
		await turn;

		assert.equal(rig.created(), 3);
		assert.deepEqual(
			(rig.ctx.__modelFallbackMeta?.().modelAttempts ?? []).map(({ model, success }) => ({ model, success })),
			[
				{ model: "anthropic/primary", success: true },
				{ model: "anthropic/primary", success: true },
			],
		);
	});
});
