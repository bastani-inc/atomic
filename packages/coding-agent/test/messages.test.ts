import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, createCustomMessage, type CustomMessage } from "../src/core/messages.ts";

describe("AgentMessage custom message typing", () => {
	it("accepts CustomMessage values in AgentMessage arrays", () => {
		const custom = createCustomMessage("test:type", "hello", true, undefined, new Date(0).toISOString());
		const messages: AgentMessage[] = [custom];

		expect(convertToLlm(messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		]);
	});
});

describe("convertToLlm custom messages", () => {
	it("skips custom messages excluded from context", () => {
		const messages: CustomMessage[] = [
			{
				role: "custom",
				customType: "test:notice",
				content: "display-only status",
				display: true,
				timestamp: 1,
				excludeFromContext: true,
			},
		];

		expect(convertToLlm(messages)).toEqual([]);
	});

	it("keeps unflagged custom messages as user context", () => {
		const messages: CustomMessage[] = [
			{
				role: "custom",
				customType: "test:context",
				content: "context custom",
				display: true,
				timestamp: 1,
			},
		];

		expect(convertToLlm(messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "context custom" }], timestamp: 1 },
		]);
	});
});
