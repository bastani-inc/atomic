import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarness, type Harness } from "./test-harness.ts";

let invocation = 0;
const echoTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Returns a numbered result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `run ${++invocation}` }], details: {} }),
};

describe("tool call ids reused across assistant turns (#3243)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		invocation = 0;
	});

	test("a session keeps sending requests when the model repeats a tool call id", async () => {
		const harness = await createHarness({
			responses: [
				{ toolCalls: [{ id: "bash:0", name: "bash", args: {} }] },
				{ toolCalls: [{ id: "bash:0", name: "bash", args: {} }] },
				"first prompt done",
				{ toolCalls: [{ id: "bash:0", name: "bash", args: {} }] },
				"second prompt done",
			],
			baseToolsOverride: { bash: echoTool },
		});
		harnesses.push(harness);
		harness.agent.convertToLlm = convertToLlm;

		await harness.session.prompt("run bash twice");
		await harness.session.prompt("run bash again");

		expect(harness.faux.callCount).toBe(5);
		expect(harness.session.getLastAssistantText()).toBe("second prompt done");
		const finalContext = harness.faux.contexts[4]?.messages ?? [];
		const calls = finalContext.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		const results = finalContext.flatMap((message) =>
			message.role === "toolResult"
				? [
						`${message.toolCallId}=${message.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`,
					]
				: [],
		);
		expect(calls).toEqual(["bash:0", "bash:0_2", "bash:0_4"]);
		expect(results).toEqual(["bash:0=run 1", "bash:0_2=run 2", "bash:0_4=run 3"]);
	});
});
