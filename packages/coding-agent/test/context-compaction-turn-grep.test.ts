import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	assistantText,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	entry,
	prepareContextCompaction,
	resetIds,
	toolResult,
	user,
} from "./context-compaction-helpers.js";

function signedToolAssistant(signature: string, callId: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [
			{ type: "thinking", thinking: `atomic omit marker ${signature}`, thinkingSignature: signature },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `${callId}.ts` } },
		],
		stopReason: "toolUse",
	} as AssistantMessage;
}

function stage(signature: string, callId: string, resultText: string) {
	const assistant = entry(signedToolAssistant(signature, callId));
	const result = entry(toolResult(callId, resultText));
	return { assistant, result, entries: [assistant, result] };
}

describe("context_grep_delete signed-turn batching", () => {
	it("applies a complete historical signed group atomically and skips an unrelated protected match", async () => {
		resetIds();
		const protectedTask = entry(user("atomic omit marker must remain as the task anchor"));
		const first = entry(signedToolAssistant("sig-grep-first", "call-grep-first"));
		const firstResult = entry(toolResult("call-grep-first", "first paired result"));
		const second = entry(signedToolAssistant("sig-grep-second", "call-grep-second"));
		const secondResult = entry(toolResult("call-grep-second", "second paired result"));
		const currentTask = entry(user("current task"));
		const currentAssistant = entry(assistantText("current response"));
		const transcript = prepareContextCompaction(
			[protectedTask, first, firstResult, second, secondResult, currentTask, currentAssistant],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const controller = createContextDeletionTool(transcript, { preserve_recent: 0 });

		const result = await controller.grepTool.execute("grep-complete-turn", {
			pattern: "atomic omit marker",
			target: "entry",
		});

		expect(result.details.error).toBeUndefined();
		expect(result.details.matches.map((match) => match.entryId)).toEqual([first.id, second.id]);
		expect(result.details.skipped).toContainEqual(
			expect.objectContaining({ entryId: protectedTask.id, reason: "protected_entry" }),
		);
		const deletedIds = new Set(result.details.deletedTargets.map((target) => target.entryId));
		for (const id of [first.id, firstResult.id, second.id, secondResult.id]) expect(deletedIds.has(id)).toBe(true);
	});

	it("skips every result candidate that would omit only two stages of a three-stage historical turn", async () => {
		resetIds();
		const first = stage("partial-1", "partial-call-1", "partial result marker");
		const second = stage("partial-2", "partial-call-2", "partial result marker");
		const third = stage("partial-3", "partial-call-3", "unmatched result");
		const transcript = prepareContextCompaction(
			[entry(user("historical task")), ...first.entries, ...second.entries, ...third.entries, entry(user("current task")), entry(assistantText("current"))],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const result = await createContextDeletionTool(transcript, { preserve_recent: 0 }).grepTool.execute("partial", {
			pattern: "partial result marker",
			target: "entry",
		});
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches).toEqual([]);
		expect(new Set(result.details.skipped.map((item) => item.entryId))).toEqual(new Set([first.result.id, second.result.id]));
	});

	it("applies a complete historical result group while skipping multiple active result matches", async () => {
		resetIds();
		const historicalOne = stage("historical-1", "historical-call-1", "shared result marker");
		const historicalTwo = stage("historical-2", "historical-call-2", "shared result marker");
		const activeOne = stage("active-1", "active-call-1", "shared result marker");
		const activeTwo = stage("active-2", "active-call-2", "shared result marker");
		const transcript = prepareContextCompaction(
			[
				entry(user("historical task")),
				...historicalOne.entries,
				...historicalTwo.entries,
				entry(user("active task")),
				...activeOne.entries,
				...activeTwo.entries,
			],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const result = await createContextDeletionTool(transcript, { preserve_recent: 0 }).grepTool.execute("mixed", {
			pattern: "shared result marker",
			target: "entry",
		});
		expect(result.details.error).toBeUndefined();
		expect(new Set(result.details.matches.map((item) => item.entryId))).toEqual(
			new Set([historicalOne.result.id, historicalTwo.result.id]),
		);
		expect(new Set(result.details.skipped.map((item) => item.entryId))).toEqual(
			new Set([activeOne.result.id, activeTwo.result.id]),
		);
		const deleted = new Set(result.details.deletedTargets.map((target) => target.entryId));
		for (const item of [historicalOne, historicalTwo]) {
			expect(deleted.has(item.assistant.id)).toBe(true);
			expect(deleted.has(item.result.id)).toBe(true);
		}
	});

	it("skips three dependency-conflicting results while retaining an unrelated safe match", async () => {
		resetIds();
		const stages = [
			stage("four-1", "four-call-1", "four result marker"),
			stage("four-2", "four-call-2", "four result marker"),
			stage("four-3", "four-call-3", "four result marker"),
			stage("four-4", "four-call-4", "unmatched result"),
		];
		const plain = entry(assistantText("four result marker plain assistant"));
		const transcript = prepareContextCompaction(
			[entry(user("historical task")), ...stages.flatMap((item) => item.entries), plain, entry(user("current task")), entry(assistantText("current"))],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const result = await createContextDeletionTool(transcript, { preserve_recent: 0 }).grepTool.execute("four", {
			pattern: "four result marker",
			target: "entry",
		});
		expect(result.details.error).toBeUndefined();
		expect(result.details.matches.map((item) => item.entryId)).toEqual([plain.id]);
		expect(new Set(result.details.skipped.map((item) => item.entryId))).toEqual(
			new Set(stages.slice(0, 3).map((item) => item.result.id)),
		);
		expect(result.details.deletedTargets).toContainEqual({ kind: "entry", entryId: plain.id });
	});

	it("keeps two conflicting boundaries while applying safe signed and plain matches", async () => {
		resetIds();
		const first = stage("conflict-marker-a0", "conflict-call-a0", "first result");
		const middle = stage("middle-unmatched", "conflict-call-a1", "middle result");
		const last = stage("conflict-marker-a2", "conflict-call-a2", "last result");
		const boundaryOne = entry(user("conflict-marker boundary one"));
		const boundaryTwo = entry(user("conflict-marker boundary two"));
		const plain = entry(assistantText("conflict-marker unrelated plain"));
		const transcript = prepareContextCompaction(
			[
				entry(user("historical task")), ...first.entries, boundaryOne, ...middle.entries,
				boundaryTwo, ...last.entries, plain, entry(user("current task")), entry(assistantText("current")),
			],
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		for (const boundary of [boundaryOne, boundaryTwo]) {
			const item = transcript.entries.find((candidate) => candidate.entryId === boundary.id)!;
			item.protected = false;
			item.contentBlocks.forEach((block) => (block.protected = false));
		}
		const result = await createContextDeletionTool(transcript, { preserve_recent: 0 }).grepTool.execute("boundaries", {
			pattern: "conflict-marker",
			target: "entry",
		});
		expect(result.details.error).toBeUndefined();
		expect(new Set(result.details.matches.map((item) => item.entryId))).toEqual(new Set([first.assistant.id, last.assistant.id, plain.id]));
		expect(new Set(result.details.skipped.map((item) => item.entryId))).toEqual(new Set([boundaryOne.id, boundaryTwo.id]));
		const deleted = new Set(result.details.deletedTargets.map((target) => target.entryId));
		for (const id of [first.assistant.id, first.result.id, last.assistant.id, last.result.id, plain.id]) {
			expect(deleted.has(id)).toBe(true);
		}
		expect(deleted.has(middle.assistant.id)).toBe(false);
	});
});
