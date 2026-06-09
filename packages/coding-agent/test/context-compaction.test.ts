import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildContextCompactionPrompt,
	type CompactableTranscript,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	parseContextDeletionRequest,
	parseContextDeletionResponse,
	prepareContextCompaction,
	validateContextDeletionRequest,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

let counter = 0;
let lastId: string | null = null;

function resetIds(): void {
	counter = 0;
	lastId = null;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

function assistantTextWithoutUsage(text: string): AssistantMessage {
	const { usage: _usage, ...message } = assistantText(text);
	void _usage;
	return message as AssistantMessage;
}

function assistantTextWithTotalUsage(text: string, totalTokens: number): AssistantMessage {
	const message = assistantText(text);
	return {
		...message,
		usage: {
			...message.usage!,
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
		},
	};
}

function bashExecution(command: string, output: string, exitCode: number, excludeFromContext = false): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
		...(excludeFromContext ? { excludeFromContext: true } : {}),
	};
}

function excludedBashExecution(command: string, output: string): AgentMessage {
	return bashExecution(command, output, 0, true);
}

function excludedCustomAgentMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "test-custom",
		content,
		display: true,
		timestamp: Date.now(),
		excludeFromContext: true,
	} as AgentMessage;
}

function assistantToolCall(toolCallId: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } }],
		stopReason: "toolUse",
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function toolResultWithImage(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	};
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

function customMessageEntry(content: string, excludeFromContext = false): CustomMessageEntry {
	const id = `entry-${counter++}`;
	const result: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType: "test-custom-entry",
		content,
		display: true,
		...(excludeFromContext ? { excludeFromContext: true } : {}),
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

function compactionEntry(summary: string, firstKeptEntryId: string, tokensBefore = 1234): CompactionEntry {
	const id = `entry-${counter++}`;
	const result: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore,
	};
	lastId = id;
	return result;
}

