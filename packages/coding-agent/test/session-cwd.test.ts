import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	findMissingSessionCwdIssue,
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	getMissingSessionCwdOptions,
	isMissingSessionCwdError,
	isSerializedMissingSessionCwdError,
	MissingSessionCwdError,
	rehydrateMissingSessionCwdError,
	serializeMissingSessionCwdError,
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

describe("MissingSessionCwdError contract (earendil-works/pi#11060)", () => {
	const issue = { sessionFile: "/sessions/s.jsonl", sessionCwd: "/proj", fallbackCwd: "/proj2" };
	const storedIssue = { sessionCwd: "/proj", fallbackCwd: "/proj2" };

	it("carries a stable code, a hint, no retry and its facts as JSON-safe fields", () => {
		const error = new MissingSessionCwdError(issue);

		expect(error).toMatchObject({ name: "MissingSessionCwdError", code: "session-cwd-missing", retryable: false });
		expect(error.hint.length).toBeGreaterThan(0);
		expect(error.issue).toBe(issue);
		expect(error.fields()).toEqual(issue);
		expect(new MissingSessionCwdError(storedIssue).fields()).toEqual(storedIssue);
		expect(Object.keys(new MissingSessionCwdError(storedIssue).fields())).not.toContain("sessionFile");
		expect(JSON.parse(JSON.stringify(error.fields()))).toEqual(issue);
	});

	it("keeps a cause it is given", () => {
		const cause = new Error("stat failed");

		expect(new MissingSessionCwdError(issue, { cause }).cause).toBe(cause);
	});

	it("is recognized by its class and by its shape after crossing a boundary", () => {
		const error = new MissingSessionCwdError(issue);
		const plain = { name: "MissingSessionCwdError", code: "session-cwd-missing", issue };

		expect(isMissingSessionCwdError(error)).toBe(true);
		expect(isMissingSessionCwdError(plain)).toBe(true);
		expect(isMissingSessionCwdError({ ...plain, issue: storedIssue })).toBe(true);
		for (const other of [
			undefined,
			null,
			"session-cwd-missing",
			new Error("x"),
			{ ...plain, name: "Other" },
			{ ...plain, code: "other" },
			{ ...plain, issue: undefined },
			{ ...plain, issue: { sessionCwd: "/proj" } },
			{ ...plain, issue: { fallbackCwd: "/proj2" } },
			{ ...plain, issue: { sessionCwd: 1, fallbackCwd: "/proj2" } },
			{ ...plain, issue: { sessionCwd: "/proj", fallbackCwd: 2 } },
			{ ...plain, issue: { ...issue, sessionFile: 1 } },
			[plain],
		]) {
			expect(isMissingSessionCwdError(other)).toBe(false);
		}
	});

	it("round-trips through JSON with its class, code, hint, message and fields intact", () => {
		for (const source of [issue, storedIssue]) {
			const error = new MissingSessionCwdError(source);

			const serialized = JSON.parse(JSON.stringify(serializeMissingSessionCwdError(error)));
			expect(isSerializedMissingSessionCwdError(serialized)).toBe(true);
			const rehydrated = rehydrateMissingSessionCwdError(serialized);

			expect(rehydrated).toBeInstanceOf(MissingSessionCwdError);
			expect(rehydrated.code).toBe("session-cwd-missing");
			expect(rehydrated.hint).toBe(error.hint);
			expect(rehydrated.message).toBe(error.message);
			expect(rehydrated.issue).toStrictEqual(source);
			expect(rehydrated.fields()).toEqual(error.fields());
			expect(rehydrated.cause).toBeUndefined();
		}
	});

	it("carries a cause across as its name and message", () => {
		const cause = new TypeError("stat failed");
		const serialized = serializeMissingSessionCwdError(new MissingSessionCwdError(issue, { cause }));
		expect(serialized.cause).toEqual({ name: "TypeError", message: "stat failed" });
		expect(isSerializedMissingSessionCwdError(JSON.parse(JSON.stringify(serialized)))).toBe(true);

		const rehydrated = rehydrateMissingSessionCwdError(JSON.parse(JSON.stringify(serialized)));

		expect(rehydrated.cause).toBeInstanceOf(Error);
		expect(rehydrated.cause).toMatchObject({ name: "TypeError", message: "stat failed" });
		const viaText = serializeMissingSessionCwdError(new MissingSessionCwdError(issue, { cause: "disk gone" }));
		expect(viaText.cause).toEqual({ name: "Error", message: "disk gone" });
	});

	it("refuses to rehydrate a malformed envelope", () => {
		const valid = JSON.parse(JSON.stringify(serializeMissingSessionCwdError(new MissingSessionCwdError(issue))));
		expect(isSerializedMissingSessionCwdError(valid)).toBe(true);
		for (const malformed of [
			undefined,
			null,
			"MissingSessionCwdError",
			[],
			{ ...valid, name: "Other" },
			{ ...valid, code: "other" },
			{ ...valid, message: 1 },
			{ ...valid, hint: undefined },
			{ ...valid, retryable: true },
			{ ...valid, fields: undefined },
			{ ...valid, fields: { sessionCwd: "/proj" } },
			{ ...valid, fields: { fallbackCwd: "/proj2" } },
			{ ...valid, fields: { ...valid.fields, sessionFile: 1 } },
			{ ...valid, cause: "text" },
			{ ...valid, cause: { name: "Error" } },
			{ ...valid, cause: { message: "m" } },
		]) {
			expect(isSerializedMissingSessionCwdError(malformed)).toBe(false);
		}
	});
});

describe("findMissingSessionCwdIssue (earendil-works/pi#11060)", () => {
	const missing = join(tmpdir(), "atomic-session-cwd-never-created");

	function manager(overrides: Partial<Parameters<typeof findMissingSessionCwdIssue>[0]>) {
		return {
			getCwd: () => missing,
			getSessionFile: () => undefined as string | undefined,
			isPersisted: () => true,
			getEntries: () => [{}] as readonly object[],
			...overrides,
		};
	}

	it("reports a session file's missing cwd with the file", () => {
		expect(findMissingSessionCwdIssue(manager({ getSessionFile: () => "/s.jsonl" }), "/here")).toEqual({
			sessionFile: "/s.jsonl",
			sessionCwd: missing,
			fallbackCwd: "/here",
		});
	});

	it("reports a missing cwd of a session kept in database storage, which has no file", () => {
		expect(findMissingSessionCwdIssue(manager({}), "/here")).toEqual({ sessionCwd: missing, fallbackCwd: "/here" });
	});

	it("reports nothing for a cwd that exists, an in-memory session or a session without entries", () => {
		expect(findMissingSessionCwdIssue(manager({ getCwd: () => tmpdir() }), "/here")).toBeUndefined();
		expect(findMissingSessionCwdIssue(manager({ isPersisted: () => false }), "/here")).toBeUndefined();
		expect(findMissingSessionCwdIssue(manager({ getEntries: () => [] }), "/here")).toBeUndefined();
	});
});
