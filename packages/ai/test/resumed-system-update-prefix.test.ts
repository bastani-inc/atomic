import { describe, expect, test } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	StreamOptions,
	SystemMessage,
	TranscriptContext,
} from "../src/types.ts";
import { TOOL_RESULTS_BRIDGE_TEXT } from "../src/utils/tool-results-bridge.ts";
import {
	appendSystemMessageUpdates,
	declarationsEqual,
	followsToolResults,
	getToolStateChanges,
	jsonSchemasEqual,
} from "../src/utils/transcript.ts";

/**
 * A session on a transport without mid-conversation system messages exits, and the version it resumes in changes
 * prompt sections (the date, a docs path). The first request after the resume must start with the last request before
 * the exit, as a session that kept running would have sent it: the leading system prompt is the one the cache holds,
 * and the changes follow the cached history.
 */

class PayloadCaptured extends Error {}

type Payload = Record<string, unknown>;
type StreamFunction = (model: Model<Api>, context: TranscriptContext, options: StreamOptions) => AssistantMessageEventStream;

function codexToken(): string {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }));
	return `aaa.${claims.toString("base64")}.bbb`;
}

const offline = { baseUrl: "http://127.0.0.1:9", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

interface Transport {
	name: string;
	model: Model<Api>;
	stream: StreamFunction;
	apiKey?: string;
	/** The payload field holding the conversation; every other field must not change. */
	conversation: "messages" | "contents" | "input";
	/** No user message may follow a tool message, so a fixed assistant message goes between them. */
	bridgesToolResults?: boolean;
}

const transports: Transport[] = [
	{
		name: "Anthropic Messages without mid-conversation system messages",
		model: { ...getModel("anthropic", "claude-sonnet-4-6"), ...offline },
		stream: streamAnthropic as StreamFunction,
		apiKey: "test-key",
		conversation: "messages",
	},
	{
		name: "Bedrock Converse",
		model: getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1"),
		stream: streamBedrock as StreamFunction,
		conversation: "messages",
	},
	{
		name: "Google Generative AI",
		model: { ...getModel("google", "gemini-2.5-flash"), ...offline },
		stream: streamGoogle as StreamFunction,
		apiKey: "test-key",
		conversation: "contents",
	},
	{
		name: "Google Vertex",
		model: { ...getModel("google-vertex", "gemini-2.5-flash"), ...offline },
		stream: streamVertex as StreamFunction,
		apiKey: "test-key",
		conversation: "contents",
	},
	{
		name: "OpenAI Chat Completions",
		model: {
			...offline,
			id: "custom-model",
			name: "Custom model",
			api: "openai-completions",
			provider: "custom-provider",
			reasoning: false,
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 1_000,
		},
		stream: streamCompletions as StreamFunction,
		apiKey: "test-key",
		conversation: "messages",
	},
	{
		name: "OpenAI Responses",
		model: {
			...offline,
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-responses",
			provider: "openai",
			reasoning: false,
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 1_000,
		},
		stream: streamResponses as StreamFunction,
		apiKey: "test-key",
		conversation: "input",
	},
	{
		name: "Azure OpenAI Responses",
		model: {
			...offline,
			baseUrl: "http://127.0.0.1:9/openai/v1",
			id: "test-deployment",
			name: "Test deployment",
			api: "azure-openai-responses",
			provider: "azure",
			reasoning: false,
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 1_000,
		},
		stream: streamAzure as StreamFunction,
		apiKey: "test-key",
		conversation: "input",
	},
	{
		name: "OpenAI Codex Responses",
		model: {
			...offline,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			reasoning: true,
			input: ["text"],
			contextWindow: 400_000,
			maxTokens: 128_000,
		},
		stream: streamCodex as StreamFunction,
		apiKey: codexToken(),
		conversation: "input",
	},
	{
		name: "Mistral Conversations",
		model: { ...getModel("mistral", "devstral-latest"), ...offline },
		stream: streamMistral as StreamFunction,
		apiKey: "test-key",
		conversation: "messages",
		bridgesToolResults: true,
	},
	{
		name: "OpenAI Chat Completions on a host whose template rejects a user message after a tool message",
		model: {
			...offline,
			id: "strict-template-model",
			name: "Strict template model",
			api: "openai-completions",
			provider: "custom-provider",
			reasoning: false,
			input: ["text"],
			contextWindow: 100_000,
			maxTokens: 1_000,
			compat: { requiresAssistantAfterToolResult: true },
		},
		stream: streamCompletions as StreamFunction,
		apiKey: "test-key",
		conversation: "messages",
		bridgesToolResults: true,
	},
];

async function capture(transport: Transport, messages: Message[]): Promise<Payload> {
	let payload: Payload | undefined;
	const result = transport.stream(
		transport.model,
		{ messages } as TranscriptContext,
		{
			...(transport.apiKey ? { apiKey: transport.apiKey } : {}),
			onPayload: (request) => {
				payload = structuredClone(request) as Payload;
				throw new PayloadCaptured();
			},
		},
	);
	for await (const event of result) if (event.type === "error" || event.type === "done") break;
	if (!payload) throw new Error(`${transport.name}: no request was built`);
	return payload;
}

/** Drops cache markers, which move to the newest input on every request, and sends string content as a text block. */
function withoutCacheMarkers(value: unknown): unknown {
	if (Array.isArray(value))
		return value
			.filter((item) => !(typeof item === "object" && item !== null && "cachePoint" in item))
			.map(withoutCacheMarkers);
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "cache_control") continue;
		result[key] =
			key === "content" && typeof item === "string" && "role" in value && value.role === "user"
				? [{ type: "text", text: item }]
				: withoutCacheMarkers(item);
	}
	return result;
}

