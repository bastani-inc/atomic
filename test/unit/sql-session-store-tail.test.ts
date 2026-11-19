import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
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
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_RESUME_REBUILD,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { seedLegacyResumeSession } from "../helpers/legacy-resume-session.js";
import { refuseChunkProjection } from "../helpers/resume-projection-limit.js";
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
const pageEntries = SESSION_RESUME_REBUILD.pageEntries;

/** Let a complete checkpoint interval elapse while reading each of the given pages. */
function advanceRebuildClockAt(db: SqliteDatabase, ...pageEnds: number[]): void {
	let now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const all = db.all.bind(db);
	db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
		const rows = await all<T>(sql, ...args);
		const last = rows.at(-1);
		if (last && "resume_type" in last && pageEnds.includes(Number(last.seq)))
			now += SESSION_RESUME_REBUILD.checkpointIntervalMs;
		return rows;
	};
}

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

function compactedEntries(history: number, after = 0): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let index = after + 1; index <= history; index++) {
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
	vi.restoreAllMocks();
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
			refuseChunkProjection(db, old.id);
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

	it("reopens an interrupted old-index rebuild at its last saved checkpoint (#5590)", async () => {
		const path = databasePath();
		const savedThrough = 2 * pageEntries;
		const interruptedAt = savedThrough + pageEntries;
		const suffix = compactedEntries(interruptedAt + 1, interruptedAt);
		const interrupted = suffix[0]!;
		assert.ok(interrupted.type === "message" && interrupted.message.role === "user");
		interrupted.message.content = "x".repeat(3 * 1024 * 1024);
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			await seedLegacyResumeSession(db, store, header, interruptedAt);
			await store.append(header.id, suffix, { expectSeq: interruptedAt });
			await store.close();
		});
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			refuseChunkProjection(db, interrupted.id);
			const summary = () => db.get("SELECT summary_state FROM session_sessions WHERE id = ?", header.id);
			const before = await summary();
			advanceRebuildClockAt(db, pageEntries, savedThrough);
			const get = db.get.bind(db);
			let chunks = 0;
			db.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const row = await get<T>(sql, ...args);
				if (row?.data instanceof Uint8Array && ++chunks === 2) throw new Error("interrupted chunk read");
				return row;
			};
			await assert.rejects(() => store.readResume(header.id), /interrupted chunk read/);
			// An older reader publishes by spreading this entire object into its final summary.
			assert.deepEqual(await summary(), before, "an interrupted rebuild must not enlarge the shared summary");
			assert.equal(await hasResumeIndex(db), false);
			await store.close();
		});
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			const all = db.all.bind(db);
			let firstProjected: SqliteValue | undefined;
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				firstProjected ??= rows.find((row) => "resume_type" in row)?.entry_id;
				return rows;
			};
			assert.equal((await store.readResume(header.id)).lastSeq, interruptedAt + suffix.length);
			assert.equal(firstProjected, `e${savedThrough + 1}`, "reread only the unsaved suffix");
			assert.equal(await hasResumeIndex(db), true);
			await store.close();
		});
	});

	it.each(["text and tool calls", "retired errors"] as const)(
		"rebuilds %s within the cost of projecting their joined rows (#5590)",
		async (shape) => {
			const path = databasePath();
			const errors = shape === "retired errors";
			const chunkedEntries = errors ? 8 : 12;
			const targetBytes = (errors ? 8 : 3) * SESSION_ENTRY_CHUNK_BYTES;
			const fragment = errors ? "a" : 'line "a"\\b\n';
			const text = fragment.repeat(Math.floor(targetBytes / (JSON.stringify(fragment).length - 2)));
			const entries = Array.from({ length: chunkedEntries }, (_, i) =>
				entry(i + 1, {
					message: {
						role: "assistant",
						timestamp: i,
						provider: "p",
						model: "m",
						api: "openai-completions",
						stopReason: errors ? "error" : "stop",
						...(errors ? { errorMessage: text } : {}),
						content: errors
							? []
							: [
									{ type: "text", text },
									{ type: "toolCall", id: "t", name: "edit", arguments: {} },
								],
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				}),
			);
			if (errors) {
				const kept = entry(chunkedEntries + 1, { message: { role: "user", timestamp: 1, content: [] } });
				entries.push(kept, {
					type: "compaction",
					id: "boundary",
					parentId: kept.id,
					timestamp: createdAt,
					summary: "done",
					firstKeptEntryId: kept.id,
					tokensBefore: chunkedEntries,
				});
			}
			await writeSession(path, entries);
			const measure = (mode: string) =>
				JSON.parse(
					execFileSync(
						process.execPath,
						[
							"--expose-gc",
							"--import",
							"jiti/register",
							"test/fixtures/session-resume-rebuild-cost.ts",
							path,
							mode,
						],
						{ encoding: "utf8" },
					),
				) as { micros: number; peakBytes: number; toolCalls: number };
			// CPU time excludes time waiting for other test workers. Bracket the run with two independent controls
			// to measure allocator and timer noise on this machine rather than setting a machine-specific RSS/time limit.
			const first = measure("joined");
			const actual = measure("stored");
			const second = measure("joined");
			assert.equal(first.toolCalls, errors ? 0 : chunkedEntries);
			assert.equal(actual.toolCalls, first.toolCalls);
			const cpuJitterFraction = 0.2;
			const allocatorSlackBytes = 2 * SESSION_ENTRY_CHUNK_BYTES;
			const cpuBudget = Math.max(first.micros, second.micros) * (1 + cpuJitterFraction);
			const peakBudget = Math.max(first.peakBytes, second.peakBytes) + allocatorSlackBytes;
			assert.ok(
				actual.micros <= cpuBudget && actual.peakBytes <= peakBudget,
				JSON.stringify({ actual, first, second }),
			);
		},
		120_000,
	);

	it("a slower reader cannot replace a peer's published index with its checkpoint (#5590)", async () => {
		const path = databasePath();
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			await seedLegacyResumeSession(db, store, header, pageEntries + 1);
			advanceRebuildClockAt(db, pageEntries);
			const all = db.all.bind(db);
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				if (rows.some((row) => row.entry_id === `e${pageEntries}`)) {
					await onDatabase(path, async (other) => {
						const peer = await SqlSessionStore.open(other);
						try {
							await peer.findLatestCompaction(header.id);
						} finally {
							await peer.close();
						}
					});
				}
				if (rows.some((row) => row.entry_id === `e${pageEntries + 1}`))
					throw new Error("reader stopped after checkpoint");
				return rows;
			};
			try {
				await assert.rejects(() => store.findLatestCompaction(header.id), /reader stopped after checkpoint/);
				assert.ok(await hasResumeIndex(db), "the completed index must still be published");
			} finally {
				await store.close();
			}
		});
	});

	it("preserves overflowing usage totals across an interrupted page fold (#5590)", async () => {
		const path = databasePath();
		const prefix = pageEntries - 2;
		const next = pageEntries + 1;
		const suffix = compactedEntries(next, prefix);
		for (const seq of [next - 2, next - 1, next]) {
			const input = seq === next ? 1 : Number.MAX_VALUE;
			suffix[seq - prefix - 1] = entry(seq, {
				type: "usage",
				kind: "auxiliary",
				provider: "p",
				model: "m",
				usage: {
					input,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input,
					cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			});
		}
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			await seedLegacyResumeSession(db, store, header, prefix);
			await store.append(header.id, suffix, { expectSeq: prefix });
			advanceRebuildClockAt(db, pageEntries);
			const all = db.all.bind(db);
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				if (rows.some((row) => row.entry_id === `e${next}`)) throw new Error("lost page reader");
				return rows;
			};
			await assert.rejects(() => store.readResume(header.id), /lost page reader/);
			await store.close();
		});
		await onDatabase(path, async (db) => {
			const store = await SqlSessionStore.open(db);
			await store.readResume(header.id);
			const row = await db.get<{ summary_state: string }>(
				"SELECT summary_state FROM session_sessions WHERE id = ?",
				header.id,
			);
			// An uninterrupted fold overflows to Infinity, which the published JSON index represents as null.
			assert.equal(JSON.parse(row!.summary_state).resume.totals.auxiliary.input, null);
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
