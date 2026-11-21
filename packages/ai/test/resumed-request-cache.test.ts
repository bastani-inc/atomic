import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, it } from "vitest";
import {
	type AnthropicOptions,
	stream as streamAnthropic,
	streamSimple as streamSimpleAnthropic,
} from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { fitThinkingBudget } from "../src/api/simple-options.ts";
import { getModel } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	StreamOptions,
	SystemMessage,
	Tool,
	TranscriptContext,
} from "../src/types.ts";
import { appendSystemMessageUpdates, collapseSystemMessages } from "../src/utils/transcript.ts";

/**
 * The first request after a resume asks for a cache breakpoint where the last request before the exit ended (the
 * `cacheBreakpoint` hint on the restored history's last message), so the provider finds that prefix however many
 * blocks the resume appends: Claude looks back only about 20 blocks from each breakpoint.
 */

class PayloadCaptured extends Error {}
type Payload = Record<string, unknown>;
type StreamFunction = (model: Model<Api>, context: TranscriptContext, options: StreamOptions) => AssistantMessageEventStream;

async function capture(stream: StreamFunction, model: Model<Api>, messages: Message[], apiKey?: string): Promise<Payload> {
	let payload: Payload | undefined;
	const result = stream(model, { messages } as TranscriptContext, {
		...(apiKey ? { apiKey } : {}),
		onPayload: (request) => {
			payload = structuredClone(request) as Payload;
			throw new PayloadCaptured();
		},
	});
	for await (const event of result) if (event.type === "error" || event.type === "done") break;
	if (!payload) throw new Error("no request was built");
	return payload;
}

const readTool: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };

function reply(model: Model<Api>, text: string, timestamp: number, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...extra,
	};
}

/** A restored history whose last reply carries the hint, then 25 user messages a resume appended. */
function resumedHistory(model: Model<Api>): Message[] {
	return [
		{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
		{ role: "user", content: "first", timestamp: 2 },
		{ ...reply(model, "first answer", 3), cacheBreakpoint: true },
		...Array.from({ length: 25 }, (_, index): Message => ({ role: "user", content: `resumed ${index}`, timestamp: 4 + index })),
	];
}

type AnthropicBlock = { type: string; text?: string; cache_control?: unknown };
type AnthropicPayload = { system?: AnthropicBlock[]; tools?: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: string | AnthropicBlock[] }> };

function markedMessages(payload: AnthropicPayload): number[] {
	return payload.messages.flatMap((message, index) =>
		Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : [],
	);
}

function markerCount(payload: AnthropicPayload): number {
	const blocks = [
		...(payload.system ?? []),
		...(payload.tools ?? []),
		...payload.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
	];
	return blocks.filter((block) => (block as { cache_control?: unknown }).cache_control).length;
}

const offline = { baseUrl: "http://127.0.0.1:9" };

describe("a resumed request's checkpoint breakpoint", () => {
	for (const id of ["claude-opus-5-5", "claude-sonnet-4-6"] as const) {
		it(`Anthropic ${id}: marks the input before the restored reply and keeps the newest input marked`, async () => {
			const model = { ...getModel("anthropic", id), ...offline };
			const payload = (await capture(streamAnthropic as StreamFunction, model, resumedHistory(model), "sk-ant-test")) as AnthropicPayload;
			const firstInput = payload.messages.findIndex((message) => message.role === "user");
			const newestInput = payload.messages.findLastIndex((message) => message.role === "user");
			assert.deepEqual(markedMessages(payload), [firstInput, newestInput]);
			assert.ok(markerCount(payload) <= 4);
		});
	}

	it("Anthropic: no hint, no checkpoint (a session that kept running)", async () => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-6"), ...offline };
		// Few enough new messages that the newest breakpoint reaches back to the previous request's.
		const history = resumedHistory(model)
			.slice(0, 6)
			.map((message) => (message.role === "assistant" ? { ...message, cacheBreakpoint: undefined } : message));
		const payload = (await capture(streamAnthropic as StreamFunction, model, history, "sk-ant-test")) as AnthropicPayload;
		assert.deepEqual(markedMessages(payload), [payload.messages.length - 1]);
	});

	it("Anthropic OAuth: the identity block's breakpoint makes room, so the request keeps Claude's four", async () => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-6"), ...offline };
		const payload = (await capture(
			streamAnthropic as StreamFunction,
			model,
			resumedHistory(model),
			"sk-ant-oat01-test",
		)) as AnthropicPayload;
		assert.equal(markerCount(payload), 4);
		assert.equal(payload.system?.[0]?.cache_control, undefined);
		assert.ok(payload.system?.[1]?.cache_control);
		assert.equal(markedMessages(payload).length, 2);
	});

	it("Bedrock: puts a cache point after the input before the restored reply", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");
		const payload = (await capture(streamBedrock as StreamFunction, model, resumedHistory(model))) as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};
		const points = payload.messages.flatMap((message, index) =>
			message.content.some((block) => "cachePoint" in block) ? [index] : [],
		);
		assert.deepEqual(points, [0, payload.messages.length - 1]);
	});

	it("OpenAI-compatible Claude routes: marks the input before the restored reply", async () => {
		const model: Model<"openai-completions"> = {
			...offline,
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "openrouter",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 1_000,
		};
		const payload = (await capture(streamCompletions as StreamFunction, model, resumedHistory(model), "test-key")) as {
			messages: Array<{ role: string; content: string | Array<{ cache_control?: unknown }> }>;
		};
		const marked = payload.messages.flatMap((message, index) =>
			Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : [],
		);
		assert.deepEqual(marked, [0, 1, payload.messages.length - 1]);
	});
});

