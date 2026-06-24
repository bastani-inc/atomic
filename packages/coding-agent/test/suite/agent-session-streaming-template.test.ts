import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession streaming prompt expansion", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("expands extension-sourced follow-up templates while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => { releaseToolExecution = resolve; });
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
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", { source: "local", scope: "temporary", origin: "top-level" }),
		};
		const resourceLoader = { ...createTestResourceLoader(), getPrompts: () => ({ prompts: [template], diagnostics: [] }) };
		const harness = await createHarness({ tools: [waitTool], resourceLoader });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") { unsubscribe(); resolve(); }
			});
		});
		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("/review src/index.ts", { source: "extension", streamingBehavior: "followUp" });

		expect(harness.session.getFollowUpMessages()).toEqual(["Review this code: src/index.ts"]);

		releaseToolExecution?.();
		await promptPromise;
	});
});
