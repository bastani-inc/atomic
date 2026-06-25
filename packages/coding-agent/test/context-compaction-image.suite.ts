import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
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
		it("refuses to delete image blocks from protected user messages", () => {
			resetIds();
			const imageUser = entry(userWithImage("analyze this screenshot"));
			const entries: SessionEntry[] = [imageUser, entry(assistantText("ack")), ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

			const userEntry = preparation.transcript.entries.find((item) => item.entryId === imageUser.id)!;
			expect(userEntry.protected).toBe(true);
			const imageBlock = userEntry.contentBlocks.find((block) => block.type === "image")!;
			expect(imageBlock.protected).toBe(true);

			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: imageUser.id, blockIndex: 1 }] },
					preparation.transcript,
				),
			).toThrow(/protected/);
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
		it("reports imageTokensBefore, imageBlockCount, and imageTokenPercent", async () => {
			resetIds();
			const task = entry(user("Task"));
			const call = entry(assistantToolCall("budget-image-tool"));
			const imageResult = entry(toolResultWithImages("budget-image-tool", "text", 2));
			const entries: SessionEntry[] = [task, call, imageResult, ...recentTail(6)];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const controller = createContextDeletionTool(preparation.transcript);

			const before = await controller.budgetTool.execute("toolu_budget", {});
			expect(before.details.imageBlockCount).toBe(2);
			expect(before.details.imageTokensBefore).toBe(2 * ESTIMATED_IMAGE_TOKENS);
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
			expect(result.details.imageTokensBefore).toBe(0);
			expect(result.details.imageBlockCount).toBe(0);
			expect(result.details.imageTokenPercent).toBe(0);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("Images account for");
		});
	});
});
