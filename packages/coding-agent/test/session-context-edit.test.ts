import type { AssistantMessage, ToolResultMessage } from "@bastani/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateProjectedContextTokens,
	prepareCompactionBoundary,
	type VerbatimCompactionDetails,
} from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function text(message: { content: string | Array<{ type: string; text?: string }> }): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

const verbatimDetails: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 3,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

/** Text of every projected message, with the verbatim boundary reported as its compacted text. */
function projectedTexts(session: SessionManager): string[] {
	return session.buildSessionProjection().messages.map((message) => {
		if (message.role === "custom" && message.customType === "compaction") {
			return text(message as { content: string | Array<{ type: string; text?: string }> });
		}
		return text(message as { content: string | Array<{ type: string; text?: string }> });
	});
}

describe("session context edits", () => {
	it("omits a target only from model projection", async () => {
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const assistantId = await session.appendMessage(assistant("partial"));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "raw output" }],
			details: { path: "large.txt" },
			isError: true,
			timestamp: Date.now(),
		};
		const resultId = await session.appendMessage(result);
		await session.appendContextEdit(assistantId, null);
		await session.appendContextEdit(resultId, null);

		expect(session.getBranch().filter((entry) => entry.type === "message")).toHaveLength(3);
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual(["user"]);
		expect((session.getEntry(resultId) as { message: ToolResultMessage }).message).toBe(result);
	});

	it("replaces only content and lets the latest edit win", async () => {
		const session = SessionManager.inMemory();
		const targetId = await session.appendMessage(assistant("original"));
		await session.appendContextEdit(targetId, { content: [{ type: "text", text: "first" }] });
		await session.appendContextEdit(targetId, null);
		await session.appendContextEdit(targetId, { content: [{ type: "text", text: "restored" }] });

		const projected = session.buildSessionProjection().messages[0];
		expect(projected.role).toBe("assistant");
		if (projected.role !== "assistant") throw new Error("expected assistant");
		expect(text(projected)).toBe("restored");
		expect(projected.usage.totalTokens).toBe(11);
		expect(text((session.getEntry(targetId) as { message: AssistantMessage }).message)).toBe("original");
	});

	it("normalizes string replacements for array-only assistant and tool-result roles", async () => {
		const session = SessionManager.inMemory();
		const assistantId = await session.appendMessage(assistant("original"));
		const resultId = await session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "original result" }],
			isError: false,
			timestamp: Date.now(),
		});
		const assistantEditId = await session.appendContextEdit(assistantId, { content: "assistant replacement" });
		const resultEditId = await session.appendContextEdit(resultId, { content: "result replacement" });

		expect(session.getEntry(assistantEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "assistant replacement" }] },
		});
		expect(session.getEntry(resultEditId)).toMatchObject({
			replacement: { content: [{ type: "text", text: "result replacement" }] },
		});
		const projected = session.buildSessionProjection().messages;
		expect(projected[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "assistant replacement" }],
		});
		expect(projected[1]).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "result replacement" }],
		});
	});

	it("normalizes imported string replacements while projecting array-only roles", async () => {
		const session = SessionManager.inMemory();
		const assistantId = await session.appendMessage(assistant("original"));
		const editId = await session.appendContextEdit(assistantId, null);
		const edit = session.getEntry(editId);
		if (edit?.type !== "context_edit") throw new Error("expected context edit");
		edit.replacement = { content: "imported replacement" };

		expect(session.buildSessionProjection().messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "imported replacement" }],
		});
	});

	it("keeps edits branch-relative", async () => {
		const session = SessionManager.inMemory();
		const targetId = await session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		await session.appendContextEdit(targetId, { content: "edited" });
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("edited");

		await session.branch(targetId);
		expect(text(session.buildSessionProjection().messages[0] as { content: string })).toBe("original");
	});

	it("rejects edits to entries off the active branch or without model content", async () => {
		const session = SessionManager.inMemory();
		const first = await session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const custom = await session.appendCustomEntry("bookkeeping", {});
		await expect(session.appendContextEdit(custom, null)).rejects.toThrow(
			/does not contribute editable model content/,
		);
		await expect(session.appendContextEdit("missing", null)).rejects.toThrow(/not found/);
		await session.branch(first);
		await session.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
		await expect(session.appendContextEdit(custom, null)).rejects.toThrow(/not on the active branch/);
	});

	it("keeps a retain-none compaction as the only pre-boundary context", async () => {
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "discarded", timestamp: Date.now() });
		const compactionId = await session.appendCompaction("exact handoff", null, 100, verbatimDetails);
		await session.appendMessage({ role: "user", content: "after", timestamp: Date.now() });

		expect(session.getEntry(compactionId)).toMatchObject({ type: "compaction", firstKeptEntryId: null });
		const projection = session.buildSessionProjection();
		expect(projection.entries[0]?.sourceEntry.id).toBe(compactionId);
		expect(projection.messages.map((message) => message.role)).toEqual(["custom", "user"]);
		const [boundary, after] = projectedTexts(session);
		expect(boundary).toContain("exact handoff");
		expect(boundary).not.toContain("discarded");
		expect(after).toBe("after");
	});

	it("applies post-compaction edits to retained pre-compaction entries", async () => {
		const session = SessionManager.inMemory();
		await session.appendMessage({ role: "user", content: "summarized", timestamp: Date.now() });
		const retainedId = await session.appendMessage({
			role: "user",
			content: "original retained",
			timestamp: Date.now(),
		});
		await session.appendCompaction("summary", retainedId, 100, verbatimDetails);
		await session.appendContextEdit(retainedId, { content: "edited retained" });

		const projection = session.buildSessionProjection();
		// The retained tail is serialized into the boundary message, so the edit lands there;
		// the retained entry and the edit itself project no standalone messages.
		expect(projection.entries.map((entry) => [entry.sourceEntry.type, entry.messages.length])).toEqual([
			["compaction", 1],
			["message", 0],
			["context_edit", 0],
		]);
		const [boundary] = projectedTexts(session);
		expect(boundary).toContain("summary");
		expect(boundary).toContain("edited retained");
		expect(boundary).not.toContain("original retained");
	});

	it("does not trust pre-edit assistant usage for projected context estimates", async () => {
		const session = SessionManager.inMemory();
		const largeUserId = await session.appendMessage({
			role: "user",
			content: "discarded input ".repeat(2_000),
			timestamp: Date.now(),
		});
		const response = assistant("small answer");
		response.usage = { ...response.usage, input: 10_000, totalTokens: 10_001 };
		const assistantId = await session.appendMessage(response);
		await session.appendContextEdit(largeUserId, null);

		const editedEstimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(editedEstimate.usageTokens).toBe(0);
		expect(editedEstimate.tokens).toBeLessThan(100);

		await session.appendContextEdit(assistantId, null);
		expect(estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens).toBe(0);
	});

	it("uses assistant usage captured after the latest context edit", async () => {
		const session = SessionManager.inMemory();
		const userId = await session.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
		await session.appendContextEdit(userId, { content: "edited" });
		const response = assistant("answer");
		response.usage = { ...response.usage, input: 4_000, output: 100, totalTokens: 4_100 };
		await session.appendMessage(response);
		await session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(4_100);
		expect(estimate.trailingTokens).toBe(1);
		expect(estimate.tokens).toBe(4_101);
	});

	it("does not reuse post-edit assistant usage after a later compaction", async () => {
		const session = SessionManager.inMemory();
		const userId = await session.appendMessage({ role: "user", content: "small input", timestamp: Date.now() });
		await session.appendContextEdit(userId, { content: "edited input" });
		const response = assistant("answer");
		response.usage = { ...response.usage, input: 50_000, output: 1, totalTokens: 50_001 };
		await session.appendMessage(response);
		await session.appendCompaction("small summary", userId, 50_001, verbatimDetails);

		const estimate = estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch());
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBeLessThan(100);
	});

	it("includes effective system and tool context in edited estimates", async () => {
		const session = SessionManager.inMemory();
		await session.appendMessage({
			role: "system",
			content: "system prompt ".repeat(3_000),
			toolsAdded: [
				{
					name: "example",
					description: "tool declaration ".repeat(100),
					parameters: { type: "object", properties: {} },
				},
			],
			timestamp: Date.now(),
		});
		const userId = await session.appendMessage({ role: "user", content: "ask", timestamp: Date.now() });
		await session.appendMessage(assistant("done"));
		await session.appendContextEdit(userId, { content: "ask" });

		expect(
			estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens,
		).toBeGreaterThan(10_000);
	});

	it("prepares compaction from edited model content", async () => {
		const session = SessionManager.inMemory();
		const omittedId = await session.appendMessage({
			role: "user",
			content: "OMIT-ME ".repeat(100),
			timestamp: Date.now(),
		});
		const replacedId = await session.appendMessage(assistant("old answer ".repeat(100)));
		await session.appendContextEdit(omittedId, null);
		await session.appendContextEdit(replacedId, { content: "REPLACED-ANSWER ".repeat(100) });
		for (let index = 0; index < 12; index++) {
			await session.appendMessage({ role: "user", content: `keep ${index} `.repeat(20), timestamp: Date.now() });
			await session.appendMessage(assistant(`suffix ${index} `.repeat(20)));
		}

		const preparation = prepareCompactionBoundary(session.getBranch(), DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const region = preparation?.region.lines.join("\n") ?? "";
		expect(region).not.toContain("OMIT-ME");
		expect(region).not.toContain("old answer");
		expect(region).toContain("REPLACED-ANSWER");
		expect(preparation?.regionEntryIds).not.toContain(omittedId);
		expect(preparation?.regionEntryIds).toContain(replacedId);
	});
});
