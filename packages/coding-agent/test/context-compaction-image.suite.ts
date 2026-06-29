import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import {
	resetIds,
	user,
	assistantText,
	assistantTextWithoutUsage,
	assistantToolCall,
	toolResult,
	toolResultWithImage,
	entry,
	contextEntry,
	buildContextCompactionPrompt,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
	buildSessionContext,
	type SessionEntry,
	type ContextCompactionEntry,
} from "./context-compaction-helpers.js";
import {
	ESTIMATED_IMAGE_TOKENS,
	ESTIMATED_IMAGE_CHARS,
	countImageContentBlocks,
	estimateImageContentTokens,
	shouldCompact,
} from "../src/core/compaction/index.ts";

const IMAGE_DATA = "aGVsbG8="; // base64 "hello"; never expected to leak into compaction output

function userWithImage(text: string): AgentMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
		],
		timestamp: Date.now(),
	};
}

function toolResultWithImages(toolCallId: string, text: string, imageCount: number): ToolResultMessage {
	const content: ToolResultMessage["content"] = [{ type: "text", text }];
	for (let i = 0; i < imageCount; i += 1) {
		content.push({ type: "image", data: IMAGE_DATA, mimeType: "image/png" });
	}
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

/** A long tail of recent non-image assistant entries so old entries are not recent-protected. */
function recentTail(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_unused, index) =>
		entry(assistantTextWithoutUsage(`recent non-image operation ${index}`)),
	);
}

