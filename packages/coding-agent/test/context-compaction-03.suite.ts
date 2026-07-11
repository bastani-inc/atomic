import { describe, expect, it } from "vitest";
import {
	resetIds,
	user,
	assistantText,
	assistantTextWithoutUsage,
	assistantTextWithTotalUsage,
	bashExecution,
	excludedBashExecution,
	excludedCustomAgentMessage,
	assistantToolCall,
	toolResult,
	toolResultWithImage,
	entry,
	customMessageEntry,
	contextEntry,
	compactionEntry,
	buildContextCompactionPrompt,
	CompactableTranscript,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
	buildSessionContext,
	CompactionEntry,
	ContextCompactionEntry,
	CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	SessionEntry,
	SessionMessageEntry,
	fauxAssistantMessage,
	registerFauxProvider,
	AssistantMessage,
	ToolResultMessage,
} from "./context-compaction-helpers.js";

describe("context compaction", () => {
		it("rejects deleting signed entries anywhere in the active assistant turn", () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const olderThinkingAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "older visible text" },
					{ type: "thinking", thinking: "older thinking becomes latest", thinkingSignature: "sig-thinking" },
				],
			} as unknown as AssistantMessage);
			const newerAssistant = entry(assistantText("newer assistant to delete"));
			const preparation = prepareContextCompaction([task, olderThinkingAssistant, newerAssistant], DEFAULT_COMPACTION_SETTINGS, {
				preserve_recent: 0,
			})!;
	
			expect(() =>
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "entry", entryId: newerAssistant.id },
							{ kind: "entry", entryId: olderThinkingAssistant.id },
						],
					},
					preparation.transcript,
				),
			).toThrow(/active assistant tool-use turn.*thinking\/redacted_thinking/);
		});


		it("rejects deleting a boundary and only one signed entry after the replay turns merge", () => {
			resetIds();
			const first = entry({
				...assistantText(""),
				content: [{ type: "thinking", thinking: "first", thinkingSignature: "sig-first" }],
			} as unknown as AssistantMessage);
			const boundary = entry(user("separating task"));
			const second = entry({
				...assistantText(""),
				content: [{ type: "thinking", thinking: "second", thinkingSignature: "sig-second" }],
			} as unknown as AssistantMessage);
			const current = entry(user("current task"));
			const preparation = prepareContextCompaction(
				[entry(user("first task")), first, boundary, second, current],
				DEFAULT_COMPACTION_SETTINGS,
				{ preserve_recent: 0 },
			)!;
			preparation.transcript.entries.find((candidate) => candidate.entryId === boundary.id)!.protected = false;

			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "entry", entryId: boundary.id }, { kind: "entry", entryId: first.id }] },
					preparation.transcript,
				),
			).toThrow(/completed assistant tool-use turn.*retain all or omit all/);
			expect(
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "entry", entryId: boundary.id },
							{ kind: "entry", entryId: first.id },
							{ kind: "entry", entryId: second.id },
						],
					},
					preparation.transcript,
				).deletedTargets,
			).toEqual([
				{ kind: "entry", entryId: boundary.id },
				{ kind: "entry", entryId: first.id },
				{ kind: "entry", entryId: second.id },
			]);
		});

		it("rejects deleting a trailing boundary with the signed entry it makes active", () => {
			resetIds();
			const signed = entry({
				...assistantText(""),
				content: [{ type: "thinking", thinking: "active after merge", thinkingSignature: "sig-active-merge" }],
			} as unknown as AssistantMessage);
			const trailingBoundary = entry(user("temporary current task"));
			const preparation = prepareContextCompaction(
				[entry(user("original task")), signed, trailingBoundary],
				DEFAULT_COMPACTION_SETTINGS,
				{ preserve_recent: 0 },
			)!;
			preparation.transcript.entries.find((candidate) => candidate.entryId === trailingBoundary.id)!.protected = false;

			expect(() =>
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "entry", entryId: trailingBoundary.id },
							{ kind: "entry", entryId: signed.id },
						],
					},
					preparation.transcript,
				),
			).toThrow(/active assistant tool-use turn/);
		});
		it("context_grep_delete skips unsafe latest-retained thinking assistant content blocks without counting them as removals", async () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const olderThinkingAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "obsolete shared grep marker in visible sibling" },
					{ type: "thinking", thinking: "private thinking remains", thinkingSignature: "sig-thinking" },
				],
			} as unknown as AssistantMessage);
			const newerAssistant = entry(assistantText("obsolete shared grep marker newer assistant"));
			const preparation = prepareContextCompaction([task, olderThinkingAssistant, newerAssistant], DEFAULT_COMPACTION_SETTINGS, {
				preserve_recent: 0,
			})!;
			const controller = createContextDeletionTool(preparation.transcript, { preserve_recent: 0 });
	
			const result = await controller.grepTool.execute("grep-call", {
				pattern: "obsolete shared grep marker",
				target: "content_block",
			});
	
			expect(result.details.error).toBeUndefined();
			expect(result.details.matches).toEqual([
				{
					entryId: newerAssistant.id,
					target: "entry",
					text: "obsolete shared grep marker newer assistant",
				},
			]);
			expect(result.details.skipped).toEqual([
				expect.objectContaining({
					entryId: olderThinkingAssistant.id,
					target: "content_block",
					blockIndex: 0,
					reason: "protected_block",
				}),
			]);
			expect(result.details.deletedTargets).toEqual([{ kind: "entry", entryId: newerAssistant.id }]);
			expect(result.details.deletedTargets).toHaveLength(1);
			expect(result.details.matches).toHaveLength(1);
		});

		it("context_delete rejects partial deletion from older retained thinking assistants", async () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const olderThinkingAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "old visible block selected first" },
					{ type: "thinking", thinking: "private thinking remains", thinkingSignature: "sig-thinking" },
				],
			} as unknown as AssistantMessage);
			const newerAssistant = entry(assistantText("newer obsolete entry marker"));
			const preparation = prepareContextCompaction([task, olderThinkingAssistant, newerAssistant], DEFAULT_COMPACTION_SETTINGS, {
				preserve_recent: 0,
			})!;
			const controller = createContextDeletionTool(preparation.transcript, { preserve_recent: 0 });
	
			const result = await controller.tool.execute("delete-old-visible", {
				deletions: [{ kind: "content_block", entryId: olderThinkingAssistant.id, blockIndex: 0 }],
			});
	
			expect(result.details.error).toMatch(/retained assistant messages containing thinking\/redacted_thinking content blocks are all-or-nothing/);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("preserves assistant thinking-bearing content arrays when applying persisted content-block deletion filters", () => {
			resetIds();
			const task = entry(user("Task"));
			const originalContent = [
				{ type: "text", text: "obsolete visible text" },
				{ type: "thinking", thinking: "persisted thinking must remain", thinkingSignature: "sig-thinking" },
				{ type: "redacted_thinking", data: "opaque-redacted-payload" },
				{ type: "text", text: "retained visible text" },
			];
			const assistantWithThinking = entry({
				...assistantText(""),
				content: originalContent,
			} as unknown as AssistantMessage);
			const persistedDeletion = contextEntry([
				{ kind: "content_block", entryId: assistantWithThinking.id, blockIndex: 0 },
				{ kind: "content_block", entryId: assistantWithThinking.id, blockIndex: 1 },
				{ kind: "content_block", entryId: assistantWithThinking.id, blockIndex: 2 },
			]);
	
			const newerAssistant = entry(assistantText("newer assistant remains latest"));
			const branch = [task, assistantWithThinking, newerAssistant, persistedDeletion];
			const rebuilt = buildSessionContext(branch);
			const rebuiltAssistant = rebuilt.messages.find((message) => message.role === "assistant") as AssistantMessage | undefined;
	
			expect(rebuiltAssistant?.content).toEqual(originalContent);
	
			const preparation = prepareContextCompaction(branch, DEFAULT_COMPACTION_SETTINGS)!;
			const transcriptAssistant = preparation.transcript.entries.find((item) => item.entryId === assistantWithThinking.id)!;
			expect(transcriptAssistant.contentBlocks.map((block) => block.type)).toEqual([
				"text",
				"thinking",
				"redacted_thinking",
				"text",
			]);
			expect(transcriptAssistant.contentBlocks.map((block) => block.text)).toEqual([
				"obsolete visible text",
				"persisted thinking must remain",
				JSON.stringify({ type: "redacted_thinking", data: "opaque-redacted-payload" }),
				"retained visible text",
			]);
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
});
