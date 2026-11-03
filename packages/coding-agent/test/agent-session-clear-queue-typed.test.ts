import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

/** An `input` hook that rewrites "beta" to "alpha" and leaves every other message as typed. */
const betaBecomesAlpha: ExtensionFactory = (pi) => {
	pi.on("input", (event) => (event.text === "beta" ? { action: "transform", text: "alpha" } : { action: "continue" }));
};

/** A tool that holds each call until the test releases it, so the test can act while a turn is open. */
function heldTool(): { tool: AgentTool; entered: () => Promise<void>; release: () => void } {
	const calls: Array<{ entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }> = [];
	const call = (index: number) => {
		while (calls.length <= index) calls.push({ entered: Promise.withResolvers(), release: Promise.withResolvers() });
		return calls[index];
	};
	let started = 0;
	let waited = 0;
	let released = 0;
	return {
		tool: {
			name: "hold",
			label: "Hold",
			description: "Holds the run open until released",
			parameters: Type.Object({}),
			execute: async () => {
				const current = call(started++);
				current.entered.resolve();
				await current.release.promise;
				return { content: [{ type: "text", text: "held" }], details: {} };
			},
		},
		entered: () => call(waited++).entered.promise,
		release: () => call(released++).release.resolve(),
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function startHeldTurn(): Promise<{ harness: Harness; hold: ReturnType<typeof heldTool> }> {
	const hold = heldTool();
	const harness = await createHarness({ extensionFactories: [betaBecomesAlpha], tools: [hold.tool] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	void harness.session.prompt("first").catch(() => {});
	await hold.entered();
	return { harness, hold };
}

describe("clearQueue() gives queued messages back as they were typed (#4284)", () => {
	test("keeps each message's own typed text when a rewrite matches an earlier message's text", async () => {
		const { harness, hold } = await startHeldTurn();

		await harness.session.prompt("alpha", { streamingBehavior: "steer" });
		await harness.session.prompt("beta", { streamingBehavior: "steer" });
		assert.deepEqual(harness.session.getSteeringMessages(), ["alpha", "alpha"]);

		const cleared = harness.session.clearQueue();
		hold.release();
		assert.deepEqual(cleared.steering, ["alpha", "alpha"]);
		assert.deepEqual(cleared.typed, { steering: ["alpha", "beta"], followUp: [] });
	});

	test("gives back the typed text of a message left queued after an earlier one with the same text was sent", async () => {
		const { harness, hold } = await startHeldTurn();
		harness.session.setSteeringMode("one-at-a-time");

		await harness.session.prompt("alpha", { streamingBehavior: "steer" });
		await harness.session.prompt("beta", { streamingBehavior: "steer" });
		hold.release();
		// The run takes the first steering message into its next turn, and holds there.
		await hold.entered();
		assert.deepEqual(getUserTexts(harness), ["first", "alpha"]);
		assert.deepEqual(harness.session.getSteeringMessages(), ["alpha"]);

		const cleared = harness.session.clearQueue();
		hold.release();
		assert.deepEqual(cleared.typed, { steering: ["beta"], followUp: [] });
	});
});
