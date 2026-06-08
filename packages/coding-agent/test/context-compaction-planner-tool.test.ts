import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONTEXT_COMPACTION_PLANNER_MAX_TURNS,
	createContextDeletionPlannerTool,
	DEFAULT_COMPACTION_SETTINGS,
	type CompactableTranscript,
	planContextDeletions,
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

describe("context compaction planner structured tool", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("records deletion targets through an executable context_deletion_plan tool", async () => {
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
							"context_deletion_plan",
							{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
							{ id: "toolu_plan_1" },
						),
						fauxToolCall(
							"context_deletion_plan",
							{ deletions: [{ kind: "entry", entryId: "entry-old-2" }] },
							{ id: "toolu_plan_2" },
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

		const plan = await planContextDeletions(createTranscript(), faux.getModel(), "test-key");

		expect(plan.deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(faux.state.callCount).toBe(2);
		expect(capturedContext).toMatchObject({
			systemPrompt: expect.stringContaining("context_deletion_plan"),
			tools: expect.arrayContaining([
				expect.objectContaining({ name: "context_deletion_plan" }),
				expect.objectContaining({ name: "context_grep_delete" }),
			]),
		});
		expect(continuationContext?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "toolResult", toolCallId: "toolu_plan_1" }),
				expect.objectContaining({ role: "toolResult", toolCallId: "toolu_plan_2" }),
			]),
		);
	});

	it("sets the transcript-bound planner tool result to terminate false explicitly", async () => {
		const controller = createContextDeletionPlannerTool(createTranscript());

		const result = await controller.tool.execute("toolu_plan", {
			deletions: [{ kind: "entry", entryId: "entry-old-1" }],
		});

		expect(result.terminate).toBe(false);
		expect(controller.getPlan().deletions).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(controller.getCallCount()).toBe(1);
	});

	it("bulk deletes grep-matched entries with embedded guardrails", async () => {
		const controller = createContextDeletionPlannerTool(createTranscript());

		const result = await controller.grepTool.execute("toolu_grep", {
			pattern: "Old",
			target: "entry",
			maxMatches: 10,
		});

		expect(result.terminate).toBe(false);
		expect(controller.getPlan().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(result.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
		expect(result.details.skipped).toEqual([]);
	});

	it("grep bulk deletion skips protected matches inside the tool", async () => {
		const controller = createContextDeletionPlannerTool(createTranscript());

		const result = await controller.grepTool.execute("toolu_grep", {
			pattern: "Keep",
			target: "entry",
			maxMatches: 10,
		});

		expect(result.terminate).toBe(false);
		expect(controller.getPlan().deletions).toEqual([]);
		expect(result.details.matches).toEqual([]);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ entryId: "entry-user", reason: "protected_entry" }),
		]);
	});

	it("supports regex grep matching and invalid regex tool errors", async () => {
		const controller = createContextDeletionPlannerTool(createTranscript());

		const regexResult = await controller.grepTool.execute("toolu_regex", {
			pattern: "Old (search|file)",
			regex: true,
			target: "entry",
			maxMatches: 10,
		});

		expect(regexResult.terminate).toBe(false);
		expect(regexResult.details.error).toBeUndefined();
		expect(regexResult.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
		expect(controller.getPlan().deletions).toEqual([
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
		expect(controller.getPlan().deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
	});

	it("supports content-block grep deletion", async () => {
		const controller = createContextDeletionPlannerTool(createContentBlockTranscript());

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
		expect(controller.getPlan().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
		]);
	});

	it("reports grep guardrail skip reasons without applying matches", async () => {
		const maxController = createContextDeletionPlannerTool(createTranscript());
		const maxResult = await maxController.grepTool.execute("toolu_grep_max", {
			pattern: "Old",
			target: "entry",
			maxMatches: 1,
		});

		expect(maxResult.terminate).toBe(false);
		expect(maxResult.details.skipped).toEqual([expect.objectContaining({ reason: "max_matches_exceeded" })]);
		expect(maxController.getPlan().deletions).toEqual([]);

		const expectedController = createContextDeletionPlannerTool(createTranscript());
		const expectedResult = await expectedController.grepTool.execute("toolu_grep_expected", {
			pattern: "Old",
			target: "entry",
			expectedMatchCount: 3,
		});

		expect(expectedResult.terminate).toBe(false);
		expect(expectedResult.details.skipped).toEqual([
			expect.objectContaining({ reason: "expected_match_count_mismatch" }),
		]);
		expect(expectedController.getPlan().deletions).toEqual([]);
	});

	it("reports already-deleted content-block promotions as entry targets", async () => {
		const controller = createContextDeletionPlannerTool(createContentBlockTranscript());

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
		expect(controller.getPlan().deletions).toEqual([{ kind: "entry", entryId: "entry-single" }]);
	});

	it("returns a non-terminating tool error when merged targets violate validation", async () => {
		const controller = createContextDeletionPlannerTool(createContentBlockTranscript());

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
		expect(controller.getPlan().deletions).toEqual([
			{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
		]);
	});

	it("throws when planning is cancelled", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const abort = new AbortController();
		abort.abort();

		await expect(planContextDeletions(createTranscript(), faux.getModel(), "test-key", undefined, abort.signal)).rejects.toThrow(
			/Request was aborted/,
		);
	});

	it("stops planner execution at an explicit turn cap", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses(
			Array.from({ length: CONTEXT_COMPACTION_PLANNER_MAX_TURNS }, (_, index) =>
				fauxAssistantMessage(
					fauxToolCall(
						"context_grep_delete",
						{ pattern: `missing-${index}`, target: "entry", maxMatches: 10 },
						{ id: `toolu_grep_${index}` },
					),
					{ stopReason: "toolUse" },
				),
			),
		);

		await expect(planContextDeletions(createTranscript(), faux.getModel(), "test-key")).rejects.toThrow(
			/planner exceeded 8 turns/,
		);
	});

	it("records grep bulk deletions through the planner agent", async () => {
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

		const plan = await planContextDeletions(createTranscript(), faux.getModel(), "test-key");

		expect(plan.deletions).toEqual([
			{ kind: "entry", entryId: "entry-old-1" },
			{ kind: "entry", entryId: "entry-old-2" },
		]);
		expect(faux.state.callCount).toBe(2);
		expect(continuationContext?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolCallId: "toolu_grep" })]),
		);
	});
});
