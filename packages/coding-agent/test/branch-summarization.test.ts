import assert from "node:assert/strict";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	unregisterApiProviders,
} from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { generateSessionSummary } from "../src/core/compaction/session-summarization.ts";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { ContextCompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

let counter = 0;
let lastId: string | null = null;

function resetIds(): void {
	counter = 0;
	lastId = null;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantBlocks(blocks: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function copilotModel(): Model<Api> {
	return {
		id: "gpt-5.5",
		name: "GitHub Copilot GPT-5.5",
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 4096,
	};
}

function nonCopilotModel(): Model<Api> {
	return {
		...copilotModel(),
		name: "OpenAI GPT-5.5",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
	};
}

function assistantErrorStream(model: Model<Api>, errorMessage: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
	stream.end(message);
	return stream;
}

function entry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${counter++}`;
	const result: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return result;
}

function contextEntry(targets: ContextCompactionEntry["deletedTargets"]): ContextCompactionEntry {
	const id = `entry-${counter++}`;
	const result: ContextCompactionEntry = {
		type: "context_compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		promptVersion: 1,
		deletedTargets: targets,
		protectedEntryIds: [],
		stats: {
			objectsBefore: 0,
			objectsAfter: 0,
			objectsDeleted: targets.length,
			tokensBefore: 0,
			tokensAfter: 0,
			percentReduction: 0,
		},
	};
	lastId = id;
	return result;
}

describe("safe prose summarization", () => {
	it.each([
		["branch", generateBranchSummary],
		["session", generateSessionSummary],
	] as const)("does not override tool choice for %s summaries", async (_label, summarize) => {
		resetIds();
		let requestOptions: import("@bastani/pi-ai/compat").SimpleStreamOptions | undefined;
		await summarize([entry(user("summarize safely"))], {
			model: nonCopilotModel(),
			signal: new AbortController().signal,
			streamFn: async (requestModel, _context, options) => {
				requestOptions = options;
				const stream = createAssistantMessageEventStream();
				stream.end({ ...assistantBlocks([{ type: "text", text: "summary" }]), model: requestModel.id });
				return stream;
			},
		});
		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("leaves branch summary output sizing to the provider (#11036)", async () => {
		resetIds();
		let requestOptions: import("@bastani/pi-ai/compat").SimpleStreamOptions | undefined;
		await generateBranchSummary([entry(user("summarize safely"))], {
			model: nonCopilotModel(),
			signal: new AbortController().signal,
			streamFn: async (_requestModel, _context, options) => {
				requestOptions = options;
				const stream = createAssistantMessageEventStream();
				stream.end(assistantBlocks([{ type: "text", text: "summary" }]));
				return stream;
			},
		});
		expect(requestOptions).not.toHaveProperty("maxTokens");
	});

	it.each([
		["branch", generateBranchSummary],
		["session", generateSessionSummary],
	] as const)("rejects tool calls from %s summaries", async (_label, summarize) => {
		resetIds();
		const result = await summarize([entry(user("summarize safely"))], {
			model: nonCopilotModel(),
			signal: new AbortController().signal,
			streamFn: async () => {
				const stream = createAssistantMessageEventStream();
				stream.end({
					...assistantBlocks([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
					stopReason: "toolUse",
				});
				return stream;
			},
		});
		expect(result.error).toMatch(/summarization attempted to call a tool/i);
	});

	it.each([
		["branch", generateBranchSummary],
		["session", generateSessionSummary],
	] as const)("rejects length-limited %s summaries", async (_label, summarize) => {
		resetIds();
		const result = await summarize([entry(user("summarize safely"))], {
			model: nonCopilotModel(),
			signal: new AbortController().signal,
			streamFn: async () => {
				const stream = createAssistantMessageEventStream();
				stream.end({ ...assistantBlocks([{ type: "text", text: "partial" }]), stopReason: "length" });
				return stream;
			},
		});
		expect(result.error).toContain("generation hit the token cap");
	});
});

describe("branch summarization with archival compaction entries", () => {
	it("leaves non-Copilot prompt-limit summarization errors unchanged", async () => {
		resetIds();
		const rawError = "prompt token count of 500000 exceeds the limit of 400000";
		const model = nonCopilotModel();
		const entries: SessionEntry[] = [entry(user("summarize this non-Copilot branch"))];
		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn: async (requestModel) => assistantErrorStream(requestModel, rawError),
		});

		expect(result.error).toBe(rawError);
		expect(result.error).not.toContain("Copilot long-context/usage-based billing");
	});

	it("uses the credential-specific baseUrl for direct summary dispatch", async () => {
		resetIds();
		const api = "branch-summary-endpoint-probe" as Api;
		const source = "branch-summary-endpoint-test";
		let dispatchedBaseUrl: string | undefined;
		const streamSimple = (requestModel: Model<Api>) => {
			dispatchedBaseUrl = requestModel.baseUrl;
			const stream = createAssistantMessageEventStream();
			stream.end({
				...assistantBlocks([{ type: "text", text: "summary" }]),
				api,
				provider: requestModel.provider,
				model: requestModel.id,
			});
			return stream;
		};
		registerApiProvider({ api, stream: streamSimple, streamSimple }, source);
		try {
			const model = { ...copilotModel(), api };
			const result = await generateBranchSummary([entry(user("summarize through enterprise"))], {
				model,
				apiKey: "test-key",
				baseUrl: "https://api.enterprise.example.com",
				signal: new AbortController().signal,
			});

			expect(result.error).toBeUndefined();
			expect(dispatchedBaseUrl).toBe("https://api.enterprise.example.com");
		} finally {
			unregisterApiProviders(source);
		}
	});

	it("dispatches branch summaries with header-only bearer authentication", async () => {
		resetIds();
		const model = nonCopilotModel();
		let observedApiKey: string | undefined = "not-called";
		let observedHeaders: Record<string, string | null> | undefined;
		let observedCacheRetention: string | undefined;
		let observedSessionId: string | undefined;
		const result = await generateBranchSummary([entry(user("summarize with gateway bearer auth"))], {
			model,
			headers: { Authorization: "Bearer gateway-token", "X-Custom": "preserved" },
			signal: new AbortController().signal,
			streamFn: async (requestModel, _context, options) => {
				observedApiKey = options?.apiKey;
				observedHeaders = options?.headers;
				observedCacheRetention = options?.cacheRetention;
				observedSessionId = options?.sessionId;
				const stream = createAssistantMessageEventStream();
				stream.end({
					...assistantBlocks([{ type: "text", text: "bearer summary" }]),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				});
				return stream;
			},
		});

		expect(result.error).toBeUndefined();
		expect(observedApiKey).toBeUndefined();
		expect(observedHeaders).toEqual({
			Authorization: "Bearer gateway-token",
			"X-Custom": "preserved",
		});
		expect(observedCacheRetention).toBe("none");
		expect(observedSessionId).toEqual(expect.any(String));
		const firstSessionId = observedSessionId;
		await generateBranchSummary([entry(user("summarize again"))], {
			model,
			signal: new AbortController().signal,
			streamFn: async (requestModel, _context, options) => {
				observedSessionId = options?.sessionId;
				const stream = createAssistantMessageEventStream();
				stream.end({
					...assistantBlocks([{ type: "text", text: "again" }]),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				});
				return stream;
			},
		});
		expect(observedSessionId).not.toBe(firstSessionId);
	});

	it("treats legacy logical-deletion records as inert when preparing prompt input", () => {
		resetIds();
		const deletedEntrySentinel = "ITER7_BRANCH_DELETED_ENTRY_SENTINEL";
		const deletedBlockSentinel = "ITER7_BRANCH_DELETED_BLOCK_SENTINEL";
		const retainedBlockSentinel = "ITER7_BRANCH_RETAINED_BLOCK_SENTINEL";
		const task = entry(user("branch task context"));
		const deletedEntry = entry(assistantBlocks([{ type: "text", text: deletedEntrySentinel }]));
		const partiallyDeletedEntry = entry(
			assistantBlocks([
				{ type: "text", text: deletedBlockSentinel },
				{ type: "text", text: retainedBlockSentinel },
			]),
		);
		const deletionRecord = contextEntry([
			{ kind: "entry", entryId: deletedEntry.id },
			{ kind: "content_block", entryId: partiallyDeletedEntry.id, blockIndex: 0 },
		]);
		const entries: SessionEntry[] = [task, deletedEntry, partiallyDeletedEntry, deletionRecord];

		const prepared = prepareBranchEntries(entries);
		const preparedJson = JSON.stringify(prepared.messages);
		const promptInput = serializeConversation(convertToLlm(prepared.messages));

		expect(preparedJson).toContain(deletedEntrySentinel);
		expect(preparedJson).toContain(deletedBlockSentinel);
		expect(preparedJson).toContain(retainedBlockSentinel);
		expect(promptInput).toContain(deletedEntrySentinel);
		expect(promptInput).toContain(deletedBlockSentinel);
		expect(promptInput).toContain(retainedBlockSentinel);
	});
});

describe("branch summarization input", () => {
	it("applies context edits to branch entries (upstream #11680)", () => {
		const ts = (n: number) => new Date(n).toISOString();
		const branch: SessionEntry[] = [
			{ type: "message", id: "u1", parentId: null, timestamp: ts(1), message: user("Investigate login") },
			{
				type: "message",
				id: "failed",
				parentId: "u1",
				timestamp: ts(2),
				message: { ...assistantBlocks([{ type: "text", text: "FAILED_ATTEMPT" }]), stopReason: "error" },
			},
			{
				type: "context_edit",
				id: "e1",
				parentId: "failed",
				timestamp: ts(3),
				targetId: "failed",
				replacement: null,
			},
			{
				type: "message",
				id: "ok",
				parentId: "e1",
				timestamp: ts(4),
				message: assistantBlocks([{ type: "text", text: "ORIGINAL_TEXT" }]),
			},
			{
				type: "context_edit",
				id: "e2",
				parentId: "ok",
				timestamp: ts(5),
				targetId: "ok",
				replacement: { content: "REPLACED_TEXT" },
			},
		];

		const serialized = JSON.stringify(prepareBranchEntries(branch).messages);

		assert.ok(serialized.includes("Investigate login"));
		assert.ok(!serialized.includes("FAILED_ATTEMPT"));
		assert.ok(!serialized.includes("ORIGINAL_TEXT"));
		assert.ok(serialized.includes("REPLACED_TEXT"));
	});
});

describe("summary input tool results (#4967)", () => {
	function capturePrompt(): {
		streamFn: NonNullable<Parameters<typeof generateBranchSummary>[1]["streamFn"]>;
		prompt: () => string;
	} {
		let prompt = "";
		return {
			streamFn: async (requestModel, context) => {
				const request = context.messages.find((message) => message.role === "user");
				if (request && Array.isArray(request.content)) {
					prompt = request.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				}
				const stream = createAssistantMessageEventStream();
				stream.end({ ...assistantBlocks([{ type: "text", text: "summary" }]), model: requestModel.id });
				return stream;
			},
			prompt: () => prompt,
		};
	}

	function toolTurn(id: string): AssistantMessage {
		return {
			...assistantBlocks([{ type: "toolCall", id, name: "read", arguments: { path: "src/app.ts" } }]),
			stopReason: "toolUse",
		};
	}

	function toolResult(id: string, text: string): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		};
	}

	it.each([
		["branch", generateBranchSummary],
		["session", generateSessionSummary],
	] as const)(
		"shows the real truncated result of a successful tool call in %s summaries (#4967)",
		async (_label, summarize) => {
			resetIds();
			const output = `REAL_TOOL_OUTPUT ${"x".repeat(5000)} TAIL_SENTINEL`;
			const capture = capturePrompt();
			await summarize(
				[
					entry(user("read the app")),
					entry(toolTurn("call-ok")),
					entry(toolResult("call-ok", output)),
					entry(user("thanks")),
				],
				{ model: nonCopilotModel(), signal: new AbortController().signal, streamFn: capture.streamFn },
			);
			const prompt = capture.prompt();
			assert.ok(prompt.includes("[Tool result]: REAL_TOOL_OUTPUT"), prompt);
			assert.ok(!prompt.includes("TAIL_SENTINEL"), "tool result should be truncated");
			assert.ok(!/interrupted/i.test(prompt), prompt);
		},
	);

	it("still marks a genuinely interrupted tool call as interrupted (#4967)", async () => {
		resetIds();
		const capture = capturePrompt();
		await generateBranchSummary([entry(user("read the app")), entry(toolTurn("call-lost")), entry(user("hello?"))], {
			model: nonCopilotModel(),
			signal: new AbortController().signal,
			streamFn: capture.streamFn,
		});
		assert.ok(/Tool execution was interrupted/.test(capture.prompt()), capture.prompt());
	});
});
