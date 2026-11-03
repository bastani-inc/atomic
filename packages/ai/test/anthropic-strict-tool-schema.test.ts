import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import type { Model, Tool } from "../src/types.js";
import { normalizeContext } from "../src/utils/transcript.js";

interface AnthropicToolPayload {
	tools?: Array<{ strict?: boolean; input_schema: Record<string, unknown> }>;
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8", name: "Claude Opus 4.8", api: "anthropic-messages", provider: "test-anthropic",
		baseUrl: "http://127.0.0.1:9", reasoning: true, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	};
}

async function captureFirstTool(parameters: Tool["parameters"]): Promise<NonNullable<AnthropicToolPayload["tools"]>[number]> {
	let payload: AnthropicToolPayload | undefined;
	const tool: Tool = { name: "lookup", description: "Look up a value", parameters, constrainedSampling: { type: "json_schema", strict: "prefer" } };
	await streamAnthropic(createModel(), normalizeContext({ messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }], tools: [tool] }), {
		apiKey: "test-key", cacheRetention: "none", onPayload: (value) => { payload = value as AnthropicToolPayload; throw new Error("payload captured"); },
	}).result();
	const firstTool = payload?.tools?.[0];
	assert(firstTool, "Expected a tool in the captured Anthropic payload");
	return firstTool;
}

describe("Anthropic strict tool schemas", () => {
	it("sends prefer tools non-strict when they use keywords Anthropic strict mode rejects (#9953)", async () => {
		const unsupportedParameters: Tool["parameters"][] = [
			Type.Object({ timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })) }),
			Type.Object({ options: Type.Object({ tags: Type.Array(Type.String(), { minItems: 2 }) }) }),
			Type.Object({ expression: Type.String({ format: "regex" }) }),
			Type.Object({ tags: Type.Array(Type.String(), { uniqueItems: true }) }),
			Type.Object({ object: Type.Object({ value: Type.String() }, { minProperties: 1 }) }),
		];
		for (const parameters of unsupportedParameters) assert.equal((await captureFirstTool(parameters)).strict, undefined);
		const supportedTool = await captureFirstTool(Type.Object({
			code: Type.String({ minLength: 1, maxLength: 1000, pattern: "^[a-z]+$" }),
			url: Type.String({ format: "uri" }), tags: Type.Array(Type.String(), { minItems: 1 }),
		}));
		assert.equal(supportedTool.strict, true);
	});

	it("keeps root definitions in non-strict schemas so property refs resolve (upstream #9557)", async () => {
		const settings = { type: "object", properties: { verbose: { type: "boolean" } } };
		const cases = [
			{ ref: "#/$defs/Settings", definitions: { $defs: { Settings: settings } } },
			{ ref: "#/definitions/Settings", definitions: { definitions: { Settings: settings } } },
		];
		for (const { ref, definitions } of cases) {
			const parameters = {
				type: "object",
				properties: { settings: { $ref: ref } },
				required: ["settings"],
				...definitions,
			} as unknown as Tool["parameters"];
			const tool = await captureFirstTool(parameters);
			assert.equal(tool.strict, undefined);
			assert.deepEqual(tool.input_schema, {
				type: "object",
				properties: { settings: { $ref: ref } },
				required: ["settings"],
				...definitions,
			});
		}
	});
});
