import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession custom-message batch admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps a streaming batch contiguous and ordered", async () => {
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => { releaseTool = resolve; });
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		await harness.session.sendCustomMessages([
			{ customType: "batch-a1", content: "A1", display: true },
			{ customType: "batch-a2", content: "A2", display: true },
			{ customType: "batch-terminal", content: "terminal", display: true },
		], { triggerTurn: true });
		await harness.session.sendCustomMessage({ customType: "unrelated-b", content: "B", display: true });
		releaseTool?.();
		await promptPromise;

		const customTypes = harness.session.messages
			.filter((message) => message.role === "custom")
			.map((message) => message.customType);
		expect(customTypes).toEqual(["batch-a1", "batch-a2", "batch-terminal", "unrelated-b"]);
	});
});
