import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	sessionTailOf as rawSessionTailOf,
	sessionCompactionOf,
} from "../../packages/coding-agent/src/core/storage/session/session-resume.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory } from "../helpers/runtime.js";

function sessionTailOf(...args: Parameters<typeof rawSessionTailOf>) {
	const { epoch: _epoch, seqs: _seqs, lastEntryId: _last, ...tail } = rawSessionTailOf(...args);
	return tail;
}
function tailContent<T extends { epoch?: string; seqs?: readonly number[]; lastEntryId?: string | null }>(tail: T) {
	const { epoch: _epoch, seqs: _seqs, lastEntryId: _last, ...content } = tail;
	return content;
}
const createdAt = "2026-11-16T00:00:00.000Z";
const header = { id: "session", version: 4 as const, createdAt, cwd: "/project" };

function entry(index: number, extra: Partial<SessionEntry> = {}): SessionEntry {
	return {
		type: "message",
		id: `e${index}`,
		parentId: index === 1 ? null : `e${index - 1}`,
		timestamp: new Date(Date.parse(createdAt) + index).toISOString(),
		message: { role: "user", content: `entry ${index}`, timestamp: index },
		...extra,
	} as SessionEntry;
}

function compactedEntries(history: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let index = 1; index <= history; index++) {
		entries.push(
			index === 3
				? ({
						type: "custom",
						customType: "workspace_binding",
						data: { kind: "bound-workspace", worktree: "/p" },
						id: `e${index}`,
						parentId: `e${index - 1}`,
						timestamp: new Date(Date.parse(createdAt) + index).toISOString(),
					} as SessionEntry)
				: entry(index),
		);
	}
	const boundary = history + 1;
	entries.push({
		type: "compaction",
		id: `e${boundary}`,
		parentId: `e${history}`,
		timestamp: new Date(Date.parse(createdAt) + boundary).toISOString(),
		summary: "compacted",
		firstKeptEntryId: `e${history - 1}`,
		tokensBefore: 10,
		details: { strategy: "verbatim-lines" },
	} as SessionEntry);
	entries.push(entry(boundary + 1, { parentId: `e${boundary}` }));
	return entries;
}

function countingRows(database: SqliteDatabase): { database: SqliteDatabase; rows: () => number } {
	let rows = 0;
	const counted = <T extends SqliteRow>(result: T[]): T[] => {
		rows += result.filter((row) => "entry_json" in row).length;
		return result;
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const row = await executor.get<T>(sql, ...params);
			if (row !== undefined) counted([row]);
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			counted(await executor.all<T>(sql, ...params)),
	});
	const wrapped: SqliteDatabase = {
		readOnly: database.readOnly,
		...wrap(database),
		get descriptor() {
			return database.descriptor;
		},
		transaction: (callback, options) => database.transaction((tx) => callback(wrap(tx)), options),
		close: () => database.close(),
	};
	return { database: wrapped, rows: () => rows };
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
});

function databasePath(): string {
	const directory = makeTempDirectory("atomic-sql-tail-");
	directories.push(directory);
	return join(directory, "sessions.sqlite");
}

async function writeSession(path: string, entries: readonly SessionEntry[]): Promise<void> {
	const database = await openNodeSqliteDatabase(path);
	const store = await SqlSessionStore.open(database);
	try {
		await store.create(header, entries);
	} finally {
		await store.close();
		await database.close();
	}
}

async function onDatabase<T>(path: string, body: (database: SqliteDatabase) => Promise<T>): Promise<T> {
	const database = await openNodeSqliteDatabase(path);
	try {
		return await body(database);
	} finally {
		await database.close();
	}
}

async function dropResumeIndex(database: SqliteDatabase): Promise<void> {
	const row = await database.get<SqliteRow & { summary_state: string }>(
		"SELECT summary_state FROM session_sessions WHERE id = ?",
		"session",
	);
	const { resume: _resume, ...state } = JSON.parse(row!.summary_state) as Record<string, unknown>;
	await database.run("UPDATE session_sessions SET summary_state = ? WHERE id = ?", JSON.stringify(state), "session");
}

async function hasResumeIndex(database: SqliteDatabase): Promise<boolean> {
	const row = await database.get<SqliteRow & { summary_state: string }>(
		"SELECT summary_state FROM session_sessions WHERE id = ?",
		"session",
	);
	return "resume" in (JSON.parse(row!.summary_state) as Record<string, unknown>);
}

