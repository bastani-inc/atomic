import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { type StorageBackend, type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Detaching forks that share a session's history, on every backend of the storage matrix (#6560): a detach stopped
 * after any of its commits leaves every fork reading what it read and finishes when run again, many forks of one
 * session cost one copy, and a deleted session's rows stay while forks read them and go with the last of them.
 */

useTemporaryAgentDir();

/** A run over a server can wait on it for each of many transactions. */
const DETACH_TIMEOUT_MS = 240_000;
const CWD = "/project";

class Crash extends Error {}

/** `database`, whose process stops (throws) after `crash.after` more committed transactions while `crash.after` is set. */
function crashing(database: SqliteDatabase, crash: { after?: number }): SqliteDatabase {
	return new Proxy(database, {
		get(target, property) {
			if (property === "transaction")
				return async (...args: Parameters<SqliteDatabase["transaction"]>) => {
					const result = await target.transaction(...args);
					if (crash.after !== undefined && --crash.after < 0) throw new Crash("the process stopped");
					return result;
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

interface Fixture {
	readonly store: SqlSessionStore;
	readonly prefix: string;
	readonly database: SqliteDatabase;
	readonly crash: { after?: number };
}

async function withStore(backend: StorageBackend, body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const scope: StorageBackendScope = await backend.openScope();
	try {
		const crash: { after?: number } = {};
		const database = await scope.connect();
		const store = await SqlSessionStore.open(crashing(database, crash), { prefix: scope.prefix });
		try {
			assert.notEqual((await store.enableSharedHistoryForks({ live: async () => false })).status, "refused");
			await body({ store, prefix: scope.prefix, database, crash });
		} finally {
			await store.close();
		}
	} finally {
		await scope.close();
	}
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1_800_000_000_000 };
}

/** A clone of `parent`'s whole stored history that shares its rows. */
async function clone(store: SqlSessionStore, parentId: string): Promise<string> {
	const head = await store.readEntrySizes(parentId, 1, 0);
	const id = randomUUID();
	const created = await store.createFork(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date().toISOString(), cwd: CWD, parentSessionId: parentId },
		completeSessionForkStream(parentId, head.epoch, head.lastSeq),
		{ store, sessionId: parentId, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.ok(created, "the store takes the clone");
	return id;
}

async function appendTo(store: SqlSessionStore, id: string, ...texts: string[]): Promise<void> {
	const manager = await SessionManager.open(store, id);
	for (const text of texts) await manager.appendMessage(user(text));
}

/** Every entry of the session, as a read of it returns them. */
async function view(store: SqlSessionStore, id: string): Promise<string> {
	return JSON.stringify((await store.load(id)).entries);
}

async function count(fixture: Fixture, sql: string, ...params: string[]): Promise<number> {
	const row = await fixture.database.get<{ n: number }>(sql, ...params);
	return Number(row?.n ?? 0);
}

const entriesTable = (prefix: string) => renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).entries;

async function segments(fixture: Fixture, id: string): Promise<number> {
	return count(
		fixture,
		`SELECT count(*) AS n FROM ${sessionForkTables(fixture.prefix).forkSegments} WHERE session_id = ?`,
		id,
	);
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`detaching shared fork history on ${name} (#6560)`, () => {
		test(
			"a detach stopped after any of its commits keeps every view and finishes when run again (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store, crash } = fixture;
					const parent = await SessionManager.create(store, CWD);
					for (let index = 0; index < 3; index++) await parent.appendMessage(user(`p${index}`));
					const parentId = parent.getSessionId();
					const sibling = await clone(store, parentId);
					for (let index = 3; index < 8; index++) await parent.appendMessage(user(`p${index}`));
					const child = await clone(store, parentId);
					await appendTo(store, child, "c own");
					await appendTo(store, sibling, "s own");
					await parent.appendMessage(user("p after the forks"));
					const before = { child: await view(store, child), sibling: await view(store, sibling) };

					let finished = false;
					for (let commits = 0; !finished; commits++) {
						assert.ok(commits < 20, "the detach finishes");
						crash.after = commits;
						finished = await store.detachForks(parentId, { pageRows: 3 }).then(
							() => true,
							(error: Error) => {
								if (!(error instanceof Crash)) throw error;
								return false;
							},
						);
						crash.after = undefined;
						assert.equal(await view(store, child), before.child, `the child after ${commits + 1} commits`);
						assert.equal(await view(store, sibling), before.sibling, `the sibling after ${commits + 1} commits`);
					}
					assert.deepEqual(await store.resumeForkDetaches(), { detached: [], reparented: [] });
					assert.equal(await segments(fixture, child), 0);
					assert.equal(await segments(fixture, sibling), 1, "the sibling reads the child's copy");
					// Nothing reads the parent's rows now: deleting it removes them, and the forks read the same.
					await store.delete(parentId);
					assert.equal(
						await count(
							fixture,
							`SELECT count(*) AS n FROM ${entriesTable(fixture.prefix)} WHERE session_id = ?`,
							parentId,
						),
						0,
					);
					assert.equal(await view(store, child), before.child);
					assert.equal(await view(store, sibling), before.sibling);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"a detach of a deleted session's forks keeps the sweep off its rows until the forks hold their own, across crashes (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store, crash } = fixture;
					const parent = await SessionManager.create(store, CWD);
					for (let index = 0; index < 8; index++) await parent.appendMessage(user(`p${index}`));
					const parentId = parent.getSessionId();
					const child = await clone(store, parentId);
					await appendTo(store, child, "c own");
					const before = await view(store, child);
					await store.delete(parentId);
					const parentRows = `SELECT count(*) AS n FROM ${entriesTable(fixture.prefix)} WHERE session_id = ?`;

					let finished = false;
					for (let commits = 0; !finished; commits++) {
						assert.ok(commits < 20, "the detach finishes");
						crash.after = commits;
						finished = await store.detachForks(parentId, { pageRows: 3 }).then(
							() => true,
							(error: Error) => {
								if (!(error instanceof Crash)) throw error;
								return false;
							},
						);
						crash.after = undefined;
						// A sweep between the detach's commits finds the child still reading the rest of the parent's rows.
						await store.sweepForkTombstones([parentId]);
						assert.equal(await view(store, child), before, `the child after ${commits + 1} commits and a sweep`);
					}
					assert.equal(await count(fixture, parentRows, parentId), 0, "the deleted parent's rows went");
					assert.equal(await view(store, child), before);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"detaching 50 sibling forks copies the parent's rows once (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store } = fixture;
					const parent = await SessionManager.create(store, CWD);
					const parentId = parent.getSessionId();
					const siblings: string[] = [];
					for (let index = 0; index < 50; index++) {
						await parent.appendMessage(user(`p${index}`));
						siblings.push(await clone(store, parentId));
					}
					await parent.appendMessage(user("p last"));
					const child = await clone(store, parentId);
					const before = new Map<string, string>();
					for (const id of [child, ...siblings]) before.set(id, await view(store, id));
					const table = entriesTable(fixture.prefix);
					const rows = await count(fixture, `SELECT count(*) AS n FROM ${table}`);

					const report = await store.detachForks(parentId);

					assert.deepEqual(report.detached, [child], "the fork that reads most of the parent copies it");
					assert.deepEqual([...report.reparented].sort(), [...siblings].sort());
					assert.equal(
						await count(fixture, `SELECT count(*) AS n FROM ${table}`),
						rows + 51,
						"one copy of the parent's 51 rows, none for the 50 re-pointed forks",
					);
					await store.delete(parentId);
					for (const [id, bodies] of before) assert.equal(await view(store, id), bodies, id);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"a deleted session's rows stay while a fork reads them and go with its detach (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store } = fixture;
					const parent = await SessionManager.create(store, CWD);
					await parent.appendMessage(user("p0"));
					await parent.appendToolOutputBlob("call-p", new Uint8Array(Buffer.from("parent output")));
					const parentId = parent.getSessionId();
					const child = await clone(store, parentId);
					const before = await view(store, child);
					const table = entriesTable(fixture.prefix);
					const parentRows = `SELECT count(*) AS n FROM ${table} WHERE session_id = ?`;

					await store.delete(parentId);
					assert.equal(await store.readHeader(parentId), undefined, "the deleted session is gone from reads");
					assert.ok((await count(fixture, parentRows, parentId)) > 0, "its rows stay for the fork");
					assert.equal(await view(store, child), before);

					await store.detachForks(parentId);
					assert.equal(await count(fixture, parentRows, parentId), 0, "its rows go with the last reader");
					assert.equal(await view(store, child), before);
					// A new session under the deleted one's ID starts empty.
					await store.create(
						{ id: parentId, version: SESSION_FORMAT_VERSION, createdAt: new Date().toISOString(), cwd: CWD },
						[],
					);
					assert.deepEqual((await store.load(parentId)).entries, []);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"deleting the last fork of a deleted session sweeps the session's rows, and only them (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store } = fixture;
					const parent = await SessionManager.create(store, CWD);
					for (let index = 0; index < 5; index++) await parent.appendMessage(user(`p${index}`));
					const parentId = parent.getSessionId();
					const first = await clone(store, parentId);
					const second = await clone(store, parentId);
					const other = await SessionManager.create(store, CWD);
					await other.appendMessage(user("unrelated"));
					const otherView = await view(store, other.getSessionId());
					const parentRows = `SELECT count(*) AS n FROM ${entriesTable(fixture.prefix)} WHERE session_id = ?`;
					const tombstones = `SELECT count(*) AS n FROM ${sessionForkTables(fixture.prefix).forkTombstones}`;

					await store.delete(parentId);
					const before = await view(store, second);
					await store.delete(first);
					assert.equal(await count(fixture, parentRows, parentId), 5, "the second fork still reads them");
					assert.equal(await view(store, second), before);
					await store.delete(second);
					assert.equal(await count(fixture, parentRows, parentId), 0, "the last reader's delete swept them");
					assert.equal(await count(fixture, tombstones), 0);
					assert.equal(await view(store, other.getSessionId()), otherView);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"a sweep stopped after any of its batches leaves a tombstone the next sweep finishes (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store, crash } = fixture;
					const parent = await SessionManager.create(store, CWD);
					for (let index = 0; index < 7; index++) await parent.appendMessage(user(`p${index}`));
					await parent.appendToolOutputBlob("call-p", new Uint8Array(Buffer.from("parent output")));
					const parentId = parent.getSessionId();
					const child = await clone(store, parentId);
					await store.delete(parentId);
					// The process stops right after the delete of the last reader commits, before its sweep.
					crash.after = 0;
					await assert.rejects(store.delete(child), Crash);
					crash.after = undefined;
					const parentRows = `SELECT count(*) AS n FROM ${entriesTable(fixture.prefix)} WHERE session_id = ?`;
					const tombstone = `SELECT count(*) AS n FROM ${sessionForkTables(fixture.prefix).forkTombstones} WHERE session_id = ?`;
					assert.equal(await count(fixture, parentRows, parentId), 8);

					let rows = 8;
					let swept: string[] | undefined;
					for (let commits = 0; swept === undefined; commits++) {
						assert.ok(commits < 20, "the sweep finishes");
						crash.after = commits;
						swept = await store.sweepForkTombstones([], 3).catch((error: Error) => {
							if (!(error instanceof Crash)) throw error;
							return undefined;
						});
						crash.after = undefined;
						const left = await count(fixture, parentRows, parentId);
						assert.ok(left <= rows, "a stopped sweep never brings rows back");
						rows = left;
						if (left > 0)
							assert.equal(await count(fixture, tombstone, parentId), 1, "the tombstone stays with its rows");
						assert.equal(await store.readHeader(parentId), undefined);
					}
					// No sweep named the session: the stopped delete's tombstone was found as left over.
					assert.equal(await count(fixture, parentRows, parentId), 0);
					assert.equal(await count(fixture, tombstone, parentId), 0);
				}),
			DETACH_TIMEOUT_MS,
		);

		test(
			"a fork of a session being deleted either reads its whole history or is refused (#6560)",
			() =>
				withStore(backend, async (fixture) => {
					const { store } = fixture;
					for (let round = 0; round < 4; round++) {
						const parent = await SessionManager.create(store, CWD);
						for (let index = 0; index < 4; index++) await parent.appendMessage(user(`p${round}.${index}`));
						const parentId = parent.getSessionId();
						const reader = await clone(store, parentId);
						const expected = (await store.load(parentId)).entries;
						const [deleted, forked] = await Promise.allSettled([store.delete(parentId), clone(store, parentId)]);
						assert.equal(deleted.status, "fulfilled");
						if (forked.status === "fulfilled")
							assert.deepEqual(
								(await store.load(forked.value)).entries,
								expected,
								"the fork reads the whole history",
							);
						assert.deepEqual((await store.load(reader)).entries, expected);
						// Once deleted, the session cannot be forked.
						await assert.rejects(clone(store, parentId));
					}
				}),
			DETACH_TIMEOUT_MS,
		);
	});
}