function reply(model: Model<Api>, text: string, timestamp: number): AssistantMessage {
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
	};
}

const prompt: SystemMessage = {
	role: "system",
	content: "",
	sections: {
		preamble: "You are a coding assistant.",
		docs: "<docs>\nDocs: /usr/lib/node_modules/atomic/docs\n</docs>",
		date: "<date>\nCurrent date: 2026-11-19\n</date>",
	},
	toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } as never }],
	timestamp: 1,
};

/** The prompt changes a newer version installed elsewhere makes on the next day. */
const resumeUpdate: SystemMessage = {
	role: "system",
	content: "",
	sections: {
		docs: "<docs>\nDocs: /home/user/.bun/install/global/node_modules/atomic/docs\n</docs>",
		date: "<date>\nCurrent date: 2026-11-20\n</date>",
	},
	timestamp: 6,
};

describe("a resume that changes prompt sections keeps the cached request prefix on transports without mid-conversation system messages", () => {
	for (const transport of transports) {
		test(transport.name, async () => {
			const beforeExit: Message[] = [
				prompt,
				{ role: "user", content: "first", timestamp: 2 },
				reply(transport.model, "first answer", 3),
				{ role: "user", content: "second", timestamp: 4 },
			];
			const resumed: Message[] = [
				...beforeExit,
				reply(transport.model, "second answer", 5),
				resumeUpdate,
				{ role: "user", content: "after the resume", timestamp: 7 },
			];
			const last = withoutCacheMarkers(await capture(transport, beforeExit)) as Payload;
			const first = withoutCacheMarkers(await capture(transport, resumed)) as Payload;

			const { [transport.conversation]: lastConversation, ...lastSettings } = last;
			const { [transport.conversation]: firstConversation, ...firstSettings } = first;
			expect(firstSettings).toEqual(lastSettings);
			const sent = lastConversation as unknown[];
			expect((firstConversation as unknown[]).slice(0, sent.length)).toEqual(sent);
			const appended = JSON.stringify((firstConversation as unknown[]).slice(sent.length));
			expect(appended).toContain("Current date: 2026-11-20");
			expect(appended).toContain("after the resume");
		});
	}
});

