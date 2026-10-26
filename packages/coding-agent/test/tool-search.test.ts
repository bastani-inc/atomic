import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { createCodemodeDescription } from "../src/extensions/codemode/tool.js";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.js";
import {
	Bm25Ranker,
	createToolSearchDescription,
	createToolSearchDocument,
} from "../src/extensions/tool-search/tool.js";
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

test("codemode describes all lookup helpers as async (#10555)", () => {
	const description = createCodemodeDescription([]);
	assert(description.includes("await searchTools(query, {limit?, namespace?})"));
	assert(description.includes("await describeTool(name)"));
	assert(description.includes("await describeNamespace(name)"));
});

test("tool search ranks a tool first when the query is its name (pi#11331)", () => {
	const documents = [
		{ name: "mcp__app__queue_read", description: "Read a queued message of this thread." },
		{
			name: "mcp__dev-app__thread_read",
			description:
				"Read durable state and a paginated timeline from any thread. The default view returns user messages, assistant messages and plans. Continue with afterPosition until hasMore is false.",
		},
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	const ranker = new Bm25Ranker();
	for (const query of [
		"thread_read",
		"dev_app__thread_read",
		"mcp__dev-app__thread_read",
		"Thread_Read",
		"thread read",
	]) {
		assert.deepEqual(
			ranker.rank(query, documents, 1).map((match) => match.name),
			["mcp__dev-app__thread_read"],
			query,
		);
	}
	// Partial names still rank by BM25.
	assert.deepEqual(
		ranker.rank("read", documents, 1).map((match) => match.name),
		["mcp__app__queue_read"],
	);
	// A lowercase query naming a camelCase tool shares no BM25 term with it, but still names it.
	const camel = [
		{ name: "mcp__app__queue_read", description: "Read a queued message of this thread." },
		{ name: "mcp__app__readThread", description: "Read a thread" },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	for (const query of ["readthread", "app__readthread"]) {
		assert.deepEqual(
			ranker.rank(query, camel, 1).map((match) => match.name),
			["mcp__app__readThread"],
			query,
		);
	}
});

test("tool search finds a tool whose name is only stop words, and nothing for other stop-word queries", () => {
	const documents = [
		{ name: "mcp__app__thread_read", description: "Read a thread." },
		{ name: "mcp__app__for_each", description: "Run a step for each item." },
		{ name: "mcp__app__is", description: "Check whether a value is set." },
	].map((tool) => createToolSearchDocument({ ...tool, parameters: Type.Object({}) }));
	const ranker = new Bm25Ranker();
	for (const [query, expected] of [
		["is", "mcp__app__is"],
		["for_each", "mcp__app__for_each"],
		["app__is", "mcp__app__is"],
	] as const) {
		assert.deepEqual(
			ranker.rank(query, documents, 1).map((match) => match.name),
			[expected],
			query,
		);
	}
	assert.deepEqual(ranker.rank("the", documents, 5), []);
	assert.deepEqual(ranker.rank("of the", documents, 5), []);
});
