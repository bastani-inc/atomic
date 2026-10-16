import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
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
	it("returns a session resume command for default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile, sessionId: "test-session" });

		expect(formatResumeCommand(sessionManager)).toBe(`${APP_NAME} --session test-session`);
	});

	it.each([
		["", "''"],
		[" raw session ID ", "' raw session ID '"],
		["session's ID", "'session'\\''s ID'"],
	])("preserves stored session ID %j in the shell resume command", (sessionId, argument) => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: createTempFile(), sessionId });
		expect(formatResumeCommand(sessionManager)).toBe(`${APP_NAME} --session ${argument}`);
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
});