describe("prompt updates keep user and assistant turns alternating, outside tool results, on transports without mid-conversation system messages", () => {
	for (const transport of transports) {
		test(transport.name, async () => {
			const call: AssistantMessage = {
				...reply(transport.model, "", 3),
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			};
			const liveUpdate: Message[] = [
				prompt,
				{ role: "user", content: "first", timestamp: 2 },
				reply(transport.model, "first answer", 3),
				resumeUpdate,
				{ role: "user", content: "second", timestamp: 7 },
			];
			const toolUpdate: Message[] = [
				prompt,
				{ role: "user", content: "first", timestamp: 2 },
				call,
				{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: false, timestamp: 4 },
				resumeUpdate,
			];
			const secondUpdate: SystemMessage = { ...resumeUpdate, sections: { model: "<model>\nB\n</model>" }, timestamp: 6 };
			const twoUpdatesThenInput: Message[] = [
				...toolUpdate,
				secondUpdate,
				{ role: "user", content: "steered", timestamp: 8 },
			];
			for (const messages of [liveUpdate, toolUpdate, [...toolUpdate, secondUpdate], twoUpdatesThenInput]) {
				const conversation = (await capture(transport, messages))[transport.conversation] as Array<{
					role?: string;
					parts?: unknown[];
				}>;
				const roles = conversation.map((item) => item.role);
				// Gemini's own shape for tool results with images is a user turn after the function responses.
				const adjacent = roles.findIndex(
					(role, index) =>
						role === "user" && roles[index - 1] === "user" && !JSON.stringify(conversation[index - 1]).includes("functionResponse"),
				);
				expect(adjacent, JSON.stringify(roles)).toBe(-1);
				// The model reads text inside a tool result as tool output, with less authority than a prompt update.
				for (const result of toolResults(conversation)) expect(JSON.stringify(result)).not.toContain("Current date");
				if (transport.conversation === "contents") {
					// Gemini gets the update as a user turn of its own after the function responses' turn.
					for (const item of conversation)
						if (JSON.stringify(item).includes("functionResponse"))
							expect(JSON.stringify(item)).not.toContain("Current date: 2026-11-20");
				}
				// Delivered with the very next request.
				expect(JSON.stringify(conversation)).toContain("Current date: 2026-11-20");
				if (transport.bridgesToolResults) {
					const tool = roles.lastIndexOf("tool");
					if (tool >= 0 && tool < roles.length - 1) {
						expect(roles.slice(tool + 1, tool + 3)).toEqual(["assistant", "user"]);
						expect(JSON.stringify(conversation[tool + 1])).toContain(TOOL_RESULTS_BRIDGE_TEXT);
					}
					expect(roles.findIndex((role, index) => role === "user" && roles[index - 1] === "tool")).toBe(-1);
				}
			}
		});
	}
});

describe("an update after tool results an earlier request sent, as on a resume after its reply was lost, leaves them unchanged", () => {
	for (const transport of transports) {
		test(transport.name, async () => {
			const call: AssistantMessage = {
				...reply(transport.model, "", 3),
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			};
			const sent: Message[] = [
				prompt,
				{ role: "user", content: "first", timestamp: 2 },
				call,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 4,
				},
			];
			const before = (await capture(transport, sent))[transport.conversation];
			const after = (await capture(transport, [...sent, resumeUpdate]))[transport.conversation];
			// Only the cache marker, which moves to the newest block on every request, may differ.
			expect(JSON.stringify(withoutCacheMarkers(toolResults(after)))).toBe(
				JSON.stringify(withoutCacheMarkers(toolResults(before))),
			);
			expect(JSON.stringify(after)).toContain("Current date: 2026-11-20");
		});
	}
});