describe("a resumed session keeps its strict-tool fallback", () => {
	afterEach(() => cleanupSessionResources());

	const model: Model<"anthropic-messages"> = {
		id: "claude-haiku-4-5",
		name: "Test Claude",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://anthropic.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 100,
		compat: { supportsStrictTools: true },
	};
	const preferred: Tool = {
		name: "lookup",
		description: "Look up a value",
		parameters: Type.Object({ value: Type.String() }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	function success(): Response {
		const events = [
			{ type: "message_start", message: { id: "msg", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	}
	async function firstAttempt(restored: Partial<AssistantMessage>) {
		const bodies: Array<{ tools?: Array<{ strict?: boolean }> }> = [];
		const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
			bodies.push(JSON.parse(init?.body as string));
			return success();
		};
		const messages: Message[] = [
			{ role: "system", content: "Be brief.", toolsAdded: [preferred], timestamp: 1 },
			{ role: "user", content: "first", timestamp: 2 },
			reply(model, "first answer", 3, restored),
			{ role: "user", content: "after the resume", timestamp: 4 },
		];
		const result = await streamAnthropic(model, { messages } as TranscriptContext, {
			apiKey: "test-key",
			fetch,
			maxRetries: 0,
			sessionId: "resumed-session",
		}).result();
		return { result, bodies };
	}

	it("sends no strict schemas when a restored reply recorded the rejection", async () => {
		const { result, bodies } = await firstAttempt({
			diagnostics: [{ type: "anthropic_strict_tools_fallback", timestamp: 3 }],
		});
		assert.equal(bodies.length, 1);
		assert.equal(bodies[0]?.tools?.[0]?.strict, undefined);
		assert.equal(result.strictToolsDisabled, true);
	});

	it("sends no strict schemas when a restored reply was sent without them, as after a compaction dropped the rejection", async () => {
		const { bodies } = await firstAttempt({ strictToolsDisabled: true });
		assert.equal(bodies[0]?.tools?.[0]?.strict, undefined);
	});

	it("sends strict schemas when nothing recorded a rejection", async () => {
		const { result, bodies } = await firstAttempt({});
		assert.equal(bodies[0]?.tools?.[0]?.strict, true);
		assert.equal(result.strictToolsDisabled, undefined);
	});
});

describe("a session whose earlier version folded prompt updates into its leading prompt", () => {
	it("rewrites the cached prompt once after the upgrade, and every later request extends that request", () => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-6"), ...offline };
		const history: Message[] = [
			{ role: "system", content: "", sections: { preamble: "Base.", date: "<date>\n1\n</date>" }, timestamp: 1 },
			{ role: "user", content: "first", timestamp: 2 },
			reply(model, "first answer", 3),
			{ role: "system", content: "", sections: { date: "<date>\n2\n</date>" }, timestamp: 4 },
			{ role: "user", content: "second", timestamp: 5 },
			reply(model, "second answer", 6),
		];
		const update: SystemMessage = { role: "system", content: "", sections: { date: "<date>\n3\n</date>" }, timestamp: 9 };
		const beforeUpgrade = collapseSystemMessages({ messages: history } as TranscriptContext).messages;
		const firstAfterUpgrade = appendSystemMessageUpdates({
			messages: [...history, { role: "user", content: "third", timestamp: 7 }],
		} as TranscriptContext).messages;
		const later = appendSystemMessageUpdates({
			messages: [
				...history,
				{ role: "user", content: "third", timestamp: 7 },
				reply(model, "third answer", 8),
				update,
				{ role: "user", content: "fourth", timestamp: 10 },
			],
		} as TranscriptContext).messages;

		assert.notDeepEqual(firstAfterUpgrade[0], beforeUpgrade[0]);
		assert.deepEqual(later.slice(0, firstAfterUpgrade.length), firstAfterUpgrade);
	});
});

describe("a budget-based thinking request near the context window", () => {
	const model: Model<"anthropic-messages"> = { ...getModel("anthropic", "claude-sonnet-4-5"), ...offline, contextWindow: 32_768, maxTokens: 32_768 };

	/** A context ending with a reply that reports `inputTokens` input, which the estimate takes as its size. */
	function contextWithInput(inputTokens: number): Message[] {
		return [
			{ role: "user", content: "first", timestamp: 1 },
			{
				...reply(model, "first answer", 2),
				usage: {
					input: inputTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: inputTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		];
	}

	it("keeps the budget whenever it and the answer room fit under the context safety margin", () => {
		const context = { messages: contextWithInput(16_000) } as TranscriptContext;
		assert.deepEqual(fitThinkingBudget(model, context, 32_768, 8_192), { maxTokens: 12_672, thinkingBudget: 8_192 });
	});

	it("lowers the budget by exactly what the ceiling under the safety margin lacks, never closer to the window", () => {
		const context = { messages: contextWithInput(20_741) } as TranscriptContext;
		const fitted = fitThinkingBudget(model, context, 32_768, 8_192);
		assert.deepEqual(fitted, { maxTokens: 7_931, thinkingBudget: 6_907 });
		assert.ok(fitted.maxTokens <= 32_768 - 20_741 - 4_096);
	});

	it("does not count a tool declared again unchanged, which a request without mid-conversation tool changes does not send again (#6117)", () => {
		const searchTool = (description: string): Tool => ({
			name: "search",
			description,
			parameters: Type.Object({ query: Type.String() }),
		});
		const declared = searchTool("a".repeat(14_000));
		const redeclared = (tool: Tool): Message[] => [
			{ role: "system", content: "You are a coding assistant.", toolsAdded: [declared], timestamp: 0 },
			...contextWithInput(16_000),
			// A resume declares the tool again. Without mid-conversation tool changes the request declares the current
			// tools once, at the top.
			{ role: "system", content: "", toolsRemoved: [{ name: "search" }], toolsAdded: [tool], timestamp: 3 },
			{ role: "user", content: "next", timestamp: 4 },
		];
		// Unchanged: only the 16,000 reported and 2 for "next" count; 32,768 - 16,002 - 4,096 = 12,670 keeps the budget.
		assert.deepEqual(fitThinkingBudget(model, { messages: redeclared(declared) } as TranscriptContext, 32_768, 8_192), {
			maxTokens: 12_670,
			thinkingBudget: 8_192,
		});
		// A changed definition counts in full (14,129 characters of JSON, 4,037 tokens), however long the old one was:
		// 32,768 - 20,039 - 4,096 = 8,633.
		assert.deepEqual(
			fitThinkingBudget(
				model,
				{ messages: redeclared(searchTool("b".repeat(14_000))) } as TranscriptContext,
				32_768,
				8_192,
			),
			{ maxTokens: 8_633, thinkingBudget: 7_609 },
		);
	});

	it("sends a configured budget below the minimum unchanged while it fits, as some compatible endpoints accept it", () => {
		const context = { messages: contextWithInput(16_000) } as TranscriptContext;
		assert.deepEqual(fitThinkingBudget(model, context, 32_768, 512), { maxTokens: 12_672, thinkingBudget: 512 });
	});

	it("sends no thinking, not a budget Claude rejects, when not even the smallest budget fits", async () => {
		const context = { messages: contextWithInput(27_455) } as TranscriptContext;
		assert.equal(fitThinkingBudget(model, context, 32_768, 8_192), undefined);
		let payload: { thinking?: { type: string; budget_tokens?: number }; max_tokens: number } | undefined;
		const result = streamSimpleAnthropic(model, context, {
			apiKey: "sk-ant-test",
			reasoning: "medium",
			onPayload: (request) => {
				payload = structuredClone(request) as typeof payload;
				throw new PayloadCaptured();
			},
		});
		for await (const event of result) if (event.type === "error" || event.type === "done") break;
		assert.notEqual(payload?.thinking?.type, "enabled");
		assert.ok((payload?.max_tokens ?? 0) >= 1);
	});
});
