import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";

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
	UserMessage,
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
	const model = { ...getFixtureModel("anthropic", "claude-sonnet-4-5"), ...offline };

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
		const managed = { ...getFixtureModel("anthropic", "claude-opus-5-5"), ...offline };
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

describe("Anthropic on the Claude API: a run of tool calls or tool results is one position", () => {
	const model = getFixtureModel("anthropic", "claude-sonnet-4-5");
	const capturePayload = (messages: Message[], apiKey = "sk-ant-test") =>
		capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, { apiKey });

	it("adds no breakpoint for a turn of many parallel tool calls and their results", async () => {
		// 12 tool calls and 12 results are two positions.
		const payload = await capturePayload(parallelReads(model, 12));
		assert.deepEqual(anthropicMarks(payload), [lastBlock(payload)]);
		const oauth = await capturePayload(parallelReads(model, 12), "sk-ant-oat01-test");
		assert.ok(oauth.system?.[0]?.cache_control, "the identity block keeps its breakpoint");
	});

	it("counts each run once, so a text block between tool calls starts another", async () => {
		// The previous request ended with "read these files". The reply has 16 text blocks, two tool calls, a text block
		// and two more tool calls (four runs of positions after the texts), and this request sends four results.
		const texts = Array.from({ length: 16 }, (_, index) => ({ type: "text" as const, text: `note ${index}` }));
		const [first, second, third, fourth] = calls(4);
		const split: Message[] = [
			...parallelReads(model, 0).slice(0, 2),
			reply(model, [...texts, first!, second!, { type: "text", text: "and" }, third!, fourth!]),
			...results(4),
		];
		// 16 texts, a run of two calls, a text, a run of two calls and a run of four results: 20 positions.
		const payload = await capturePayload(split);
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
		// Without the text between them the four calls are one run: 18 positions.
		const joined: Message[] = [
			...parallelReads(model, 0).slice(0, 2),
			reply(model, [...texts, ...calls(4)]),
			...results(4),
		];
		const near = await capturePayload(joined);
		assert.deepEqual(anthropicMarks(near), [lastBlock(near)]);
	});
});

/** A user message of `count` text blocks. */
function lines(count: number, prefix: string): UserMessage {
	return {
		role: "user",
		content: Array.from({ length: count }, (_, index) => ({ type: "text" as const, text: `${prefix} ${index}` })),
		timestamp: 5,
	};
}

/**
 * The last answered request ended with "start". With `empty`, its reply sent nothing and the request after it (20 more
 * blocks) is the last answered one. The next request got no reply before the exit, so the resume hints a breakpoint at
 * its end (24 blocks); the first request after the resume adds `added` blocks.
 */
function unansweredBeforeResume(model: Model<Api>, added: number, tools = true): Message[] {
	return [
		{
			role: "system",
			content: "You are a coding assistant.",
			...(tools ? { toolsAdded: [readTool] } : {}),
			timestamp: 1,
		},
		{ role: "user", content: "start", timestamp: 2 },
		reply(model, [{ type: "text", text: "Started." }]),
		{ ...lines(24, "pasted"), cacheBreakpoint: true },
		lines(added, "resumed"),
	];
}

describe("Anthropic: a resumed request whose restored history ends with a request no reply answered", () => {
	const model = { ...getFixtureModel("anthropic", "claude-sonnet-4-5"), ...offline };
	const resumed = (added: number, tools = true) => unansweredBeforeResume(model, added, tools);

	it("keeps a breakpoint where the last answered request ended when the hinted one is 20 or more positions past it", async () => {
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, resumed(25), {
			apiKey: "sk-ant-test",
		});
		// The tools, the system prompt and the newest input take three breakpoints; the last one goes to "start".
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
		assert.equal(markerCount(payload), 4);
	});

	it("marks both ends when the request has a breakpoint to spare for each", async () => {
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, resumed(25, false), {
			apiKey: "sk-ant-test",
		});
		assert.deepEqual(anthropicMarks(payload), [[0, 0], [2, 23], lastBlock(payload)]);
		assert.equal(markerCount(payload), 4);
		const oauth = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, resumed(25, false), {
			apiKey: "sk-ant-oat01-test",
		});
		assert.equal(oauth.system?.[0]?.cache_control, undefined);
		assert.deepEqual(anthropicMarks(oauth), [[0, 0], [2, 23], lastBlock(oauth)]);
	});

	it("OAuth: the identity block and then the hinted end give way to where the last answered request ended", async () => {
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, resumed(25), {
			apiKey: "sk-ant-oat01-test",
		});
		assert.equal(payload.system?.[0]?.cache_control, undefined);
		assert.ok(payload.system?.[1]?.cache_control);
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
		assert.equal(markerCount(payload), 4);
	});

	it("keeps only the hinted breakpoint when it reaches where the last answered request ended", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
			{ role: "user", content: "start", timestamp: 2 },
			reply(model, [{ type: "text", text: "Started." }]),
			{ ...lines(18, "pasted"), cacheBreakpoint: true },
			lines(25, "resumed"),
		];
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		// The reply and 18 blocks: 19 positions from "start" to the hinted end.
		assert.deepEqual(anthropicMarks(payload), [[2, 17], lastBlock(payload)]);
	});

	it.each([
		{ answeredBy: "another model", reply: { model: "claude-opus-4-5" } },
		{ answeredBy: "the same model with another thinking budget", reply: { thinkingBudgetTokens: 8192 } },
	])("keeps the hinted end's breakpoint when $answeredBy answered the last request", async ({ reply: answered }) => {
		const messages = resumed(25).map((message) =>
			message.role === "assistant" ? { ...message, ...answered } : message,
		);
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		// Nothing this request can read is known to be cached there, so the hint keeps its breakpoint, as before.
		assert.deepEqual(anthropicMarks(payload), [[2, 23], lastBlock(payload)]);
	});

	it("measures from the newest input when the hinted end cannot take a breakpoint", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
			{ role: "user", content: "start", timestamp: 2 },
			reply(model, [{ type: "text", text: "Started." }]),
			{
				role: "user",
				content: [{ type: "document", data: "JVBERi0=", mimeType: "application/pdf" }],
				timestamp: 4,
				cacheBreakpoint: true,
			},
			lines(24, "resumed"),
		];
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		// A document takes no breakpoint, so only the newest input's could find "start", 26 positions back.
		assert.deepEqual(anthropicMarks(payload), [[0, 0], lastBlock(payload)]);
	});

	it("counts from a reply that sent nothing, which still answered its request", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", toolsAdded: [readTool], timestamp: 1 },
			{ role: "user", content: "start", timestamp: 2 },
			reply(model, [{ type: "text", text: "Started." }]),
			lines(20, "pasted"),
			reply(model, []),
			lines(25, "next"),
		];
		const payload = await capture<AnthropicPayload>(streamAnthropic as StreamFunction, model, messages, {
			apiKey: "sk-ant-test",
		});
		// The empty reply answered the request that ended with the pasted lines.
		assert.deepEqual(anthropicMarks(payload), [[2, 19], lastBlock(payload)]);
	});
});

