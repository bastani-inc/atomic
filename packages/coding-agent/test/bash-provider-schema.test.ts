import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createAllTools } from "../src/core/tools/index.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";

// Regression #3031: xAI rejects root union branches without explicit object types.
test("Grok receives object-typed bash alternatives without weakening local validation", async () => {
	const tool = createBashToolDefinition(process.cwd());
	let captured = false;
	const result = await stream(
		{ ...getModel("xai", "grok-4.6"), baseUrl: "http://127.0.0.1:9" },
		{ messages: [{ role: "user", content: "Run bash", timestamp: 0 }], tools: [tool] },
		{
			apiKey: "test-key",
			onPayload(payload) {
				const request = payload as {
					tools: Array<{ name: string; parameters: { type: string; anyOf: Array<{ type: string }> } }>;
				};
				const bash = request.tools.find((entry) => entry.name === "bash");
				assert.ok(bash);
				assert.equal(bash.parameters.type, "object");
				assert.equal(bash.parameters.anyOf.length, 2);
				for (const branch of bash.parameters.anyOf) assert.equal(branch.type, "object");
				captured = true;
				throw new Error("payload captured before network request");
			},
		},
	).result();
	assert.ok(captured, result.errorMessage);

	for (const args of [
		{ command: "true" },
		{ command: "true", wait: { kind: "background" }, timeout: 60 },
		{ action: "wait", id: "task-1" },
		{ action: "wait", id: "task-1", budgetMs: 0 },
	]) {
		assert.deepEqual(
			validateToolArguments(tool, { type: "toolCall", id: "test", name: "bash", arguments: args }),
			args,
		);
	}
	for (const args of [
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
	]) {
		assert.throws(
			() => validateToolArguments(tool, { type: "toolCall", id: "test", name: "bash", arguments: args }),
			JSON.stringify(args),
		);
	}
});

// Registry-wide guard for #3031: a new builtin tool must not reintroduce an untyped root union branch.
test("every builtin tool root schema is an object, including union alternatives", () => {
	const tools: Array<{ name: string; parameters: unknown }> = [
		...Object.values(createAllTools(process.cwd())),
		createPowerShellToolDefinition(process.cwd()),
	];
	assert.ok(tools.length > 1);
	for (const tool of tools) {
		const schema = tool.parameters as { type?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
		assert.equal(schema.type, "object", `${tool.name} root schema must be an object`);
		for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
			assert.equal(
				(branch as { type?: unknown }).type,
				"object",
				`${tool.name} root union branches must declare type object`,
			);
		}
	}
});
