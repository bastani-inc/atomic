import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildContextCompactionPrompt,
	CONTEXT_COMPACTION_MAX_TURNS,
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

function createTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const oldOne = assistantMessage("Old search output that can be deleted.");
	const oldTwo = assistantMessage("Old file read that can be deleted.");
	return {
		entries: [
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
		],
		protectedEntryIds: ["entry-user"],
		tokensBefore: 24,
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createCriticalOverflowTranscript(): CompactableTranscript {
	const oldTask = userMessage("Old protected user message may be evicted only during overflow.");
	const recentTask = userMessage("Recent protected user message must survive.");
	const entries = [
		{
			entryId: "entry-old-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Old protected user message may be evicted only during overflow.",
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
				protected: false,
				contentBlocks: [],
				message,
				toolCallIds: [],
			};
		}),
		{
			entryId: "entry-recent-user",
			entryType: "message" as const,
			role: "user" as const,
			text: "Recent protected user message must survive.",
			tokenEstimate: 8,
			protected: true,
			contentBlocks: [],
			message: recentTask,
			toolCallIds: [],
		},
	];
	return {
		entries,
		protectedEntryIds: ["entry-old-user", "entry-recent-user"],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function createContentBlockTranscript(): CompactableTranscript {
	const task = userMessage("Keep the user's task protected.");
	const multi = assistantMessage("alpha stale block\nbeta active block");
	const single = assistantMessage("single stale block");
	return {
		entries: [
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
		],
		protectedEntryIds: ["entry-user"],
		tokensBefore: 26,
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
		let continuationContext: Context | undefined;
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
			(context) => {
				continuationContext = context;
				return fauxAssistantMessage("Done recording deletion targets.");
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(faux.state.callCount).toBe(2);
		expect(capturedContext).toMatchObject({
			systemPrompt: expect.stringContaining("context_delete"),
			tools: expect.arrayContaining([
				expect.objectContaining({ name: "context_delete", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_grep_delete", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_search_transcript", executionMode: "parallel" }),
				expect.objectContaining({ name: "context_read_entry", executionMode: "parallel" }),
			]),
		});
		expect(continuationContext?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "toolResult", toolCallId: "toolu_delete_1" }),
				expect.objectContaining({ role: "toolResult", toolCallId: "toolu_delete_2" }),
			]),
		);
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
		const overflowPrompt = buildContextCompactionPrompt(transcript, "/tmp/full-transcript.jsonl", "critical_overflow");

		expect(prompt).toContain("/tmp/full-transcript.jsonl");
		expect(prompt).toContain("context_delete");
		expect(prompt).toContain("context_search_transcript");
		expect(prompt).not.toContain("context_deletion_plan");
		expect(prompt).toContain("Do not delete entries or content blocks marked protected");
		expect(overflowPrompt).toContain("critical LRU-style compaction pass");
		expect(overflowPrompt).toContain("earliest protected entries");
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
			maxMatches: 10,
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
			maxMatches: 10,
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
			maxMatches: 10,
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
			maxMatches: 10,
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

	it("reports grep guardrail skip reasons without applying matches", async () => {
		const maxController = createContextDeletionTool(createTranscript());
		const maxResult = await maxController.grepTool.execute("toolu_grep_max", {
			pattern: "Old",
			target: "entry",
			maxMatches: 1,
		});

		expect(maxResult.terminate).toBe(false);
		expect(maxResult.details.skipped).toEqual([expect.objectContaining({ reason: "max_matches_exceeded" })]);
		expect(maxController.getDeletionRequest().deletions).toEqual([]);

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

	it("keeps protected entries undeletable during standard compaction", async () => {
		const controller = createContextDeletionTool(createCriticalOverflowTranscript());

		const result = await controller.tool.execute("toolu_delete_old_user", {
			deletions: [{ kind: "entry", entryId: "entry-old-user" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/entry-old-user is protected/);
		expect(controller.getDeletionRequest().deletions).toEqual([]);
	});

	it("allows earliest protected entries during critical overflow compaction", async () => {
		const controller = createContextDeletionTool(createCriticalOverflowTranscript(), { mode: "critical_overflow" });

		const result = await controller.tool.execute("toolu_delete_old_user", {
			deletions: [{ kind: "entry", entryId: "entry-old-user" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toBeUndefined();
		expect(controller.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-old-user" }]);
	});

	it("keeps recent protected entries undeletable during critical overflow compaction", async () => {
		const controller = createContextDeletionTool(createCriticalOverflowTranscript(), { mode: "critical_overflow" });

		const result = await controller.tool.execute("toolu_delete_recent_user", {
			deletions: [{ kind: "entry", entryId: "entry-recent-user" }],
		});

		expect(result.terminate).toBe(false);
		expect(result.details.error).toMatch(/entry-recent-user is protected/);
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

	it("uses deletions recorded so far when context compaction reaches the turn cap", async () => {
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
			...Array.from({ length: CONTEXT_COMPACTION_MAX_TURNS - 1 }, (_, index) =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_grep_delete",
						{ pattern: `missing-${index}`, target: "entry", maxMatches: 10 },
						{ id: `toolu_grep_${index}` },
					),
					{ stopReason: "toolUse" },
				),
			),
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(CONTEXT_COMPACTION_MAX_TURNS).toBe(50);
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(result.stats.objectsDeleted).toBeGreaterThan(0);
		expect(faux.state.callCount).toBe(CONTEXT_COMPACTION_MAX_TURNS);
	});

	it("uses deletions recorded so far when context compaction runs out of context", async () => {
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
				errorMessage: "prompt is too long: 100 tokens > 50 maximum",
			}),
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(result.stats.objectsDeleted).toBeGreaterThan(0);
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

	it("uses the lowest supported thinking level for context compaction", async () => {
		let capturedReasoning: string | undefined;
		const faux = registerFauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(_context, options) => {
				capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
						{ id: "toolu_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("Done recording deletion targets."),
		]);

		await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, undefined, "high");

		expect(capturedReasoning).toBeUndefined();
	});

	it("uses minimal thinking for context compaction when off is unsupported", async () => {
		let capturedReasoning: string | undefined;
		const faux = registerFauxProvider({ models: [{ id: "faux-reasoning-minimal", reasoning: true }] });
		cleanups.push(() => faux.unregister());
		const model = { ...faux.getModel(), thinkingLevelMap: { off: null } };
		faux.setResponses([
			(_context, options) => {
				capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
				return fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
						{ id: "toolu_delete" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage("Done recording deletion targets."),
		]);

		await contextCompact({ transcript: createTranscript(), branchEntries: [] }, model, "test-key", undefined, undefined, "high");

		expect(capturedReasoning).toBe("minimal");
	});

	it("surfaces the last deletion tool error when context compaction has no safe deletions", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{ deletions: [{ kind: "entry", entryId: "entry-user" }] },
						{ id: "toolu_bad_delete" },
					),
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("Unable to find safe deletions."),
		]);

		await expect(
			contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key"),
		).rejects.toThrow(/last deletion tool error: Deletion target entry-user is protected/);
	});

	it("records grep bulk deletions through context compaction", async () => {
		let continuationContext: Context | undefined;
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_grep_delete",
						{ pattern: "Old", target: "entry", maxMatches: 10 },
						{ id: "toolu_grep" },
					),
					{ stopReason: "toolUse" },
				),
			(context) => {
				continuationContext = context;
				return fauxAssistantMessage("Done recording deletion targets.");
			},
		]);

		const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(faux.state.callCount).toBe(2);
		expect(continuationContext?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolCallId: "toolu_grep" })]),
		);
	});
});
