import assert from "node:assert/strict";
import { test } from "vitest";
import { createToolAdmissionBoundary } from "../../packages/workflows/src/engine/run-tool-admission-boundary.js";
import { WorkflowGracefulQuitError } from "../../packages/workflows/src/engine/workflow-tool-abort.js";

// Regression for #2700: resumed live workflows must admit their next tool,
// without weakening the registration drain or a subsequent quit boundary.
test("live resume reopens tool admission only after the quit registration drain", async () => {
	const boundary = createToolAdmissionBoundary();
	const admitted = boundary.admit();
	assert.equal(admitted.accepted, true);
	assert.ok(admitted.accepted);
	const firstReason = new WorkflowGracefulQuitError("run", "first quit");
	let drained = false;
	const closing = boundary.closeForQuit(firstReason).then(() => {
		drained = true;
	});
	await Promise.resolve();
	assert.equal(drained, false);
	assert.deepEqual(boundary.admit(), { accepted: false, error: firstReason });
	admitted.lease.release();
	admitted.lease.release();
	await closing;
	assert.equal(boundary.closed, true);
	boundary.resume();
	assert.equal(boundary.closed, false);
	assert.equal(boundary.quitReason, undefined);
	const resumed = boundary.admit();
	assert.ok(resumed.accepted);
	const secondReason = new WorkflowGracefulQuitError("run", "second quit");
	const secondClose = boundary.closeForQuit(secondReason);
	assert.deepEqual(boundary.admit(), { accepted: false, error: secondReason });
	resumed.lease.release();
	await secondClose;
	assert.equal(boundary.quitReason, secondReason);
});
