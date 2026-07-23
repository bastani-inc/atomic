import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("lax message content normalization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("normalizes null content returned by a message_end extension", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return { message: { ...event.message, content: null as never } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);

		await harness.session.prompt("hello");

		const assistant = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([]);
	});

	it("normalizes omitted content returned by a message_end extension", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						const replacement = { ...event.message } as typeof event.message & { content?: never };
						delete replacement.content;
						return { message: replacement };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);

		await harness.session.prompt("hello");

		const assistant = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([]);
	});

	it("normalizes null content injected by before_agent_start", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "lax", content: null as never, display: false },
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);

		await harness.session.prompt("hello");

		const custom = harness.session.messages.find((message) => message.role === "custom" && message.customType === "lax");
		expect(custom?.content).toEqual([]);
	});

	it("normalizes null sendCustomMessage content and preserves context exclusion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.sendCustomMessage(
			{ customType: "lax", content: null as never, display: true },
			{ excludeFromContext: true },
		);

		const custom = harness.session.messages.find((message) => message.role === "custom" && message.customType === "lax");
		expect(custom?.content).toEqual([]);
		expect(custom && "excludeFromContext" in custom ? custom.excludeFromContext : undefined).toBe(true);
	});

	it("normalizes null content while rebuilding old session context", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "old-message",
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: null as never,
				timestamp: 1,
			},
		};

		expect(buildSessionContext([entry]).messages[0]?.content).toEqual([]);
	});

	it("normalizes omitted content while rebuilding old session context", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "old-message-without-content",
			parentId: null,
			timestamp: "2025-01-01T00:00:00.000Z",
			message: { role: "user", timestamp: 1 } as never,
		};

		expect(buildSessionContext([entry]).messages[0]?.content).toEqual([]);
	});
});
