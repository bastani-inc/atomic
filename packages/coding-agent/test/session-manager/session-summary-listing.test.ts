import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionHeader, SessionManager } from "../../src/core/session-manager.ts";

/**
 * A `session_summary` entry is only shown by the resume picker while it still describes the
 * session. `summarizedThroughId` anchors it to the last user/assistant message it covered, and a
 * later `branch_summary` retires it because the branch it described was abandoned.
 */

function header(id: string, cwd: string): SessionHeader {
	return { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
}

function writeSessionFile(dir: string, id: string, cwd: string, lines: string[]): void {
	const h = header(id, cwd);
	writeFileSync(
		join(dir, `${h.timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
		`${JSON.stringify(h)}\n${lines.join("\n")}\n`,
	);
}

function userMessage(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
}

function assistantMessage(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:02Z",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2, stopReason: "stop" },
	});
}

function toolResult(id: string, parentId: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:03Z",
		message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: "ok", isError: false, timestamp: 3 },
	});
}

function sessionSummary(id: string, parentId: string, summary: string, summarizedThroughId: string): string {
	return JSON.stringify({
		type: "session_summary",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:04Z",
		summary,
		summarizedThroughId,
	});
}

function branchSummary(id: string, parentId: string): string {
	return JSON.stringify({
		type: "branch_summary",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:05Z",
		fromId: parentId,
		summary: "abandoned branch",
	});
}

describe("resume listing surfaces session summaries", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-summary-list-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("exposes the summary while it still anchors to the newest conversation message", async () => {
		writeSessionFile(dir, "fresh", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
			sessionSummary("s1", "m2", "Added resume summaries to the session picker", "m2"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBe("Added resume summaries to the session picker");
	});

	it("drops the summary once a newer message lands", async () => {
		writeSessionFile(dir, "stale", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
			sessionSummary("s1", "m2", "Added resume summaries to the session picker", "m2"),
			userMessage("m3", "s1", "now also handle workflows"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBeUndefined();
	});

	it("drops the summary once a branch summary retires it", async () => {
		writeSessionFile(dir, "branched", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
			sessionSummary("s1", "m2", "Added resume summaries to the session picker", "m2"),
			branchSummary("b1", "s1"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBeUndefined();
	});

	it("ignores tool results when anchoring, so a tool turn does not make the summary stale", async () => {
		writeSessionFile(dir, "tools", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
			sessionSummary("s1", "m2", "Added resume summaries to the session picker", "m2"),
			toolResult("t1", "s1"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBe("Added resume summaries to the session picker");
	});

	it("keeps a summary written after a branch summary", async () => {
		// Retirement is positional, not permanent: a summary generated after the branch summary
		// describes the current branch and must survive.
		writeSessionFile(dir, "rebranched", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
			branchSummary("b1", "m2"),
			sessionSummary("s1", "b1", "Reworked the resume picker after a rewind", "m2"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBe("Reworked the resume picker after a rewind");
	});

	it("leaves the summary absent when the session never generated one", async () => {
		writeSessionFile(dir, "none", cwd, [
			userMessage("m1", null, "add a resume summary"),
			assistantMessage("m2", "m1", "done"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions[0]?.summary).toBeUndefined();
	});
});