describe("the request after an update that followed tool results extends the request that sent it", () => {
	for (const transport of transports) {
		test(transport.name, async () => {
			const call: AssistantMessage = {
				...reply(transport.model, "", 3),
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			};
			const withUpdate: Message[] = [
				prompt,
				{ role: "user", content: "first", timestamp: 2 },
				call,
				{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: false, timestamp: 4 },
				resumeUpdate,
			];
			const sent = withoutCacheMarkers((await capture(transport, withUpdate))[transport.conversation]) as unknown[];
			const next = withoutCacheMarkers(
				(
					await capture(transport, [
						...withUpdate,
						reply(transport.model, "answer", 7),
						{ role: "user", content: "next", timestamp: 8 },
					])
				)[transport.conversation],
			) as unknown[];
			expect(JSON.stringify(next.slice(0, sent.length))).toBe(JSON.stringify(sent));
		});
	}
});

/** The tool results of a conversation in any transport's format. */
function toolResults(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(toolResults);
	if (typeof value !== "object" || value === null) return [];
	const item = value as Record<string, unknown>;
	if (
		item.type === "tool_result" ||
		item.type === "function_call_output" ||
		item.role === "tool" ||
		"toolResult" in item ||
		"functionResponse" in item
	)
		return [item];
	return Object.values(item).flatMap(toolResults);
}

test("Bedrock joins input steered in after tool results into the tool results' user message", async () => {
	const bedrock = transports.find((transport) => transport.name === "Bedrock Converse")!;
	const call: AssistantMessage = {
		...reply(bedrock.model, "", 3),
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};
	const payload = await capture(bedrock, [
		prompt,
		{ role: "user", content: "first", timestamp: 2 },
		call,
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: false, timestamp: 4 },
		{ role: "user", content: "steered", timestamp: 5 },
	]);
	const messages = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
	expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
	expect(messages[2]?.content.map((block) => Object.keys(block)[0])).toEqual(["toolResult", "text", "cachePoint"]);
});

/** Every message of `before` is in `after` unchanged, except that its last one may have gained blocks at its end. */
function expectExtends(before: readonly Message[], after: readonly Message[]): void {
	expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
	const blocks = (message: Message | undefined) =>
		message === undefined || message.role === "assistant" || message.role === "system"
			? message
			: typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
	const last = blocks(before.at(-1));
	const extended = blocks(after[before.length - 1]);
	expect(Array.isArray(last) && Array.isArray(extended) ? extended.slice(0, last.length) : extended).toEqual(last);
}

