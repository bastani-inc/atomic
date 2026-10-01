import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { createCodemodeDescription } from "../src/extensions/codemode/tool.js";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.js";
import { createToolSearchDescription } from "../src/extensions/tool-search/tool.js";
import { createHarness, getMessageText } from "./suite/harness.js";

test("tool search activates matching deferred tools for the next model call", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createToolSearchExtension(),
			(pi) => {
				pi.registerTool({
					name: "github_issues",
					label: "Issues",
					description: "Search repository issues",
					exposure: "deferred",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "issue 42" }], details: {} }),
				});
				pi.registerTool({
					name: "hidden_issues",
					label: "Hidden",
					description: "Search repository issues",
					exposure: "hidden",
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error("unreachable");
					},
				});
			},
		],
		initialActiveToolNames: ["tool_search"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "repository issue" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("github_issues", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find issue");
		assert(harness.session.getActiveToolNames().includes("github_issues"));
		assert(!harness.session.getActiveToolNames().includes("hidden_issues"));
		assert(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message) === "issue 42",
			),
		);
	} finally {
		await harness.cleanup();
	}
});

test("deferred tools do not change codemode or tool-search descriptions (#10212)", () => {
	const plain = {
		name: "plain",
		label: "Plain",
		description: "Plain tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
	const deferred = { ...plain, name: "later" };
	const namespaces = new Map([[deferred.name, { name: "later_namespace", description: "Late source" }]]);
	for (const inlineBudget of [undefined, 0, 100]) {
		assert.equal(
			createCodemodeDescription([plain, deferred], { namespaces, deferred: new Set([deferred.name]), inlineBudget }),
			createCodemodeDescription([plain], { inlineBudget }),
		);
		assert(
			!createCodemodeDescription([plain, deferred], {
				namespaces,
				deferred: new Set([deferred.name]),
				inlineBudget,
			}).includes("later_namespace"),
		);
	}
	assert.equal(createToolSearchDescription([...namespaces.values()]), createToolSearchDescription());
});
