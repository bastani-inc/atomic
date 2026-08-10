import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

describe("#5998 blocked tool termination", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("lets a blocked tool_call handler terminate the run without a follow-up model call", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({
						block: true,
						reason: "Blocked by terminating policy",
						terminate: true,
					}));
				},
			],
		});
		harnesses.push(harness);
		let followUpCalls = 0;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			() => {
				followUpCalls += 1;
				return fauxAssistantMessage("should not run");
			},
		]);

		await harness.session.prompt("hi");

		expect(followUpCalls).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("should not run");
		expect(harness.eventsOfType("tool_execution_end")[0]?.result).toHaveProperty("terminate", true);
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});
});
