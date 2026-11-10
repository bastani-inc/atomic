import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	getMissingSessionCwdOptions,
	MissingSessionCwdError,
} from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 4,
			id: "session-id",
			createdAt: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = await SessionManager.open(sessionFile);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-override-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = await SessionManager.open(sessionFile, undefined, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-runtime-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = await SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});
});

describe("missing session cwd prompt (earendil-works/pi#11060)", () => {
	const issue = { sessionFile: "/sessions/s.jsonl", sessionCwd: "/proj", fallbackCwd: "/proj2" };

	it("names the stored cwd and nothing else in the prompt text", () => {
		expect(formatMissingSessionCwdPrompt(issue)).toBe("Session cwd does not exist: /proj");
	});

	it("offers continue, fork and cancel in that order, naming the current cwd", () => {
		expect(getMissingSessionCwdOptions(issue)).toEqual([
			{ label: "Continue in /proj2 (asks again next time)", value: "continue" },
			{ label: "Fork into /proj2 (new session ID, original kept)", value: "fork" },
			{ label: "Cancel", value: undefined },
		]);
	});

	it("keeps the non-interactive error text unchanged", () => {
		expect(new MissingSessionCwdError(issue).message).toBe(
			"Stored session working directory does not exist: /proj\nSession file: /sessions/s.jsonl\nCurrent working directory: /proj2",
		);
	});
});
