import assert from "node:assert/strict";
import { test } from "vitest";
import { currentRunningFrame, RUNNING_ANIMATION_MS } from "../../packages/subagents/src/tui/render.js";

test("currentRunningFrame advances one step per animation interval", () => {
	const f0 = currentRunningFrame(1_000_000);
	const f1 = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS);
	const fSame = currentRunningFrame(1_000_000 + RUNNING_ANIMATION_MS - 1);
	assert.equal(f1 - f0, 1);
	assert.equal(fSame, f0);
});
