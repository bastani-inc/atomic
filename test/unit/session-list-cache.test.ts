import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry, SessionInfo } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	LISTING_FETCH_BATCH,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionRecordHeader } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createSessionCwdMatcher } from "../../packages/coding-agent/src/utils/canonical-path.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/** A real Bun child process that opens the store, writes once and exits. */
const WRITER_PROCESS_TIMEOUT_MS = 60_000;
const WRITER = resolve("test/fixtures/resume-list-cache-writer.ts");

function header(id: string, cwd: string): SessionRecordHeader {
	return { id, version: 4, createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), cwd };
}

function message(id: string, text: string, time = Date.UTC(2026, 0, 1, 1)): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(time).toISOString(),
		message: { role: "user", content: text, timestamp: time },
	};
}

function rename(id: string, name: string): SessionEntry {
	return { type: "session_info", id, parentId: null, timestamp: new Date().toISOString(), name };
}

/** Records which listing reads the reader's connection serves, through the database the store was given. */
function observeReads(database: SqliteDatabase) {
	const all = database.all.bind(database);
	const reads = { statements: 0, searchTextRows: 0 };
	database.all = async <Row extends SqliteRow>(sql: string, ...values: readonly SqliteValue[]): Promise<Row[]> => {
		const rows = await all<Row>(sql, ...values);
		reads.statements++;
		if (sql.includes("search_texts")) reads.searchTextRows += rows.length;
		return rows;
	};
	return {
		reads,
		reset() {
			reads.statements = 0;
			reads.searchTextRows = 0;
		},
	};
}

/**
 * Resumes every by-id search-text read on a later event-loop turn, so the read of a listing's next batch
 * always gives a concurrent listing the chance to run to completion first, whatever the adapter's queueing.
 */
function yieldAfterFetchBatches(database: SqliteDatabase): void {
	const all = database.all.bind(database);
	database.all = async <Row extends SqliteRow>(sql: string, ...values: readonly SqliteValue[]): Promise<Row[]> => {
		const rows = await all<Row>(sql, ...values);
		if (sql.includes("search_texts") && sql.includes("WHERE id IN")) await nextTurn();
		return rows;
	};
}

function byId(sessions: readonly SessionInfo[]): Map<string, SessionInfo> {
	return new Map(sessions.map((session) => [session.id, session]));
}

function ids(sessions: readonly SessionInfo[]): string[] {
	return sessions.map((session) => session.id).sort();
}

