import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../src/core/messages.ts";
import { relaxTranscriptForCriticalEviction } from "../src/core/compaction/context-compaction-critical.ts";
import {
	assistantText,
	buildSessionContext,
	contextEntry,
	DEFAULT_COMPACTION_SETTINGS,
	entry,
	prepareContextCompaction,
	resetIds,
	type SessionEntry,
	user,
	toolResult,
	validateContextDeletionRequest,
} from "./context-compaction-helpers.js";

function signed(signature: string): AssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "thinking", thinking: signature, thinkingSignature: signature }],
	} as AssistantMessage;
}

function custom(content: string | (TextContent | ImageContent)[]): AgentMessage {
	return {
		role: "custom",
		customType: "visibility-test",
		content,
		display: true,
		timestamp: Date.now(),
	} as AgentMessage;
}

function branchSummary(summary: string): SessionEntry {
	return {
		type: "branch_summary",
		id: `summary-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		fromId: "old-branch",
		summary,
	} as SessionEntry;
}

function relink(entries: SessionEntry[]): SessionEntry[] {
	entries.forEach((item, index) => {
		item.parentId = index === 0 ? null : entries[index - 1]!.id;
	});
	return entries;
}

function invisibleBoundaries(): Array<() => SessionEntry> {
	return [
		() => entry({ role: "user", content: [], timestamp: Date.now() }),
		() => entry(user("  \n\t")),
		() => entry({ role: "user", content: null, timestamp: Date.now() } as never),
		() => entry({ role: "user", content: [{ type: "text", text: "  \n " }], timestamp: Date.now() }),
		() => entry(custom("   ")),
		() => entry(custom([])),
		() => branchSummary(""),
	];
}

describe("provider-visible signed-turn boundaries", () => {
	it("fresh validation ignores empty and whitespace-only user-like inputs", () => {
		for (const makeBoundary of invisibleBoundaries()) {
			resetIds();
			const first = entry(signed("sig-first"));
			const second = entry(signed("sig-second"));
			const entries = relink([
				entry(user("historical task")),
				first,
				makeBoundary(),
				second,
				entry(user("current task")),
			]);
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: first.id }] }, transcript),
			).toThrow(/completed assistant tool-use turn.*retain all or omit all/);
		}
	});

	it("persisted omission closure follows final LLM visibility and remains non-destructive", () => {
		for (const makeBoundary of invisibleBoundaries()) {
			resetIds();
			const first = entry(signed("sig-persisted-first"));
			const second = entry(signed("sig-persisted-second"));
			const branch = relink([
				entry(user("historical task")),
				first,
				makeBoundary(),
				second,
				contextEntry([{ kind: "entry", entryId: first.id }]),
				entry(user("current task")),
			]);
			const durable = JSON.stringify(branch);
			const llm = convertToLlm(buildSessionContext(branch).messages);
			const serialized = JSON.stringify(llm);
			expect(serialized).not.toContain("sig-persisted-first");
			expect(serialized).not.toContain("sig-persisted-second");
			expect(JSON.stringify(branch)).toBe(durable);
		}
	});

	it("keeps genuine call/result closure across provider-invisible user-like entries", () => {
		for (const makeBoundary of invisibleBoundaries()) {
			resetIds();
			const callId = "reused-across-invisible-boundary";
			const call = entry({
				...signed("sig-call-across-invisible-boundary"),
				content: [
					{ type: "thinking", thinking: "exact call reasoning", thinkingSignature: "sig-call-across-invisible-boundary" },
					{ type: "toolCall", id: callId, name: "read", arguments: { path: "paired.ts" } },
				],
				stopReason: "toolUse",
			} as AssistantMessage);
			const result = entry(toolResult(callId, "deleted paired result"));
			const branch = relink([
				entry(user("historical task")),
				call,
				makeBoundary(),
				result,
				contextEntry([{ kind: "entry", entryId: result.id }]),
				entry(user("current task")),
			]);

			const rebuilt = JSON.stringify(convertToLlm(buildSessionContext(branch).messages));
			expect(rebuilt).not.toContain("sig-call-across-invisible-boundary");
			expect(rebuilt).not.toContain("paired.ts");
			expect(rebuilt).not.toContain("deleted paired result");
		}

		resetIds();
		const filteredCallId = "call-across-filtered-boundary";
		const filteredCall = entry({
			...signed("sig-call-across-filtered-boundary"),
			content: [
				{ type: "thinking", thinking: "filtered boundary reasoning", thinkingSignature: "sig-call-across-filtered-boundary" },
				{ type: "toolCall", id: filteredCallId, name: "read", arguments: { path: "filtered.ts" } },
			],
			stopReason: "toolUse",
		} as AssistantMessage);
		const filteredBoundary = entry(custom([{ type: "text", text: "deleted boundary" }]));
		const filteredResult = entry(toolResult(filteredCallId, "filtered-boundary result"));
		const filteredBranch = relink([
			entry(user("historical filtered-boundary task")),
			filteredCall,
			filteredBoundary,
			filteredResult,
			contextEntry([
				{ kind: "content_block", entryId: filteredBoundary.id, blockIndex: 0 },
				{ kind: "entry", entryId: filteredResult.id },
			]),
			entry(user("current filtered-boundary task")),
		]);
		const filteredRebuilt = JSON.stringify(convertToLlm(buildSessionContext(filteredBranch).messages));
		expect(filteredRebuilt).not.toContain("sig-call-across-filtered-boundary");
		expect(filteredRebuilt).not.toContain("filtered.ts");
		expect(filteredRebuilt).not.toContain("filtered-boundary result");
	});

	it("treats filtering the only visible custom block as removing the boundary", () => {
		resetIds();
		const first = entry(signed("sig-filtered-boundary-first"));
		const boundary = entry(custom([
			{ type: "text", text: "visible boundary" },
			{ type: "text", text: "   " },
		]));
		const second = entry(signed("sig-filtered-boundary-second"));
		const base = relink([entry(user("first task")), first, boundary, second, entry(user("current task"))]);
		const transcript = prepareContextCompaction(base, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
		const boundaryEntry = transcript.entries.find((candidate) => candidate.entryId === boundary.id)!;
		boundaryEntry.protected = false;
		boundaryEntry.contentBlocks.forEach((block) => (block.protected = false));
		expect(() =>
			validateContextDeletionRequest(
				{
					deletions: [
						{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
						{ kind: "entry", entryId: first.id },
					],
				},
				transcript,
			),
		).toThrow(/completed assistant tool-use turn.*retain all or omit all/);

		const persisted = relink([
			...base.slice(0, -1),
			contextEntry([
				{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
				{ kind: "entry", entryId: first.id },
			]),
			entry(user("current task")),
		]);
		const rebuilt = JSON.stringify(convertToLlm(buildSessionContext(persisted).messages));
		expect(rebuilt).not.toContain("sig-filtered-boundary-first");
		expect(rebuilt).not.toContain("sig-filtered-boundary-second");
	});
	it("keeps image inputs and whitespace branch summaries as visible boundaries", () => {
		const visibleBoundaries: Array<() => SessionEntry> = [
			() => entry({ role: "user", content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], timestamp: Date.now() }),
			() => branchSummary("   "),
		];
		for (const makeBoundary of visibleBoundaries) {
			resetIds();
			const first = entry(signed("sig-visible-first"));
			const entries = relink([
				entry(user("first task")),
				first,
				makeBoundary(),
				entry(signed("sig-visible-second")),
				entry(user("current task")),
			]);
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
			expect(
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: first.id }] }, transcript).deletedTargets,
			).toContainEqual({ kind: "entry", entryId: first.id });
		}
	});

	it("convertToLlm emits exactly the same user-like boundaries used by turn analysis", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "   " }], timestamp: 2 },
			custom(""),
			custom([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]),
			{ role: "branchSummary", summary: "", fromId: "a", timestamp: 3 },
			{ role: "branchSummary", summary: " ", fromId: "b", timestamp: 4 },
		];
		const converted = convertToLlm(messages);
		expect(converted).toHaveLength(2);
		expect(JSON.stringify(converted[0])).toContain("image");
		expect(JSON.stringify(converted[1])).toContain("<summary>");
	});
	it("rejects deleting the image when only whitespace would remain as the final visible task", () => {
		resetIds();
		const task = entry({
			role: "user",
			content: [
				{ type: "image", data: "dGFzay1pbWFnZQ==", mimeType: "image/png" },
				{ type: "text", text: "   " },
			],
			timestamp: Date.now(),
		});
		const entries = relink([task, entry(assistantText("ack")), entry(assistantText("old detail"))]);
		const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;

		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: task.id, blockIndex: 0 }] },
				transcript,
			),
		).toThrow(/protected|no user task/);
	});

	it("rejects deleting an image-only task when all alternative task entries are provider-invisible", () => {
		const alternatives: Array<() => SessionEntry> = [
			() => entry({ role: "user", content: [], timestamp: Date.now() }),
			() => entry(user("   ")),
			() => entry(custom([])),
			() => entry(custom("   ")),
			() => branchSummary(""),
		];
		for (const makeAlternative of alternatives) {
			resetIds();
			const imageTask = entry({
				role: "user",
				content: [{ type: "image", data: "aW1hZ2Utb25seS10YXNr", mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			const entries = relink([imageTask, makeAlternative(), entry(assistantText("old detail"))]);
			const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;

			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "entry", entryId: imageTask.id }] },
					transcript,
				),
			).toThrow(/protected|no user task/);
		}
	});

	it("excludes provider-invisible tasks from transcript tokens and the recent window", () => {
		resetIds();
		const task = entry(user("task"));
		const recentAssistant = entry(assistantText("answer"));
		const whitespaceSummary = branchSummary("   ");
		const entries = relink([
			task,
			recentAssistant,
			whitespaceSummary,
			entry(user(" ".repeat(400))),
			entry(custom(" ".repeat(400))),
			branchSummary(""),
		]);

		const transcript = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!.transcript;

		expect(transcript.entries.map((item) => item.entryId)).toEqual([
			task.id,
			recentAssistant.id,
			whitespaceSummary.id,
		]);
		expect(transcript.tokensBefore).toBe(4);
		expect(transcript.entries.find((item) => item.entryId === recentAssistant.id)?.protected).toBe(true);
		const providerMessages = convertToLlm(buildSessionContext(entries).messages);
		expect(providerMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(providerMessages.some((message) => message.role === "user")).toBe(true);
	});

	it("accounts for the whole message when block deletion makes it provider-invisible", () => {
		resetIds();
		const customTask = entry(custom([
			{ type: "text", text: "delete this old detail" },
			{ type: "text", text: "   " },
		]));
		const task = entry(user("retained task"));
		const entries = relink([
			customTask,
			task,
			...Array.from({ length: 5 }, (_, index) => entry(assistantText(`recent ${index}`))),
		]);
		const prepared = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
		const transcript = relaxTranscriptForCriticalEviction(prepared);
		const customTranscriptEntry = transcript.entries.find((item) => item.entryId === customTask.id)!;
		expect(customTranscriptEntry.protected).toBe(false);

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "content_block", entryId: customTask.id, blockIndex: 0 }] },
			transcript,
		);

		expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(customTranscriptEntry.tokenEstimate);
		const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
		expect(convertToLlm(rebuilt.messages).some((message) => JSON.stringify(message).includes("old detail"))).toBe(false);
	});
	it("estimates future visible blocks consistently across blocks, entries, and transcript totals", () => {
		resetIds();
		const rawFutureBlock: Record<string, unknown> = { type: "audio", data: "future-provider-payload" };
		rawFutureBlock.self = rawFutureBlock;
		const future = entry({
			role: "user",
			content: [rawFutureBlock],
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		const transcript = prepareContextCompaction(
			relink([future, entry(assistantText("ack"))]),
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;
		const futureEntry = transcript.entries.find((candidate) => candidate.entryId === future.id)!;
		const futureBlock = futureEntry.contentBlocks[0]!;

		expect(futureBlock.tokenEstimate).toBeGreaterThan(0);
		expect(futureEntry.tokenEstimate).toBe(futureBlock.tokenEstimate);
		expect(Number.isFinite(futureBlock.tokenEstimate)).toBe(true);
		expect(Number.isFinite(futureEntry.tokenEstimate)).toBe(true);
		expect(Number.isFinite(transcript.tokensBefore)).toBe(true);
		expect(transcript.tokensBefore).toBe(
			transcript.entries.reduce((total, candidate) => total + candidate.tokenEstimate, 0),
		);
	});

	it("uses raw block visibility when an image has only malformed siblings", () => {
		resetIds();
		const first = entry(signed("sig-mixed-first"));
		const boundary = entry({
			role: "user",
			content: [
				{ type: "image", data: "bWl4ZWQtaW1hZ2U=", mimeType: "image/png" },
				{ data: "untyped-sentinel" },
				{ type: "text", text: 42 },
				{ type: "", data: "blank-type-sentinel" },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		const second = entry(signed("sig-mixed-second"));
		const base = relink([entry(user("historical task")), first, boundary, second, entry(user("current task"))]);
		const transcript = prepareContextCompaction(base, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!.transcript;
		const boundaryEntry = transcript.entries.find((candidate) => candidate.entryId === boundary.id)!;
		boundaryEntry.protected = false;
		boundaryEntry.contentBlocks.forEach((block) => (block.protected = false));

		expect(boundaryEntry.contentBlocks.map((block) => (block as { llmVisible?: boolean }).llmVisible)).toEqual([
			true,
			false,
			false,
			false,
		]);
		expect(boundaryEntry.contentBlocks[0]!.tokenEstimate).toBeGreaterThan(0);
		expect(boundaryEntry.contentBlocks.slice(1).map((block) => block.tokenEstimate)).toEqual([0, 0, 0]);
		expect(() =>
			validateContextDeletionRequest(
				{
					deletions: [
						{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
						{ kind: "entry", entryId: first.id },
					],
				},
				transcript,
			),
		).toThrow(/completed assistant tool-use turn.*retain all or omit all/);

		const persisted = relink([
			...base.slice(0, -1),
			contextEntry([
				{ kind: "content_block", entryId: boundary.id, blockIndex: 0 },
				{ kind: "entry", entryId: first.id },
			]),
			entry(user("current task")),
		]);
		const converted = convertToLlm(buildSessionContext(persisted).messages);
		const serialized = JSON.stringify(converted);
		expect(serialized).not.toContain("sig-mixed-first");
		expect(serialized).not.toContain("sig-mixed-second");
		expect(serialized).not.toContain("untyped-sentinel");
		expect(serialized).not.toContain("blank-type-sentinel");
	});

	it("treats an image with only malformed siblings as stale image-only content", () => {
		resetIds();
		const staleImage = entry({
			role: "user",
			content: [
				{ type: "image", data: "c3RhbGUtaW1hZ2U=", mimeType: "image/png" },
				{ data: "untyped" },
				{ type: "text", text: false },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		const transcript = prepareContextCompaction(
			relink([staleImage, entry(user("retained task")), entry(assistantText("old detail"))]),
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;

		expect(
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: staleImage.id }] },
				transcript,
			).deletedTargets,
		).toContainEqual({ kind: "entry", entryId: staleImage.id });
	});

	it("rejects deleting the only visible image task when malformed siblings remain", () => {
		resetIds();
		const imageTask = entry({
			role: "user",
			content: [
				{ type: "image", data: "dGFzay1pbWFnZQ==", mimeType: "image/png" },
				{ data: "untyped" },
				{ type: "text", text: 99 },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		const transcript = prepareContextCompaction(
			relink([imageTask, entry(assistantText("ack")), entry(assistantText("old detail"))]),
			DEFAULT_COMPACTION_SETTINGS,
			{ preserve_recent: 0 },
		)!.transcript;

		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageTask.id, blockIndex: 0 }] },
				transcript,
			),
		).toThrow(/protected|no user task/);
	});

	it("ignores malformed persisted branch summaries while completing signed omissions", () => {
		resetIds();
		const first = entry(signed("sig-null-summary-first"));
		const malformedSummary = branchSummary("") as SessionEntry & { summary: unknown };
		malformedSummary.summary = null;
		const second = entry(signed("sig-null-summary-second"));
		const branch = relink([
			entry(user("historical task")),
			first,
			malformedSummary as SessionEntry,
			second,
			contextEntry([{ kind: "entry", entryId: first.id }]),
			entry(user("current task")),
		]);

		let converted: ReturnType<typeof convertToLlm> = [];
		expect(() => {
			converted = convertToLlm(buildSessionContext(branch).messages);
		}).not.toThrow();
		const serialized = JSON.stringify(converted);
		expect(serialized).not.toContain("sig-null-summary-first");
		expect(serialized).not.toContain("sig-null-summary-second");
		expect(serialized).not.toContain("<summary>");
	});

});
