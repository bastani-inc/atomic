import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { quoteIfNeeded } from "../src/modes/interactive/chat-input-actions.ts";
import { formatResumeCommand } from "../src/modes/interactive/interactive-mode.ts";

const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let sessionStore: JsonlSessionStore;

beforeEach(async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-format-resume-store-"));
	tempDirs.push(dir);
	sessionStore = await JsonlSessionStore.open(dir, { exactDirectory: true });
});

afterEach(async () => {
	await sessionStore.close();
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-format-resume-command-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function createSessionManager(options: {
	persisted?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	usesDefaultSessionDir?: boolean;
}): SessionManager {
	return {
		isPersisted: () => options.persisted ?? options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => options.sessionId ?? "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
		getSessionDir: () => options.sessionDir ?? "/tmp/atomic-sessions",
		usesDefaultSessionDir: () => options.usesDefaultSessionDir ?? true,
		getSessionStore: (): ReturnType<SessionManager["getSessionStore"]> => sessionStore,
	} as unknown as SessionManager;
}

describe("formatResumeCommand", () => {
	it("includes the JSONL directory even when it is the default", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile, sessionId: "test-session" });

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir /tmp/atomic-sessions --session test-session`,
		);
	});

	it.each([
		["", "''"],
		[" raw session ID ", "' raw session ID '"],
		["session's ID", "'session'\\''s ID'"],
	])("preserves stored session ID %j in the shell resume command", (sessionId, argument) => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: createTempFile(), sessionId });
		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir /tmp/atomic-sessions --session ${argument}`,
		);
	});

	it("includes unquoted safe session dirs for non-default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom-atomic-sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir /tmp/custom-atomic-sessions --session test-session`,
		);
	});

	it("quotes session dirs containing spaces", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom atomic sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom atomic sessions' --session test-session`,
		);
	});

	it("quotes session dirs containing single quotes", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom atomic's sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom atomic'\\''s sessions' --session test-session`,
		);
	});

	it("returns undefined when stdout is not a TTY", () => {
		setStdoutIsTTY(false);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined for in-memory sessions", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ persisted: false, sessionFile });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined when the session file is missing", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: "/tmp/atomic-missing-session.jsonl" });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined when the session file is not set", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: undefined });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it.each([
		["same path and prefix", "same_", "same_"],
		["different prefix", "same_", "other_"],
		["default prefix", "", "other_"],
	] as const)("SQLite hints pin the store with %s", async (_label, prefix, selectedPrefix) => {
		setStdoutIsTTY(true);
		const dir = mkdtempSync(join(tmpdir(), "sqlite-resume-selection-"));
		tempDirs.push(dir);
		const path = join(dir, "sessions.sqlite");
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ sessions: { storage: { path, prefix: selectedPrefix } } }),
		);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", dir);
		const store = await resolveSessionStore(dir, { sessionStore: { kind: "sqlite", path, prefix } });
		try {
			const manager = await SessionManager.create(store, dir, { id: "selected-session" });
			const selection = ` --session-store ${quoteIfNeeded(path)}${prefix ? ` --session-prefix ${prefix}` : ""}`;
			assert.equal(formatResumeCommand(manager), `${APP_NAME}${selection} --session selected-session`);
		} finally {
			await store.close();
			vi.unstubAllEnvs();
		}
	});

	it("SQLite hints retain an explicit store despite invalid overridden settings (#3709)", async () => {
		setStdoutIsTTY(true);
		const dir = mkdtempSync(join(tmpdir(), "sqlite-resume-invalid-settings-"));
		tempDirs.push(dir);
		const path = join(dir, "sessions.sqlite");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ sessions: { storage: { memory: "invalid" } } }));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", dir);
		const store = await resolveSessionStore(dir, { sessionStorePath: path, sessionPrefix: "kept_" });
		try {
			const manager = await SessionManager.create(store, dir, { id: "selected-session" });
			assert.equal(
				formatResumeCommand(manager),
				`${APP_NAME} --session-store ${quoteIfNeeded(path)} --session-prefix kept_ --session selected-session`,
			);
		} finally {
			await store.close();
			vi.unstubAllEnvs();
		}
	});

	it("SQLite hints retain explicit flags for matching untrusted project settings (#3709)", async () => {
		setStdoutIsTTY(true);
		const dir = mkdtempSync(join(tmpdir(), "sqlite-resume-untrusted-"));
		tempDirs.push(dir);
		const cwd = join(dir, "project");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		const path = join(dir, "sessions.sqlite");
		writeFileSync(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ sessions: { storage: { path, prefix: "kept_" } } }),
		);
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", dir);
		new ProjectTrustStore(dir).set(cwd, false);
		const store = await resolveSessionStore(cwd, { sessionStorePath: path, sessionPrefix: "kept_" });
		try {
			const manager = await SessionManager.create(store, cwd, { id: "selected-session" });
			assert.equal(
				formatResumeCommand(manager),
				`${APP_NAME} --session-store ${quoteIfNeeded(path)} --session-prefix kept_ --session selected-session`,
			);
		} finally {
			await store.close();
			vi.unstubAllEnvs();
		}
	});
});