describe("context compaction", () => {
	it("parses fenced deletion-request JSON", () => {
		const parsed = parseContextDeletionRequest('```json\n{ "deletions": [{ "kind": "entry", "entryId": "abc" }] }\n```');
		expect(parsed.deletions).toEqual([{ kind: "entry", entryId: "abc" }]);
	});

	it("reads deletion requests from structured deletion tool calls", () => {
		const response: AssistantMessage = {
			...assistantText(""),
			content: [
				{
					type: "toolCall",
					id: "toolu_delete",
					name: "context_delete",
					arguments: { deletions: [{ kind: "content_block", entryId: "abc", blockIndex: 1 }] },
				},
			],
			stopReason: "toolUse",
		};

		const parsed = parseContextDeletionResponse(response);

		expect(parsed.deletions).toEqual([{ kind: "content_block", entryId: "abc", blockIndex: 1 }]);
	});

	it("excludes excludeFromContext entries from context compaction transcript, prompt, recency, and stats", () => {
		resetIds();
		const bashSentinel = "ITER4_EXCLUDED_BASH_SENTINEL";
		const customSentinel = "ITER4_EXCLUDED_CUSTOM_SENTINEL";
		const customEntrySentinel = "ITER4_EXCLUDED_CUSTOM_MESSAGE_ENTRY_SENTINEL";
		const sentinels = [bashSentinel, customSentinel, customEntrySentinel];
		const task = entry(user("Eligible user task remains protected"));
		const oldEligible = entry(assistantTextWithoutUsage("eligible old context can be deleted"));
		const recentCandidate = entry(assistantTextWithoutUsage("eligible recent candidate should remain protected"));
		const excludedBash = entry(excludedBashExecution(`echo ${bashSentinel}`, `output ${bashSentinel}`));
		const excludedCustom = entry(excludedCustomAgentMessage(customSentinel));
		const excludedCustomEntry = customMessageEntry(customEntrySentinel, true);
		const recent1 = entry(assistantTextWithoutUsage("eligible recent operation 1"));
		const recent2 = entry(assistantTextWithoutUsage("eligible recent operation 2"));
		const recent3 = entry(assistantTextWithoutUsage("eligible recent operation 3"));
		const recent4 = entry(assistantTextWithoutUsage("eligible recent operation 4"));
		const entries: SessionEntry[] = [
			task,
			oldEligible,
			recentCandidate,
			excludedBash,
			excludedCustom,
			excludedCustomEntry,
			recent1,
			recent2,
			recent3,
			recent4,
		];

		const rawContextMessages = buildSessionContext(entries).messages;
		const rawContextJson = JSON.stringify(rawContextMessages);
		for (const sentinel of sentinels) {
			expect(rawContextJson).toContain(sentinel);
		}

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const transcript = preparation!.transcript;
		const transcriptJson = JSON.stringify(transcript);
		const prompt = buildContextCompactionPrompt(transcript);

		for (const sentinel of sentinels) {
			expect(transcriptJson).not.toContain(sentinel);
			expect(prompt).not.toContain(sentinel);
		}

		const transcriptEntryIds = transcript.entries.map((item) => item.entryId);
		expect(transcriptEntryIds).not.toContain(excludedBash.id);
		expect(transcriptEntryIds).not.toContain(excludedCustom.id);
		expect(transcriptEntryIds).not.toContain(excludedCustomEntry.id);
		expect(transcript.protectedEntryIds).not.toContain(excludedBash.id);
		expect(transcript.protectedEntryIds).not.toContain(excludedCustom.id);
		expect(transcript.protectedEntryIds).not.toContain(excludedCustomEntry.id);
		expect(transcript.entries.find((item) => item.entryId === recentCandidate.id)?.protected).toBe(true);

		const eligibleContextMessages = rawContextMessages.filter((message) => {
			const serialized = JSON.stringify(message);
			return !sentinels.some((sentinel) => serialized.includes(sentinel));
		});
		expect(transcript.tokensBefore).toBe(estimateContextTokens(eligibleContextMessages).tokens);
		expect(transcript.tokensBefore).toBeLessThan(estimateContextTokens(rawContextMessages).tokens);

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: oldEligible.id }] },
			transcript,
		);
		expect(validated.stats.objectsBefore).toBe(
			transcript.entries.length + transcript.entries.reduce((total, item) => total + item.contentBlocks.length, 0),
		);
		expect(validated.stats.objectsBefore).toBe(14);
		expect(validated.stats.objectsDeleted).toBe(2);
		expect(validated.stats.tokensBefore).toBe(transcript.tokensBefore);
		expect(validated.protectedEntryIds).not.toContain(excludedBash.id);
		expect(validated.protectedEntryIds).not.toContain(excludedCustom.id);
		expect(validated.protectedEntryIds).not.toContain(excludedCustomEntry.id);
	});

	it("protects failed context-eligible bash executions while keeping excluded bash omitted", () => {
		resetIds();
		const excludedSentinel = "ITER5_EXCLUDED_FAILED_BASH_SENTINEL";
		const task = entry(user("Task that must remain available"));
		const failedBash = entry(bashExecution("bun test failing-suite", "expected failure output", 2));
		const excludedFailedBash = entry(
			bashExecution(`echo ${excludedSentinel}`, `hidden ${excludedSentinel}`, 1, true),
		);
		const oldDeletable = entry(assistantTextWithoutUsage("old assistant note can be deleted"));
		const recent1 = entry(assistantTextWithoutUsage("recent operation 1"));
		const recent2 = entry(assistantTextWithoutUsage("recent operation 2"));
		const recent3 = entry(assistantTextWithoutUsage("recent operation 3"));
		const recent4 = entry(assistantTextWithoutUsage("recent operation 4"));
		const recent5 = entry(assistantTextWithoutUsage("recent operation 5"));
		const entries: SessionEntry[] = [
			task,
			failedBash,
			excludedFailedBash,
			oldDeletable,
			recent1,
			recent2,
			recent3,
			recent4,
			recent5,
		];

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const transcript = preparation!.transcript;
		const transcriptJson = JSON.stringify(transcript);
		const failedTranscriptEntry = transcript.entries.find((item) => item.entryId === failedBash.id);

		expect(failedTranscriptEntry).toBeDefined();
		expect(failedTranscriptEntry!.protected).toBe(true);
		expect(transcript.protectedEntryIds).toContain(failedBash.id);
		expect(transcript.entries.map((item) => item.entryId)).not.toContain(excludedFailedBash.id);
		expect(transcript.protectedEntryIds).not.toContain(excludedFailedBash.id);
		expect(transcriptJson).not.toContain(excludedSentinel);

		expect(() =>
			validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: failedBash.id }] }, transcript),
		).toThrow(/protected/);
		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: failedBash.id, blockIndex: 0 }] },
				transcript,
			),
		).toThrow(/protected/);

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: oldDeletable.id }] },
			transcript,
		);
		expect(validated.deletedTargets).toEqual([{ kind: "entry", entryId: oldDeletable.id }]);
	});

	it("uses filtered token estimates instead of stale pre-boundary assistant usage for context stats", () => {
		resetIds();
		const task = entry(user("Task with post-boundary context"));
		const staleAssistantUsage = entry(assistantTextWithTotalUsage("pre-boundary assistant with stale usage", 1_000_000));
		const priorContextCompaction = contextEntry([]);
		const deletable = entry(assistantTextWithoutUsage("obsolete post-boundary note ".repeat(20)));
		const recent1 = entry(assistantTextWithoutUsage("recent post-boundary operation 1"));
		const recent2 = entry(assistantTextWithoutUsage("recent post-boundary operation 2"));
		const recent3 = entry(assistantTextWithoutUsage("recent post-boundary operation 3"));
		const recent4 = entry(assistantTextWithoutUsage("recent post-boundary operation 4"));
		const recent5 = entry(assistantTextWithoutUsage("recent post-boundary operation 5"));
		const recent6 = entry(assistantTextWithoutUsage("recent post-boundary operation 6"));
		const entries: SessionEntry[] = [
			task,
			staleAssistantUsage,
			priorContextCompaction,
			deletable,
			recent1,
			recent2,
			recent3,
			recent4,
			recent5,
			recent6,
		];
		const staleUsageEstimate = estimateContextTokens(buildSessionContext(entries).messages).tokens;

		expect(staleUsageEstimate).toBeGreaterThan(1_000_000);

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const transcript = preparation!.transcript;
		const transcriptEstimate = transcript.entries.reduce((total, item) => total + item.tokenEstimate, 0);

		expect(transcript.tokensBefore).toBe(transcriptEstimate);
		expect(transcript.tokensBefore).toBeLessThan(10_000);
		expect(transcript.tokensBefore).toBeLessThan(staleUsageEstimate);

		const deletableTranscriptEntry = transcript.entries.find((item) => item.entryId === deletable.id);
		expect(deletableTranscriptEntry).toBeDefined();
		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: deletable.id }] },
			transcript,
		);
		const expectedTokensAfter = Math.max(0, transcriptEstimate - deletableTranscriptEntry!.tokenEstimate);
		const expectedPercentReduction =
			transcriptEstimate > 0 ? Math.round(((transcriptEstimate - expectedTokensAfter) / transcriptEstimate) * 1000) / 10 : 0;

		expect(validated.stats.tokensBefore).toBe(transcriptEstimate);
		expect(validated.stats.tokensAfter).toBe(expectedTokensAfter);
		expect(validated.stats.percentReduction).toBe(expectedPercentReduction);
	});

	it("validates paired tool-call deletions and rebuilds without mutating retained entries", () => {
		resetIds();
		const u1 = entry(user("Original user task must stay verbatim"));
		const oldAssistant = entry(assistantText("old assistant note"));
		const call = entry(assistantToolCall("tool-1"));
		const result = entry(toolResult("tool-1", "redundant old file contents"));
		const oldAssistant2 = entry(assistantText("another old note"));
		const u2 = entry(user("Current instruction with active/path.ts:42"));
		const recent1 = entry(assistantText("recent operation 1"));
		const recent2 = entry(assistantText("recent operation 2"));
		const recent3 = entry(assistantText("recent operation 3"));
		const recent4 = entry(assistantText("recent operation 4"));
		const entries: SessionEntry[] = [u1, oldAssistant, call, result, oldAssistant2, u2, recent1, recent2, recent3, recent4];

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: call.id }, { kind: "entry", entryId: result.id }] },
			preparation!.transcript,
		);

		expect(validated.deletedTargets).toEqual([
			{ kind: "entry", entryId: call.id },
			{ kind: "entry", entryId: result.id },
		]);
		expect(validated.stats.objectsDeleted).toBe(4);
		expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore - 4);

		const compacted = contextEntry(validated.deletedTargets);
		const rebuilt = buildSessionContext([...entries, compacted]);
		expect(rebuilt.messages).not.toContain(call.message);
		expect(rebuilt.messages).not.toContain(result.message);
		expect(rebuilt.messages).toContain(u1.message);
		expect(rebuilt.messages).toContain(recent4.message);
		expect(rebuilt.messages).toContain(oldAssistant.message);
	});

	it("rejects protected user-message deletion", () => {
		resetIds();
		const u1 = entry(user("Do not delete user task"));
		const entries: SessionEntry[] = [
			u1,
			entry(assistantText("old 1")),
			entry(assistantText("old 2")),
			entry(assistantText("old 3")),
			entry(assistantText("old 4")),
			entry(assistantText("old 5")),
			entry(assistantText("old 6")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		expect(() =>
			validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: u1.id }] }, preparation.transcript),
		).toThrow(/protected/);
	});

	describe("critical overflow task-bearing context", () => {
		function branchSummaryMessage(summary: string): AgentMessage {
			return { role: "branchSummary", summary, fromId: "branch-1", timestamp: Date.now() } as AgentMessage;
		}

		// A transcript large enough that the old user + branch-summary entries sit outside the
		// recent-entry boundary, so critical_overflow may evict the protected user message.
		function criticalOverflowTranscript(): CompactableTranscript {
			const entries = [
				{
					entryId: "entry-user",
					entryType: "message" as const,
					role: "user" as const,
					text: "Original user task to be evicted under overflow.",
					tokenEstimate: 12,
					protected: true,
					contentBlocks: [],
					message: user("Original user task to be evicted under overflow."),
					toolCallIds: [],
				},
				{
					entryId: "entry-branch-summary",
					entryType: "branch_summary" as const,
					role: "branchSummary" as const,
					text: "Recap of the prior branch's task and decisions.",
					tokenEstimate: 10,
					protected: true,
					contentBlocks: [],
					message: branchSummaryMessage("Recap of the prior branch's task and decisions."),
					toolCallIds: [],
				},
				...Array.from({ length: 6 }, (_unused, index) => ({
					entryId: `entry-assistant-${index}`,
					entryType: "message" as const,
					role: "assistant" as const,
					text: `assistant context ${index}`,
					tokenEstimate: 4,
					protected: false,
					contentBlocks: [],
					message: assistantText(`assistant context ${index}`),
					toolCallIds: [],
				})),
			];
			return {
				entries,
				protectedEntryIds: ["entry-user", "entry-branch-summary"],
				tokensBefore: entries.reduce((total, item) => total + item.tokenEstimate, 0),
				settings: DEFAULT_COMPACTION_SETTINGS,
			};
		}

		it("allows deleting every user message when a branch summary still bears the task", () => {
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: "entry-user" }] },
				criticalOverflowTranscript(),
				{ mode: "critical_overflow" },
			);
			// The protected user message is evicted, and the surviving branch summary satisfies the
			// task-bearing guarantee, so validation succeeds.
			expect(validated.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-user" });
		});

		it("rejects deleting every task-bearing entry (user and branch summary)", () => {
			expect(() =>
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "entry", entryId: "entry-user" },
							{ kind: "entry", entryId: "entry-branch-summary" },
						],
					},
					criticalOverflowTranscript(),
					{ mode: "critical_overflow" },
				),
			).toThrow(/leave no user task/);
		});

		it("still protects the user message outside critical overflow", () => {
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: "entry-user" }] }, criticalOverflowTranscript()),
			).toThrow(/protected/);
		});
	});

	it("repairs deletion requests that would orphan tool calls or results", () => {
		resetIds();
		const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
		const entries: SessionEntry[] = [
			entry(user("Task")),
			entry(assistantToolCall(combinedToolCallId)),
			entry(toolResult(combinedToolCallId, "tool output")),
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const callEntry = entries[1] as SessionMessageEntry;
		const resultEntry = entries[2] as SessionMessageEntry;
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const callValidated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: callEntry.id }] },
			preparation.transcript,
		);
		expect(callValidated.deletedTargets).toEqual([
			{ kind: "entry", entryId: callEntry.id },
			{ kind: "entry", entryId: resultEntry.id },
		]);

		const resultValidated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: resultEntry.id }] },
			preparation.transcript,
		);
		expect(resultValidated.deletedTargets).toEqual([
			{ kind: "entry", entryId: resultEntry.id },
			{ kind: "entry", entryId: callEntry.id },
		]);
	});

	it("rejects content-block deletion requests that would remove every block from an entry", () => {
		resetIds();
		const multi = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: "obsolete block 1" },
				{ type: "text", text: "obsolete block 2" },
			],
		});
		const entries: SessionEntry[] = [
			entry(user("Task")),
			multi,
			entry(assistantText("recent 1")),
			entry(assistantText("recent 2")),
			entry(assistantText("recent 3")),
			entry(assistantText("recent 4")),
			entry(assistantText("recent 5")),
			entry(assistantText("recent 6")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		expect(() =>
			validateContextDeletionRequest(
				{
					deletions: [
						{ kind: "content_block", entryId: multi.id, blockIndex: 0 },
						{ kind: "content_block", entryId: multi.id, blockIndex: 1 },
					],
				},
				preparation.transcript,
			),
		).toThrow(/every content block/);
	});

	it("repairs deleted tool-call content blocks with combined call ids", () => {
		resetIds();
		const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
		const task = entry(user("Task"));
		const assistantWithCall = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: "retain assistant note" },
				{ type: "toolCall", id: combinedToolCallId, name: "read", arguments: { path: "old.ts" } },
			],
			stopReason: "toolUse",
		});
		const result = entry(toolResult(combinedToolCallId, "redundant old file contents"));
		const entries: SessionEntry[] = [
			task,
			assistantWithCall,
			result,
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "content_block", entryId: assistantWithCall.id, blockIndex: 1 }] },
			preparation.transcript,
		);

		expect(validated.deletedTargets).toEqual([
			{ kind: "content_block", entryId: assistantWithCall.id, blockIndex: 1 },
			{ kind: "entry", entryId: result.id },
		]);
		const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
		expect(rebuilt.messages).not.toContain(result.message);
		const retainedAssistant = rebuilt.messages.find(
			(message) => message.role === "assistant" && message !== assistantWithCall.message,
		) as AssistantMessage | undefined;
		expect(retainedAssistant?.content).toEqual([{ type: "text", text: "retain assistant note" }]);
	});

	it("drops stale result block targets when promoting paired result deletion", () => {
		resetIds();
		const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
		const task = entry(user("Task"));
		const call = entry(assistantToolCall(combinedToolCallId));
		const result = entry(toolResultWithImage(combinedToolCallId, "redundant text"));
		const entries: SessionEntry[] = [
			task,
			call,
			result,
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const validated = validateContextDeletionRequest(
			{
				deletions: [
					{ kind: "entry", entryId: call.id },
					{ kind: "content_block", entryId: result.id, blockIndex: 0 },
				],
			},
			preparation.transcript,
		);

		expect(validated.deletedTargets).toEqual([
			{ kind: "entry", entryId: call.id },
			{ kind: "entry", entryId: result.id },
		]);
	});

	it("promotes assistant deletion when paired repair combines with sibling block deletion", () => {
		resetIds();
		const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
		const task = entry(user("Task"));
		const assistantWithCall = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: "obsolete sibling block" },
				{ type: "toolCall", id: combinedToolCallId, name: "read", arguments: { path: "old.ts" } },
			],
			stopReason: "toolUse",
		});
		const result = entry(toolResult(combinedToolCallId, "redundant old file contents"));
		const entries: SessionEntry[] = [
			task,
			assistantWithCall,
			result,
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const validated = validateContextDeletionRequest(
			{
				deletions: [
					{ kind: "content_block", entryId: assistantWithCall.id, blockIndex: 0 },
					{ kind: "entry", entryId: result.id },
				],
			},
			preparation.transcript,
		);

		expect(validated.deletedTargets).toEqual([
			{ kind: "entry", entryId: result.id },
			{ kind: "entry", entryId: assistantWithCall.id },
		]);
	});

	it("promotes assistant deletion when accumulated block deletions cover a tool-call entry", () => {
		resetIds();
		const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
		const task = entry(user("Task"));
		const assistantWithCall = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: "obsolete sibling block" },
				{ type: "toolCall", id: combinedToolCallId, name: "read", arguments: { path: "old.ts" } },
			],
			stopReason: "toolUse",
		});
		const result = entry(toolResult(combinedToolCallId, "redundant old file contents"));
		const entries: SessionEntry[] = [
			task,
			assistantWithCall,
			result,
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const firstValidated = validateContextDeletionRequest(
			{ deletions: [{ kind: "content_block", entryId: assistantWithCall.id, blockIndex: 1 }] },
			preparation.transcript,
		);
		const accumulatedValidated = validateContextDeletionRequest(
			{
				deletions: [
					...firstValidated.deletedTargets,
					{ kind: "content_block", entryId: assistantWithCall.id, blockIndex: 0 },
				],
			},
			preparation.transcript,
		);

		expect(accumulatedValidated.deletedTargets).toEqual([
			{ kind: "entry", entryId: result.id },
			{ kind: "entry", entryId: assistantWithCall.id },
		]);
	});

	it("promotes fully deleted multi-tool assistant entries", () => {
		resetIds();
		const firstToolCallId = "call_A|fc_a";
		const secondToolCallId = "call_B|fc_b";
		const task = entry(user("Task"));
		const assistantWithCalls = entry({
			...assistantText(""),
			content: [
				{ type: "toolCall", id: firstToolCallId, name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: secondToolCallId, name: "read", arguments: { path: "b.ts" } },
			],
			stopReason: "toolUse",
		});
		const firstResult = entry(toolResult(firstToolCallId, "old a"));
		const secondResult = entry(toolResult(secondToolCallId, "old b"));
		const entries: SessionEntry[] = [
			task,
			assistantWithCalls,
			firstResult,
			secondResult,
			entry(assistantText("old filler 1")),
			entry(assistantText("old filler 2")),
			entry(assistantText("old filler 3")),
			entry(assistantText("old filler 4")),
			entry(assistantText("old filler 5")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const validated = validateContextDeletionRequest(
			{
				deletions: [
					{ kind: "entry", entryId: firstResult.id },
					{ kind: "entry", entryId: secondResult.id },
				],
			},
			preparation.transcript,
		);

		expect(validated.deletedTargets).toEqual([
			{ kind: "entry", entryId: firstResult.id },
			{ kind: "entry", entryId: secondResult.id },
			{ kind: "entry", entryId: assistantWithCalls.id },
		]);
	});

	it("supports content-block logical deletion while retaining other blocks verbatim", () => {
		resetIds();
		const multi = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: "obsolete block" },
				{ type: "text", text: "keep exact path packages/coding-agent/src/core/session-manager.ts" },
			],
		});
		const entries: SessionEntry[] = [
			entry(user("Task")),
			multi,
			entry(assistantText("recent 1")),
			entry(assistantText("recent 2")),
			entry(assistantText("recent 3")),
			entry(assistantText("recent 4")),
			entry(assistantText("recent 5")),
			entry(assistantText("recent 6")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "content_block", entryId: multi.id, blockIndex: 0 }] },
			preparation.transcript,
		);
		expect(validated.stats.objectsDeleted).toBe(1);
		expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore - 1);
		const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
		const rebuiltMulti = rebuilt.messages.find(
			(message) => message.role === "assistant" && message !== multi.message && "content" in message,
		) as AssistantMessage | undefined;

		expect(rebuiltMulti?.content).toEqual([
			{ type: "text", text: "keep exact path packages/coding-agent/src/core/session-manager.ts" },
		]);
	});

	it("counts deleted image content blocks with image-sized token estimates", () => {
		resetIds();
		const imageTokenEstimate = 1200;
		const placeholderTokenEstimate = Math.ceil("[image]".length / 4);
		const task = entry(user("Task that must remain available while deleting an old image block"));
		const call = entry(assistantToolCall("image-tool-1"));
		const imageResult = entry(toolResultWithImage("image-tool-1", "retained image tool text"));
		const entries: SessionEntry[] = [
			task,
			call,
			imageResult,
			entry(assistantTextWithoutUsage("recent image operation 1")),
			entry(assistantTextWithoutUsage("recent image operation 2")),
			entry(assistantTextWithoutUsage("recent image operation 3")),
			entry(assistantTextWithoutUsage("recent image operation 4")),
			entry(assistantTextWithoutUsage("recent image operation 5")),
			entry(assistantTextWithoutUsage("recent image operation 6")),
		];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
		const transcriptEntry = preparation.transcript.entries.find((item) => item.entryId === imageResult.id);
		const imageBlock = transcriptEntry?.contentBlocks.find((block) => block.blockIndex === 1);

		expect(transcriptEntry?.protected).toBe(false);
		expect(imageBlock).toEqual(expect.objectContaining({ type: "image", text: "[image]" }));
		expect(imageBlock!.tokenEstimate).toBe(imageTokenEstimate);
		expect(imageBlock!.tokenEstimate).toBeGreaterThan(placeholderTokenEstimate);

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }] },
			preparation.transcript,
		);

		expect(validated.stats.objectsDeleted).toBe(1);
		expect(validated.stats.tokensBefore).toBe(preparation.transcript.tokensBefore);
		expect(validated.stats.tokensAfter).toBe(preparation.transcript.tokensBefore - imageTokenEstimate);
		expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(imageTokenEstimate);
	});

	it("derives repeated compaction text and token estimates from retained blocks", () => {
		resetIds();
		const deletedText = "obsolete repeated compaction block ".repeat(20);
		const retainedText = "keep repeated compaction block packages/coding-agent/src/core/session-manager.ts";
		const task = entry(user("Task"));
		const multi = entry({
			...assistantText(""),
			content: [
				{ type: "text", text: deletedText },
				{ type: "text", text: retainedText },
			],
		});
		const priorDeletion = contextEntry([{ kind: "content_block", entryId: multi.id, blockIndex: 0 }]);
		const entries: SessionEntry[] = [
			task,
			multi,
			priorDeletion,
			entry(assistantText("recent 1")),
			entry(assistantText("recent 2")),
			entry(assistantText("recent 3")),
			entry(assistantText("recent 4")),
			entry(assistantText("recent 5")),
			entry(assistantText("recent 6")),
		];

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		const repeatedEntry = preparation!.transcript.entries.find((item) => item.entryId === multi.id);
		expect(repeatedEntry).toBeDefined();
		expect(repeatedEntry!.contentBlocks).toEqual([
			expect.objectContaining({ blockIndex: 1, text: retainedText }),
		]);
		expect(repeatedEntry!.text).toContain(retainedText);
		expect(repeatedEntry!.text).not.toContain(deletedText);
		expect(repeatedEntry!.tokenEstimate).toBe(
			estimateTokens({ ...multi.message, content: [{ type: "text", text: retainedText }] } as AssistantMessage),
		);
		expect(repeatedEntry!.tokenEstimate).toBeLessThan(estimateTokens(multi.message));
	});

	it("ignores historical /compact summaries in context compaction transcript and stats", () => {
		resetIds();
		const staleSummary = "stale /compact summary that must not be active";
		const activeSummary =
			"Active /compact summary with current decision for packages/coding-agent/src/core/session-manager.ts";
		const preStale = entry(user("old task before stale compact"));
		const staleCompaction = compactionEntry(staleSummary, preStale.id, 111);
		const summarizedBetween = entry(assistantTextWithoutUsage("summarized context between stale and active compaction"));
		const firstKept = entry(user("first retained task from active compact"));
		const retainedBeforeCompact = entry(assistantTextWithoutUsage("retained assistant context before active compact"));
		const activeCompaction = compactionEntry(activeSummary, firstKept.id, 4096);
		const retainedAfterUser = entry(user("post compact retained user instruction"));
		const retainedAfterAssistant = entry(assistantTextWithoutUsage("post compact retained assistant response"));
		const entries: SessionEntry[] = [
			preStale,
			staleCompaction,
			summarizedBetween,
			firstKept,
			retainedBeforeCompact,
			activeCompaction,
			retainedAfterUser,
			retainedAfterAssistant,
		];

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		const transcript = preparation!.transcript;
		const prompt = buildContextCompactionPrompt(transcript);
		expect(transcript.entries.map((item) => item.entryId)).toEqual([
			preStale.id,
			summarizedBetween.id,
			firstKept.id,
			retainedBeforeCompact.id,
			retainedAfterUser.id,
			retainedAfterAssistant.id,
		]);
		expect(transcript.entries.some((item) => item.entryType === "compaction")).toBe(false);
		expect(transcript.protectedEntryIds).not.toContain(activeCompaction.id);
		expect(prompt).not.toContain(activeSummary);
		expect(prompt).not.toContain(staleSummary);

		const rebuilt = buildSessionContext(entries);
		expect(transcript.entries.map((item) => item.message)).toEqual(rebuilt.messages);

		const rawObjectCount = transcript.entries.reduce((total, item) => total + 1 + item.contentBlocks.length, 0);
		const rawTokenCount = transcript.entries.reduce((total, item) => total + item.tokenEstimate, 0);
		const validated = validateContextDeletionRequest({ deletions: [] }, transcript);

		expect(transcript.tokensBefore).toBe(rawTokenCount);
		expect(validated.stats.objectsBefore).toBe(rawObjectCount);
		expect(validated.stats.tokensBefore).toBe(rawTokenCount);
		expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore);
		expect(validated.stats.tokensAfter).toBe(validated.stats.tokensBefore);
		expect(() =>
			validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: activeCompaction.id }] }, transcript),
		).toThrow(/Unknown deletion target/);
	});

	it("requires raw task-bearing context because historical /compact summaries are inert", () => {
		resetIds();
		const activeSummary = "Active /compact summary preserving the user's summarized task and constraints";
		const preCompactUser = entry(user("raw task retained because legacy summaries are inert"));
		const firstKeptAssistant = entry(assistantTextWithoutUsage("assistant context kept by summary compaction"));
		const activeCompaction = compactionEntry(activeSummary, firstKeptAssistant.id, 2048);
		const oldDeletableAssistant = entry(assistantTextWithoutUsage("old non-user assistant context safe to delete"));
		const entries: SessionEntry[] = [
			preCompactUser,
			firstKeptAssistant,
			activeCompaction,
			oldDeletableAssistant,
			entry(assistantTextWithoutUsage("recent post-compact operation 1")),
			entry(assistantTextWithoutUsage("recent post-compact operation 2")),
			entry(assistantTextWithoutUsage("recent post-compact operation 3")),
			entry(assistantTextWithoutUsage("recent post-compact operation 4")),
			entry(assistantTextWithoutUsage("recent post-compact operation 5")),
		];

		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		const transcript = preparation!.transcript;
		expect(transcript.entries.some((item) => item.role === "user")).toBe(true);
		expect(transcript.entries.some((item) => item.entryId === activeCompaction.id)).toBe(false);
		expect(transcript.entries.find((item) => item.entryId === oldDeletableAssistant.id)?.protected).toBe(false);

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: oldDeletableAssistant.id }] },
			transcript,
		);

		expect(validated.deletedTargets).toEqual([{ kind: "entry", entryId: oldDeletableAssistant.id }]);
		expect(validated.protectedEntryIds).not.toContain(activeCompaction.id);
		expect(validated.stats.objectsDeleted).toBe(2);
	});

	it("treats only context compaction entries as compaction boundaries", () => {
		resetIds();
		const u1 = entry(user("task"));
		const compaction = compactionEntry("Existing /compact summary", u1.id, 1234);
		const logicalDeletion = contextEntry([]);
		const entries: SessionEntry[] = [u1, compaction, logicalDeletion];

		expect(getLatestCompactionBoundaryEntry(entries)).toBe(logicalDeletion);
	});

	it("treats historical summary /compact entries as inert when context_compaction entries are present", () => {
		resetIds();
		const u1 = entry(user("summarized task"));
		const a1 = entry(assistantText("summarized answer"));
		const u2 = entry(user("kept task"));
		const a2 = entry(assistantText("kept answer"));
		const logicalDeletion = contextEntry([{ kind: "entry", entryId: a2.id }]);
		const compaction = compactionEntry("Existing /compact summary", u2.id, 1234);

		const rebuilt = buildSessionContext([u1, a1, u2, a2, logicalDeletion, compaction]);

		expect(rebuilt.messages.map((message) => message.role)).not.toContain("compactionSummary");
		expect(rebuilt.messages).toContain(u1.message);
		expect(rebuilt.messages).toContain(a1.message);
		expect(rebuilt.messages).toContain(u2.message);
		expect(rebuilt.messages).not.toContain(a2.message);
	});
});
