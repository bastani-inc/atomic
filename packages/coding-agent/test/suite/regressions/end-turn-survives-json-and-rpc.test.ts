import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { serializeRpcOutputRecord } from "../../../src/modes/rpc/rpc-output-buffer.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * `AssistantMessage.endTurn` is the provider's explicit end-of-turn signal
 * (OpenAI Codex `end_turn`). Atomic's two stdout protocols share one projection:
 * print mode writes `JSON.stringify(toJsonEvent(event))` and the RPC session
 * binding writes `serializeRpcOutputRecord(toJsonEvent(event))`, so both are
 * exercised here against the same events.
 */
function jsonWire(event: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

function rpcWire(event: Parameters<typeof serializeRpcOutputRecord>[0]): Record<string, unknown> {
	return JSON.parse(serializeRpcOutputRecord(event)) as Record<string, unknown>;
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
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.endTurn).toBe(true);
			expect(jsonWire(update).endTurn).toBe(true);
			expect(rpcWire(update).endTurn).toBe(true);
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

		expect(end.message.endTurn).toBe(true);
		const jsonMessage = jsonWire(end).message as Record<string, unknown>;
		const rpcMessage = rpcWire(end).message as Record<string, unknown>;
		expect(jsonMessage.endTurn).toBe(true);
		expect(rpcMessage.endTurn).toBe(true);
	});

	it("omits endTurn entirely when the provider reported none", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		// A present-but-undefined key would make silence indistinguishable from a
		// provider that explicitly reported `endTurn: false`.
		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update).not.toHaveProperty("endTurn");
			expect(jsonWire(update)).not.toHaveProperty("endTurn");
			expect(rpcWire(update)).not.toHaveProperty("endTurn");
		}
	});

	it("preserves a reported endTurn of false rather than dropping it as falsy", async () => {
		harness = await createHarness();
		harness.setResponses([{ ...fauxAssistantMessage("hello"), endTurn: false }]);

		await harness.session.prompt("respond");

		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.endTurn).toBe(false);
			expect(jsonWire(update).endTurn).toBe(false);
			expect(rpcWire(update).endTurn).toBe(false);
		}
	});
});
