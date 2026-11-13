import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@bastani/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("issue #12119 /copy after an aborted or failed turn", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("returns the previous answer after Esc during a tool call (#12119)", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Blocks until aborted",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				markToolStarted();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "tool aborted" }], details: {} };
			},
		};
		harness = await createHarness({ tools: [blockingTool] });
		harness.setResponses([
			fauxAssistantMessage("Here is the answer."),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("first question");
		const run = harness.session.prompt("run the blocking tool");
		await toolStarted;
		await harness.session.abort();
		await run;

		assert.equal(harness.session.getLastAssistantText(), "Here is the answer.");
	});

	it("returns the previous answer after a provider error (#12119)", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage("Here is the answer."),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error" }),
		]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		assert.equal(harness.session.getLastAssistantText(), "Here is the answer.");
	});

	it("keeps a reply that ended normally without text as the last reply (#12119)", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage("Here is the answer."), fauxAssistantMessage([])]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		assert.equal(harness.session.getLastAssistantText(), undefined);
	});

	it("keeps a thinking-only normal reply without text as the last reply (#12119)", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage("Here is the answer."),
			fauxAssistantMessage([fauxThinking("internal thought without visible reply")]),
		]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		assert.equal(harness.session.getLastAssistantText(), undefined);
	});
});
