import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	StreamOptions,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "../src/types.ts";

/**
 * Claude finds the previous request's cached prefix only within 20 positions of a breakpoint. When one turn adds more
 * than that, the request also puts a breakpoint where the previous request put its newest one.
 */

class PayloadCaptured extends Error {}
type StreamFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options: StreamOptions,
) => AssistantMessageEventStream;

async function capture<T>(
	stream: StreamFunction,
	model: Model<Api>,
	messages: Message[],
	options: StreamOptions = {},
): Promise<T> {
	let payload: T | undefined;
	const result = stream(model, { messages } as TranscriptContext, {
		...options,
		onPayload: (request) => {
			payload = structuredClone(request) as T;
			throw new PayloadCaptured();
		},
	});
	for await (const event of result) if (event.type === "error" || event.type === "done") break;
	if (!payload) throw new Error("no request was built");
	return payload;
}

const readTool: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };
const offline = { baseUrl: "http://127.0.0.1:9" };
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(
	model: Model<Api>,
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 3,
		...extra,
	};
}

function calls(count: number): ToolCall[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "toolCall",
		id: `toolu_${index}`,
		name: "read",
		arguments: { path: `file-${index}.ts` },
	}));
}

function results(count: number): ToolResultMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		role: "toolResult",
		toolCallId: `toolu_${index}`,
		toolName: "read",
		content: [{ type: "text", text: `contents of file ${index}` }],
		isError: false,
		timestamp: 4 + index,
	}));
}

/**
 * The previous request sent the system prompt and "read these files"; its reply asked for `count` reads, and this
 * request sends their results. With `text`, the reply also has a text block before its tool calls.
 */
function parallelReads(model: Model<Api>, count: number, text = false): Message[] {
	return [
		{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
		{ role: "user", content: "read these files", timestamp: 2 },
		reply(model, [...(text ? [{ type: "text" as const, text: "Reading them." }] : []), ...calls(count)]),
		...results(count),
	];
}

type AnthropicBlock = { type: string; text?: string; cache_control?: unknown };
type AnthropicPayload = {
	system?: AnthropicBlock[];
	tools?: Array<{ cache_control?: unknown }>;
	messages: Array<{ role: string; content: string | AnthropicBlock[] }>;
};

/** Each marked block as [message index, block index]. */
function anthropicMarks(payload: AnthropicPayload): Array<[number, number]> {
	return payload.messages.flatMap((message, index) =>
		Array.isArray(message.content)
			? message.content.flatMap(
					(block, blockIndex): Array<[number, number]> => (block.cache_control ? [[index, blockIndex]] : []),
				)
			: [],
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

function lastBlock(payload: AnthropicPayload): [number, number] {
	const index = payload.messages.length - 1;
	const content = payload.messages[index]!.content;
	return [index, Array.isArray(content) ? content.length - 1 : 0];
}

describe("Anthropic: a turn that adds 20 or more positions", () => {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5"), ...offline };

	it("marks where the previous request ended when one turn adds more than 20 blocks (#6103)", async () => {
		const payload = await capture<AnthropicPayload>(
			streamAnthropic as StreamFunction,
			model,
			parallelReads(model, 12),
			{
				apiKey: "sk-ant-test",
			},
		);
		// The first user message ended the previous request; 12 tool calls and 12 results follow it.
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
		assert.equal(markerCount(payload), 4);
	});

	it("marks the previous request's end at exactly 20 positions, and leaves a 19-position turn as it was (#6103)", async () => {
		// 10 tool calls and 10 results: 20 positions after the previous request's breakpoint.
		const twenty = await capture<AnthropicPayload>(
			streamAnthropic as StreamFunction,
			model,
			parallelReads(model, 10),
			{
				apiKey: "sk-ant-test",
			},
		);
		assert.deepEqual(anthropicMarks(twenty), [[0, 0], lastBlock(twenty)]);
		// A text block, 9 tool calls and 9 results: 19 positions, which the newest breakpoint still reaches.
		const nineteen = await capture<AnthropicPayload>(
			streamAnthropic as StreamFunction,
			model,
			parallelReads(model, 9, true),
			{ apiKey: "sk-ant-test" },
		);
		assert.deepEqual(anthropicMarks(nineteen), [lastBlock(nineteen)]);
	});

	it("counts from the request the last answered reply came from, past a failed and an aborted attempt (#6103)", async () => {
		const messages: Message[] = [
			...parallelReads(model, 10),
			reply(model, [], { stopReason: "error", errorMessage: "overloaded" }),
			reply(model, [{ type: "text", text: "partial" }], { stopReason: "aborted" }),
			{ role: "user", content: "go on", timestamp: 20 },
		];
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
	});

	it("counts the effort markers a request sends before earlier replies (#6103)", async () => {
		const managed = { ...getModel("anthropic", "claude-opus-5-5"), ...offline };
		// A text block and 9 tool calls with a recorded effort, then 9 results: 19 blocks and the reply's effort marker.
		const messages = parallelReads(managed, 9, true).map((message) =>
			message.role === "assistant" ? { ...message, providerThinkingLevel: "high" } : message,
		);
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, managed, messages, {
			apiKey: "sk-ant-test",
		});
		const marks = anthropicMarks(payload);
		assert.equal(marks.length, 2);
		assert.deepEqual(marks[0], [0, 0]);
	});

	it("OAuth: the identity block's breakpoint gives way only while the request needs the extra one (#6103)", async () => {
		const wide = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, parallelReads(model, 12), {
			apiKey: "sk-ant-oat01-test",
		});
		assert.equal(markerCount(wide), 4);
		assert.equal(wide.system?.[0]?.cache_control, undefined);
		assert.ok(wide.system?.[1]?.cache_control);
		assert.ok(wide.tools?.at(-1)?.cache_control);
		const short = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, parallelReads(model, 2), {
			apiKey: "sk-ant-oat01-test",
		});
		assert.equal(markerCount(short), 4);
		assert.ok(short.system?.[0]?.cache_control);
		assert.deepEqual(anthropicMarks(short), [lastBlock(short)]);
	});

	it("adds no breakpoint with cacheRetention none (#6103)", async () => {
		const payload = await capture<AnthropicPayload>(
			streamAnthropic as StreamFunction,
			model,
			parallelReads(model, 12),
			{
				apiKey: "sk-ant-test",
				cacheRetention: "none",
			},
		);
		assert.equal(markerCount(payload), 0);
	});

	it("a resumed request whose prompt update and input join the restored tool results marks where the last request ended (#6103)", async () => {
		// Restored history ending with tool results, which the last request before the exit sent; the resume adds a
		// prompt update and the user's input with many blocks, all of which join the tool results' user message.
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
			{ role: "user", content: "read it", timestamp: 2 },
			reply(model, calls(1)),
			{ ...results(1)[0]!, cacheBreakpoint: true },
			{ role: "system", content: "", sections: { date: "Today is Saturday." }, timestamp: 10 },
			{
				role: "user",
				content: Array.from({ length: 40 }, (_, index) => ({ type: "text" as const, text: `line ${index}` })),
				timestamp: 11,
			},
		];
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		const last = lastBlock(payload);
		assert.deepEqual(anthropicMarks(payload), [[last[0], 0], last]);
		assert.equal((payload.messages[last[0]]!.content as AnthropicBlock[])[0]!.type, "tool_result");
	});
});

