import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERBATIM_COMPACTION_PREFIX, convertToLlm, isVerbatimCompactionMessage, type CustomMessage } from "../../src/core/messages.js";
import { buildSessionContext, SessionManager, type SessionEntry } from "../../src/core/session-manager.js";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { setSessionAppendImplementationForTest } from "../../src/core/session-manager-storage.js";
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
		setSessionAppendImplementationForTest(undefined);
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	it("persists the exact string and rebuilds the boundary plus kept tail across open", () => {
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
		expect(beforeResume).toHaveLength(4);
		expect(beforeResume[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: VERBATIM_COMPACTION_PREFIX + compactedText }],
		});
		expect(JSON.stringify(beforeResume)).not.toContain("historical answer");
		expect(JSON.stringify(beforeResume)).toContain("kept user");
		expect(JSON.stringify(beforeResume)).toContain("kept answer");
		expect(JSON.stringify(beforeResume)).toContain("post boundary");

		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		const resumed = SessionManager.open(file!);
		const resumedContext = resumed.buildSessionContext();
		expect(isVerbatimCompactionMessage(resumedContext.messages[0] as CustomMessage)).toBe(true);
		expect(convertToLlm(resumedContext.messages)).toEqual(beforeResume);
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
			stats: { objectsBefore: 1, objectsAfter: 0, objectsDeleted: 1, tokensBefore: 4, tokensAfter: 0, percentReduction: 100 },
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
		expect(context.messages.map((message) => message.role === "user" ? message.content : "")).toEqual(["first", "last"]);
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
		const serialized = JSON.stringify(buildSessionContext([root, firstBoundary, middle, latestBoundary, after]).messages);
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

	function fullDetails(): VerbatimCompactionDetails {
		return { ...details("planned"), promptVersion: 4, format: "full-collapse" };
	}

	it("reconstructs a v2 full-collapse boundary as the string plus post-boundary entries only", () => {
		const before = messageEntry("m1", null, "folded user");
		const anchor = messageEntry("m2", "m1", "folded assistant");
		const boundary: SessionEntry = {
			type: "compaction", id: "c1", parentId: "m2", timestamp: "2026-01-01T00:00:02.000Z",
			summary: "[User]: folded user\n(filtered 4 lines)", firstKeptEntryId: "m2", tokensBefore: 100, details: { ...fullDetails(), rung: "extension" },
		};
		const after = messageEntry("m3", "c1", "after boundary");
		const messages = buildSessionContext([before, anchor, boundary, after]).messages;
		// Format, not the extension rung, suppresses the pre-boundary kept tail.
		expect(messages).toHaveLength(2);
		const serialized = JSON.stringify(convertToLlm(messages));
		expect(serialized).toContain("[User]: folded user");
		expect(serialized).not.toContain("folded assistant");
		expect(serialized).toContain("after boundary");
	});

	it("keeps legacy (format-absent) boundaries replaying their kept tail", () => {
		const root = messageEntry("m1", null, "kept root");
		const legacy: SessionEntry = {
			type: "compaction", id: "c1", parentId: "m1", timestamp: "2026-01-01T00:00:01.000Z",
			summary: "[User]: durable", firstKeptEntryId: "m1", tokensBefore: 20, details: details("planned"),
		};
		const after = messageEntry("m2", "c1", "after legacy");
		const serialized = JSON.stringify(buildSessionContext([root, legacy, after]).messages);
		// Format absence, not the planned rung, replays the structured kept tail.
		expect(serialized).toContain("kept root");
		expect(serialized).toContain("after legacy");
	});

	it("navigates branches through and around a v2 boundary and resumes byte-identically", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-full-collapse-branch-"));
		tempDirs.push(cwd);
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage(userMsg("origin user"));
		const anchor = manager.appendMessage(assistantMsg("origin answer"));
		manager.appendCompaction("[User]: origin user\n(filtered 6 lines)\n[Assistant]: origin answer", anchor, 100, fullDetails());
		manager.appendMessage(userMsg("through branch"));

		const throughContext = convertToLlm(manager.buildSessionContext().messages);
		expect(JSON.stringify(throughContext)).toContain("through branch");

		// A branch rooted before the boundary reconstructs from raw messages (no boundary on its path).
		const aroundContext = convertToLlm(buildSessionContext(manager.getEntries(), anchor).messages);
		expect(JSON.stringify(aroundContext)).toContain("origin answer");
		expect(JSON.stringify(aroundContext)).not.toContain("filtered 6 lines");

		const resumed = SessionManager.open(manager.getSessionFile()!);
		expect(convertToLlm(resumed.buildSessionContext().messages)).toEqual(throughContext);
	});

	it("restores active JSONL bytes after a partial compaction append while retaining the backup", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-compaction-partial-"));
		tempDirs.push(cwd);
		const manager = SessionManager.create(cwd, cwd);
		manager.appendMessage(userMsg("origin user"));
		const anchor = manager.appendMessage(assistantMsg("origin answer"));
		const file = manager.getSessionFile()!;
		const beforeBytes = readFileSync(file);
		const beforeEntries = manager.getEntries();
		const backup = manager.writeBackupSnapshot("partial-append");
		setSessionAppendImplementationForTest((path, data) => {
			appendFileSync(path, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
			throw new Error("injected partial write");
		});
		expect(() => manager.appendCompaction("[User]: exact", anchor, 100, fullDetails())).toThrow("injected partial write");
		expect(readFileSync(file)).toEqual(beforeBytes);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.getLeafId()).toBe(anchor);
		expect(backup && existsSync(backup)).toBe(true);
		setSessionAppendImplementationForTest(undefined);
		const next = manager.appendMessage(userMsg("after rollback"));
		expect(manager.getEntry(next)?.parentId).toBe(anchor);
		const reopened = SessionManager.open(file);
		expect(reopened.getLeafId()).toBe(next);
		expect(reopened.getEntries()).toEqual(manager.getEntries());
	});
});
