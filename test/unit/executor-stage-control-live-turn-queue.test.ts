/**
 * A steer or follow-up for a stage whose live session runs a turn goes into that turn, even while
 * the stage's session is still starting up, as on a pooled replacement attempt (#3996).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";

test("a stage still starting up queues steers and follow-ups into the turn its live session runs, and arms its continuation (#3996)", async () => {
	const queued: string[] = [];
	const contextCalls: string[] = [];
	const state = { liveHandleReleased: false, resumeContinuationPending: false as false | string };
	const runtime = {
		runId: "run",
		stageId: "stage",
		name: "stage",
		stageSnapshot: { status: "running", sessionId: "session" },
		state,
		innerCtx: {
			// The stage context's session is not ready yet: its queueing waits for the replayed turn.
			__sessionMeta: () => ({ sessionId: undefined, sessionFile: undefined }),
			__ensureSessionFromId: () => new Promise<void>(() => {}),
			steer: () => {
				contextCalls.push("steer");
				return new Promise<void>(() => {});
			},
			followUp: () => {
				contextCalls.push("followUp");
				return new Promise<void>(() => {});
			},
			get isStreaming() {
				return false;
			},
			subscribe: () => () => {},
			// The replayed turn's live session.
			__agentSession: () => ({
				isStreaming: true,
				async steer(text: string) {
					queued.push(`steer:${text}`);
				},
				async followUp(text: string) {
					queued.push(`followUp:${text}`);
				},
			}),
		},
		throwIfStageMutationBlocked() {},
		captureStageSessionMeta() {},
	};
	const handle = createStageControlHandle(runtime as never);
	await handle.followUp("FOLLOW");
	await handle.steer("STEER");
	assert.deepEqual(queued, ["followUp:FOLLOW", "steer:STEER"]);
	assert.deepEqual(contextCalls, []);
	assert.equal(state.resumeContinuationPending, "queued-user-message");
});
