import assert from "node:assert/strict";
import { test } from "vitest";
import { RemoteQueuePause } from "../../packages/coding-agent/src/modes/interactive-engine/remote-queue-pause.js";

test("remote queue resume checks admission after awaited pause setup and before release RPC", async () => {
	const pauseRequest = Promise.withResolvers<object | undefined>();
	const terminalError = new Error("root terminated during remote resume");
	let terminal = false;
	let releaseRequests = 0;
	const control = new RemoteQueuePause({
		requestInternal(request: { type: string }): Promise<object | undefined> {
			if (request.type === "pause_queued_messages") return pauseRequest.promise;
			releaseRequests += 1;
			return Promise.resolve({ released: false });
		},
	} as never);
	control.pause();

	const resume = control.resume(() => {
		if (terminal) throw terminalError;
	});
	await Promise.resolve();
	terminal = true;
	pauseRequest.resolve();

	await assert.rejects(resume, (error) => error === terminalError);
	assert.equal(releaseRequests, 0);
	assert.equal(control.isPaused, true);
});
