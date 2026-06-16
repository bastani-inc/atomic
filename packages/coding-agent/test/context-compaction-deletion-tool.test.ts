import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildContextCompactionPrompt,
	CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	type CompactableTranscript,
} from "../src/core/compaction/index.ts";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function recentAssistantEntries(prefix: string, count = 2): CompactableTranscript["entries"] {
	return Array.from({ length: count }, (_unused, index) => {
		const message = assistantMessage(`Recent assistant context ${prefix} ${index}`);
		return {
			entryId: `${prefix}-${index}`,
			entryType: "message" as const,
			role: "assistant" as const,
			text: `Recent assistant context ${prefix} ${index}`,
			tokenEstimate: 4,
			protected: true,
			contentBlocks: [],
			message,
			toolCallIds: [],
		};
	});
}

function createTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const oldOne = assistantMessage("Old search output that can be deleted.");
	const oldTwo = assistantMessage("Old file read that can be deleted.");
	const recentEntries = recentAssistantEntries("entry-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-old-1",
				entryType: "message",
				role: "assistant",
				text: "Old search output that can be deleted.",
				tokenEstimate: 8,
				protected: false,
				contentBlocks: [],
				message: oldOne,
				toolCallIds: [],
			},
			{
				entryId: "entry-old-2",
				entryType: "message",
				role: "assistant",
				text: "Old file read that can be deleted.",
				tokenEstimate: 8,
				protected: false,
				contentBlocks: [],
				message: oldTwo,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createProtectedTranscript(): CompactableTranscript {
	const oldTask = userMessage("Old protected user message stays unavailable for deletion.");
	const recentTask = userMessage("Recent protected user message stays unavailable for deletion.");
	const entries = [
		{
			entryId: "entry-old-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Old protected user message stays unavailable for deletion.",
			tokenEstimate: 12,
			protected: true,
			contentBlocks: [],
			message: oldTask,
			toolCallIds: [],
		},
		...Array.from({ length: 5 }, (_, index) => {
			const message = assistantMessage(`assistant context ${index}`);
			return {
				entryId: `entry-assistant-${index}`,
				entryType: "message" as const,
				role: "assistant" as const,
				text: `assistant context ${index}`,
				tokenEstimate: 4,
				protected: index > 0,
				contentBlocks: [],
				message,
				toolCallIds: [],
			};
		}),
		{
			entryId: "entry-recent-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Recent protected user message stays unavailable for deletion.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: recentTask,
			toolCallIds: [],
		},
	];
	return {
		entries,
		protectedEntryIds: [
			"entry-old-user",
			"entry-assistant-1",
			"entry-assistant-2",
			"entry-assistant-3",
			"entry-assistant-4",
			"entry-recent-user",
		],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createContentBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const multi = assistantMessage("alpha stale block\nbeta active block");
	const single = assistantMessage("single stale block");
	const recentEntries = recentAssistantEntries("entry-content-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-multi",
				entryType: "message",
				role: "assistant",
				text: "alpha stale block\nbeta active block",
				tokenEstimate: 12,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-multi",
						blockIndex: 0,
						type: "text",
						text: "alpha stale block",
						tokenEstimate: 6,
						protected: false,
					},
					{
						entryId: "entry-multi",
						blockIndex: 1,
						type: "text",
						text: "beta active block",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: multi,
				toolCallIds: [],
			},
			{
				entryId: "entry-single",
				entryType: "message",
				role: "assistant",
				text: "single stale block",
				tokenEstimate: 6,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-single",
						blockIndex: 0,
						type: "text",
						text: "single stale block",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: single,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createProtectedContentBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const safe = assistantMessage("alpha safe stale block\nbeta active block");
	const protectedBlock = assistantMessage("alpha protected stale block\nprotected sibling block");
	const recentEntries = recentAssistantEntries("entry-protected-block-recent");
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "entry-user",
			entryType: "message",
			role: "user",
			text: "Keep the user's task protected.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		{
			entryId: "entry-safe-block",
			entryType: "message",
			role: "assistant",
			text: "alpha safe stale block\nbeta active block",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-safe-block",
					blockIndex: 0,
					type: "text",
					text: "alpha safe stale block",
					tokenEstimate: 6,
					protected: false,
				},
				{
					entryId: "entry-safe-block",
					blockIndex: 1,
					type: "text",
					text: "beta active block",
					tokenEstimate: 6,
					protected: false,
				},
			],
			message: safe,
			toolCallIds: [],
		},
		{
			entryId: "entry-protected-block",
			entryType: "message",
			role: "assistant",
			text: "alpha protected stale block\nprotected sibling block",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-protected-block",
					blockIndex: 0,
					type: "text",
					text: "alpha protected stale block",
					tokenEstimate: 6,
					protected: true,
				},
				{
					entryId: "entry-protected-block",
					blockIndex: 1,
					type: "text",
					text: "protected sibling block",
					tokenEstimate: 6,
					protected: false,
				},
			],
			message: protectedBlock,
			toolCallIds: [],
		},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createProtectedToolBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const callId = "call-protected-tool";
	const toolCallMessage = {
		...assistantMessage(""),
		content: [
			{ type: "text", text: "assistant text beside protected tool call" },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: "protected.ts" } },
		],
		stopReason: "toolUse",
	} as AgentMessage;
	const resultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: "old result paired with protected tool call" }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-protected-tool-recent");
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "entry-user",
			entryType: "message",
			role: "user",
			text: "Keep the user's task protected.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		{
			entryId: "entry-tool-call",
			entryType: "message",
			role: "assistant",
			text: "assistant text beside protected tool call\nread({\"path\":\"protected.ts\"})",
			tokenEstimate: 12,
			protected: false,
			contentBlocks: [
				{
					entryId: "entry-tool-call",
					blockIndex: 0,
					type: "text",
					text: "assistant text beside protected tool call",
					tokenEstimate: 6,
					protected: false,
				},
				{
					entryId: "entry-tool-call",
					blockIndex: 1,
					type: "toolCall",
					text: "read({\"path\":\"protected.ts\"})",
					tokenEstimate: 6,
					protected: true,
					toolCallId: callId,
				},
			],
			message: toolCallMessage,
			toolCallIds: [callId],
		},
		{
			entryId: "entry-tool-result",
			entryType: "message",
			role: "toolResult",
			text: "old result paired with protected tool call",
			tokenEstimate: 8,
			protected: false,
			contentBlocks: [],
			message: resultMessage,
			toolCallIds: [],
			toolResultFor: callId,
		},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createAssistantThinkingBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const thinkingMessage = {
		...assistantMessage(""),
		content: [{ type: "thinking", thinking: "single thinking sentinel", thinkingSignature: "sig-thinking" }],
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-thinking-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-thinking",
				entryType: "message",
				role: "assistant",
				text: "single thinking sentinel",
				tokenEstimate: 6,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-thinking",
						blockIndex: 0,
						type: "thinking",
						text: "single thinking sentinel",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: thinkingMessage,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createAssistantThinkingSiblingTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const thinkingMessage = {
		...assistantMessage(""),
		content: [
			{ type: "text", text: "visible sibling sentinel" },
			{ type: "thinking", thinking: "paired thinking sentinel", thinkingSignature: "sig-thinking" },
		],
	} as AgentMessage;
	const recentEntries = recentAssistantEntries("entry-thinking-sibling-recent");
	const entries: CompactableTranscript["entries"] = [
			{
				entryId: "entry-user",
				entryType: "message",
				role: "user",
				text: "Keep the user's task protected.",
				tokenEstimate: 8,
				protected: true,
				contentBlocks: [],
				message: task,
				toolCallIds: [],
			},
			{
				entryId: "entry-thinking-sibling",
				entryType: "message",
				role: "assistant",
				text: "visible sibling sentinel\npaired thinking sentinel",
				tokenEstimate: 10,
				protected: false,
				contentBlocks: [
					{
						entryId: "entry-thinking-sibling",
						blockIndex: 0,
						type: "text",
						text: "visible sibling sentinel",
						tokenEstimate: 4,
						protected: false,
					},
					{
						entryId: "entry-thinking-sibling",
						blockIndex: 1,
						type: "thinking",
						text: "paired thinking sentinel",
						tokenEstimate: 6,
						protected: false,
					},
				],
				message: thinkingMessage,
				toolCallIds: [],
			},
		...recentEntries,
	];
	return {
		entries,
		protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

describe("context compaction deletion tools", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("records deletion targets through an executable context_delete tool", async () => {
		let capturedContext: Context | undefined;
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				capturedContext = context;
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"context_delete",
							{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
							{ id: "toolu_delete_1" },
						),
						fauxToolCall(
							"context_delete",
							{ deletions: [{ kind: "entry", entryId: "entry-old-2" }] },
							{ id: "toolu_delete_2" },
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				throw new Error("provider should not be called after the strict reduction target is met");
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(faux.state.callCount).toBe(1);
		expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		expect(capturedContext).toMatchObject({
			systemPrompt: expect.stringContaining("context_delete"),
			tools: expect.arrayContaining([
				expect.objectContaining({ name: "context_delete", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_grep_delete", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_search_transcript", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_read_entry", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_compaction_budget", executionMode: "parallel" }),
			]),
		});
	});

	it("sets the transcript-bound deletion tool result to terminate false explicitly", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.tool.execute("toolu_delete", {
			deletions: [{ kind: "entry", entryId: "entry-old-1" }],
		});

		expect(result.terminate).toBe(false);
		expect(controller.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(controller.getCallCount()).toBe(1);
	});

	it("reports context-window fullness and 50 percent reduction progress", async () => {
		const controller = createContextDeletionTool(createTranscript(), { contextWindow: 100 });

		const before = await controller.budgetTool.execute("toolu_budget_before", {});
		await controller.tool.execute("toolu_delete", {
			deletions: [{ kind: "entry", entryId: "entry-old-1" }],
		});
		const after = await controller.budgetTool.execute("toolu_budget_after", {});

		expect(before.terminate).toBe(false);
		expect(before.details.contextWindowBeforePercent).toBe(32);
		expect(before.details.contextWindowAfterPercent).toBe(32);
		expect(before.details.compression_ratio).toBe(0.5);
		expect(before.details.targetReductionPercent).toBe(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		expect(before.details.tokensToDeleteForTarget).toBe(16);
		expect(after.details.currentReductionPercent).toBe(25);
		expect(after.details.contextWindowAfterPercent).toBe(24);
		expect(after.details.tokensToDeleteForTarget).toBe(8);
		expect(after.content[0]?.type === "text" ? after.content[0].text : "").toContain(`${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}% reduction target`);
	});

	it("uses custom compression_ratio for budget targets", async () => {
		const controller = createContextDeletionTool(createTranscript(), { contextWindow: 100, compression_ratio: 0.25 });

		const result = await controller.budgetTool.execute("toolu_budget_custom_ratio", {});

		expect(result.details.compression_ratio).toBe(0.25);
		expect(result.details.targetReductionPercent).toBe(75);
		expect(result.details.targetTokensAfter).toBe(8);
		expect(result.details.tokensToDeleteForTarget).toBe(24);
	});

	it("rejects deletion tool calls that include transcript text instead of id-only targets", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.tool.execute("toolu_delete_with_text", {
			deletions: [{ kind: "entry", entryId: "entry-old-1", text: "Old search output that can be deleted." }],
		} as never);

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/id-only/);
		expect(result.details.error).toMatch(/unsupported property "text"/);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("returns an explicit tool error for deletion of the last two context entries", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.tool.execute("toolu_delete_recent", {
			deletions: [{ kind: "entry", entryId: "entry-recent-1" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/Cannot delete recent context entry entry-recent-1/);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(/corrected tool call/);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("grep deletion ignores matches against recent context", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.grepTool.execute("toolu_grep_recent", {
			pattern: "Recent assistant context entry-recent 1",
			target: "entry",
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches).toEqual([]);
		expect(result.details.skipped).toEqual([expect.objectContaining({ entryId: "entry-recent-1", reason: "protected_entry" })]);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("builds a bounded prompt with a transcript file path instead of full transcript text", () => {
		const transcript = createTranscript();
		for (let index = 0; index < 120; index++) {
			const message = assistantMessage(`Large omitted preview ${index} ${"x".repeat(1000)} SENTINEL_FULL_TEXT_${index}`);
			transcript.entries.push({
				entryId: `entry-large-${index}`,
				entryType: "message",
				role: "assistant",
				text: `Large omitted preview ${index} ${"x".repeat(1000)} SENTINEL_FULL_TEXT_${index}`,
				tokenEstimate: 400,
				protected: false,
				contentBlocks: [],
				message,
				toolCallIds: [],
			});
		}

		const prompt = buildContextCompactionPrompt(transcript, "/tmp/full-transcript.jsonl");

		expect(prompt).toContain("/tmp/full-transcript.jsonl");
		expect(prompt).toContain("context_delete");
		expect(prompt).toContain("context_search_transcript");
		expect(prompt).toContain("context_compaction_budget");
		expect(prompt).not.toContain("context_deletion_plan");
		expect(prompt).not.toContain("<standard-mode>");
		expect(prompt).not.toContain("overflow-mode>");
		expect(prompt).toContain("Start by calling context_compaction_budget");
		expect(prompt).toContain("Spend a few turns exploring with search/read tools");
		expect(prompt).toContain(`Strict requirement: reduce current context by at least ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}%`);
		expect(prompt).toContain(`Do not send a final plain-text completion message until context_compaction_budget reports at least ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}%`);
		expect(prompt).toContain('"compression_ratio": 0.5');
		expect(prompt).toContain('"preserve_recent": 2');
		expect(prompt).toContain('"query": "auto-detected"');
		expect(prompt).toContain("Prefer high-confidence exploit actions");
		expect(prompt.length).toBeLessThan(80_000);
		expect(prompt).not.toContain("SENTINEL_FULL_TEXT_119");
		expect(prompt).not.toContain("x".repeat(1000));
	});

	it("searches and reads transcript slices without mutating deletion state", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const search = await controller.searchTool.execute("toolu_search", {
			pattern: "Old",
			target: "entry",
			maxMatches: 5,
			contextChars: 20,
		});
		const read = await controller.readEntryTool.execute("toolu_read", {
			entryId: "entry-old-1",
			offset: 0,
			maxChars: 8,
		});

		expect(search.terminate).toBe(false);
		expect(search.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
		expect(read.terminate).toBe(false);
		expect(read.details.text).toBe("Old sear");
		expect(read.details.truncatedAfter).toBe(true);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("allows parallel tool execution while serializing shared deletion state", async () => {
		const controller = createContextDeletionTool(createTranscript());

		expect(controller.tool.executionMode).toBe("parallel");
		expect(controller.grepTool.executionMode).toBe("parallel");
		expect(controller.searchTool.executionMode).toBe("parallel");
		expect(controller.readEntryTool.executionMode).toBe("parallel");

		const [first, second] = await Promise.all([
			controller.tool.execute("toolu_delete_1", {
				deletions: [{ kind: "entry", entryId: "entry-old-1" }],
			}),
			controller.tool.execute("toolu_delete_2", {
				deletions: [{ kind: "entry", entryId: "entry-old-2" }],
			}),
		]);

		expect(first.terminate).toBe(false);
		expect(second.terminate).toBe(false);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(controller.getCallCount()).toBe(2);
	});

	it("bulk deletes grep-matched entries with embedded guardrails", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.grepTool.execute("toolu_grep", {
			pattern: "Old",
			target: "entry",
		});

		expect(result.terminate).toBe(false);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(result.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
		expect(result.details.skipped).toEqual([]);
	});

	it("grep bulk deletion skips protected matches inside the tool", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const result = await controller.grepTool.execute("toolu_grep", {
			pattern: "Keep",
			target: "entry",
		});

		expect(result.terminate).toBe(false);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
		expect(result.details.matches).toEqual([]);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ entryId: "entry-user", reason: "protected_entry" }),
		]);
	});

	it("supports regex grep matching and invalid regex tool errors", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const regexResult = await controller.grepTool.execute("toolu_regex", {
			pattern: "Old (search|file)",
			regex: true,
			target: "entry",
		});

		expect(regexResult.terminate).toBe(false);
		expect(regexResult.details.error).toBeUndefined();
		expect(regexResult.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);

		const invalidResult = await controller.grepTool.execute("toolu_invalid_regex", {
			pattern: "[",
			regex: true,
			target: "entry",
		});

		expect(invalidResult.terminate).toBe(false);
		expect(invalidResult.details.error).toMatch(/Invalid grep regex/);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
	});

	it("guards regex pattern length, backtracking shapes, and scan size", async () => {
		const controller = createContextDeletionTool(createTranscript());

		const longPattern = await controller.grepTool.execute("toolu_long_regex", {
			pattern: "a".repeat(513),
			regex: true,
			target: "entry",
		});
		const unsafePattern = await controller.grepTool.execute("toolu_unsafe_regex", {
			pattern: "(a+)+$",
			regex: true,
			target: "entry",
		});

		expect(longPattern.terminate).toBe(false);
		expect(longPattern.details.error).toMatch(/Regex pattern is too long/);
		expect(unsafePattern.terminate).toBe(false);
		expect(unsafePattern.details.error).toMatch(/excessive backtracking/);

		const largeTranscript = createTranscript();
		largeTranscript.entries[1] = {
			...largeTranscript.entries[1],
			text: `${"a".repeat(250_001)} old regex scan sentinel`,
		};
		const scanResult = await createContextDeletionTool(largeTranscript).grepTool.execute("toolu_scan_regex", {
			pattern: "sentinel",
			regex: true,
			target: "entry",
		});

		expect(scanResult.terminate).toBe(false);
		expect(scanResult.details.error).toMatch(/Regex grep would scan/);
	});

	it("supports content-block grep deletion", async () => {
		const controller = createContextDeletionTool(createContentBlockTranscript());

		const result = await controller.grepTool.execute("toolu_block_grep", {
			pattern: "alpha",
			target: "content_block",
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches).toEqual([
			expect.objectContaining({ entryId: "entry-multi", target: "content_block", blockIndex: 0 }),
		]);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
		]);
	});

	it("regex grep removes non-protected content blocks and ignores protected block matches", async () => {
		const controller = createContextDeletionTool(createProtectedContentBlockTranscript());

		const result = await controller.grepTool.execute("toolu_regex_protected_block", {
			pattern: "alpha .* stale block",
			regex: true,
			target: "content_block",
			expectedMatchCount: 1,
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches).toEqual([
			expect.objectContaining({ entryId: "entry-safe-block", target: "content_block", blockIndex: 0 }),
		]);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ entryId: "entry-protected-block", target: "content_block", blockIndex: 0, reason: "protected_block" }),
		]);
		expect(result.details.stats.objectsDeleted).toBe(1);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-safe-block", blockIndex: 0 },
		]);
	});

	it("returns a protected-tool-block correction when exact deletion would orphan a tool result", async () => {
		const controller = createContextDeletionTool(createProtectedToolBlockTranscript());

		const result = await controller.tool.execute("toolu_delete_protected_tool_result", {
			deletions: [{ kind: "entry", entryId: "entry-tool-result" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/protected tool block/i);
		expect(result.details.error).toMatch(/Choose another/i);
		expect(result.details.deletedTargets).toEqual([]);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("grep deletion can remove older assistant thinking blocks", async () => {
		const blockController = createContextDeletionTool(createAssistantThinkingBlockTranscript());

		const blockResult = await blockController.grepTool.execute("toolu_thinking_block_grep", {
			pattern: "single thinking sentinel",
			target: "content_block",
		});

		expect(blockResult.terminate).toBe(false);
		expect(blockResult.details.error).toBeUndefined();
		expect(blockResult.details.matches).toEqual([expect.objectContaining({ entryId: "entry-thinking", target: "entry" })]);
		expect(blockResult.details.skipped).toEqual([]);
		expect(blockController.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-thinking" }]);

		const entryController = createContextDeletionTool(createAssistantThinkingBlockTranscript());
		const entryResult = await entryController.grepTool.execute("toolu_thinking_entry_grep", {
			pattern: "single thinking sentinel",
			target: "entry",
		});

		expect(entryResult.details.matches).toEqual([expect.objectContaining({ entryId: "entry-thinking", target: "entry" })]);
		expect(entryResult.details.skipped).toEqual([]);
		expect(entryController.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-thinking" }]);
	});

	it("grep deletion can remove sibling blocks in older assistant thinking-bearing entries", async () => {
		const controller = createContextDeletionTool(createAssistantThinkingSiblingTranscript());

		const result = await controller.grepTool.execute("toolu_thinking_sibling_grep", {
			pattern: "visible sibling sentinel",
			target: "content_block",
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches).toEqual([
			expect.objectContaining({ entryId: "entry-thinking-sibling", target: "content_block", blockIndex: 0 }),
		]);
		expect(result.details.skipped).toEqual([]);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-thinking-sibling", blockIndex: 0 },
		]);
	});

	it("keeps maxMatches scoped to a single grep tool call without imposing a cumulative cap", async () => {
		const task = userMessage("Keep enough task context.");
		const bulkEntries = Array.from({ length: 60 }, (_unused, index) => {
			const batch = index < 30 ? "alpha" : "beta";
			const text = `bulk ${batch} stale grep target ${index}`;
			const message = assistantMessage(text);
			return {
				entryId: `entry-bulk-${index}`,
				entryType: "message" as const,
				role: "assistant" as const,
				text,
				tokenEstimate: 4,
				protected: false,
				contentBlocks: [],
				message,
				toolCallIds: [],
			};
		});
		const recentEntries = recentAssistantEntries("entry-bulk-recent");
		const transcript: CompactableTranscript = {
			entries: [
				{
					entryId: "entry-user",
					entryType: "message",
					role: "user",
					text: "Keep enough task context.",
					tokenEstimate: 6,
					protected: true,
					contentBlocks: [],
					message: task,
					toolCallIds: [],
				},
				...bulkEntries,
				...recentEntries,
			],
			protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
			tokensBefore:
				6 +
				bulkEntries.reduce((total, entry) => total + entry.tokenEstimate, 0) +
				recentEntries.reduce((total, entry) => total + entry.tokenEstimate, 0),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const cappedController = createContextDeletionTool(transcript);
		const cappedResult = await cappedController.grepTool.execute("toolu_grep_capped", {
			pattern: "stale grep target",
			target: "entry",
			maxMatches: 10,
		});

		expect(cappedResult.terminate).toBe(false);
		expect(cappedResult.details.skipped).toEqual([expect.objectContaining({ reason: "max_matches_exceeded" })]);
		expect(cappedController.getDeletionRequest().deletions).toEqual([]);

		const controller = createContextDeletionTool(transcript);
		const alpha = await controller.grepTool.execute("toolu_grep_alpha", {
			pattern: "bulk alpha stale grep target",
			target: "entry",
			maxMatches: 30,
		});
		const beta = await controller.grepTool.execute("toolu_grep_beta", {
			pattern: "bulk beta stale grep target",
			target: "entry",
			maxMatches: 30,
		});

		expect(alpha.details.error).toBeUndefined();
		expect(beta.details.error).toBeUndefined();
		expect(alpha.details.matches).toHaveLength(30);
		expect(beta.details.matches).toHaveLength(30);
		expect(controller.getDeletionRequest().deletions).toHaveLength(60);
	});

	it("reports expectedMatchCount guardrail mismatches without applying matches", async () => {
		const expectedController = createContextDeletionTool(createTranscript());
		const expectedResult = await expectedController.grepTool.execute("toolu_grep_expected", {
			pattern: "Old",
			target: "entry",
			expectedMatchCount: 3,
		});

		expect(expectedResult.terminate).toBe(false);
		expect(expectedResult.details.skipped).toEqual([
			expect.objectContaining({ reason: "expected_match_count_mismatch" }),
		]);
		expect(expectedController.getDeletionRequest().deletions).toEqual([]);
	});

	it("reports already-deleted content-block promotions as entry targets", async () => {
		const controller = createContextDeletionTool(createContentBlockTranscript());

		const first = await controller.grepTool.execute("toolu_single_first", {
			pattern: "single",
			target: "content_block",
		});
		const second = await controller.grepTool.execute("toolu_single_second", {
			pattern: "single",
			target: "content_block",
		});

		expect(first.details.matches).toEqual([expect.objectContaining({ entryId: "entry-single", target: "entry" })]);
		expect(second.details.skipped).toEqual([
			expect.objectContaining({ entryId: "entry-single", target: "entry", reason: "already_deleted" }),
		]);
		expect(controller.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-single" }]);
	});

	it("keeps protected entries undeletable during compaction", async () => {
		const controller = createContextDeletionTool(createProtectedTranscript());

		const result = await controller.tool.execute("toolu_delete_old_user", {
			deletions: [{ kind: "entry", entryId: "entry-old-user" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/entry-old-user is protected/);
		expect(result.details.error).toMatch(/Choose another/i);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});


	it("returns a clear self-correction error for non-deletable latest thinking blocks", async () => {
		const latestThinking = {
			...assistantMessage(""),
			content: [
				{ type: "text", text: "latest visible text" },
				{ type: "thinking", thinking: "latest thinking must stay", thinkingSignature: "sig-latest" },
			],
		};
		const transcript: CompactableTranscript = {
			entries: [
				{
					entryId: "entry-user",
					entryType: "message",
					role: "user",
					text: "Task remains available.",
					tokenEstimate: 6,
					protected: true,
					contentBlocks: [],
					message: userMessage("Task remains available."),
					toolCallIds: [],
				},
				{
					entryId: "entry-latest-thinking",
					entryType: "message",
					role: "assistant",
					text: "latest visible text\nlatest thinking must stay",
					tokenEstimate: 8,
					protected: false,
					contentBlocks: [
						{
							entryId: "entry-latest-thinking",
							blockIndex: 0,
							type: "text",
							text: "latest visible text",
							tokenEstimate: 4,
							protected: false,
						},
						{
							entryId: "entry-latest-thinking",
							blockIndex: 1,
							type: "thinking",
							text: "latest thinking must stay",
							tokenEstimate: 4,
							protected: false,
						},
					],
					message: latestThinking,
					toolCallIds: [],
				},
			],
			protectedEntryIds: ["entry-user"],
			tokensBefore: 14,
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const controller = createContextDeletionTool(transcript, { preserve_recent: 0 });

		const result = await controller.tool.execute("toolu_delete_latest_thinking_block", {
			deletions: [{ kind: "content_block", entryId: "entry-latest-thinking", blockIndex: 1 }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/thinking\/redacted_thinking block in the latest assistant message/);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(/corrected tool call/);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("returns a non-terminating tool error when merged targets violate validation", async () => {
		const controller = createContextDeletionTool(createContentBlockTranscript());

		const first = await controller.tool.execute("toolu_block_1", {
			deletions: [{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 }],
		});
		const second = await controller.tool.execute("toolu_block_2", {
			deletions: [{ kind: "content_block", entryId: "entry-multi", blockIndex: 1 }],
		});

		expect(first.terminate).toBe(false);
		expect(first.details.error).toBeUndefined();
		expect(second.terminate).toBe(false);
		expect(second.details.error).toMatch(/would remove every content block/);
		expect(controller.getDeletionRequest().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
		]);
	});

	it("throws when context compaction is cancelled", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const abort = new AbortController();
		abort.abort();

		await expect(
			contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, abort.signal),
		).rejects.toThrow(/Request was aborted/);
	});

	it("stops deterministically once validated deletions meet the strict reduction target", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"context_delete",
					{
						deletions: [
							{ kind: "entry", entryId: "entry-old-1" },
							{ kind: "entry", entryId: "entry-old-2" },
						],
					},
					{ id: "toolu_target_delete" },
				),
				{ stopReason: "toolUse" },
			),
			() => {
				throw new Error("provider should not be called after the target is met");
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		expect(faux.state.callCount).toBe(1);
	});

	it("nudges the planner when it tries to stop before the strict reduction target", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Done too early.");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{
							deletions: [
								{ kind: "entry", entryId: "entry-old-1" },
								{ kind: "entry", entryId: "entry-old-2" },
							],
						},
						{ id: "toolu_nudged_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		expect(JSON.stringify(contexts[1]!)).toContain(
			`strict ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}% context-reduction requirement is not met yet`,
		);
		expect(JSON.stringify(contexts[1]!)).toContain("Continue removing low-value message entries or message content blocks");
		expect(faux.state.callCount).toBe(2);
	});

	it("still fails non-overflow provider errors after recording deletions", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"context_delete",
					{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
					{ id: "toolu_partial_delete" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "529 overloaded",
			}),
		]);

		await expect(
			contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key"),
		).rejects.toThrow(/Context compaction failed: 529 overloaded/);
	});

	it("inherits the selected thinking level for reasoning-model context compaction", async () => {
		let capturedReasoning: string | undefined;
		const faux = registerFauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(_context, options) => {
				capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{
							deletions: [
								{ kind: "entry", entryId: "entry-old-1" },
								{ kind: "entry", entryId: "entry-old-2" },
							],
						},
						{ id: "toolu_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("Done recording deletion targets."),
		]);

		await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, undefined, "high");

		expect(capturedReasoning).toBe("high");
	});

	it("keeps the inherited thinking level when lower variants are unsupported", async () => {
		let capturedReasoning: string | undefined;
		const faux = registerFauxProvider({ models: [{ id: "faux-reasoning-low", reasoning: true }] });
		cleanups.push(() => faux.unregister());
		const model = { ...faux.getModel(), thinkingLevelMap: { off: null, minimal: null } };
		faux.setResponses([
			(_context, options) => {
				capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{
							deletions: [
								{ kind: "entry", entryId: "entry-old-1" },
								{ kind: "entry", entryId: "entry-old-2" },
							],
						},
						{ id: "toolu_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("Done recording deletion targets."),
		]);

		await contextCompact({ transcript: createTranscript(), branchEntries: [] }, model, "test-key", undefined, undefined, "high");

		expect(capturedReasoning).toBe("high");
	});

	it("keeps thinking off for non-reasoning-model context compaction", async () => {
		let capturedReasoning: string | undefined;
		const faux = registerFauxProvider({ models: [{ id: "faux-non-reasoning", reasoning: false }] });
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(_context, options) => {
				capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{
							deletions: [
								{ kind: "entry", entryId: "entry-old-1" },
								{ kind: "entry", entryId: "entry-old-2" },
							],
						},
						{ id: "toolu_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("Done recording deletion targets."),
		]);

		await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, undefined, "off");

		expect(capturedReasoning).toBeUndefined();
	});

	it("surfaces the deletion tool error when context compaction has no safe deletions", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{ deletions: [{ kind: "entry", entryId: "entry-user" }] },
						{ id: "toolu_bad_standard_delete" },
					),
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("Unable to find safe deletions."),
			() => fauxAssistantMessage("Still unable after target nudge."),
		]);

		await expect(
			contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key"),
		).rejects.toThrow(/attempt reached 0%.*last deletion tool error: Deletion target entry-user is protected/s);
	});

	it("records grep bulk deletions through context compaction", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_grep_delete",
						{ pattern: "Old", target: "entry" },
						{ id: "toolu_grep" },
					),
					{ stopReason: "toolUse" },
				),
			() => {
				throw new Error("provider should not be called after grep deletion meets the target");
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		expect(faux.state.callCount).toBe(1);
	});
});
