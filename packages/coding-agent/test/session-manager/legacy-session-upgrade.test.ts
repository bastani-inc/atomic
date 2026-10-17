import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { SessionFormatVersionError } from "../../src/core/storage/session/errors.js";
import { userMsg } from "../utilities.js";

type JsonRecord = Record<string, string | number | boolean | null | object>;

interface LegacyFixture {
	readonly version: 1 | 2 | 3;
	readonly id: string;
	readonly createdAt: string;
	readonly name?: string;
	readonly firstMessage: string;
	lines(cwd: string): JsonRecord[];
}

const fixtures: readonly LegacyFixture[] = [
	{
		version: 1,
		id: "0191f0a1-0000-7000-8000-000000000001",
		createdAt: "2025-03-01T10:00:00.000Z",
		firstMessage: "Explain the v1 parser",
		lines: (cwd) => [
			{ type: "session", id: "0191f0a1-0000-7000-8000-000000000001", timestamp: "2025-03-01T10:00:00.000Z", cwd },
			{
				type: "message",
				timestamp: "2025-03-01T10:00:01.000Z",
				message: { role: "user", content: "Explain the v1 parser", timestamp: 1740823201000 },
			},
			{
				type: "message",
				timestamp: "2025-03-01T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "It reads JSONL." }],
					provider: "anthropic",
					model: "claude",
					timestamp: 1740823202000,
				},
			},
			{
				type: "compaction",
				timestamp: "2025-03-01T10:00:03.000Z",
				summary: "Discussed the parser",
				firstKeptEntryIndex: 2,
				tokensBefore: 120,
			},
		],
	},
	{
		version: 2,
		id: "0191f0a1-0000-7000-8000-000000000002",
		createdAt: "2025-05-01T10:00:00.000Z",
		firstMessage: "Review the v2 hooks",
		lines: (cwd) => [
			{
				type: "session",
				version: 2,
				id: "0191f0a1-0000-7000-8000-000000000002",
				timestamp: "2025-05-01T10:00:00.000Z",
				cwd,
			},
			{
				type: "message",
				id: "a0000001",
				parentId: null,
				timestamp: "2025-05-01T10:00:01.000Z",
				message: { role: "user", content: "Review the v2 hooks", timestamp: 1746093601000 },
			},
			{
				type: "message",
				id: "a0000002",
				parentId: "a0000001",
				timestamp: "2025-05-01T10:00:02.000Z",
				message: {
					role: "hookMessage",
					customType: "reminder",
					content: "Hook note",
					display: true,
					timestamp: 1746093602000,
				},
			},
		],
	},
	{
		version: 3,
		id: "0191f0a1-0000-7000-8000-000000000003",
		createdAt: "2025-08-01T10:00:00.000Z",
		name: "Legacy auth refactor",
		firstMessage: "Refactor the v3 auth module",
		lines: (cwd) => [
			{
				type: "session",
				version: 3,
				id: "0191f0a1-0000-7000-8000-000000000003",
				timestamp: "2025-08-01T10:00:00.000Z",
				cwd,
				parentSession: "0191f0a1-0000-7000-8000-000000000002",
			},
			{
				type: "message",
				id: "b0000001",
				parentId: null,
				timestamp: "2025-08-01T10:00:01.000Z",
				message: { role: "user", content: "Refactor the v3 auth module", timestamp: 1754042401000 },
			},
			{
				type: "session_info",
				id: "b0000002",
				parentId: "b0000001",
				timestamp: "2025-08-01T10:00:02.000Z",
				name: "Legacy auth refactor",
			},
		],
	},
];

function readLines(path: string): JsonRecord[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as JsonRecord);
}

