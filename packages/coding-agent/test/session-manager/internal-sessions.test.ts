import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type SessionHeader,
	SessionManager,
	findMostRecentSession,
} from "../../src/core/session-manager.ts";
import { WORKFLOW_SESSION_METADATA_ENV } from "../../src/core/session-manager-classification.ts";
import {
	isInternalHeader,
	readSessionHeader,
} from "../../src/core/session-manager-storage.ts";
import { applyInheritedWorkflowSessionClassification } from "../../src/main-session.ts";

/**
 * Regression tests for issue #1504: workflow-created (internal) sessions must
 * be excluded from the standard `/resume` history while remaining resumable
 * via the workflow-specific resume path and via explicit file/session access.
 */

function writeSessionFile(
	dir: string,
	header: SessionHeader,
	lines: string[] = [],
): string {
	const path = join(dir, `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
	writeFileSync(path, `${JSON.stringify(header)}\n${lines.join("\n")}${lines.length ? "\n" : ""}`);
	return path;
}

function userHeader(id: string, cwd: string, mtimeAgo = 0): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: new Date(Date.now() - mtimeAgo).toISOString(),
		cwd,
	};
}

function workflowHeader(id: string, cwd: string, mtimeAgo = 0): SessionHeader {
	return {
		...userHeader(id, cwd, mtimeAgo),
		internal: true,
		workflow: { runId: "run-1", stageId: "stage-x", stageName: "build" },
	};
}

describe("internal session marking", () => {
	it("createSessionHeader stores internal/workflow metadata via NewSessionOptions", () => {
		const dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
		try {
			const cwd = dir;
			const session = SessionManager.create(cwd, dir, {
				internal: true,
				workflow: { runId: "r1", stageId: "s1", stageName: "build" },
			});
			const header = session.getHeader();
			expect(header?.internal).toBe(true);
			expect(header?.workflow).toEqual({ runId: "r1", stageId: "s1", stageName: "build" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		{ internal: true },
		{ internal: true, workflow: { runId: "r", stageId: "", stageName: "n" } },
		{ internal: "yes", workflow: { runId: "r", stageId: "s", stageName: "n" } },
	] as const)("normalizes malformed creation options without hiding the session", (marker) => {
		const session = SessionManager.inMemory("/project", marker as never);
		expect(session.getHeader()).not.toHaveProperty("internal");
		expect(session.getHeader()).not.toHaveProperty("workflow");
	});

	it("markSessionInternal stamps a fresh marker on an unmarked persisted session", () => {
		const dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
		try {
			const session = SessionManager.create(dir, dir);
			expect(session.getHeader()?.internal).toBeUndefined();
			session.markSessionInternal({ runId: "r", stageId: "s", stageName: "n" });
			expect(session.getHeader()?.internal).toBe(true);
			expect(session.getHeader()?.workflow).toEqual({ runId: "r", stageId: "s", stageName: "n" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("markSessionInternal preserves an existing full marker", () => {
		const dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
		try {
			const session = SessionManager.create(dir, dir, {
				internal: true,
				workflow: { runId: "original", stageId: "s", stageName: "n" },
			});
			session.markSessionInternal({ runId: "should-not-overwrite", stageId: "x", stageName: "y" });
			expect(session.getHeader()?.workflow).toEqual({ runId: "original", stageId: "s", stageName: "n" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findMostRecentSession excludes internal by default", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips internal sessions and returns the most recent user session", () => {
		// User session older; workflow session newer.
		const userPath = writeSessionFile(dir, userHeader("user-1", cwd, 10_000));
		writeSessionFile(dir, workflowHeader("wf-1", cwd, 1_000));
		// findMostRecent uses mtime, so touch user file to be newer than workflow.
		utimesSync(userPath, Date.now() / 1000 + 100, Date.now() / 1000 + 100);
		const recent = findMostRecentSession(dir, cwd);
		expect(recent).toBe(userPath);
	});

	it("returns the internal session when includeInternal is true", () => {
		const wfPath = writeSessionFile(dir, workflowHeader("wf-2", cwd, 5_000));
		const recent = findMostRecentSession(dir, cwd, true);
		expect(recent).toBe(wfPath);
	});

	it("returns null when only internal sessions exist (default)", () => {
		writeSessionFile(dir, workflowHeader("wf-3", cwd, 5_000));
		expect(findMostRecentSession(dir, cwd)).toBeNull();
	});
});

describe("SessionManager.list excludes internal by default", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("omits internal sessions from the default listing", async () => {
		writeSessionFile(dir, userHeader("user-2", cwd), [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
		]);
		writeSessionFile(dir, workflowHeader("wf-4", cwd), [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"workflow","timestamp":1}}',
		]);
		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions.map((s) => s.id)).toEqual(["user-2"]);
	});

	it("includes internal sessions with includeInternal option and surfaces workflow linkage", async () => {
		writeSessionFile(dir, workflowHeader("wf-5", cwd), [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"workflow","timestamp":1}}',
		]);
		const sessions = await SessionManager.list(cwd, dir, undefined, { includeInternal: true });
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.internal).toBe(true);
		expect(sessions[0]?.workflow).toEqual({ runId: "run-1", stageId: "stage-x", stageName: "build" });
	});

	it("SessionManager.listAll also excludes internal by default", async () => {
		writeSessionFile(dir, userHeader("user-3", cwd), [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}',
		]);
		writeSessionFile(dir, workflowHeader("wf-6", cwd), [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"workflow","timestamp":1}}',
		]);
		const sessions = await SessionManager.listAll(dir);
		expect(sessions.map((s) => s.id)).toEqual(["user-3"]);
	});
});

describe("readSessionHeader robustness for long headers", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads headers larger than the previous 512-byte window", () => {
		const longStageName = "x".repeat(2000);
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "long-1",
			timestamp: new Date().toISOString(),
			cwd: dir,
			internal: true,
			workflow: { runId: "r", stageId: "s", stageName: longStageName },
		};
		const path = writeSessionFile(dir, header);
		const read = readSessionHeader(path);
		expect(read?.id).toBe("long-1");
		expect(read?.internal).toBe(true);
		expect(read?.workflow?.stageName).toBe(longStageName);
	});
});

describe("isInternalHeader helper", () => {
	describe.each([
		["missing workflow metadata", { internal: true }],
		["workflow-only metadata", { workflow: { runId: "r", stageId: "s", stageName: "n" } }],
		["truthy non-boolean internal", { internal: "true", workflow: { runId: "r", stageId: "s", stageName: "n" } }],
		["incomplete workflow metadata", { internal: true, workflow: { runId: "r" } }],
		["empty workflow metadata", { internal: true, workflow: { runId: "r", stageId: " ", stageName: "n" } }],
	] as const)("%s", (_label, marker) => {
		it("does not classify a malformed marker", () => {
			const header = { type: "session", id: "x", ...marker } as unknown as SessionHeader;
			expect(isInternalHeader(header)).toBe(false);
		});
	});

	it("classifies only exact true with complete workflow metadata", () => {
		expect(isInternalHeader(workflowHeader("x", "/project"))).toBe(true);
		expect(isInternalHeader(null)).toBe(false);
	});
});

describe("malformed internal session markers remain visible", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-malformed-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["internal only", { internal: true }],
		["workflow only", { workflow: { runId: "r", stageId: "s", stageName: "n" } }],
		["truthy internal", { internal: "yes", workflow: { runId: "r", stageId: "s", stageName: "n" } }],
		["missing field", { internal: true, workflow: { runId: "r", stageId: "s" } }],
	] as const)("lists %s legacy headers without normalized classification fields", async (_label, marker) => {
		writeSessionFile(dir, { ...userHeader("legacy", cwd), ...marker } as unknown as SessionHeader, [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"legacy","timestamp":1}}',
		]);

		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).not.toHaveProperty("internal");
		expect(sessions[0]).not.toHaveProperty("workflow");
	});

	it("does not infer workflow ownership from parentSession", async () => {
		writeSessionFile(dir, { ...userHeader("user-fork", cwd), parentSession: "/tmp/source.jsonl" }, [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"fork","timestamp":1}}',
		]);
		expect((await SessionManager.list(cwd, dir)).map((session) => session.id)).toEqual(["user-fork"]);
	});

	it("repairs malformed persisted markers when valid ownership is supplied", () => {
		const path = writeSessionFile(dir, { ...userHeader("repair", cwd), internal: true } as SessionHeader);
		const session = SessionManager.open(path, dir);
		session.markSessionInternal({ runId: "r", stageId: "s", stageName: "n" });
		expect(readSessionHeader(path)).toMatchObject({
			internal: true,
			workflow: { runId: "r", stageId: "s", stageName: "n" },
		});
	});

	it("classifies and persists a fresh workflow subagent session from inherited metadata", () => {
		const path = join(dir, "fresh-subagent.jsonl");
		const workflow = { runId: "run-1", stageId: "stage-1", stageName: "build" };
		const session = SessionManager.open(path, dir, cwd);
		applyInheritedWorkflowSessionClassification(session, {
			[WORKFLOW_SESSION_METADATA_ENV]: JSON.stringify(workflow),
		});
		session.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(readSessionHeader(path)).toMatchObject({ internal: true, workflow });
	});
});

describe("readSessionHeader reads multi-chunk headers with the small dedicated buffer", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a header larger than the 64KB header chunk but smaller than 1MiB", () => {
		// A header that spans more than one 64KB read chunk but is well under
		// the old 1MiB transcript buffer. This proves the small dedicated header
		// buffer correctly accumulates across chunks until the first newline.
		const longStageName = "z".repeat(80 * 1024);
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "smallbuf-multichunk-1",
			timestamp: new Date().toISOString(),
			cwd: dir,
			internal: true,
			workflow: { runId: "r", stageId: "s", stageName: longStageName },
		};
		const path = writeSessionFile(dir, header, [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:00Z","message":{"role":"user","content":"after-newline","timestamp":1}}',
		]);
		const read = readSessionHeader(path);
		expect(read?.id).toBe("smallbuf-multichunk-1");
		expect(read?.internal).toBe(true);
		expect(read?.workflow?.stageName).toBe(longStageName);
	});
});

describe("readSessionHeader decoder flush after newline", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not corrupt a >1MiB header when a newline is found mid-buffer", () => {
		// Build a header line larger than 1MiB so it spans multiple read chunks.
		const longStageName = "y".repeat(1024 * 1024);
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "big-header-1",
			timestamp: new Date().toISOString(),
			cwd: dir,
			internal: true,
			workflow: { runId: "r", stageId: "s", stageName: longStageName },
		};
		const path = writeSessionFile(dir, header, [
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"second-line","timestamp":1}}',
		]);
		const read = readSessionHeader(path);
		expect(read?.id).toBe("big-header-1");
		expect(read?.internal).toBe(true);
		expect(read?.workflow?.stageName).toBe(longStageName);
	});

	it("reads a header when there is no trailing newline (single-line file)", () => {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "no-newline-1",
			timestamp: new Date().toISOString(),
			cwd: dir,
			internal: true,
			workflow: { runId: "r", stageId: "s", stageName: "n" },
		};
		// Write header only, no newline, no body.
		const path = join(dir, "no-newline.jsonl");
		writeFileSync(path, JSON.stringify(header));
		const read = readSessionHeader(path);
		expect(read?.id).toBe("no-newline-1");
		expect(read?.internal).toBe(true);
	});
});

describe("header prefiltering skips internal sessions before transcript parse", () => {
	let dir: string;
	const cwd = "/project";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "internal-sess-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips internal sessions with malformed bodies by default without throwing", async () => {
		// Internal workflow session with a body that would break JSON parsing if
		// buildSessionInfo ran on it. The header prefilter must skip it entirely.
		const header = workflowHeader("wf-malformed", cwd);
		const path = writeSessionFile(dir, header, ["{this is not valid json}"]);
		// Sanity: header is readable.
		expect(readSessionHeader(path)?.id).toBe("wf-malformed");
		// Default listing must not throw and must exclude the malformed internal session.
		const sessions = await SessionManager.list(cwd, dir);
		expect(sessions).toHaveLength(0);
	});

	it("includes the malformed internal session via includeInternal", async () => {
		const header = workflowHeader("wf-malformed-2", cwd);
		writeSessionFile(dir, header, ["{this is not valid json}"]);
		const sessions = await SessionManager.list(cwd, dir, undefined, { includeInternal: true });
		// The unparseable body line is skipped by parseSessionEntries, so the
		// session is still surfaced with includeInternal (0 messages). The key
		// guarantee is that it does not throw.
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe("wf-malformed-2");
		expect(sessions[0]?.internal).toBe(true);
	});
});
