import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	assistantText,
	bashExecution,
	buildSessionContext,
	contextEntry,
	customMessageEntry,
	DEFAULT_COMPACTION_SETTINGS,
	entry,
	prepareContextCompaction,
	resetIds,
	type SessionEntry,
	toolResult,
	user,
	validateContextDeletionRequest,
} from "./context-compaction-helpers.js";
import { runDeterministicContextEviction } from "../src/core/compaction/context-compaction-eviction.js";

function thinkingAssistant(
	thinking: string,
	signature: string,
	extra: AssistantMessage["content"] = [],
): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "thinking", thinking, thinkingSignature: signature }, ...extra],
		stopReason: extra.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	} as AssistantMessage;
}

function redactedAssistant(data: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "redacted_thinking", data }],
	} as unknown as AssistantMessage;
}

function toolOnlyAssistant(callId: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "old.ts" } }],
		stopReason: "toolUse",
	};
}

describe("turn-aware signed-thinking compaction", () => {
	it("rejects a proper subset but accepts all-retained and all-omitted completed historical turns", () => {
		resetIds();
		const first = entry(thinkingAssistant("first exact thinking", "sig-first"));
		const second = entry(redactedAssistant("opaque-second"));
		const entries = [
			entry(user("historical task")),
			first,
			second,
			entry(user("current task")),
			entry(assistantText("current response")),
		];
		const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;

		expect(() =>
			validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: first.id }] }, transcript),
		).toThrow(/completed assistant tool-use turn.*retain all or omit all/);
		expect(validateContextDeletionRequest({ deletions: [] }, transcript).deletedTargets).toEqual([]);
		expect(
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: first.id }, { kind: "entry", entryId: second.id }] },
				transcript,
			).deletedTargets,
		).toEqual([{ kind: "entry", entryId: first.id }, { kind: "entry", entryId: second.id }]);
	});

	it("protects mixed signed block types in the active turn even when it ends with a tool-only assistant", () => {
		resetIds();
		const first = entry(thinkingAssistant("active exact thinking", "sig-active"));
		const second = entry(redactedAssistant("active-redacted"));
		const toolOnly = entry(toolOnlyAssistant("call-active-tail"));
		const entries = [entry(user("active task")), first, second, toolOnly];
		const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;

		for (const target of [first, second]) {
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: target.id }] }, transcript),
			).toThrow(/active assistant tool-use turn/);
		}
		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: first.id }, { kind: "entry", entryId: second.id }] },
				transcript,
			),
		).toThrow(/active assistant tool-use turn/);
	});

	it("treats every context-visible user-like input as a boundary and a trailing input as current", () => {
		const boundaryFactories: Array<() => SessionEntry> = [
			() => customMessageEntry("extension follow-up"),
			() =>
				({
					type: "branch_summary",
					id: "branch-boundary",
					parentId: null,
					timestamp: new Date().toISOString(),
					fromId: "old-branch",
					summary: "branch task",
				} as SessionEntry),
			() => entry(bashExecution("echo next", "next task", 0)),
			() => entry(user("trailing current input")),
		];

		for (const createBoundary of boundaryFactories) {
			resetIds();
			const signed = entry(thinkingAssistant("historical exact", "sig-boundary"));
			const entries = [entry(user("historical task")), signed, createBoundary()];
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
			expect(
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: signed.id }] }, transcript)
					.deletedTargets,
			).toContainEqual({ kind: "entry", entryId: signed.id });
		}
	});

	it("promotes historical signed-assistant block filters to whole-message omissions", () => {
		resetIds();
		const historicalTask = entry(user("historical task"));
		const signed = entry(
			thinkingAssistant("exact historical thinking", "sig-text-filter", [
				{ type: "text", text: "exact visible text" },
			]),
		);
		const branch = [
			historicalTask,
			signed,
			contextEntry([{ kind: "content_block", entryId: signed.id, blockIndex: 1 }]),
			entry(user("current task")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("exact historical thinking");
		expect(rebuiltJson).not.toContain("sig-text-filter");
		expect(rebuiltJson).not.toContain("exact visible text");
	});

	it("omits a signed assistant and paired result when its tool-call block is filtered", () => {
		resetIds();
		const callId = "call-filtered-signed";
		const historicalTask = entry(user("historical task"));
		const signed = entry(
			thinkingAssistant("exact tool reasoning", "sig-tool-filter", [
				{ type: "toolCall", id: callId, name: "read", arguments: { path: "exact.ts" } },
			]),
		);
		const result = entry(toolResult(callId, "exact paired result"));
		const branch = [
			historicalTask,
			signed,
			result,
			contextEntry([{ kind: "content_block", entryId: signed.id, blockIndex: 1 }]),
			entry(user("current task")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-tool-filter");
		expect(rebuiltJson).not.toContain("exact.ts");
		expect(rebuiltJson).not.toContain("exact paired result");
	});

	it("promotes block filters across every signed entry to complete omission", () => {
		resetIds();
		const historicalTask = entry(user("historical task"));
		const first = entry(thinkingAssistant("first exact", "sig-all-filtered-1", [{ type: "text", text: "first text" }]));
		const second = entry(thinkingAssistant("second exact", "sig-all-filtered-2", [{ type: "text", text: "second text" }]));
		const branch = [
			historicalTask,
			first,
			second,
			contextEntry([
				{ kind: "content_block", entryId: first.id, blockIndex: 1 },
				{ kind: "content_block", entryId: second.id, blockIndex: 1 },
			]),
			entry(user("current task")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		for (const exact of ["sig-all-filtered-1", "first text", "sig-all-filtered-2", "second text"]) {
			expect(rebuiltJson).not.toContain(exact);
		}
	});

	it("completes unsafe persisted signed subsets by omission without rewriting history", () => {
		resetIds();
		const callId = "call-historical-signed";
		const historicalTask = entry(user("historical task"));
		const first = entry(
			thinkingAssistant("byte-exact \ud800 thinking", "sig-byte-exact", [
				{ type: "toolCall", id: callId, name: "read", arguments: { path: "old.ts" } },
			]),
		);
		const result = entry(toolResult(callId, "paired result must return"));
		const second = entry(redactedAssistant("opaque-redacted-exact"));
		const persisted = contextEntry([
			{ kind: "entry", entryId: first.id },
			{ kind: "entry", entryId: result.id },
		]);
		const branch = [
			historicalTask,
			first,
			result,
			second,
			persisted,
			entry(user("current task")),
			entry(assistantText("current response")),
		];
		const durableBefore = JSON.stringify(branch);

		const rebuilt = buildSessionContext(branch);
		const rebuiltJson = JSON.stringify(rebuilt.messages);
		expect(rebuiltJson).not.toContain("byte-exact \\ud800 thinking");
		expect(rebuiltJson).not.toContain("sig-byte-exact");
		expect(rebuiltJson).not.toContain("opaque-redacted-exact");
		expect(rebuiltJson).not.toContain("paired result must return");
		expect(JSON.stringify(branch)).toBe(durableBefore);
		expect(persisted.deletedTargets).toEqual([
			{ kind: "entry", entryId: first.id },
			{ kind: "entry", entryId: result.id },
		]);
	});

	it("preserves a safe persisted complete historical signed-sequence omission", () => {
		resetIds();
		const callId = "call-safe-omission";
		const historicalTask = entry(user("historical task"));
		const first = entry(
			thinkingAssistant("omit all thinking", "sig-omit", [
				{ type: "toolCall", id: callId, name: "read", arguments: {} },
			]),
		);
		const result = entry(toolResult(callId, "omit paired result"));
		const second = entry(redactedAssistant("omit-redacted"));
		const branch = [
			historicalTask,
			first,
			result,
			second,
			contextEntry([
				{ kind: "entry", entryId: first.id },
				{ kind: "entry", entryId: result.id },
				{ kind: "entry", entryId: second.id },
			]),
			entry(user("current task")),
			entry(assistantText("current response")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-omit");
		expect(rebuiltJson).not.toContain("omit-redacted");
		expect(rebuiltJson).not.toContain("omit paired result");
	});

	it("preserves a safe complete historical omission split across persisted compaction entries", () => {
		resetIds();
		const first = entry(thinkingAssistant("split omission first", "sig-split-1"));
		const second = entry(redactedAssistant("split-opaque-2"));
		const branch = [
			entry(user("historical task")),
			first,
			second,
			contextEntry([{ kind: "entry", entryId: first.id }]),
			contextEntry([{ kind: "entry", entryId: second.id }]),
			entry(user("current task")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-split-1");
		expect(rebuiltJson).not.toContain("split-opaque-2");
	});


	it("completes a persisted partial signed omission after deleting its separating boundary", () => {
		resetIds();
		const first = entry(thinkingAssistant("merged first exact", "sig-merged-first"));
		const boundary = entry(user("deleted separating task"));
		const second = entry(redactedAssistant("merged-second-exact"));
		const persisted = contextEntry([
			{ kind: "entry", entryId: boundary.id },
			{ kind: "entry", entryId: first.id },
		]);
		const branch = [entry(user("first task")), first, boundary, second, persisted, entry(user("current task"))];
		const durableBefore = JSON.stringify(branch);

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-merged-first");
		expect(rebuiltJson).not.toContain("merged-second-exact");
		expect(rebuiltJson).not.toContain("deleted separating task");
		expect(JSON.stringify(branch)).toBe(durableBefore);
	});

	it("preserves a safe complete historical omission after deleting its separating boundary", () => {
		resetIds();
		const first = entry(thinkingAssistant("safe merged first", "sig-safe-merged-first"));
		const boundary = entry(user("deleted safe separator"));
		const second = entry(redactedAssistant("safe-merged-second"));
		const branch = [
			entry(user("first task")),
			first,
			boundary,
			second,
			contextEntry([
				{ kind: "entry", entryId: boundary.id },
				{ kind: "entry", entryId: first.id },
				{ kind: "entry", entryId: second.id },
			]),
			entry(user("current task")),
		];

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-safe-merged-first");
		expect(rebuiltJson).not.toContain("safe-merged-second");
		expect(rebuiltJson).not.toContain("deleted safe separator");
	});

	it("completes a partial merged omission when every custom boundary block is filtered", () => {
		resetIds();
		const first = entry(thinkingAssistant("custom merged first", "sig-custom-merged-first"));
		const customBoundary = customMessageEntry("temporary custom boundary");
		customBoundary.content = [{ type: "text", text: "temporary custom boundary" }];
		const second = entry(redactedAssistant("custom-merged-second"));
		const persisted = contextEntry([
			{ kind: "content_block", entryId: customBoundary.id, blockIndex: 0 },
			{ kind: "entry", entryId: first.id },
		]);
		const branch = [entry(user("first task")), first, customBoundary, second, persisted, entry(user("current task"))];
		const durableBefore = JSON.stringify(branch);

		const rebuiltJson = JSON.stringify(buildSessionContext(branch).messages);
		expect(rebuiltJson).not.toContain("sig-custom-merged-first");
		expect(rebuiltJson).not.toContain("custom-merged-second");
		expect(rebuiltJson).not.toContain("temporary custom boundary");
		expect(JSON.stringify(branch)).toBe(durableBefore);
	});
	it("deterministic eviction deletes every signed stage and paired result together, or none", () => {
		resetIds();
		const callOne = "call-evict-one";
		const callTwo = "call-evict-two";
		const historicalTask = entry(user("historical task"));
		const first = entry(
			thinkingAssistant("large first historical thinking ".repeat(20), "sig-evict-1", [
				{ type: "toolCall", id: callOne, name: "read", arguments: { path: "one.ts" } },
			]),
		);
		const firstResult = entry(toolResult(callOne, "first paired result"));
		const second = entry(
			thinkingAssistant("large second historical thinking ".repeat(20), "sig-evict-2", [
				{ type: "toolCall", id: callTwo, name: "read", arguments: { path: "two.ts" } },
			]),
		);
		const secondResult = entry(toolResult(callTwo, "second paired result"));
		const entries = [
			historicalTask,
			first,
			firstResult,
			second,
			secondResult,
			entry(user("current task")),
			...Array.from({ length: 6 }, (_, index) => entry(assistantText(`current filler ${index}`))),
		];
		const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
		const historicalIds = [first.id, firstResult.id, second.id, secondResult.id];
		const historicalTokens = transcript.entries
			.filter((candidate) => candidate.entryId === historicalTask.id || historicalIds.includes(candidate.entryId))
			.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0);
		const taskTokens = transcript.entries.find((candidate) => candidate.entryId === historicalTask.id)!.tokenEstimate;

		const firstPlan = runDeterministicContextEviction(transcript, transcript.tokensBefore - taskTokens);
		const noneOrAll = new Set(firstPlan.deletedTargets.map((target) => target.entryId));
		const deletedHistoricalCount = historicalIds.filter((entryId) => noneOrAll.has(entryId)).length;
		expect([0, historicalIds.length]).toContain(deletedHistoricalCount);

		const all = runDeterministicContextEviction(transcript, transcript.tokensBefore - historicalTokens);
		const deletedIds = new Set(all.deletedTargets.map((target) => target.entryId));
		for (const entryId of historicalIds) expect(deletedIds.has(entryId)).toBe(true);
	});

	it("deterministic eviction revisits a boundary after both merged signed groups become safe", () => {
		resetIds();
		const firstTask = entry(user("first historical task"));
		const first = entry(thinkingAssistant("first eviction reasoning ".repeat(20), "sig-stateful-first"));
		const boundary = entry(user("separating historical task"));
		const second = entry(thinkingAssistant("second eviction reasoning ".repeat(20), "sig-stateful-second"));
		const current = entry(user("current protected task"));
		const recent = Array.from({ length: 4 }, (_, index) => entry(assistantText(`recent ${index}`)));
		const transcript = prepareContextCompaction(
			[firstTask, first, boundary, second, current, ...recent],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const protectedTokens = transcript.entries
			.filter((candidate) => candidate.entryId === current.id || recent.some((item) => item.id === candidate.entryId))
			.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0);

		const result = runDeterministicContextEviction(transcript, protectedTokens);
		const deletedIds = new Set(result.deletedTargets.map((target) => target.entryId));
		for (const entryId of [first.id, boundary.id, second.id]) expect(deletedIds.has(entryId)).toBe(true);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(protectedTokens);
	});
});