describe("appendSystemMessageUpdates", () => {
	test("folds the system messages that open the conversation into the prompt, as the first request sent them", () => {
		const update: SystemMessage = { role: "system", content: "", sections: { extra: "<extra>\nx\n</extra>" }, timestamp: 2 };
		const messages: Message[] = [prompt, update, { role: "user", content: "first", timestamp: 3 }];
		const projected = appendSystemMessageUpdates({ messages } as TranscriptContext).messages;
		expect(projected.map((message) => message.role)).toEqual(["system", "user"]);
		expect((projected[0] as SystemMessage).sections).toEqual({ ...prompt.sections, extra: "<extra>\nx\n</extra>" });
	});

	test("sends a later update after the tool results that follow it, never inside them, joined by the next input", () => {
		const model = transports[0]!.model;
		const call: AssistantMessage = {
			...reply(model, "", 3),
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
			stopReason: "toolUse",
		};
		const messages: Message[] = [
			prompt,
			{ role: "user", content: "first", timestamp: 2 },
			call,
			resumeUpdate,
			{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [], isError: false, timestamp: 4 },
			{ role: "user", content: "next", timestamp: 7 },
		];
		const projected = appendSystemMessageUpdates({ messages } as TranscriptContext).messages;
		expect(projected.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult", "user"]);
		expect(JSON.stringify(projected[3])).not.toContain("Current date");
		expect(JSON.stringify(projected[4])).toContain("Current date: 2026-11-20");
		expect(JSON.stringify(projected[4])).toContain("next");
		expect(followsToolResults(projected[4]!)).toBe(true);
	});

	test("an update keeps its place when input follows it later, as after an interrupted request", () => {
		const update: SystemMessage = { role: "system", content: "", sections: { model: "<model>\nB\n</model>" }, timestamp: 4 };
		const sent: Message[] = [
			prompt,
			{ role: "user", content: "first", timestamp: 2 },
			reply(transports[0]!.model, "first answer", 3),
			{ role: "user", content: "second", timestamp: 4 },
			update,
		];
		const before = appendSystemMessageUpdates({ messages: sent } as TranscriptContext).messages;
		const after = appendSystemMessageUpdates({
			messages: [...sent, { role: "user", content: "after the resume", timestamp: 9 }],
		} as TranscriptContext).messages;
		expectExtends(before, after);
	});

	test("an update after the first input keeps its place when the first request got no reply", () => {
		const update: SystemMessage = { role: "system", content: "", sections: { extra: "<extra>\nx\n</extra>" }, timestamp: 3 };
		const sent: Message[] = [prompt, { role: "user", content: "first", timestamp: 2 }];
		const before = appendSystemMessageUpdates({ messages: sent } as TranscriptContext).messages;
		const after = appendSystemMessageUpdates({
			messages: [...sent, update, { role: "user", content: "after the resume", timestamp: 4 }],
		} as TranscriptContext).messages;
		expectExtends(before, after);
	});

	test("a legacy transcript whose first system message follows a reply still gets it as its prompt", () => {
		const model = transports[0]!.model;
		const messages: Message[] = [
			{ role: "user", content: "old", timestamp: 1 },
			reply(model, "old answer", 2),
			prompt,
			{ role: "user", content: "new", timestamp: 3 },
		];
		const projected = appendSystemMessageUpdates({ messages } as TranscriptContext).messages;
		expect(projected[0]).toMatchObject({ role: "system", sections: prompt.sections });
		expect(projected.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
	});
});

describe("tool declarations", () => {
	test("a schema rebuilt with its keys in another order is the same declaration", () => {
		const first = {
			name: "query",
			description: "Query docs",
			parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
		} as never;
		const reordered = {
			description: "Query docs",
			name: "query",
			parameters: { required: ["a"], properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
		} as never;
		expect(declarationsEqual(first, reordered)).toBe(true);
		expect(getToolStateChanges([first], [reordered])).toEqual({ toolsAdded: [], toolsRemoved: [] });
	});

	/** A tool whose `query` parameter is `schema`, at every place a schema can sit. */
	const withSchema = (schema: object, required = ["query", "list"]) =>
		({
			name: "query",
			description: "Query docs",
			parameters: {
				type: "object",
				properties: { query: schema, list: { type: "array", items: schema }, either: { anyOf: [schema, { type: "null" }] } },
				additionalProperties: schema,
				$defs: { query: schema },
				required,
			},
		}) as never;

	test("a schema that lists its required parameters in another order is the same declaration (#6130)", () => {
		const object = (required: string[]) => ({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required,
		});
		const declared = withSchema(object(["b", "a"]));
		const relisted = withSchema(object(["a", "b"]), ["list", "query"]);
		expect(declarationsEqual(declared, relisted)).toBe(true);
		expect(getToolStateChanges([declared], [relisted])).toEqual({ toolsAdded: [], toolsRemoved: [] });
	});

	test("a schema that lists its types or dependent property names in another order is the same declaration", () => {
		const object = (types: string[], dependents: string[]) => ({
			type: types,
			properties: { a: { type: types }, b: { type: "number" }, c: { type: "string" } },
			dependentRequired: { a: dependents },
			dependencies: { b: dependents, c: { type: types, required: dependents } },
		});
		const declared = withSchema(object(["object", "null"], ["b", "c"]));
		const relisted = withSchema(object(["null", "object"], ["c", "b"]));
		expect(declarationsEqual(declared, relisted)).toBe(true);
		expect(getToolStateChanges([declared], [relisted])).toEqual({ toolsAdded: [], toolsRemoved: [] });
		expect(jsonSchemasEqual(object(["object", "null"], ["b", "c"]), object(["null", "object"], ["c", "b"]))).toBe(
			true,
		);
	});

	test("types or dependent property names that differ, and the same names as values, still change a declaration", () => {
		const declared = withSchema({ type: ["object", "null"], dependentRequired: { a: ["b", "c"] } });
		const changed = [
			{ type: ["object"], dependentRequired: { a: ["b", "c"] } },
			{ type: ["object", "null", "null"], dependentRequired: { a: ["b", "c"] } },
			{ type: ["object", "string"], dependentRequired: { a: ["b", "c"] } },
			{ type: ["object", "null"], dependentRequired: { a: ["b"] } },
			{ type: ["object", "null"], dependentRequired: { a: ["b", "d"] } },
			{ type: ["object", "null"], dependentRequired: { d: ["b", "c"] } },
		];
		for (const schema of changed) {
			expect(declarationsEqual(declared, withSchema(schema)), JSON.stringify(schema)).toBe(false);
		}
		// Lists of the same words in data, and a property that is named `type`, keep their order.
		const ordered = (first: string, second: string) => [
			{ enum: [[first, second]] },
			{ const: { type: [first, second] } },
			{ default: { dependentRequired: { a: [first, second] } } },
			{ examples: [{ dependencies: { a: [first, second] } }] },
			{ type: "object", properties: { type: { enum: [first, second] } } },
			{ type: "object", properties: { dependencies: { const: [first, second] } } },
			{ dependentRequired: { a: [first === "string" ? 1 : 2, first === "string" ? 2 : 1] } },
			{ type: [first === "string" ? 1 : 2, first === "string" ? 2 : 1] },
		];
		const before = ordered("string", "null");
		const after = ordered("null", "string");
		for (const [index, schema] of before.entries()) {
			expect(declarationsEqual(withSchema(schema), withSchema(after[index]!)), JSON.stringify(schema)).toBe(false);
		}
	});

	test("required names that differ, and values whose order counts, still change a declaration (#6130)", () => {
		const declared = withSchema({ type: "object", properties: {}, required: ["a", "b"] });
		const changed = [
			{ type: "object", properties: {}, required: ["a"] },
			{ type: "object", properties: {}, required: ["a", "b", "b"] },
			{ type: "object", properties: {}, required: ["a", "c"] },
		];
		for (const schema of changed) {
			expect(declarationsEqual(declared, withSchema(schema))).toBe(false);
			expect(getToolStateChanges([declared], [withSchema(schema)])).toEqual({
				toolsAdded: [withSchema(schema)],
				toolsRemoved: [{ name: "query" }],
			});
		}
		// Values, examples, tuples and alternatives keep their order, as does a parameter that is itself named `required`.
		const ordered = (first: string, second: string) => [
			{ enum: [first, second] },
			{ const: { required: [first, second] } },
			{ type: "object", default: { required: [first, second] } },
			{ type: "object", examples: [{ required: [first, second] }] },
			{ type: "array", prefixItems: [{ const: first }, { const: second }] },
			{ type: "array", items: [{ const: first }, { const: second }] },
			{ oneOf: [{ const: first }, { const: second }] },
			{ type: "object", properties: { required: { enum: [first, second] } } },
			{ type: "object", required: [first === "a" ? 1 : 2, first === "a" ? 2 : 1] },
		];
		const before = ordered("a", "b");
		const after = ordered("b", "a");
		for (const [index, schema] of before.entries()) {
			expect(declarationsEqual(withSchema(schema), withSchema(after[index]!)), JSON.stringify(schema)).toBe(false);
		}
	});
});
