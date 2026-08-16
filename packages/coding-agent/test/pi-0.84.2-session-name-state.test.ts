import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionHeader, SessionManager } from "../src/core/session-manager.ts";

/**
 * Upstream 7bdb16c2 gave pi's storage a has_session_name / session_name pair so a cleared
 * name stops reading as "never named". Atomic's JSONL already records the distinction — a
 * clear appends a `session_info` entry with `name: ""`, a never-named session has none —
 * so this layer surfaces it at the read side only: `getLatestSessionName` returns a name
 * state and the `SessionInfo` list reducer keeps `hasName` alongside `name`.
 */
describe("pi 0.84.2 session name state", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-name-state-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeSessionFile(id: string, lines: string[]): string {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id,
			timestamp: "2025-01-01T00:00:00Z",
			cwd,
		};
		const path = join(dir, `${header.timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		writeFileSync(path, `${JSON.stringify(header)}\n${lines.join("\n")}\n`);
		return path;
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

	function sessionInfo(id: string, parentId: string | null, name: string): string {
		return JSON.stringify({
			type: "session_info",
			id,
			parentId,
			timestamp: "2025-01-01T00:00:02Z",
			name,
		});
	}

	it("cleared-session-name-differs-from-never-named", async () => {
		const clearedPath = writeSessionFile("cleared", [
			userMessage("m1", null, "chase the flaky test"),
			sessionInfo("n1", "m1", "Bug hunt"),
			sessionInfo("n2", "n1", ""),
		]);
		const neverPath = writeSessionFile("never", [userMessage("m1", null, "chase the flaky test")]);

		// The list reducer keeps the distinction per session_info presence.
		const sessions = await SessionManager.list(cwd, dir);
		const cleared = sessions.find((s) => s.id === "cleared");
		const never = sessions.find((s) => s.id === "never");
		expect(cleared).toBeDefined();
		expect(never).toBeDefined();
		expect(cleared?.name).toBeUndefined();
		expect(cleared?.hasName).toBe(true);
		expect(never?.name).toBeUndefined();
		expect(never?.hasName).toBeFalsy();

		// Opening the same files reports the same states through SessionManager.
		const clearedSession = SessionManager.open(clearedPath);
		expect(clearedSession.getSessionNameState()).toEqual({ hasName: true });
		const neverSession = SessionManager.open(neverPath);
		expect(neverSession.getSessionNameState()).toEqual({ hasName: false });

		// The bare-string surface is unchanged: both still read as nameless.
		expect(clearedSession.getSessionName()).toBeUndefined();
		expect(neverSession.getSessionName()).toBeUndefined();
	});

	it("reports the latest name while the session stays named", async () => {
		const path = writeSessionFile("named", [
			userMessage("m1", null, "chase the flaky test"),
			sessionInfo("n1", "m1", "First title"),
			sessionInfo("n2", "n1", "Second title"),
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions.find((s) => s.id === "named")).toMatchObject({
			name: "Second title",
			hasName: true,
		});

		const session = SessionManager.open(path);
		expect(session.getSessionNameState()).toEqual({ hasName: true, name: "Second title" });
		expect(session.getSessionName()).toBe("Second title");
	});

	it("treats a whitespace-only latest name as a clear", () => {
		const path = writeSessionFile("blank", [
			userMessage("m1", null, "chase the flaky test"),
			sessionInfo("n1", "m1", "Bug hunt"),
			sessionInfo("n2", "n1", "   "),
		]);

		expect(SessionManager.open(path).getSessionNameState()).toEqual({ hasName: true });
	});

	it("keeps the distinction across the live name and clear path", () => {
		const session = SessionManager.inMemory(cwd);
		expect(session.getSessionNameState()).toEqual({ hasName: false });

		session.appendSessionInfo("Sprint");
		expect(session.getSessionNameState()).toEqual({ hasName: true, name: "Sprint" });

		session.appendSessionInfo("");
		expect(session.getSessionNameState()).toEqual({ hasName: true });
		expect(session.getSessionName()).toBeUndefined();
	});

	it("still writes a clear as a session_info entry with an empty name", () => {
		const session = SessionManager.create(cwd, dir);
		session.appendMessage({ role: "user", content: "name this session", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.appendSessionInfo("Sprint");
		session.appendSessionInfo("");
		session.flush();

		// The storage format is unchanged: a clear is a session_info entry with name "".
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const infoEntries = readFileSync(file!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; name?: string })
			.filter((entry) => entry.type === "session_info");
		expect(infoEntries.map((entry) => entry.name)).toEqual(["Sprint", ""]);
	});
});
