import assert from "node:assert/strict";
import { constants as bufferConstants } from "buffer";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { SessionFormatVersionError, StorageUnavailableError } from "../../src/core/storage/session/errors.js";
import { assistantMsg, readSessionFileRoles, userMsg } from "../utilities.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a file without a valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(() => loadEntriesFromFile(file)).toThrow(SessionFormatVersionError);
	});

	it("rejects malformed JSON with a typed storage error", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow(StorageUnavailableError);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("rejects malformed lines rather than silently losing history", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(() => loadEntriesFromFile(file)).toThrow(StorageUnavailableError);
	});

	it("reads an unterminated valid record without modifying the file", () => {
		const file = join(tempDir, "unterminated.jsonl");
		const content =
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		assert.equal(readFileSync(file, "utf8"), content);
	});

	it("preserves record boundaries when appending after a read-only unterminated reopen", async () => {
		const file = join(tempDir, "append-after-reopen.jsonl");
		const content =
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"first","timestamp":1}}';
		writeFileSync(file, content);
		const session = await SessionManager.open(file, tempDir);
		assert.equal(readFileSync(file, "utf8"), content);
		assert.equal(session.getEntries().length, 1);
		await session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		assert.equal(session.getEntries().length, 2);
		assert.equal((await SessionManager.open(file, tempDir)).getEntries().length, 2);
		assert.ok(readFileSync(file, "utf8").startsWith(`${content}\n`));
	});

	it("leaves an unterminated malformed final fragment unchanged", () => {
		const file = join(tempDir, "malformed-tail.jsonl");
		const content =
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message"';
		writeFileSync(file, content);

		expect(() => loadEntriesFromFile(file)).toThrow(StorageUnavailableError);
		assert.equal(readFileSync(file, "utf8"), content);
	});

	it("does not modify an unterminated non-session file", () => {
		const file = join(tempDir, "invalid.jsonl");
		const content = '{"type":"message","id":"1"}';
		writeFileSync(file, content);

		expect(() => loadEntriesFromFile(file)).toThrow(SessionFormatVersionError);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("opens session files larger than Node's max string length", async () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "a");
		try {
			const padding = Buffer.from(`${" ".repeat(1024 * 1024 - 1)}\n`);
			for (let written = 0; written <= bufferConstants.MAX_STRING_LENGTH; written += padding.length) {
				writeSync(fd, padding);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = await SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("SessionManager durable prelude persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-prelude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists each admitted pre-start message once before the first task across restart", async () => {
		const session = await SessionManager.create(tempDir, tempDir, {
			internal: true,
			workflow: { runId: "run-2724", stageId: "reviewer-id", stageName: "reviewer" },
		});
		await session.appendModelChange("test-provider", "test-model");
		await session.appendThinkingLevelChange("high");
		const admissionKeys = ["intercom:pending-first", "intercom:pending-second"];
		for (const stageAdmissionKey of admissionKeys) {
			await session.appendCustomMessageEntry(
				"intercom_message",
				stageAdmissionKey,
				true,
				{ message: { id: stageAdmissionKey.slice("intercom:".length) } },
				undefined,
				undefined,
				stageAdmissionKey,
			);
		}
		await session.appendMessage({ role: "user", content: "review task", timestamp: 1 });
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "review complete" }],
			api: "anthropic-messages",
			provider: "test-provider",
			model: "test-model",
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

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		const readPhysicalEntries = () =>
			readFileSync(sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const physicalEntries = readPhysicalEntries();
		const firstTaskIndex = physicalEntries.findIndex(
			(entry) => entry.type === "message" && entry.message?.role === "user",
		);
		expect({
			sessionHeaders: physicalEntries.filter((entry) => entry.type === "session").length,
			modelChanges: physicalEntries.filter((entry) => entry.type === "model_change").length,
			thinkingChanges: physicalEntries.filter((entry) => entry.type === "thinking_level_change").length,
			admissions: admissionKeys.map(
				(key) => physicalEntries.filter((entry) => entry.stageAdmissionKey === key).length,
			),
			admissionsBeforeTask: admissionKeys.map(
				(key) =>
					physicalEntries.filter((entry, index) => index < firstTaskIndex && entry.stageAdmissionKey === key)
						.length,
			),
		}).toEqual({
			sessionHeaders: 1,
			modelChanges: 1,
			thinkingChanges: 1,
			admissions: [1, 1],
			admissionsBeforeTask: [1, 1],
		});

		const restored = await SessionManager.open(sessionFile!, tempDir, tempDir);
		await restored.appendMessage({ role: "user", content: "retry task", timestamp: 3 });
		await restored.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "retry complete" }],
			api: "anthropic-messages",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 4,
		});
		expect(
			admissionKeys.map((key) => readPhysicalEntries().filter((entry) => entry.stageAdmissionKey === key).length),
		).toEqual([1, 1]);
	});
});
describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(
			file1,
			'{"type":"session","version":4,"id":"old","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			file2,
			'{"type":"session","version":4,"id":"new","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			valid,
			'{"type":"session","version":4,"id":"abc","createdAt":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", version: 4, id: "a", createdAt: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", version: 4, id: "b", createdAt: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	it("reports custom session directories as non-default", async () => {
		const tempDir = join(tmpdir(), `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const projectDir = join(tempDir, "project");
		try {
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(tempDir, { recursive: true });
			const session = await SessionManager.create(projectDir, tempDir);
			expect(session.usesDefaultSessionDir()).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createPersistedSession(cwd: string, label: string): Promise<string> {
		const session = await SessionManager.create(cwd, tempDir);
		await session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
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
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = await createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = await createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = await SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects an empty file without rewriting it", async () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");
		await expect(SessionManager.open(emptyFile, tempDir)).rejects.toMatchObject({
			constructor: StorageUnavailableError,
			cause: expect.any(SyntaxError),
		});
		expect(readFileSync(emptyFile, "utf8")).toBe("");
	});

	it("rejects non-empty file without a valid session header instead of overwriting it", async () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);

		await expect(SessionManager.open(noHeaderFile, tempDir)).rejects.toThrow(SessionFormatVersionError);

		// The corrupted file must be left untouched.
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("failed file selection preserves the active session path and entries", async () => {
		const explicitPath = join(tempDir, "empty-selection.jsonl");
		writeFileSync(explicitPath, "");
		const sm = await SessionManager.create(tempDir, tempDir);
		await sm.appendMessage(userMsg("retained"));
		const beforePath = sm.getSessionFile();
		const beforeEntries = sm.getEntries();
		await expect(sm.setSessionFile(explicitPath)).rejects.toThrow(StorageUnavailableError);
		expect(sm.getSessionFile()).toBe(beforePath);
		expect(sm.getEntries()).toEqual(beforeEntries);
	});

	it("repeated invalid opens preserve the original empty file", async () => {
		const path = join(tempDir, "empty.jsonl");
		writeFileSync(path, "");
		await expect(SessionManager.open(path, tempDir)).rejects.toThrow(StorageUnavailableError);
		await expect(SessionManager.open(path, tempDir)).rejects.toThrow(StorageUnavailableError);
		expect(readFileSync(path, "utf8")).toBe("");
	});
});

describe("SessionManager session file creation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-session-persist-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("commits the header and setup entries before the first message", async () => {
		const session = await SessionManager.create(tempDir, tempDir);
		await session.appendModelChange("anthropic", "claude-sonnet-4-5");
		await session.appendThinkingLevelChange("off");

		assert.equal(existsSync(session.getSessionFile()!), true);
		assert.deepEqual(readSessionFileRoles(session.getSessionFile()!), [
			"session",
			"model_change",
			"thinking_level_change",
		]);
	});

	it("creates the file when the first user message is appended (#10000)", async () => {
		const session = await SessionManager.create(tempDir, tempDir);
		await session.appendModelChange("anthropic", "claude-sonnet-4-5");
		await session.appendMessage(userMsg("first question"));

		const file = session.getSessionFile()!;
		assert.deepEqual(readSessionFileRoles(file), ["session", "model_change", "user"]);
		assert.equal((await SessionManager.open(file, tempDir)).buildSessionContext().messages.length, 1);
	});

	it("appends later entries to the file without rewriting earlier ones", async () => {
		const session = await SessionManager.create(tempDir, tempDir);
		await session.appendMessage(userMsg("first question"));
		await session.appendCustomEntry("preset-state", { name: "plan" });
		await session.appendMessage(assistantMsg("first answer"));

		assert.deepEqual(readSessionFileRoles(session.getSessionFile()!), ["session", "user", "custom", "assistant"]);
	});
});