describe("Bedrock: a turn that adds 20 or more blocks", () => {
	const model = getFixtureModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");
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

	it("puts cache points at the hinted end and where the last answered request ended when they are 20 blocks apart", async () => {
		const payload = await capture<BedrockPayload>(
			streamBedrock as StreamFunction,
			model,
			unansweredBeforeResume(model, 25),
		);
		// Consecutive user messages are one message: "start", then the reply, then the pasted and resumed lines.
		const last = payload.messages.length - 1;
		assert.deepEqual(cachePoints(payload), [
			[0, 1],
			[2, 24],
			[last, payload.messages[last]!.content.length - 1],
		]);
	});

	it("counts from a reply that sent nothing, which still answered its request", async () => {
		const messages: Message[] = [
			{ role: "user", content: "start", timestamp: 2 },
			reply(model, [{ type: "text", text: "Started." }]),
			lines(20, "pasted"),
			reply(model, []),
			lines(25, "next"),
		];
		const payload = await capture<BedrockPayload>(streamBedrock as StreamFunction, model, messages);
		// The empty reply is left out, so the next lines join the pasted ones; it answered the request that ended there.
		const last = payload.messages.length - 1;
		assert.deepEqual(cachePoints(payload), [
			[2, 20],
			[last, payload.messages[last]!.content.length - 1],
		]);
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

	it("keeps the breakpoint where the last answered request ended over a hinted end 20 positions past it", async () => {
		const payload = await capture<CompletionsPayload>(
			streamCompletions as StreamFunction,
			model,
			unansweredBeforeResume(model, 25),
			{ apiKey: "test-key" },
		);
		// The system prompt, the tools, "start" and the newest input.
		assert.deepEqual(marked(payload), [0, 1, 4]);
		const noTools = await capture<CompletionsPayload>(
			streamCompletions as StreamFunction,
			model,
			unansweredBeforeResume(model, 25, false),
			{ apiKey: "test-key" },
		);
		assert.deepEqual(marked(noTools), [0, 1, 3, 4]);
	});

	it("puts a hinted breakpoint on an image-only message where that request put its newest one", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", timestamp: 1 },
			{ role: "user", content: "first", timestamp: 2 },
			reply(model, [{ type: "text", text: "first answer" }]),
			{ role: "user", content: [{ type: "text", text: "look" }], timestamp: 4 },
			{ role: "user", content: [image], timestamp: 5, cacheBreakpoint: true },
			lines(25, "resumed"),
		];
		const payload = await capture<CompletionsPayload>(streamCompletions as StreamFunction, model, messages, {
			apiKey: "test-key",
		});
		// The request that ended with the image put its newest breakpoint on "look".
		assert.deepEqual(marked(payload), [0, 3, 5]);
	});

	it("counts from a reply that sent nothing, which still answered its request", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are a coding assistant.", timestamp: 1 },
			{ role: "user", content: "start", timestamp: 2 },
			reply(model, [{ type: "text", text: "Started." }]),
			lines(20, "pasted"),
			reply(model, []),
			lines(25, "next"),
		];
		const payload = await capture<CompletionsPayload>(streamCompletions as StreamFunction, model, messages, {
			apiKey: "test-key",
		});
		assert.deepEqual(marked(payload), [0, 3, 4]);
	});
});
