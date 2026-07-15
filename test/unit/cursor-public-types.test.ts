import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
	CursorExecutionAuthorityScheduler,
	CursorExecutionAuthorityTimer,
	CursorProviderRegistrationOptions,
} from "../../packages/cursor/index.js";

test("Cursor registration exports its execution-authority scheduler types", () => {
	const timer: CursorExecutionAuthorityTimer = { cancel() {} };
	const scheduler: CursorExecutionAuthorityScheduler = {
		schedule: () => timer,
		clear: (scheduled) => scheduled.cancel(),
	};
	const options: CursorProviderRegistrationOptions = { executionAuthorityScheduler: scheduler };

	assert.equal(options.executionAuthorityScheduler, scheduler);
});
