/**
 * A tool result is finalized for the session's model (#4309): its image limits shape the normalization, and a model that
 * declares no image limits at all (or only other limits) gets the defaults without failing the call.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import {
	detachedResult,
	harnessPool,
	reopenedAfterDetaching,
	settlesWithin,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const pool = harnessPool();
afterEach(async () => {
	await pool.cleanup();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("a model with input limits but no image limits leaves the call's result as the tool reported it (#4309)", async () => {
	const tool = waitTool();
	const harness = await createHarness({
		customTools: [tool.definition],
		models: [{ id: "limits-without-images", inputLimits: {} }],
	});
	harnesses.push(harness);
	harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("done")]);

	const turn = harness.session.prompt("watch ci");
	await untilStarted(tool);
	tool.finish(0, "passed");
	await settlesWithin(turn);

	const result = harness.sessionManager
		.buildSessionProjection()
		.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	assert.equal(getMessageText(result), "passed");
});

test("a session that has no model records the result its transcript waits on as the tool reported it (#4309)", async () => {
	const { reopened } = await reopenedAfterDetaching(pool, [waitTool().definition], [waitForCiTurn("ci-1")]);
	(reopened.session.agent.state as { model: unknown }).model = undefined;
	reopened.setResponses([fauxAssistantMessage("ci passed")]);

	// Without a model the turn cannot continue; what the call returned is recorded before it tries.
	await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]).catch(() => undefined);

	const result = reopened.sessionManager
		.buildSessionProjection()
		.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	assert.equal(getMessageText(result), "passed");
});
