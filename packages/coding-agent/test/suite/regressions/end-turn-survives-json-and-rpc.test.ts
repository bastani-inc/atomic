import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import { type JsonAgentSessionEvent, toJsonEvent } from "../../../src/modes/json-event.js";
import { serializeRpcOutputRecord } from "../../../src/modes/rpc/rpc-output-buffer.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * `AssistantMessage.endTurn` is the provider's explicit end-of-turn signal
 * (OpenAI Codex `end_turn`). Atomic's two stdout protocols share one projection:
 * print mode writes `JSON.stringify(toJsonEvent(event))` and the RPC session
 * binding writes `serializeRpcOutputRecord(toJsonEvent(event))`, so both are
 * exercised here against the same events.
 */
function jsonWire(event: JsonAgentSessionEvent): JsonAgentSessionEvent {
	return JSON.parse(JSON.stringify(event)) as JsonAgentSessionEvent;
}

function rpcWire(event: JsonAgentSessionEvent): JsonAgentSessionEvent {
	return JSON.parse(serializeRpcOutputRecord(event)) as JsonAgentSessionEvent;
}

describe("regression end-turn-survives-json-and-rpc", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("carries a reported endTurn on streamed updates through both wires", async () => {
		harness = await createHarness();
		harness.setResponses([{ ...fauxAssistantMessage("hello"), endTurn: true }]);

		await harness.session.prompt("respond");

		// The delta-only projection strips `partial`, which is where a provider's
		// end-of-turn signal lives during streaming — the same loss #7982 fixed for usage.
		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		assert.ok(updates.length > 0);
		for (const update of updates) {
			assert.equal(update.endTurn, true);
			assert.equal(jsonWire(update).endTurn, true);
			assert.equal(rpcWire(update).endTurn, true);
		}
	});

	it("carries a reported endTurn on the final message through both wires", async () => {
		harness = await createHarness();
		harness.setResponses([{ ...fauxAssistantMessage("hello"), endTurn: true }]);

		await harness.session.prompt("respond");

		const end = harness
			.eventsOfType("message_end")
			.map((event) => toJsonEvent(event))
			.find((event) => event.type === "message_end" && event.message.role === "assistant");
		if (end?.type !== "message_end" || end.message.role !== "assistant") {
			throw new Error("Expected an assistant message_end event");
		}

		assert.equal(end.message.endTurn, true);
		const jsonMessage = jsonWire(end).message;
		const rpcMessage = rpcWire(end).message;
		assert.equal(jsonMessage.endTurn, true);
		assert.equal(rpcMessage.endTurn, true);
	});

	it("omits endTurn entirely when the provider reported none", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		// A present-but-undefined key would make silence indistinguishable from a
		// provider that explicitly reported `endTurn: false`.
		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		assert.ok(updates.length > 0);
		for (const update of updates) {
			assert.equal(Object.hasOwn(update, "endTurn"), false);
			assert.equal(Object.hasOwn(jsonWire(update), "endTurn"), false);
			assert.equal(Object.hasOwn(rpcWire(update), "endTurn"), false);
		}
	});

	it("preserves a reported endTurn of false rather than dropping it as falsy", async () => {
		harness = await createHarness();
		harness.setResponses([{ ...fauxAssistantMessage("hello"), endTurn: false }]);

		await harness.session.prompt("respond");

		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		assert.ok(updates.length > 0);
		for (const update of updates) {
			assert.equal(update.endTurn, false);
			assert.equal(jsonWire(update).endTurn, false);
			assert.equal(rpcWire(update).endTurn, false);
		}
	});
});