describe("SqlSessionStore tail reads (#5249)", () => {
	it("reads a compacted session's tail without the history rows before it (#5249)", async () => {
		for (const history of [40, 400]) {
			const path = databasePath();
			await writeSession(path, compactedEntries(history));
			const { database, rows } = countingRows(await openNodeSqliteDatabase(path));
			const store = await SqlSessionStore.open(database);
			try {
				const point = await store.findLatestCompaction("session");
				assert.equal(point?.retainedStartSeq, history - 1);
				const tail = await store.readTail("session", point!.retainedStartSeq);
				assert.deepEqual(
					tail.state.map(({ seq }) => seq),
					[3],
				);
				assert.equal(tail.entries.length, 4);
				assert.equal(rows(), 1 + 1 + 4, `history ${history}`);
			} finally {
				await store.close();
				await database.close();
			}
		}
	});

	it("indexes a session an earlier build wrote on its first resume, then reads only its tail (#5249)", async () => {
		const path = databasePath();
		const entries = compactedEntries(40);
		await writeSession(path, entries);
		await onDatabase(path, dropResumeIndex);
		assert.equal(await onDatabase(path, hasResumeIndex), false);

		const writable = await openNodeSqliteDatabase(path);
		const store = await SqlSessionStore.open(writable);
		try {
			assert.deepEqual(await store.findLatestCompaction("session"), sessionCompactionOf(entries));
			assert.deepEqual(tailContent(await store.readTail("session", 39)), sessionTailOf(header, entries, 39));
		} finally {
			await store.close();
			await writable.close();
		}
		assert.equal(await onDatabase(path, hasResumeIndex), true);

		const { database, rows } = countingRows(await openNodeSqliteDatabase(path));
		const indexed = await SqlSessionStore.open(database);
		try {
			assert.deepEqual(tailContent(await indexed.readTail("session", 39)), sessionTailOf(header, entries, 39));
			assert.equal(rows(), 1 + 4);
		} finally {
			await indexed.close();
			await database.close();
		}
	});

	it("remembers the index of a session it cannot save it for, while the session is unchanged (#5249)", async () => {
		const path = databasePath();
		const entries = compactedEntries(40);
		await writeSession(path, entries);
		await onDatabase(path, dropResumeIndex);

		const { database, rows } = countingRows(await openNodeSqliteDatabase(path, { readOnly: true }));
		const store = await SqlSessionStore.open(database);
		try {
			assert.deepEqual(await store.findLatestCompaction("session"), sessionCompactionOf(entries));
			const whole = rows();
			assert.ok(whole < entries.length);
			assert.deepEqual(tailContent(await store.readTail("session", 39)), sessionTailOf(header, entries, 39));
			assert.equal(rows() - whole, 1 + 4);
		} finally {
			await store.close();
			await database.close();
		}
		assert.equal(await onDatabase(path, hasResumeIndex), false);
	});

	it("projects legacy chunked transcript metadata without returning its omitted payload (#5249)", async () => {
		const path = databasePath();
		const entries = compactedEntries(40);
		const first = entries[0]!;
		assert.equal(first.type, "message");
		if (first.type === "message" && first.message.role === "user")
			first.message.content = "🙂long omitted body".repeat(100_000);
		await writeSession(path, entries);
		await onDatabase(path, dropResumeIndex);
		const { database, rows } = countingRows(await openNodeSqliteDatabase(path));
		const store = await SqlSessionStore.open(database);
		try {
			const resumed = await store.readResume("session");
			assert.equal(resumed.branch.length, 4);
			assert.ok(rows() < entries.length);
			assert.equal(
				resumed.state.some((held) => held.entry.id === "e1"),
				false,
			);
			assert.equal(resumed.omitted.userMessages, 37);
		} finally {
			await store.close();
			await database.close();
		}
	});

	it("yields between chunk pages and does not publish an index for an intervening replacement (#5590)", async () => {
		const path = databasePath();
		const entries = compactedEntries(5);
		const old = entries[0]!;
		assert.ok(old.type === "message" && old.message.role === "user");
		old.message.content = "x".repeat(3 * 1024 * 1024);
		await writeSession(path, entries);
		await onDatabase(path, dropResumeIndex);
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			const get = db.get.bind(db);
			let replacement: Promise<void> | undefined;
			db.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const row = await get<T>(sql, ...args);
				if (row?.data instanceof Uint8Array && !replacement)
					replacement = new Promise((resolve) => setImmediate(resolve)).then(async () => {
						await store.replace(header.id, header, [entry(1, { id: "replacement" })], {
							expectSeq: entries.length,
						});
					});
				return row;
			};
			try {
				assert.equal((await store.readResume(header.id)).lastEntryId, "replacement");
			} finally {
				await replacement;
				await store.close();
			}
		});
	});

	it("reopens an interrupted old-index rebuild at its last completed page (#5590)", async () => {
		const path = databasePath();
		const entries = compactedEntries(520);
		const interrupted = entries[512]!;
		assert.ok(interrupted.type === "message" && interrupted.message.role === "user");
		interrupted.message.content = "x".repeat(3 * 1024 * 1024);
		await writeSession(path, entries);
		await onDatabase(path, dropResumeIndex);
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			const get = db.get.bind(db);
			let chunks = 0;
			db.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const row = await get<T>(sql, ...args);
				if (row?.data instanceof Uint8Array && ++chunks === 2) throw new Error("interrupted chunk read");
				return row;
			};
			await assert.rejects(() => store.readResume(header.id), /interrupted chunk read/);
			assert.equal(await hasResumeIndex(db), false);
			await store.close();
		});
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			const all = db.all.bind(db);
			let reread = false;
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				reread ||= rows.some((row) => row.entry_id === "e1");
				return rows;
			};
			assert.equal((await store.readResume(header.id)).lastSeq, entries.length);
			assert.equal(reread, false, "already folded the first page before interruption");
			assert.equal(await hasResumeIndex(db), true);
			await store.close();
		});
	});

	it("rebuilds the index after an earlier build appends without it (#5249)", async () => {
		const path = databasePath();
		const entries = compactedEntries(40);
		const database = await openNodeSqliteDatabase(path);
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(header, entries.slice(0, 30));
			await dropResumeIndex(database);
			await store.append("session", entries.slice(30), { expectSeq: 30 });
			assert.equal(await hasResumeIndex(database), false);
			assert.deepEqual(tailContent(await store.readTail("session", 39)), sessionTailOf(header, entries, 39));
			assert.equal(await hasResumeIndex(database), true);
			const later = entry(entries.length + 1, { parentId: entries.at(-1)!.id });
			await store.append("session", [later], { expectSeq: entries.length });
			assert.deepEqual(
				tailContent(await store.readTail("session", 39)),
				sessionTailOf(header, [...entries, later], 39),
			);
		} finally {
			await store.close();
			await database.close();
		}
	});
});