describe("issue #1500 image token accounting and image context deletion", () => {
	describe("centralized image token estimation", () => {
		it("exports a single shared image token constant used by both estimation paths", () => {
			expect(ESTIMATED_IMAGE_CHARS).toBe(4800);
			expect(ESTIMATED_IMAGE_TOKENS).toBe(Math.ceil(ESTIMATED_IMAGE_CHARS / 4));
			expect(ESTIMATED_IMAGE_TOKENS).toBe(1200);
		});

		it("estimateTokens counts image content blocks at the shared estimate", () => {
			const message: AgentMessage = {
				role: "user",
				content: [
					{ type: "text", text: "x" },
					{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			};
			const textOnly: AgentMessage = { role: "user", content: [{ type: "text", text: "x" }], timestamp: Date.now() };
			expect(estimateTokens(message) - estimateTokens(textOnly)).toBe(ESTIMATED_IMAGE_TOKENS);
		});

		it("countImageContentBlocks and estimateImageContentTokens scale with image count", () => {
			const content = [
				{ type: "text", text: "hi" },
				{ type: "image" },
				{ type: "image" },
				{ type: "image" },
			];
			expect(countImageContentBlocks(content)).toBe(3);
			expect(estimateImageContentTokens(content)).toBe(3 * ESTIMATED_IMAGE_TOKENS);
			expect(countImageContentBlocks("plain string")).toBe(0);
			expect(estimateImageContentTokens("plain string")).toBe(0);
		});
	});

	describe("image tokens drive compaction thresholds", () => {
		it("counts image tokens in estimateContextTokens for trailing messages", () => {
			const imageCount = 12;
			const messages: AgentMessage[] = [
				user("task with no usage yet"),
				assistantTextWithoutUsage("response that also has no usage"),
				...Array.from({ length: imageCount }, (): AgentMessage => ({
					role: "user",
					content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
					timestamp: Date.now(),
				})),
			];
			const estimate = estimateContextTokens(messages);
			// No usage anywhere, so everything is heuristic. The image tail must contribute
			// imageCount * ESTIMATED_IMAGE_TOKENS plus a small amount of text token estimate.
			const imageContribution = imageCount * ESTIMATED_IMAGE_TOKENS;
			expect(estimate.tokens).toBeGreaterThan(imageContribution);
			expect(estimate.trailingTokens).toBeGreaterThanOrEqual(imageContribution);
			expect(estimate.usageTokens).toBe(0);
		});

		it("an image-heavy conversation triggers shouldCompact below the window reserve", () => {
			// 20 images at 1200 tokens each = 24000 tokens, well past a small window reserve.
			const imageCount = 20;
			const messages: AgentMessage[] = [
				user("task"),
				assistantTextWithoutUsage("ack"),
				...Array.from({ length: imageCount }, (): AgentMessage => ({
					role: "user",
					content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
					timestamp: Date.now(),
				})),
			];
			const estimate = estimateContextTokens(messages);
			const contextWindow = 32768;
			// Image tokens alone exceed (window - reserve) with default reserve 16384.
			expect(shouldCompact(estimate.tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
			// Sanity: a text-only tiny conversation does not compact at the same window.
			const tiny: AgentMessage[] = [user("hi"), assistantTextWithoutUsage("hello")];
			expect(shouldCompact(estimateContextTokens(tiny).tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		});

		it("counts multiple image blocks per entry in the transcript token estimate", () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("multi-image-tool"));
			const multi = entry(toolResultWithImages("multi-image-tool", "result text", 4));
			const entries: SessionEntry[] = [task, call, multi, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const multiEntry = preparation.transcript.entries.find((item) => item.entryId === multi.id)!;
			const imageBlocks = multiEntry.contentBlocks.filter((block) => block.type === "image");
			expect(imageBlocks).toHaveLength(4);
			expect(imageBlocks.every((block) => block.tokenEstimate === ESTIMATED_IMAGE_TOKENS)).toBe(true);
			const imageTokenTotal = imageBlocks.reduce((sum, block) => sum + block.tokenEstimate, 0);
			expect(imageTokenTotal).toBe(4 * ESTIMATED_IMAGE_TOKENS);
		});
	});

	describe("delete-context removes irrelevant images", () => {
		it("deletes an old irrelevant image content block and credits image-sized tokens", () => {
			resetIds();
			const task = entry(user("Task that must stay while an old image block is removed"));
			const call = entry(assistantToolCall("stale-image-tool"));
			const imageResult = entry(toolResultWithImage("stale-image-tool", "retained text alongside image"));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }] },
				preparation.transcript,
			);

			expect(validated.stats.objectsDeleted).toBe(1);
			expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);
		});

		it("deletes one of several image blocks in a single entry, retaining the rest verbatim", () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("multi-tool"));
			const multi = entry(toolResultWithImages("multi-tool", "keep this text", 3));
			const entries: SessionEntry[] = [task, call, multi, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: multi.id, blockIndex: 1 }] },
				preparation.transcript,
			);
			expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);

			const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
			const rebuiltMulti = rebuilt.messages.find(
				(message) => message.role === "toolResult" && (message as ToolResultMessage).toolCallId === "multi-tool",
			) as ToolResultMessage | undefined;
			// text block + 2 surviving image blocks remain; the deleted image index is gone.
			expect(rebuiltMulti?.content).toHaveLength(3);
			expect(rebuiltMulti?.content[0]).toMatchObject({ type: "text", text: "keep this text" });
			expect(rebuiltMulti?.content.filter((block) => block.type === "image")).toHaveLength(2);
		});

		it("finds image candidates via grep-delete of the [image] placeholder", async () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("grep-image-tool"));
			const imageResult = entry(toolResultWithImage("grep-image-tool", "text near image"));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			const result = await controller.grepTool.execute("toolu_grep", {
				pattern: "[image]",
				target: "content_block",
				maxMatches: 5,
			});

			expect(result.details.deletedTargets).toEqual([
				{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 },
			]);
			expect(result.details.stats.tokensBefore - result.details.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);
		});
	});

	describe("delete-context preserves task-relevant images", () => {
		it("deletes a stale user image content block while preserving user text", () => {
			resetIds();
			const imageUser = entry(userWithImage("old screenshot text that must remain"));
			const entries: SessionEntry[] = [imageUser, entry(assistantText("ack")), ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const userEntry = preparation.transcript.entries.find((item) => item.entryId === imageUser.id)!;
			expect(userEntry.protected).toBe(true);
			expect(userEntry.contentBlocks.map((block) => block.type)).toEqual(["text", "image"]);

			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageUser.id, blockIndex: 1 }] },
				preparation.transcript,
			);

			expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);
			const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
			const rebuiltUser = rebuilt.messages.find((message) => message.role === "user") as AgentMessage | undefined;
			expect(Array.isArray(rebuiltUser?.content)).toBe(true);
			const content = Array.isArray(rebuiltUser?.content) ? rebuiltUser.content : [];
			expect(content).toEqual([{ type: "text", text: "old screenshot text that must remain" }]);
		});

		it("grep-deletes old user images via the [image] placeholder", async () => {
			resetIds();
			const imageUser = entry(userWithImage("old pasted screenshot"));
			const entries: SessionEntry[] = [imageUser, entry(assistantText("ack")), ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			const result = await controller.grepTool.execute("toolu_grep_user_image", {
				pattern: "[image]",
				target: "content_block",
				maxMatches: 5,
			});

			expect(result.details.deletedTargets).toEqual([
				{ kind: "content_block", entryId: imageUser.id, blockIndex: 1 },
			]);
			expect(result.details.stats.tokensBefore - result.details.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);
		});

		it("keeps recent user image blocks protected", () => {
			resetIds();
			const imageUser = entry(userWithImage("current screenshot for the active task"));
			const entries: SessionEntry[] = [entry(user("Task")), entry(assistantText("ack")), imageUser];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: imageUser.id, blockIndex: 1 }] },
					preparation.transcript,
				),
			).toThrow(/last \d+ context entries|recent/);
		});

		it("rejects deleting the only block of an old user image entry", () => {
			resetIds();
			const imageOnlyUser = entry({
				role: "user",
				content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
				timestamp: Date.now(),
			});
			const entries: SessionEntry[] = [imageOnlyUser, entry(assistantText("ack")), ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: imageOnlyUser.id, blockIndex: 0 }] },
					preparation.transcript,
				),
			).toThrow(/protected|only content block/);
		});

		it("retains a task-relevant image-bearing tool result when it is recent", () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("recent-image-tool"));
			const imageResult = entry(toolResultWithImage("recent-image-tool", "recent image text"));
			// Only a short tail so the image result falls inside the default preserve_recent window.
			const entries: SessionEntry[] = [task, call, imageResult, entry(assistantTextWithoutUsage("only recent"))];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			expect(preparation.transcript.entries.find((item) => item.entryId === imageResult.id)?.protected).toBe(true);
			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }] },
					preparation.transcript,
				),
			).toThrow(/last \d+ context entries|recent/);
		});
	});

	describe("verbatim compaction never reintroduces image payloads", () => {
		it("the compaction prompt contains no base64 image data", () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("img-tool"));
			const imageResult = entry(toolResultWithImage("img-tool", "prompt text"));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const prompt = buildContextCompactionPrompt(preparation.transcript);

			expect(prompt).not.toContain(IMAGE_DATA);
			expect(prompt).toContain("[image]");
		});

		it("validated deletion results and rebuilt context never embed new image payloads", () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("img-tool"));
			const imageResult = entry(toolResultWithImage("img-tool", "prompt text"));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }] },
				preparation.transcript,
			);
			const compactionEntryRecord: ContextCompactionEntry = {
				...contextEntry(validated.deletedTargets),
				stats: validated.stats,
				protectedEntryIds: validated.protectedEntryIds,
			};
			const rebuilt = buildSessionContext([...entries, compactionEntryRecord]);

			// The image block was deleted, so no image data survives in rebuilt context at all.
			for (const message of rebuilt.messages) {
				if (!Array.isArray((message as { content?: unknown }).content)) continue;
				for (const block of (message as { content: Array<{ data?: string }> }).content) {
					expect(block.data).toBeUndefined();
				}
			}
		});
	});

	describe("budget tool reports image token share", () => {
		it("reports remainingImageTokens, imageBlockCount, and imageTokenPercent", async () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("budget-image-tool"));
			const imageResult = entry(toolResultWithImages("budget-image-tool", "text", 2));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			const before = await controller.budgetTool.execute("toolu_budget", {});
			expect(before.details.imageBlockCount).toBe(2);
			expect(before.details.remainingImageTokens).toBe(2 * ESTIMATED_IMAGE_TOKENS);
			expect(before.details.imageTokenPercent).toBeGreaterThan(0);
			expect(
				before.content[0]?.type === "text" ? before.content[0].text : "",
			).toContain("Images account for");
		});

		it("reports zero image tokens when there are no image blocks", async () => {
			resetIds();
			const task = entry(user("Task"));
			const entries: SessionEntry[] = [task, entry(assistantText("text only")), ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			const result = await controller.budgetTool.execute("toolu_budget", {});
			expect(result.details.remainingImageTokens).toBe(0);
			expect(result.details.imageBlockCount).toBe(0);
			expect(result.details.imageTokenPercent).toBe(0);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("Images account for");
		});

		it("recomputes image stats after deleting image content blocks (issue #1500 reviewer fix)", async () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("live-image-tool"));
			const imageResult = entry(toolResultWithImages("live-image-tool", "text", 2));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			// Before any deletions: both image blocks are present.
			const before = await controller.budgetTool.execute("toolu_budget_before", {});
			expect(before.details.imageBlockCount).toBe(2);
			expect(before.details.remainingImageTokens).toBe(2 * ESTIMATED_IMAGE_TOKENS);
			expect(before.details.imageTokenPercent).toBeGreaterThan(0);

			// Delete one image content block.
			await controller.tool.execute("toolu_delete", {
				deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }],
			});

			// After deleting one image block: budget reflects the reduced live image set.
			const afterOne = await controller.budgetTool.execute("toolu_budget_after_one", {});
			expect(afterOne.details.imageBlockCount).toBe(1);
			expect(afterOne.details.remainingImageTokens).toBe(ESTIMATED_IMAGE_TOKENS);
			expect(afterOne.details.imageTokenPercent).toBeLessThan(before.details.imageTokenPercent);

			// Delete the remaining image block too.
			await controller.tool.execute("toolu_delete_two", {
				deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 2 }],
			});

			// All images gone: budget reports zero image stats and drops the image text.
			const afterAll = await controller.budgetTool.execute("toolu_budget_after_all", {});
			expect(afterAll.details.imageBlockCount).toBe(0);
			expect(afterAll.details.remainingImageTokens).toBe(0);
			expect(afterAll.details.imageTokenPercent).toBe(0);
			expect(afterAll.content[0]?.type === "text" ? afterAll.content[0].text : "").not.toContain("Images account for");
		});

		it("computes imageTokenPercent against remaining context so text-only deletions increase image share (#1500)", async () => {
			resetIds();
			const task = entry(user("Task that must stay while an old image block and old text are removed"));
			const call = entry(assistantToolCall("share-image-tool"));
			const imageResult = entry(toolResultWithImage("share-image-tool", "text alongside image"));
			// A separate deletable text-heavy entry that is not recent-protected.
			const textResult = entry(toolResult("share-text-tool", "x".repeat(4000)));
			const entries: SessionEntry[] = [task, call, imageResult, textResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			// Baseline: image share measured against full pre-deletion token total.
			const before = await controller.budgetTool.execute("toolu_share_before", {});
			expect(before.details.imageBlockCount).toBe(1);
			expect(before.details.remainingImageTokens).toBe(ESTIMATED_IMAGE_TOKENS);
			expect(before.details.imageTokenPercent).toBeGreaterThan(0);

			// Delete only the text-heavy entry; image blocks are untouched.
			await controller.tool.execute("toolu_delete_text", {
				deletions: [{ kind: "entry", entryId: textResult.id }],
			});

			// Remaining image token count is unchanged, but the denominator shrank
			// (currentTokensAfter < tokensBefore), so the image share must rise.
			const afterText = await controller.budgetTool.execute("toolu_share_after_text", {});
			expect(afterText.details.remainingImageTokens).toBe(ESTIMATED_IMAGE_TOKENS);
			expect(afterText.details.imageBlockCount).toBe(1);
			expect(afterText.details.currentTokensAfter).toBeLessThan(before.details.tokensBefore);
			expect(afterText.details.imageTokenPercent).toBeGreaterThan(before.details.imageTokenPercent);

			// Sanity: image share equals remainingImageTokens / currentTokensAfter.
			const expectedShare = Math.round((ESTIMATED_IMAGE_TOKENS / afterText.details.currentTokensAfter) * 1000) / 10;
			expect(afterText.details.imageTokenPercent).toBe(expectedShare);
		});
	});
});
