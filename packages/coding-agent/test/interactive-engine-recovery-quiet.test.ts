import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { renderEngineDiagnostic } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import {
	UNEXPECTED_ENGINE_LOSS_NOTICE,
	UNRESPONSIVE_ENGINE_NOTICE,
} from "../src/modes/interactive-engine/engine-health.js";

test("an interactive engine that is replaced shows nothing and stops the working indicator", () => {
	for (const message of [`${UNEXPECTED_ENGINE_LOSS_NOTICE} Cause: exit.`, UNRESPONSIVE_ENGINE_NOTICE]) {
		const view = { showStatus: vi.fn(), showError: vi.fn(), stopWorkingLoader: vi.fn() };
		renderEngineDiagnostic(
			{ activity: undefined, elapsedMs: 0, level: "blocking", source: "recovery", message },
			view,
		);
		assert.equal(view.showStatus.mock.calls.length, 0, message);
		assert.equal(view.showError.mock.calls.length, 0, message);
		assert.equal(view.stopWorkingLoader.mock.calls.length, 1, message);
	}
});

test("an interactive engine that cannot be restarted still says so", () => {
	const view = { showStatus: vi.fn(), showError: vi.fn(), stopWorkingLoader: vi.fn() };
	renderEngineDiagnostic(
		{
			activity: undefined,
			elapsedMs: 0,
			level: "unresponsive",
			message: "Interactive engine restart failed: spawn ENOENT",
		},
		view,
	);
	assert.equal(view.showError.mock.calls[0]?.[0], "Interactive engine restart failed: spawn ENOENT");
});
