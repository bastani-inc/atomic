import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/**
 * A stage's control handle over a stage context with no live session, as after the session went away, with `released`
 * saying whether the stage waits released. `calls` lists what the handle asked of the stage context, in order.
 */
function handleOver(status: StageSnapshot["status"], released: boolean) {
	const calls: string[] = [];
	const runtime = {
		runId: "run-handle",
		stageId: "stage-handle",
		name: "implement",
		stageSnapshot: { status, sessionId: "saved-session" },
		state: { liveHandleReleased: false, resumeContinuationPending: false },
		innerCtx: {
			__sessionMeta: () => ({ sessionId: undefined, sessionFile: undefined }),
			__isReleased: () => released,
			__agentSession: () => undefined,
			isStreaming: false,
			subscribe: () => () => {},
			async __ensureSessionFromId(sessionId: string) {
				calls.push(`reopen:${sessionId}`);
			},
			async steer(text: string) {
				calls.push(`steer:${text}`);
			},
			async __requestPause() {
				calls.push("pause-session");
			},
		},
		activeStore: { recordStagePaused: () => false },
		throwIfStageMutationBlocked() {},
		async captureStageSessionMeta() {},
	};
	return { handle: createStageControlHandle(runtime as never), calls };
}

describe("a stage's control handle over a stage with no live session (#4309)", () => {
	test("a message to a stage that is not released reopens the stage's own saved session first; one to a released stage leaves the reopening to its wake (#4309)", async () => {
		const resident = handleOver("completed", false);
		await resident.handle.steer("check the logs");
		assert.deepEqual(resident.calls, ["reopen:saved-session", "steer:check the logs"]);

		const released = handleOver("suspended", true);
		await released.handle.steer("check the logs");
		assert.deepEqual(released.calls, ["steer:check the logs"]);
	});

	test("pausing a waiting stage pauses its session, and pausing a stage that already finished leaves its session alone (#4309)", async () => {
		const waiting = handleOver("suspended", true);
		await waiting.handle.pause();
		assert.deepEqual(waiting.calls, ["pause-session"]);

		const finished = handleOver("completed", false);
		await finished.handle.pause();
		assert.deepEqual(finished.calls, []);
	});
});
