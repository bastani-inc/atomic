import assert from "node:assert/strict";
import { test } from "vitest";
import { StageSessionReplacement } from "../../packages/workflows/src/runs/foreground/stage-runner-replacement.js";
import { makeMockSession } from "./stage-runner-helpers.js";

test("fallback replacement waits for idle after a missing session (#3655)", async () => {
	const idle = Promise.withResolvers<void>();
	let disposed = false;
	const previous = makeMockSession({
		agent: { waitForIdle: () => idle.promise } as never,
		dispose() {
			disposed = true;
		},
	}).session;
	const target = makeMockSession().session;
	const replacement = new StageSessionReplacement();

	replacement.retire(previous);
	replacement.retire(undefined);
	replacement.adopt(target);
	await Promise.resolve();
	assert.equal(disposed, false);

	idle.resolve();
	await replacement.dispose();
	assert.equal(disposed, true);
});

test.each([true, false])(
	"fallback retains cleanup after a missing session with successor=%s (#3655)",
	async (adopt) => {
		let disposeCount = 0;
		const previous = makeMockSession({
			dispose() {
				disposeCount++;
			},
		}).session;
		const replacement = new StageSessionReplacement();

		replacement.retire(previous);
		replacement.retire(undefined);
		if (adopt) replacement.adopt(makeMockSession().session);
		await replacement.dispose();
		assert.equal(disposeCount, 1);

		await replacement.dispose();
		assert.equal(disposeCount, 1);
	},
);