describe("resume of pre-format-4 sessions", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-legacy-sessions-"));
		cwd = join(root, "project");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(sessionDir);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeLegacy(fixture: LegacyFixture): string {
		const path = join(sessionDir, `${fixture.createdAt.replace(/[:.]/g, "-")}_${fixture.id}.jsonl`);
		writeFileSync(
			path,
			`${fixture
				.lines(cwd)
				.map((line) => JSON.stringify(line))
				.join("\n")}\n`,
		);
		return path;
	}

	for (const fixture of fixtures) {
		describe(`format ${fixture.version}`, () => {
			it("is listed for /resume without changing the file", async () => {
				const path = writeLegacy(fixture);
				const before = readFileSync(path);
				const mtime = statSync(path).mtimeMs;

				const sessions = await SessionManager.list(cwd, sessionDir);

				assert.equal(sessions.length, 1);
				assert.equal(sessions[0]!.id, fixture.id);
				assert.equal(sessions[0]!.name, fixture.name);
				assert.equal(sessions[0]!.firstMessage, fixture.firstMessage);
				assert.equal(sessions[0]!.created.toISOString(), fixture.createdAt);
				assert.deepEqual(readFileSync(path), before);
				assert.equal(statSync(path).mtimeMs, mtime);
			});

			it("is found by --session ID lookup and --continue", async () => {
				const path = writeLegacy(fixture);

				assert.equal(await SessionManager.findById(cwd, fixture.id, sessionDir), path);
				const continued = await SessionManager.continueRecent(cwd, sessionDir);
				assert.equal(continued.getSessionId(), fixture.id);
				assert.equal(continued.getHeader()?.createdAt, fixture.createdAt);
			});

			it("opens, upgrades the file to format 4, and accepts appended entries", async () => {
				const path = writeLegacy(fixture);

				const manager = await SessionManager.open(path, sessionDir);
				await manager.appendMessage(userMsg("follow-up after upgrade"));

				const [header, ...entries] = readLines(path);
				assert.equal(header!.version, 4);
				assert.equal(header!.id, fixture.id);
				assert.equal(header!.createdAt, fixture.createdAt);
				assert.equal(header!.timestamp, undefined);
				assert.equal(entries.length, fixture.lines(cwd).length);
				for (const [index, entry] of entries.entries()) {
					assert.equal(typeof entry.id, "string");
					assert.equal(entry.parentId, index === 0 ? null : entries[index - 1]!.id);
				}
				const reopened = await SessionManager.open(path, sessionDir);
				assert.equal(reopened.getEntries().length, entries.length);
				assert.equal(reopened.getSessionId(), fixture.id);
			});
		});
	}

	it("restores the format 1 compaction anchor and format 2 hook messages", async () => {
		const v1 = writeLegacy(fixtures[0]!);
		const v2 = writeLegacy(fixtures[1]!);

		await SessionManager.open(v1, sessionDir);
		await SessionManager.open(v2, sessionDir);

		const v1Entries = readLines(v1).slice(1);
		assert.equal(v1Entries[2]!.firstKeptEntryId, v1Entries[1]!.id);
		assert.equal(v1Entries[2]!.firstKeptEntryIndex, undefined);
		const hook = readLines(v2)[2]!.message as JsonRecord;
		assert.equal(hook.role, "custom");
		assert.equal(hook.customType, "reminder");
	});

	it("maps the format 3 parent session to parentSessionId", async () => {
		const path = writeLegacy(fixtures[2]!);

		const manager = await SessionManager.open(path, sessionDir);

		assert.equal(manager.getHeader()?.parentSessionId, "0191f0a1-0000-7000-8000-000000000002");
		assert.equal(readLines(path)[0]!.parentSessionId, "0191f0a1-0000-7000-8000-000000000002");
	});

	it("forks a format 3 session into a new format 4 session", async () => {
		const path = writeLegacy(fixtures[2]!);

		const fork = await SessionManager.forkFrom(path, cwd, sessionDir);

		assert.notEqual(fork.getSessionId(), fixtures[2]!.id);
		assert.equal(fork.getHeader()?.version, 4);
		assert.equal(fork.getHeader()?.parentSessionId, fixtures[2]!.id);
		assert.equal(fork.getEntries().length, 2);
	});

	for (const version of [5, "3", 2.5, 0, null]) {
		it(`still rejects session format ${JSON.stringify(version)}`, async () => {
			const path = join(sessionDir, "unsupported.jsonl");
			const content = `${JSON.stringify({
				type: "session",
				version,
				id: "0191f0a1-0000-7000-8000-000000000009",
				timestamp: "2025-01-01T00:00:00.000Z",
				createdAt: "2025-01-01T00:00:00.000Z",
				cwd,
			})}\n`;
			writeFileSync(path, content);

			await assert.rejects(SessionManager.open(path, sessionDir), SessionFormatVersionError);
			assert.deepEqual(await SessionManager.list(cwd, sessionDir), []);
			assert.equal(
				await SessionManager.findById(cwd, "0191f0a1-0000-7000-8000-000000000009", sessionDir),
				undefined,
			);
			assert.equal(readFileSync(path, "utf8"), content);
		});
	}
});