describe("Bedrock: a turn that adds 20 or more blocks", () => {
	const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");
	type BedrockPayload = { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
	const cachePoints = (payload: BedrockPayload): Array<[number, number]> =>
		payload.messages.flatMap((message, index) =>
			message.content.flatMap(
				(block, blockIndex): Array<[number, number]> => ("cachePoint" in block ? [[index, blockIndex]] : []),
			),
		);

	it("puts a cache point where the previous request ended when one turn adds more than 20 blocks (#6103)", async () => {
		const payload = await capture<BedrockPayload>(streamBedrock as StreamFunction, model, parallelReads(model, 12));
		const last = payload.messages.length - 1;
		assert.deepEqual(cachePoints(payload), [
			[0, 1],
			[last, payload.messages[last]!.content.length - 1],
		]);
	});

	it("leaves a 19-block turn with its one cache point (#6103)", async () => {
		const payload = await capture<BedrockPayload>(
			streamBedrock as StreamFunction,
			model,
			parallelReads(model, 9, true),
		);
		const last = payload.messages.length - 1;
		assert.deepEqual(cachePoints(payload), [[last, payload.messages[last]!.content.length - 1]]);
	});
});

describe("OpenAI-compatible Claude routes: a turn that adds 20 or more positions", () => {
	const model: Model<"openai-completions"> = {
		...offline,
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "openrouter",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_000,
	};
	type CompletionsPayload = {
		messages: Array<{ role: string; content: string | null | Array<{ type: string; cache_control?: unknown }> }>;
	};
	const marked = (payload: CompletionsPayload): number[] =>
		payload.messages.flatMap((message, index) =>
			Array.isArray(message.content) && message.content.some((part) => part.cache_control) ? [index] : [],
		);
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

	it("marks the input before the reply when one turn adds more than 20 positions (#6103)", async () => {
		const payload = await capture<CompletionsPayload>(
			streamCompletions as StreamFunction,
			model,
			parallelReads(model, 10),
			{ apiKey: "test-key" },
		);
		// The system prompt, the previous request's newest input and the newest tool result.
		assert.deepEqual(marked(payload), [0, 1, payload.messages.length - 1]);
	});

	it("leaves a 19-position turn with only its newest breakpoint (#6103)", async () => {
		const payload = await capture<CompletionsPayload>(
			streamCompletions as StreamFunction,
			model,
			parallelReads(model, 9),
			{ apiKey: "test-key" },
		);
		assert.deepEqual(marked(payload), [0, payload.messages.length - 1]);
	});

	it("measures from the previous breakpoint's text, before the images that followed it (#6103)", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", timestamp: 1 },
			{
				role: "user",
				content: [{ type: "text", text: "look" }, ...Array.from({ length: 19 }, () => image)],
				timestamp: 2,
			},
			reply(model, [{ type: "text", text: "Seen." }]),
			{ role: "user", content: "next", timestamp: 4 },
		];
		const payload = await capture<CompletionsPayload>(streamCompletions as StreamFunction, model, messages, {
			apiKey: "test-key",
		});
		// The previous breakpoint was on "look"; 19 images, the reply and "next" follow it: 21 positions.
		assert.deepEqual(marked(payload), [0, 1, 3]);
	});

	it("marks the reply the previous request's newest breakpoint went on when its last input had no text (#6103)", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", timestamp: 1 },
			{ role: "user", content: "first", timestamp: 2 },
			reply(model, [{ type: "text", text: "first answer" }]),
			{ role: "user", content: [image], timestamp: 4 },
			reply(model, [{ type: "text", text: "Reading them." }, ...calls(10)]),
			...results(10),
		];
		const payload = await capture<CompletionsPayload>(streamCompletions as StreamFunction, model, messages, {
			apiKey: "test-key",
		});
		// The previous request ended with an image-only message, so its newest breakpoint was on "first answer".
		assert.deepEqual(marked(payload), [0, 2, payload.messages.length - 1]);
	});
});
