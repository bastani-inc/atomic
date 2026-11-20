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
import { appendSystemMessageUpdates, declarationsEqual, getToolStateChanges } from "../src/utils/transcript.ts";

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

describe("appendSystemMessageUpdates", () => {
	test("folds the system messages that open the conversation into the prompt, as the first request sent them", () => {
		const update: SystemMessage = { role: "system", content: "", sections: { extra: "<extra>\nx\n</extra>" }, timestamp: 2 };
		const messages: Message[] = [prompt, update, { role: "user", content: "first", timestamp: 3 }];
		const projected = appendSystemMessageUpdates({ messages } as TranscriptContext).messages;
		expect(projected.map((message) => message.role)).toEqual(["system", "user"]);
		expect((projected[0] as SystemMessage).sections).toEqual({ ...prompt.sections, extra: "<extra>\nx\n</extra>" });
	});

	test("sends a later update after the tool results that follow it and before the next user input", () => {
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
		expect(projected.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult", "user", "user"]);
		expect(JSON.stringify(projected[4])).toContain("Current date: 2026-11-20");
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
		expect(after.slice(0, before.length)).toEqual(before);
	});

	test("an update after the first input keeps its place when the first request got no reply", () => {
		const update: SystemMessage = { role: "system", content: "", sections: { extra: "<extra>\nx\n</extra>" }, timestamp: 3 };
		const sent: Message[] = [prompt, { role: "user", content: "first", timestamp: 2 }];
		const before = appendSystemMessageUpdates({ messages: sent } as TranscriptContext).messages;
		const after = appendSystemMessageUpdates({
			messages: [...sent, update, { role: "user", content: "after the resume", timestamp: 4 }],
		} as TranscriptContext).messages;
		expect(after.slice(0, before.length)).toEqual(before);
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
		const required = { ...(reordered as object), parameters: { type: "object", properties: {}, required: ["b", "a"] } };
		const requiredOther = { ...(reordered as object), parameters: { type: "object", properties: {}, required: ["a", "b"] } };
		expect(declarationsEqual(required as never, requiredOther as never)).toBe(false);
	});
});
