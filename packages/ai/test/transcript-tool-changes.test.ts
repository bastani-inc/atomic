import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, Context, Model, Tool } from "../src/types.ts";

class PayloadCaptured extends Error {}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

async function capturePayload<T>(model: Model<Api>, context: Context): Promise<T> {
	let captured: T | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as T;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

const modelBase = {
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

const baseTool = tool("base_tool");
const lateTool = tool("late_tool");
const context: Context = {
	messages: [
		{
			role: "system",
			content: "base prompt",
			sections: { rules: "<rules>\nold rules\n</rules>", docs: "<docs>\nread docs\n</docs>" },
			toolsAdded: [baseTool],
			timestamp: 0,
		},
		{ role: "user", content: "before", timestamp: 1 },
		{
			role: "system",
			content: "updated guidance",
			sections: { rules: "<rules>\nnew rules\n</rules>", docs: null },
			toolsRemoved: [{ name: "base_tool" }],
			toolsAdded: [lateTool],
			timestamp: 2,
		},
	],
};
const additionContext: Context = {
	messages: [
		{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
		{ role: "user", content: "before", timestamp: 1 },
		{ role: "system", content: "updated guidance", toolsAdded: [lateTool], timestamp: 2 },
	],
};

const anthropicNativeModel: Model<"anthropic-messages"> = {
	...modelBase,
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "anthropic",
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

interface AnthropicPayload {
	betas?: string[];
	system?: Array<{ text: string }>;
	tools?: Array<{ name: string; description?: string; defer_loading?: boolean; cache_control?: { type: "ephemeral" } }>;
	messages: Array<{
		role: string;
		content: Array<{
			type: string;
			text?: string;
			cache_control?: { type: "ephemeral" };
			tool?: {
				type?: string;
				name?: string;
				definition?: { name: string; description?: string; cache_control?: { type: "ephemeral" }; defer_loading?: boolean };
			};
		}>;
	}>;
}

describe("transcript system messages", () => {
	test("sends Anthropic updates and tool changes in native system messages", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, context);

		assert.ok(payload.betas?.includes("inline-tools-2026-09-15"));
		assert.ok(!payload.betas?.includes("mid-conversation-tool-changes-2026-07-01"));
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\n<rules>\nold rules\n</rules>\n\n<docs>\nread docs\n</docs>",
		]);
		assert.deepEqual(
			payload.tools?.map((tool) => tool.name),
			["base_tool", "__pi_deferred_placeholder__"],
		);
		assert.deepEqual(payload.tools?.[0]?.cache_control, { type: "ephemeral" });
		assert.equal(payload.tools?.[0]?.defer_loading, undefined);
		assert.equal(payload.tools?.[1]?.defer_loading, true);
		assert.equal(payload.tools?.[1]?.cache_control, undefined);
		const update = payload.messages.at(-1);
		expect(update).toMatchObject({
			role: "system",
			content: [
				{ type: "text" },
				{ type: "tool_removal", tool: { type: "tool_reference", name: "base_tool" } },
				{
					type: "tool_addition",
					tool: { type: "tool_definition", definition: { name: "late_tool", description: "late_tool tool" } },
					cache_control: { type: "ephemeral" },
				},
			],
		});
		assert.equal(update?.content[2]?.tool?.definition?.cache_control, undefined);
		assert.equal(update?.content[2]?.tool?.definition?.defer_loading, undefined);
		expect(update?.content[0]?.text).toContain("updated guidance");
		expect(update?.content[0]?.text).toContain("<rules>\nnew rules\n</rules>");
		expect(update?.content[0]?.text).toContain('Removed system prompt section "docs"');

		// The placeholder is declared before any change so its scaffolding is cached from request one.
		const initial = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: context.messages.slice(0, 2),
		});
		expect(initial.tools?.map((tool) => tool.name)).toEqual(["base_tool", "__pi_deferred_placeholder__"]);
	});

	test("redefines an Anthropic tool by value under the same name", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: [
				{ role: "system", content: "base prompt", toolsAdded: [baseTool], timestamp: 0 },
				{ role: "user", content: "before", timestamp: 1 },
				{
					role: "system",
					content: "",
					toolsRemoved: [{ name: "base_tool" }],
					toolsAdded: [{ ...baseTool, description: "changed" }],
					timestamp: 2,
				},
			],
		});
		assert.ok(payload.betas?.includes("inline-tools-2026-09-15"));
		assert.deepEqual(
			payload.tools?.map((tool) => tool.name),
			["base_tool", "__pi_deferred_placeholder__"],
		);
		assert.equal(payload.tools?.[0]?.description, "base_tool tool");
		const update = payload.messages.at(-1);
		assert.equal(update?.role, "system");
		assert.deepEqual(
			update?.content.map((block) => block.type),
			["tool_addition"],
		);
		assert.equal(update?.content[0]?.tool?.type, "tool_definition");
		assert.equal(update?.content[0]?.tool?.definition?.name, "base_tool");
		assert.equal(update?.content[0]?.tool?.definition?.description, "changed");
	});

	test("sends the current Anthropic tool list without an initial tool", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropicNativeModel, {
			messages: [
				{ role: "system", content: "base prompt", timestamp: 0 },
				{ role: "user", content: "before", timestamp: 1 },
				{ role: "system", content: "updated guidance", toolsAdded: [lateTool], timestamp: 2 },
			],
		});
		assert.ok(!payload.betas?.includes("inline-tools-2026-09-15"));
		assert.deepEqual(
			payload.tools?.map((tool) => tool.name),
			["late_tool"],
		);
		assert.deepEqual(payload.tools?.[0]?.cache_control, { type: "ephemeral" });
		assert.equal(payload.tools?.[0]?.defer_loading, undefined);
		assert.deepEqual(
			payload.messages.at(-1)?.content.map((block) => block.type),
			["text"],
		);
	});

	test("folds Anthropic updates into the system prompt without native support", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
		};
		const payload = await capturePayload<{
			betas?: string[];
			system?: Array<{ text: string }>;
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		assert.ok(!payload.betas?.includes("inline-tools-2026-09-15"));
		expect(payload.system?.map((block) => block.text)).toEqual([
			"base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>",
		]);
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("requires both Anthropic capabilities for native tool changes", async () => {
		const model: Model<"anthropic-messages"> = {
			...modelBase,
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			provider: "anthropic",
			compat: { supportsMidConvoToolChanges: true },
		};
		const payload = await capturePayload<{
			betas?: string[];
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string }>;
		}>(model, context);

		assert.ok(!payload.betas?.includes("inline-tools-2026-09-15"));
		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
	});

	test("anchors OpenAI additions at their developer message", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string; content?: string; tools?: Array<{ name: string }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expect(payload.input.find((item) => item.type === "additional_tools")?.tools?.map((value) => value.name)).toEqual(
			["late_tool"],
		);
		expect(
			payload.input
				.filter((item) => item.role === "developer" && item.type === undefined)
				.map((item) => item.content),
		).toEqual(["base prompt", "updated guidance"]);
	});

	test("maps system-message additions into synthetic tool search", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; tools?: Array<{ name: string }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.name)).toEqual(["base_tool"]);
		expect(payload.input.map((item) => item.type)).toContain("tool_search_call");
		expect(
			payload.input.find((item) => item.type === "tool_search_output")?.tools?.map((value) => value.name),
		).toEqual(["late_tool"]);
	});

	test("folds OpenAI updates into the leading developer message without native support", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsAdditionalTools: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.input.map((item) => item.type ?? item.role)).toEqual(["developer", "user"]);
		expect(payload.input[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});

	test("falls back to the complete current tool state when removals are unsupported", async () => {
		const model: Model<"openai-responses"> = {
			...modelBase,
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ name: string }>;
			input: Array<{ type?: string; role?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.name)).toEqual(["late_tool"]);
		expect(payload.input.some((item) => item.type === "additional_tools")).toBe(false);
		expect(payload.input.filter((item) => item.role === "developer")).toHaveLength(2);
	});

	test("anchors Kimi additions in tool-bearing system messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool"]);
		expect(payload.messages.find((message) => message.tools)?.tools?.map((value) => value.function?.name)).toEqual([
			"late_tool",
		]);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", undefined, "updated guidance"],
		);
	});

	test("keeps Kimi K2 system text inline without dynamic tool messages", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			api: "openai-completions",
			provider: "moonshotai",
			compat: { supportsMidConvoSystemMessages: true },
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string; tools?: Array<{ function?: { name: string } }> }>;
		}>(model, additionContext);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
		expect(payload.messages.filter((message) => message.role === "system").map((message) => message.content)).toEqual(
			["base prompt", "updated guidance"],
		);
	});

	test("folds OpenAI-compatible updates into the system prompt without native support", async () => {
		const model: Model<"openai-completions"> = {
			...modelBase,
			id: "custom-model",
			name: "Custom model",
			api: "openai-completions",
			provider: "custom-provider",
			reasoning: false,
		};
		const payload = await capturePayload<{
			tools?: Array<{ function?: { name: string } }>;
			messages: Array<{ role: string; content?: string }>;
		}>(model, context);

		expect(payload.tools?.map((value) => value.function?.name)).toEqual(["late_tool"]);
		expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(payload.messages[0]?.content).toBe("base prompt\n\nupdated guidance\n\n<rules>\nnew rules\n</rules>");
	});
});
