import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { DecisionConfigError, findDecisionError, isDecisionConfigError } from "../src/core/decision/errors.ts";
import { startInteractiveEngineLiveness } from "../src/modes/interactive-engine/engine-child-liveness.ts";
import { InteractiveEngineMonitor } from "../src/modes/interactive-engine/engine-monitor.ts";

vi.mock("../src/utils/interactive-engine-env.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/interactive-engine-env.ts")>()),
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
		code: "renamed-setting",
		source: "settings",
		field: "routerModel",
		scope: "project",
	});
	const error = await hostFailureFor(new Error("startup reload failed", { cause: refused }));
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe("Interactive engine resource loading failed: startup reload failed");
	const found = findDecisionError(error);
	assert.ok(isDecisionConfigError(found));
	expect(found.fields()).toEqual(refused.fields());
	expect(found.message).toBe(refused.message);
});

test("an engine resource failure without a decision error stays a plain failure", async () => {
	const error = await hostFailureFor(new Error("bad extension"));
	expect((error as Error).message).toBe("Interactive engine resource loading failed: bad extension");
	expect((error as Error).cause).toBeUndefined();
});