describe("/resume session list cache", () => {
	let dir: string;
	let path: string;
	let cwd: string;
	let database: SqliteDatabase;
	let store: SqlSessionStore;
	const opened: { close(): Promise<void> }[] = [];

	async function openStore(on: SqliteDatabase): Promise<SqlSessionStore> {
		const opened = await SqlSessionStore.open(on, { cwdMatcher: createSessionCwdMatcher });
		return opened;
	}

	async function otherConnection(): Promise<SqlSessionStore> {
		const other = await openNodeSqliteDatabase(path);
		const otherStore = await openStore(other);
		opened.push(otherStore, other);
		return otherStore;
	}

	function writerProcess(...args: string[]): void {
		const child = spawnSyncCollect([bunExecutable(), WRITER, path, ...args], { timeout: WRITER_PROCESS_TIMEOUT_MS });
		assert.equal(child.exitCode, 0, child.stderr.toString());
	}

	beforeEach(async () => {
		dir = makeTempDirectory("session-list-cache-");
		path = join(dir, "journal.sqlite");
		cwd = join(dir, "project");
		database = await openNodeSqliteDatabase(path);
		store = await openStore(database);
		await store.create(header("alpha", cwd), [message("a1", "alpha words")]);
		await store.create(header("beta", cwd), [message("b1", "beta words")]);
		await store.create(header("elsewhere", join(dir, "other")), [message("e1", "other project")]);
	});

	afterEach(async () => {
		for (const handle of opened.splice(0).reverse()) await handle.close();
		await store.close();
		await database.close();
		removeTempDirectory(dir);
	});

	test("an unchanged reopen returns the same list without re-reading the store", async () => {
		const observed = observeReads(database);
		const first = await SessionManager.listAll(store);
		const firstFolder = await SessionManager.list(cwd, store);
		observed.reset();
		assert.deepEqual(await SessionManager.listAll(store), first);
		assert.deepEqual(await SessionManager.list(cwd, store), firstFolder);
		assert.deepEqual(observed.reads, { statements: 0, searchTextRows: 0 });
		assert.deepEqual([...byId(firstFolder).keys()].sort(), ["alpha", "beta"]);
	});

	test("a reopen after one change re-reads only that session's search text", async () => {
		for (let index = 0; index < 8; index++)
			await store.create(header(`filler-${index}`, cwd), [message(`f${index}`, `filler ${index}`)]);
		await SessionManager.listAll(store);
		const observed = observeReads(database);
		const { lastSeq } = await store.load("alpha");
		await store.append("alpha", [message("a2", "freshly appended needle", Date.UTC(2026, 0, 3))], {
			expectSeq: lastSeq,
		});
		const reopened = byId(await SessionManager.listAll(store));
		assert.equal(observed.reads.searchTextRows, 1);
		assert.match(reopened.get("alpha")?.allMessagesText ?? "", /freshly appended needle/);
		assert.equal(reopened.get("alpha")?.modified.toISOString(), new Date(Date.UTC(2026, 0, 3)).toISOString());
		assert.equal(reopened.get("beta")?.allMessagesText, "beta words");
	});

	test("own-process creates, renames and deletes are reflected, including through another store on the same connection", async () => {
		const sibling = await openStore(database);
		await SessionManager.listAll(store);
		await sibling.create(header("gamma", cwd), [message("g1", "gamma words")]);
		assert.ok(byId(await SessionManager.list(cwd, store)).has("gamma"));
		await sibling.append("gamma", [rename("g-name", "Gamma renamed")], { expectSeq: 1 });
		assert.equal(byId(await SessionManager.list(cwd, store)).get("gamma")?.name, "Gamma renamed");
		await store.append("beta", [rename("b-name", "Beta renamed")], { expectSeq: 1 });
		assert.equal(byId(await SessionManager.listAll(store)).get("beta")?.name, "Beta renamed");
		await sibling.delete("alpha");
		const reopened = byId(await SessionManager.list(cwd, store));
		assert.deepEqual([...reopened.keys()].sort(), ["beta", "gamma"]);
		await sibling.close();
	});

	test.each(["this", "another"] as const)(
		"a later message's text replaced through %s connection, with the listed columns unchanged, is searched on reopen",
		async (writer) => {
			const before = [message("a1", "alpha words"), message("a2", "removed needle")];
			const { lastSeq } = await store.replace("alpha", header("alpha", cwd), before, { expectSeq: 1 });
			assert.match(byId(await SessionManager.listAll(store)).get("alpha")?.allMessagesText ?? "", /removed needle/);
			const replacing = writer === "this" ? store : await otherConnection();
			await replacing.replace(
				"alpha",
				header("alpha", cwd),
				[message("a1", "alpha words"), message("a2", "replacement needle")],
				{ expectSeq: lastSeq },
			);
			const searched = byId(await SessionManager.listAll(store)).get("alpha")?.allMessagesText ?? "";
			assert.match(searched, /replacement needle/);
			assert.doesNotMatch(searched, /removed needle/);
		},
	);

	test("another connection's creates, renames, deletes and visibility changes are reflected", async () => {
		const other = await otherConnection();
		await SessionManager.listAll(store);
		await other.create(header("gamma", cwd), [message("g1", "gamma words")]);
		assert.equal(byId(await SessionManager.list(cwd, store)).get("gamma")?.allMessagesText, "gamma words");
		await other.append("alpha", [rename("a-name", "Alpha renamed")], { expectSeq: 1 });
		assert.equal(byId(await SessionManager.list(cwd, store)).get("alpha")?.name, "Alpha renamed");
		await other.delete("beta");
		assert.equal(byId(await SessionManager.listAll(store)).has("beta"), false);
		// A header-only rewrite keeps the sequence: marking a session internal must still hide it.
		await other.replace("gamma", { ...header("gamma", cwd), internal: true }, [message("g1", "gamma words")], {
			expectSeq: 1,
		});
		assert.equal(byId(await SessionManager.list(cwd, store)).has("gamma"), false);
		assert.equal(
			byId(await SessionManager.list(cwd, store, undefined, { includeInternal: true })).get("gamma")?.internal,
			true,
		);
	});

	test(
		"another process's creates, renames and deletes are reflected",
		async () => {
			await SessionManager.listAll(store);
			writerProcess("create", "gamma", cwd, "written by another process");
			assert.equal(
				byId(await SessionManager.list(cwd, store)).get("gamma")?.allMessagesText,
				"written by another process",
			);
			writerProcess("rename", "alpha", "Renamed by another process");
			assert.equal(byId(await SessionManager.list(cwd, store)).get("alpha")?.name, "Renamed by another process");
			writerProcess("delete", "beta");
			assert.deepEqual([...byId(await SessionManager.list(cwd, store)).keys()].sort(), ["alpha", "gamma"]);
		},
		WRITER_PROCESS_TIMEOUT_MS * 3,
	);

	test.each(["project", "all-projects"] as const)(
		"concurrent listings of two scopes keep every session another connection created, when the %s listing starts first",
		async (startsFirst) => {
			// More changed sessions than one fetch batch, in a scope large enough to re-read them by id in batches.
			// One lands in the project too, so both listings fetch by id and each pauses after its batches.
			const changed = LISTING_FETCH_BATCH + 1;
			const elsewhere = join(dir, "other");
			for (let index = 0; index < 4 * changed; index++) {
				const listed = `listed-${index}`;
				await store.create(header(listed, index % 2 === 0 ? cwd : elsewhere), [message(`${listed}-m`, listed)]);
			}
			await SessionManager.list(cwd, store);
			await SessionManager.listAll(store);
			const other = await otherConnection();
			for (let index = 0; index < changed; index++) {
				const created = `created-${index}`;
				await other.create(header(created, index === 0 ? cwd : elsewhere), [message(`${created}-m`, created)]);
			}
			const expectedProject = ids(await SessionManager.list(cwd, other));
			const expectedAll = ids(await SessionManager.listAll(other));
			yieldAfterFetchBatches(database);

			// Both listings run at once, as when Tab switches the picker's scope while the first scope still loads.
			const allFirst = startsFirst === "all-projects" ? SessionManager.listAll(store) : undefined;
			const projectListing = SessionManager.list(cwd, store);
			const [projectListed, allListed] = await Promise.all([
				projectListing,
				allFirst ?? SessionManager.listAll(store),
			]);
			const assertLists = (listed: readonly SessionInfo[], expected: readonly string[], listing: string) =>
				assert.deepEqual(ids(listed), expected, `${listing} lists ${listed.length} of ${expected.length} sessions`);
			assertLists(projectListed, expectedProject, "the concurrent project listing");
			assertLists(allListed, expectedAll, "the concurrent all-projects listing");
			// The unchanged reopen is served from the cache the concurrent listings left behind.
			assertLists(await SessionManager.listAll(store), expectedAll, "the reopened all-projects listing");
			assertLists(await SessionManager.list(cwd, store), expectedProject, "the reopened project listing");
		},
	);

	test("selecting a listed session that another connection deleted finds nothing to open", async () => {
		const other = await otherConnection();
		const listed = byId(await SessionManager.list(cwd, store));
		assert.ok(listed.has("beta"));
		await other.delete("beta");
		await assert.rejects(store.load("beta"), { name: "SessionNotFoundError" });
		assert.equal(await store.readHeader("beta"), undefined);
	});
});
