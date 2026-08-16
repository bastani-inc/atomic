import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #7982: JSON message updates retain usage", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("includes cumulative usage without cumulative message snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		// #2221's delta-only wire projection dropped this fixed-size metadata with the snapshots.
		const update = harness
			.eventsOfType("message_update")
			.find((event) => event.message.role === "assistant" && event.message.usage.totalTokens > 0);
		if (update?.message.role !== "assistant") {
			throw new Error("Expected an assistant update with populated usage");
		}

		const wireUpdate = toJsonEvent(update);
		expect(wireUpdate.usage).toEqual(update.message.usage);
		expect(wireUpdate).not.toHaveProperty("message");
		expect(wireUpdate.assistantMessageEvent).not.toHaveProperty("partial");
	});

	it("carries usage on every streamed update rather than only the last", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello there, wire")]);

		await harness.session.prompt("respond");

		const updates = harness.eventsOfType("message_update").map((event) => toJsonEvent(event));
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.usage).toBeDefined();
			expect(typeof update.usage.totalTokens).toBe("number");
		}
	});

	it("throws on a non-assistant message_update instead of emitting zeroed usage", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("respond");

		const update = harness.eventsOfType("message_update")[0];
		if (!update) throw new Error("Expected at least one message_update event");

		// A user message on this event is a protocol violation: usage would have to
		// be invented, and an invented zero is indistinguishable from a real one.
		const violation = {
			...update,
			message: { role: "user", content: "not an assistant message", timestamp: 1 },
		} as unknown as AgentSessionEvent;

		expect(() => toJsonEvent(violation)).toThrow("message_update message is not an assistant message");
	});
});
