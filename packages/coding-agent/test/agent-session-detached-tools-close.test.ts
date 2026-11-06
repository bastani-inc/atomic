/**
 * What closing a session does to the detachable calls it let go on (#4403): the places they held in its tool
 * scheduler are given back, so nothing of the scheduler stays reachable from a call that outlives the session, and the
 * call still delivers its result.
 */
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.js";
import { waitTool } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

/** Whether `target` is collected once collections and the finalizers they schedule have settled. */
async function collected(target: WeakRef<object>): Promise<boolean> {
	// Dereferencing keeps the target alive until the current job ends, so each check runs in a later job.
	for (let round = 0; round < 10; round++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (target.deref() === undefined) return true;
	}
	return false;
}

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("closing a session gives back its running detached call's place in the tool scheduler, and the call still delivers its result (#4403)", async () => {
	const tool = waitTool();

	/** Detach a call, close its session, and keep only a weak reference to the session's scheduler. */
	async function detachThenClose() {
		const harness = await createHarness({ customTools: [tool.definition] });
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], { stopReason: "toolUse" }),
		]);
		await harness.session.prompt("watch ci");
		const [call] = harness.session.takeDetachedToolCalls();
		assert.ok(call !== undefined, "the call detached");
		const scheduler = new WeakRef((harness.session as AgentSessionInternalSurface)._toolExecutionScheduler);
		await harness.cleanup();
		return { call, scheduler };
	}

	const { call, scheduler } = await detachThenClose();

	assert.equal(
		await collected(scheduler),
		true,
		"the closed session's scheduler was collected while its call went on",
	);
	tool.finish(0, "green");
	const result = await call.result;
	assert.deepEqual(result.result.content, [{ type: "text", text: "green" }]);
	assert.equal(result.toolCallId, "ci-1");
});

test("a session that never registered a detachable tool closes cleanly (#4403)", async () => {
	const harness = await createHarness({ tools: [] });
	await assert.doesNotReject(harness.cleanup());
});
