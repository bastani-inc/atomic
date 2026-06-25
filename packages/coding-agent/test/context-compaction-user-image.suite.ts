import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	assistantText,
	buildSessionContext,
	contextEntry,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	entry,
	prepareContextCompaction,
	resetIds,
	type SessionEntry,
	user,
	validateContextDeletionRequest,
} from "./context-compaction-helpers.js";
import { ESTIMATED_IMAGE_TOKENS } from "../src/core/compaction/index.ts";

const IMAGE_DATA = "aGVsbG8=";

function imageOnlyUser(imageCount = 1): AgentMessage {
	return {
		role: "user",
		content: Array.from({ length: imageCount }, () => ({ type: "image", data: IMAGE_DATA, mimeType: "image/png" })),
		timestamp: Date.now(),
	};
}

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

function recentTail(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_unused, index) => entry(assistantText(`recent non-image operation ${index}`)));
}

describe("issue #1500 stale user image-only deletion", () => {
	it("allows deleting an old standalone image-only user entry when another task-bearing entry remains", () => {
		resetIds();
		const staleImage = entry(imageOnlyUser());
		const task = entry(user("Current task text must remain"));
		const entries: SessionEntry[] = [staleImage, task, entry(assistantText("ack")), ...recentTail(6)];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: staleImage.id }] },
			preparation.transcript,
		);

		expect(validated.deletedTargets).toEqual([{ kind: "entry", entryId: staleImage.id }]);
		expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(ESTIMATED_IMAGE_TOKENS);
		const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
		expect(rebuilt.messages).not.toContainEqual(staleImage.message);
		expect(rebuilt.messages).toContainEqual(task.message);
	});

	it("canonicalizes multi-image-only user grep matches to one entry deletion", async () => {
		resetIds();
		const staleImages = entry(imageOnlyUser(2));
		const task = entry(user("Current task text must remain"));
		const entries: SessionEntry[] = [staleImages, task, entry(assistantText("ack")), ...recentTail(6)];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
		const controller = createContextDeletionTool(preparation.transcript);

		const result = await controller.grepTool.execute("toolu_grep_old_user_images", {
			pattern: "[image]",
			target: "content_block",
			maxMatches: 5,
		});

		expect(result.details.deletedTargets).toEqual([{ kind: "entry", entryId: staleImages.id }]);
		expect(result.details.matches).toHaveLength(1);
		expect(result.details.stats.tokensBefore - result.details.stats.tokensAfter).toBe(2 * ESTIMATED_IMAGE_TOKENS);
	});

	it("keeps recent image-only user entries protected", () => {
		resetIds();
		const task = entry(user("Task"));
		const recentImage = entry(imageOnlyUser());
		const entries: SessionEntry[] = [task, entry(assistantText("ack")), recentImage];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: recentImage.id }] },
				preparation.transcript,
			),
		).toThrow(/last \d+ context entries|recent/);
	});

	it("continues to protect user text blocks and image-only content-block deletion", () => {
		resetIds();
		const imageWithText = entry(userWithImage("old screenshot text that must remain"));
		const imageOnly = entry(imageOnlyUser(2));
		const entries: SessionEntry[] = [imageWithText, imageOnly, entry(user("Task")), ...recentTail(6)];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageWithText.id, blockIndex: 0 }] },
				preparation.transcript,
			),
		).toThrow(/protected/);
		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageOnly.id, blockIndex: 0 }] },
				preparation.transcript,
			),
		).toThrow(/protected|every content block/);
	});
});
