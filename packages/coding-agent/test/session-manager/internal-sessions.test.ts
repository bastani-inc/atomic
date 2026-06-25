import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type SessionHeader,
	SessionManager,
	findMostRecentSession,
} from "../../src/core/session-manager.ts";
import {
	isInternalHeader,
	readSessionHeader,
} from "../../src/core/session-manager-storage.ts";

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
	it("returns true only when internal flag is set", () => {
		expect(isInternalHeader({ type: "session", id: "x", internal: true } as SessionHeader)).toBe(true);
		expect(isInternalHeader({ type: "session", id: "x" } as SessionHeader)).toBe(false);
		expect(isInternalHeader(null)).toBe(false);
	});
});
