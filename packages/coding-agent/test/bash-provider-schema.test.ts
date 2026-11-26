import assert from "node:assert/strict";
import { type ToolCall, validateToolArguments } from "@bastani/atomic-ai";
import { stream as streamCompletions } from "@bastani/atomic-ai/api/openai-completions";
import { stream as streamResponses } from "@bastani/atomic-ai/api/openai-responses";
import { test } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { createAllTools } from "../src/core/tools/index.js";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.js";

const ROOT_COMBINATOR_KEYS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const;

interface ToolRootSchema {
	type?: string;
	oneOf?: object[];
	anyOf?: object[];
	allOf?: object[];
	enum?: string[];
	const?: string;
	not?: object;
}

function assertStructuredOutputsRoot(name: string, schema: ToolRootSchema): void {
	assert.equal(schema.type, "object", `${name} root schema must be an object`);
	for (const key of ROOT_COMBINATOR_KEYS)
		assert.equal(Object.hasOwn(schema, key), false, `${name} root schema must not declare ${key}`);
}

function prepareAndValidate(args: Record<string, string | number | object>) {
	const tool = createBashToolDefinition(process.cwd());
	const toolCall: ToolCall = { type: "toolCall", id: "test", name: "bash", arguments: args };
	return validateToolArguments(tool, { ...toolCall, arguments: tool.prepareArguments?.(args) ?? args });
}

const VALID_SHELL_INPUTS = [
	{ command: "true" },
	{ command: "true", wait: { kind: "background" }, timeout: 60 },
	{ action: "wait", id: "task-1" },
	{ action: "wait", id: "task-1", budgetMs: 0 },
];

const INVALID_SHELL_INPUTS = [
	{},
	{ action: "wait" },
	{ id: "task-1" },
	{ command: "true", action: "wait", id: "task-1" },
	{ command: "true", id: "task-1" },
	{ command: "true", budgetMs: 0 },
	{ action: "wait", id: "task-1", timeout: 60 },
	{ action: "wait", id: "task-1", wait: { kind: "background" } },
	{ action: "wait", id: "task-1", budgetMs: -1 },
	{ command: {} },
];

test("bash rejects mixed command and wait inputs before execution (#3220)", () => {
	for (const args of VALID_SHELL_INPUTS) assert.deepEqual(prepareAndValidate(args), args);
	for (const args of INVALID_SHELL_INPUTS) assert.throws(() => prepareAndValidate(args), JSON.stringify(args));
});

test("Grok receives an object-typed bash schema (#3031)", async () => {
	const tool = createBashToolDefinition(process.cwd());
	let captured = false;
	const result = await streamResponses(
		{ ...getFixtureModel("xai", "grok-4.6"), baseUrl: "http://127.0.0.1:9" },
		{
			messages: [
				{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
				{ role: "user", content: "Run bash", timestamp: 0 },
			],
			tools: [tool],
		},
		{
			apiKey: "test-key",
			onPayload(payload) {
				const request = payload as { tools: Array<{ name: string; parameters: ToolRootSchema }> };
				const bash = request.tools.find((entry) => entry.name === "bash");
				assert.ok(bash);
				assertStructuredOutputsRoot("bash", bash.parameters);
				captured = true;
				throw new Error("payload captured before network request");
			},
		},
	).result();
	assert.ok(captured, result.errorMessage);
});

for (const supportsStrictMode of [false, true]) {
	test(`OpenAI-compatible gateways receive a bash schema without root combinators, supportsStrictMode ${supportsStrictMode} (#3220)`, async () => {
		const tool = createBashToolDefinition(process.cwd());
		const base = getFixtureModel("openai", "gpt-4o");
		let captured = false;
		const result = await streamCompletions(
			{
				...base,
				api: "openai-completions",
				provider: "gateway",
				baseUrl: "http://127.0.0.1:9/v1",
				compat: { supportsStrictMode },
			},
			{
				messages: [
					{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
					{ role: "user", content: "Run bash", timestamp: 0 },
				],
				tools: [tool],
			},
			{
				apiKey: "test-key",
				onPayload(payload) {
					const request = payload as {
						tools: Array<{ function: { name: string; parameters: ToolRootSchema } }>;
					};
					const bash = request.tools.find((entry) => entry.function.name === "bash");
					assert.ok(bash);
					assertStructuredOutputsRoot("bash", bash.function.parameters);
					captured = true;
					throw new Error("payload captured before network request");
				},
			},
		).result();
		assert.ok(captured, result.errorMessage);
	});
}

test("every builtin tool root schema is a plain object without top-level combinators (#3031, #3220)", () => {
	const tools: Array<{ name: string; parameters: object }> = [
		...Object.values(createAllTools(process.cwd())),
		createPowerShellToolDefinition(process.cwd()),
	];
	assert.ok(tools.length > 1);
	for (const tool of tools) assertStructuredOutputsRoot(tool.name, tool.parameters as ToolRootSchema);
});
