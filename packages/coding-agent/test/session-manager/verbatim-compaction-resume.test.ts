import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import {
	type CustomMessage,
	convertToLlm,
	isVerbatimCompactionMessage,
	VERBATIM_COMPACTION_PREFIX,
} from "../../src/core/messages.js";
import { buildSessionContext, type SessionEntry, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

function details(rung: VerbatimCompactionDetails["rung"] = "standard"): VerbatimCompactionDetails {
	return {
		strategy: "verbatim-lines",
		promptVersion: 2,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
		stats: {
			linesBefore: 20,
			linesDeleted: 10,
			linesKept: 10,
			rangeCount: 1,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
		rung,
	};
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: userMsg(text) };
}

describe("verbatim compaction persistence and resume", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("persists the exact string and appends the kept tail to the boundary text across open", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-verbatim-resume-"));
		tempDirs.push(cwd);
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage(userMsg("historical user"));
		manager.appendMessage(assistantMsg("historical answer"));
		const firstKeptEntryId = manager.appendMessage(userMsg("kept user"));
		manager.appendMessage(assistantMsg("kept answer"));
		const compactedText = "[User]: historical user\n(filtered 8 lines)";
		const compactionId = manager.appendCompaction(compactedText, firstKeptEntryId, 100, details());
		manager.appendMessage(userMsg("post boundary"));

		const entry = manager.getEntry(compactionId);
		expect(entry?.type).toBe("compaction");
		if (entry?.type === "compaction") {
			expect(entry.summary).toBe(compactedText);
			expect(entry.firstKeptEntryId).toBe(firstKeptEntryId);
			expect(entry.details).toMatchObject({ strategy: "verbatim-lines" });
		}

		const builtContext = manager.buildSessionContext();
		expect(isVerbatimCompactionMessage(builtContext.messages[0] as CustomMessage)).toBe(true);
		expect(isVerbatimCompactionMessage({ ...builtContext.messages[0] } as CustomMessage)).toBe(false);
		const beforeResume = convertToLlm(builtContext.messages);
		// One boundary text message (compacted string + kept tail) plus the post-boundary message.
		expect(beforeResume).toHaveLength(2);
		expect(beforeResume[0]).toMatchObject({
			role: "user",
			content: [
				{
					type: "text",
					text: `${VERBATIM_COMPACTION_PREFIX + compactedText}\n\n[User]: kept user\n\n[Assistant]: kept answer`,
				},
			],
		});
		expect(JSON.stringify(beforeResume)).not.toContain("historical answer");
		expect(JSON.stringify(beforeResume)).toContain("post boundary");

		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const resumed = SessionManager.open(file!);
		const resumedContext = resumed.buildSessionContext();
		expect(isVerbatimCompactionMessage(resumedContext.messages[0] as CustomMessage)).toBe(true);
		expect(convertToLlm(resumedContext.messages)).toEqual(beforeResume);
	});

	it("flattens a mid-turn kept tail instead of replaying unpaired tool blocks", () => {
		const before = messageEntry("m1", null, "compacted away");
		const danglingToolCall: SessionEntry = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				...assistantMsg("looking"),
				content: [
					{ type: "text", text: "looking" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "old.ts" } },
				],
				stopReason: "toolUse",
			},
		};
		const boundary: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "m2",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "[User]: durable",
			firstKeptEntryId: "m2",
			tokensBefore: 20,
			details: details(),
		};
		const messages = buildSessionContext([before, danglingToolCall, boundary]).messages;

		expect(messages).toHaveLength(1);
		expect(messages.every((message) => message.role !== "assistant")).toBe(true);
		expect(convertToLlm(messages)[0]).toMatchObject({
			role: "user",
			content: [
				{
					type: "text",
					text: `${VERBATIM_COMPACTION_PREFIX}[User]: durable\n\n[Assistant]: looking\n\n[Assistant tool calls]: read(path="old.ts")`,
				},
			],
		});
	});

	it("keeps retained images and full tool output when flattening the kept tail", () => {
		const before = messageEntry("m1", null, "compacted away");
		const toolCall: SessionEntry = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				...assistantMsg("reading"),
				content: [
					{ type: "text", text: "reading" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } },
				],
				stopReason: "toolUse",
			},
		};
		const longOutput = "y".repeat(16_050);
		const toolResult: SessionEntry = {
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [
					{ type: "text", text: longOutput },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 1,
			},
		};
		const boundary: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "m3",
			timestamp: "2026-01-01T00:00:03.000Z",
			summary: "[User]: durable",
			firstKeptEntryId: "m2",
			tokensBefore: 20,
			details: details(),
		};
		const converted = convertToLlm(buildSessionContext([before, toolCall, toolResult, boundary]).messages);

		expect(converted).toHaveLength(1);
		expect(converted[0].role).toBe("user");
		const content = converted[0].content as (
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string }
		)[];
		expect(content).toHaveLength(2);
		expect(content[0]).toMatchObject({
			type: "text",
			text: `${VERBATIM_COMPACTION_PREFIX}[User]: durable\n\n[Assistant]: reading\n\n[Assistant tool calls]: read(path="shot.png")\n\n[Tool result]: ${longOutput}\n`,
		});
		expect(content[0].type === "text" && content[0].text).not.toContain("more characters truncated");
		expect(content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
	});

	it("durably rebuilds a zero-retention boundary without restoring a hidden message", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-verbatim-zero-tail-"));
		tempDirs.push(cwd);
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage(userMsg("fully compacted user"));
		manager.appendMessage(assistantMsg("fully compacted answer"));
		const compactedText = "[User]: fully compacted user\n(filtered 8 lines)";
		const compactionId = manager.appendCompaction(compactedText, null, 100, {
			...details(),
			parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "task" },
		});
		manager.appendMessage(userMsg("after boundary"));

		const persisted = manager.getEntry(compactionId);
		expect(persisted?.type === "compaction" && persisted.firstKeptEntryId).toBeNull();
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		expect(readFileSync(file!, "utf8")).toContain('"firstKeptEntryId":null');
		const resumed = SessionManager.open(file!);
		const rebuiltMessages = convertToLlm(resumed.buildSessionContext().messages);
		expect(rebuiltMessages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: VERBATIM_COMPACTION_PREFIX + compactedText }],
		});
		const rebuilt = JSON.stringify(rebuiltMessages);
		expect(rebuilt).toContain("after boundary");
		expect(rebuilt).not.toContain("fully compacted answer");
	});

	it("treats legacy deletion and non-verbatim compaction records as inert", () => {
		const first = messageEntry("m1", null, "first");
		const legacyDeletion: SessionEntry = {
			type: "context_compaction",
			id: "d1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			promptVersion: 1,
			deletedTargets: [{ kind: "entry", entryId: "m1" }],
			protectedEntryIds: [],
			stats: {
				objectsBefore: 1,
				objectsAfter: 0,
				objectsDeleted: 1,
				tokensBefore: 4,
				tokensAfter: 0,
				percentReduction: 100,
			},
		};
		const legacySummary: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "d1",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "legacy summary",
			firstKeptEntryId: "m1",
			tokensBefore: 4,
			details: undefined,
		};
		const last = messageEntry("m2", "c1", "last");
		const context = buildSessionContext([first, legacyDeletion, legacySummary, last]);
		expect(context.messages.map((message) => (message.role === "user" ? message.content : ""))).toEqual([
			"first",
			"last",
		]);
	});

	it("falls back to boundary plus post-boundary messages when the kept id is missing", () => {
		const before = messageEntry("m1", null, "must not re-enter");
		const boundary: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "[User]: durable",
			firstKeptEntryId: "missing",
			tokensBefore: 20,
			details: details(),
		};
		const after = messageEntry("m2", "c1", "after");
		const messages = buildSessionContext([before, boundary, after]).messages;
		expect(messages).toHaveLength(2);
		expect(JSON.stringify(messages)).not.toContain("must not re-enter");
		expect(JSON.stringify(messages)).toContain("[User]: durable");
		expect(JSON.stringify(messages)).toContain("after");
	});

	it("uses only the latest active verbatim boundary", () => {
		const root = messageEntry("m1", null, "root");
		const firstBoundary: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "[User]: first durable summary",
			firstKeptEntryId: "m1",
			tokensBefore: 30,
			details: details(),
		};
		const middle = messageEntry("m2", "c1", "middle tail");
		const latestBoundary: SessionEntry = {
			...firstBoundary,
			id: "c2",
			parentId: "m2",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "[User]: latest durable summary",
			firstKeptEntryId: "m2",
		};
		const after = messageEntry("m3", "c2", "after latest");
		const serialized = JSON.stringify(
			buildSessionContext([root, firstBoundary, middle, latestBoundary, after]).messages,
		);
		expect(serialized).toContain("latest durable summary");
		expect(serialized).not.toContain("first durable summary");
		expect(serialized).toContain("middle tail");
		expect(serialized).toContain("after latest");
	});

	it("rejects persistence when firstKeptEntryId is not in the session tree", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMsg("hello"));
		expect(() => manager.appendCompaction("text", "missing", 1, details())).toThrow("Entry missing not found");
	});
});
