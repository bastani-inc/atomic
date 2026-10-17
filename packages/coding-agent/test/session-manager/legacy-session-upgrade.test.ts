import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { SessionFormatVersionError } from "../../src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { userMsg } from "../utilities.js";

type JsonRecord = Record<string, string | number | boolean | null | object>;

interface LegacyFixture {
	readonly version: 1 | 2 | 3 | 4;
	readonly title?: string;
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
	{
		version: 4,
		title: "4 with a timestamp header",
		id: "0191f0a1-0000-7000-8000-000000000006",
		createdAt: "2026-10-15T10:00:00.000Z",
		name: "Alpha.4 session",
		firstMessage: "Resume the early format 4 session",
		lines: (cwd) => [
			{
				type: "session",
				version: 4,
				id: "0191f0a1-0000-7000-8000-000000000006",
				timestamp: "2026-10-15T10:00:00.000Z",
				cwd,
				parentSession: "0191f0a1-0000-7000-8000-000000000002",
			},
			{
				type: "message",
				id: "e0000001",
				parentId: null,
				timestamp: "2026-10-15T10:00:01.000Z",
				message: { role: "user", content: "Resume the early format 4 session", timestamp: 1791540001000 },
			},
			{
				type: "message",
				id: "e0000002",
				parentId: "e0000001",
				timestamp: "2026-10-15T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Resumed." }],
					provider: "anthropic",
					model: "claude",
					timestamp: 1791540002000,
				},
			},
			{
				type: "session_info",
				id: "e0000003",
				parentId: "e0000002",
				timestamp: "2026-10-15T10:00:03.000Z",
				name: "Alpha.4 session",
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
		describe(`format ${fixture.title ?? fixture.version}`, () => {
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

	function writeLegacyFork(parentSession: string, version: 3 | 4 = 3): { path: string; id: string } {
		const id = "0191f0a1-0000-7000-8000-000000000004";
		const path = join(sessionDir, `2025-09-01T10-00-00-000Z_${id}.jsonl`);
		const lines: JsonRecord[] = [
			{ type: "session", version, id, timestamp: "2025-09-01T10:00:00.000Z", cwd, parentSession },
			{
				type: "message",
				id: "c0000001",
				parentId: null,
				timestamp: "2025-09-01T10:00:01.000Z",
				message: { role: "user", content: "Continue the forked review", timestamp: 1756720801000 },
			},
		];
		writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return { path, id };
	}

	const parentPaths = {
		posix: (parentPath: string) => parentPath,
		windows: (parentPath: string) =>
			`C:\\Users\\dev\\.atomic\\agent\\sessions\\--C--work-project--\\${parentPath.split("/").at(-1)}`,
	} as const;

	for (const [platform, toParentSession] of Object.entries(parentPaths)) {
		it(`resolves a format 3 ${platform} parent session file path to the parent session id`, async () => {
			const parentPath = writeLegacy(fixtures[1]!);
			const fork = writeLegacyFork(toParentSession(parentPath));

			const listed = await SessionManager.list(cwd, sessionDir);
			const manager = await SessionManager.open(fork.path, sessionDir);

			assert.equal(listed.find((session) => session.id === fork.id)?.parentSessionPath, parentPath);
			assert.equal(manager.getHeader()?.parentSessionId, fixtures[1]!.id);
			assert.equal(readLines(fork.path)[0]!.parentSessionId, fixtures[1]!.id);
		});

		it(`resolves an early format 4 ${platform} parent session file path to the parent session id`, async () => {
			const parentPath = writeLegacy(fixtures[1]!);
			const fork = writeLegacyFork(toParentSession(parentPath), 4);

			const listed = await SessionManager.list(cwd, sessionDir);
			const manager = await SessionManager.open(fork.path, sessionDir);

			assert.equal(listed.find((session) => session.id === fork.id)?.parentSessionPath, parentPath);
			assert.equal(manager.getHeader()?.parentSessionId, fixtures[1]!.id);
			const [header] = readLines(fork.path);
			assert.equal(header!.version, 4);
			assert.equal(header!.parentSessionId, fixtures[1]!.id);
			assert.equal(header!.parentSession, undefined);
			assert.equal(header!.timestamp, undefined);
		});
	}

	function writeV1Compaction(firstKeptEntryIndex: number): string {
		const id = "0191f0a1-0000-7000-8000-000000000005";
		const path = join(sessionDir, `2025-02-01T10-00-00-000Z_${id}.jsonl`);
		const message = (content: string, second: number): JsonRecord => ({
			type: "message",
			timestamp: `2025-02-01T10:00:0${second}.000Z`,
			message: { role: "user", content, timestamp: 1738404000000 + second * 1000 },
		});
		const lines: JsonRecord[] = [
			{ type: "session", id, timestamp: "2025-02-01T10:00:00.000Z", cwd },
			message("summarized prefix", 1),
			message("kept tail", 2),
			{
				type: "compaction",
				timestamp: "2025-02-01T10:00:03.000Z",
				summary: "Summarized prefix",
				firstKeptEntryIndex,
				tokensBefore: 120,
			},
			message("after compaction", 4),
		];
		writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return path;
	}

	const supportedAnchors: ReadonlyArray<readonly [string, number, number | null]> = [
		["the first entry", 1, 0],
		["the last pre-compaction entry", 2, 1],
		["the session header as an empty tail", 0, null],
		["the compaction itself as an empty tail", 3, null],
	];

	for (const [anchor, index, keptEntry] of supportedAnchors) {
		it(`upgrades a format 1 compaction anchored at ${anchor}`, async () => {
			const path = writeV1Compaction(index);

			await SessionManager.open(path, sessionDir);

			const entries = readLines(path).slice(1);
			assert.equal(entries[2]!.firstKeptEntryId, keptEntry === null ? null : entries[keptEntry]!.id);
			assert.equal("firstKeptEntryIndex" in entries[2]!, false);
		});
	}

	for (const index of [1.5, -1, 4, 5, 99]) {
		it(`rejects a format 1 compaction with invalid firstKeptEntryIndex ${index}`, async () => {
			const path = writeV1Compaction(index);
			const content = readFileSync(path, "utf8");

			await assert.rejects(SessionManager.open(path, sessionDir), SessionFormatVersionError);
			assert.deepEqual(await SessionManager.list(cwd, sessionDir), []);
			assert.equal(readFileSync(path, "utf8"), content);
		});
	}

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

	describe("early format 4 through the JSONL store", () => {
		const early = fixtures[3]!;

		it("lists, reads the header of, and loads a session with a timestamp header", async () => {
			const path = writeLegacy(early);
			const content = readFileSync(path, "utf8");
			const store = await JsonlSessionStore.open(sessionDir, { exactDirectory: true });
			try {
				const summaries = [];
				for await (const summary of store.list({ cwd })) summaries.push(summary);
				const header = await store.readHeader(early.id);

				assert.deepEqual(
					summaries.map((summary) => [summary.id, summary.createdAt, summary.name, summary.parentSessionId]),
					[[early.id, early.createdAt, early.name, "0191f0a1-0000-7000-8000-000000000002"]],
				);
				assert.equal(header?.createdAt, early.createdAt);
				assert.equal(header?.version, 4);
				assert.equal(readFileSync(path, "utf8"), content);

				const snapshot = await store.load(early.id);
				assert.equal(snapshot.header.createdAt, early.createdAt);
				assert.deepEqual(
					snapshot.entries.map((entry) => entry.id),
					["e0000001", "e0000002", "e0000003"],
				);
				assert.equal(readLines(path)[0]!.createdAt, early.createdAt);
				assert.equal(readLines(path)[0]!.timestamp, undefined);
			} finally {
				await store.close();
			}
		});

		it("finds a session with a timestamp header in a project directory of the global store", async () => {
			const projectDir = join(sessionDir, "--project--");
			mkdirSync(projectDir);
			const path = join(projectDir, basename(writeLegacy(early)));
			renameSync(join(sessionDir, basename(path)), path);
			const store = await JsonlSessionStore.open(sessionDir);
			try {
				assert.equal(await store.findFile(early.id), path);
				assert.equal((await store.load(early.id)).header.createdAt, early.createdAt);
				const summaries = [];
				for await (const summary of store.list({})) summaries.push(summary.id);
				assert.deepEqual(summaries, [early.id]);
			} finally {
				await store.close();
			}
		});

		it("rejects appending to an unloaded session with a timestamp header", async () => {
			const path = writeLegacy(early);
			const content = readFileSync(path, "utf8");
			const store = await JsonlSessionStore.open(sessionDir, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(
					store.append(
						early.id,
						[{ type: "session_info", id: "new", parentId: null, timestamp: early.createdAt, name: "x" }],
						{ expectSeq: 0 },
					),
					SessionFormatVersionError,
				);
			} finally {
				await store.close();
			}
			assert.equal(readFileSync(path, "utf8"), content);
		});

		const rejectedHeaders: ReadonlyArray<readonly [string, JsonRecord]> = [
			["neither timestamp nor createdAt", { version: 4 }],
			["a numeric createdAt and no timestamp", { version: 4, createdAt: 1 }],
			["a numeric timestamp and no createdAt", { version: 4, timestamp: 1 }],
			["a future version with a timestamp", { version: 5, timestamp: "2026-10-15T10:00:00.000Z" }],
			["version 0 with a timestamp", { version: 0, timestamp: "2026-10-15T10:00:00.000Z" }],
		];

		for (const [name, fields] of rejectedHeaders) {
			it(`still rejects a header with ${name}`, async () => {
				const id = "0191f0a1-0000-7000-8000-000000000009";
				const path = join(sessionDir, `2026-10-15T10-00-00-000Z_${id}.jsonl`);
				const content = `${JSON.stringify({ type: "session", id, cwd, ...fields })}\n`;
				writeFileSync(path, content);
				const store = await JsonlSessionStore.open(sessionDir, { exactDirectory: true });
				try {
					await assert.rejects(SessionManager.open(path, sessionDir), SessionFormatVersionError);
					await assert.rejects(store.load(id), SessionFormatVersionError);
					assert.deepEqual(await SessionManager.list(cwd, sessionDir), []);
					const summaries = [];
					for await (const summary of store.list({})) summaries.push(summary.id);
					assert.deepEqual(summaries, []);
					assert.equal(readFileSync(path, "utf8"), content);
				} finally {
					await store.close();
				}
			});
		}
	});

	it("upgrades through the global store only under the project directory lock so project appends survive", async () => {
		const fixture = fixtures[2]!;
		const projectDir = join(sessionDir, "--project--");
		mkdirSync(projectDir);
		const path = join(projectDir, basename(writeLegacy(fixture)));
		renameSync(join(sessionDir, basename(path)), path);
		const content = readFileSync(path, "utf8");
		const staging = join(root, "staging");
		mkdirSync(staging);
		const stagedPath = join(staging, basename(path));
		writeFileSync(stagedPath, content);
		const projectWriter = await SessionManager.open(stagedPath, staging);
		await projectWriter.appendMessage(userMsg("appended by the project store"));
		const projectBytes = readFileSync(stagedPath, "utf8");

		const release = await lockfile.lock(projectDir, { lockfilePath: join(projectDir, ".session.lock") });
		const global = await JsonlSessionStore.open(sessionDir, { scanExisting: false });
		let settled = false;
		const loading = global.load(fixture.id).finally(() => {
			settled = true;
		});
		try {
			await delay(250);
			assert.equal(settled, false);
			assert.equal(readFileSync(path, "utf8"), content);
			writeFileSync(path, projectBytes);
		} finally {
			await release();
		}
		const snapshot = await loading;
		await global.close();

		assert.equal(readFileSync(path, "utf8"), projectBytes);
		assert.equal(snapshot.entries.length, readLines(path).length - 1);
		const reopened = await SessionManager.open(path, projectDir);
		const last = reopened.buildSessionContext().messages.at(-1);
		assert.equal(last && "content" in last ? last.content : undefined, "appended by the project store");
	});
});
