import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { DecisionConfigError, findDecisionError, isDecisionConfigError } from "../src/core/decision/errors.js";
import { startInteractiveEngineLiveness } from "../src/modes/interactive-engine/engine-child-liveness.js";
import { InteractiveEngineMonitor } from "../src/modes/interactive-engine/engine-monitor.js";

vi.mock("../src/utils/interactive-engine-env.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/interactive-engine-env.js")>()),
	interactiveEngineStartupEnv: () => ({ child: "1", hostPid: undefined, guardFile: undefined, apiKey: undefined }),
}));

async function hostFailureFor(failure: Error): Promise<unknown> {
	const lines: string[] = [];
	const liveness = startInteractiveEngineLiveness((line) => lines.push(line));
	try {
		liveness.resourcesFailed(failure);
	} finally {
		liveness.stop();
	}
	const monitor = new InteractiveEngineMonitor(vi.fn(), vi.fn());
	const readiness = monitor.waitUntilResourcesReady();
	for (const line of lines) monitor.handleLine(line);
	return readiness.then(
		() => assert.fail("resource loading unexpectedly succeeded"),
		(error: unknown) => error,
	);
}

test("a refused decision setting in the engine child reaches the host as a typed error (#4358)", async () => {
	const refused = new DecisionConfigError({
		code: "invalid-setting",
		source: "settings",
		field: "decisionModel",
		scope: "project",
	});
	const error = await hostFailureFor(new Error("startup reload failed", { cause: refused }));
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Interactive engine resource loading failed: startup reload failed");
	const found = findDecisionError(error);
	assert.ok(isDecisionConfigError(found));
	assert.deepEqual(found.fields(), refused.fields());
	assert.equal(found.message, refused.message);
});

test("an engine resource failure without a decision error stays a plain failure", async () => {
	const error = await hostFailureFor(new Error("bad extension"));
	assert.equal((error as Error).message, "Interactive engine resource loading failed: bad extension");
	assert.equal((error as Error).cause, undefined);
});
