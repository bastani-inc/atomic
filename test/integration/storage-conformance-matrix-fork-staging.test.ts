import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	FORK_STAGING_BATCH_BYTES,
	forkStagingLegacyCut,
} from "../../packages/coding-agent/src/core/storage/session/fork-staging.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	BIG_BLOB_BYTES,
	bytesOf,
	gate,
	header,
	instrumented,
	type Ledger,
	listedIds,
	mainClone,
	SERVER_TIMEOUT_MS,
	seedSource,
	sha256,
	stagedClone,
	stagedRows,
	stagingTable,
	stored,
	toolOutput,
	user,
	withBackendScope,
	within,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A full-session clone between SQL handles whose physical identity cannot be proven goes through the fork staging
 * table (#5594): pages are read from the source and released before they are written, the child is published in one
 * transaction, and what a stopped clone left is removed. Runs on every backend of the storage matrix; a server backend
 * runs when its URL is set (see test/helpers/storage-backends.ts).
 */

/** The first summary a store lists. */
async function firstSummary(store: SessionStore) {
	for await (const summary of store.list({ includeInternal: true })) return summary;
	return undefined;
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`fork staging on ${name} (#5594)`, () => {
		const withScope = (body: Parameters<typeof withBackendScope>[1]) => withBackendScope(backend, body);

		test(
			"a staged clone stores exactly what main's full-session clone stores, and leaves no staged row",
			() =>
				withScope(async (scope) => {
					const sourcePrefix = `${scope.prefix}s_`;
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: sourcePrefix });
					const { missing } = await seedSource(source, "src", "alpha");
					const viaMain = `${scope.prefix}m_`;
					const viaStaging = `${scope.prefix}t_`;
					const mainDb = await scope.connect();
					const stagingDb = await scope.connect();
					const mainDest = await SqlSessionStore.open(mainDb, { prefix: viaMain });
					const stagingDest = await SqlSessionStore.open(stagingDb, { prefix: viaStaging });
					const child = header("child", "src");

					const main = await mainClone(source, "src", mainDest, child);
					const staged = await stagedClone(source, "src", stagingDest, child);

					assert.deepEqual(
						staged.created.remainingBlobs,
						[missing],
						"only the blob the source lacks is left over",
					);
					assert.deepEqual(staged.missing, main.missing, "the missing blob is reported as main reports it");
					assert.equal(staged.created.lastSeq, 13);
					assert.deepEqual(await stored(stagingDb, viaStaging, "child"), await stored(mainDb, viaMain, "child"));
					assert.equal(await stagedRows(stagingDb, viaStaging), 0);
					assert.deepEqual(await stagingDest.load("child"), await mainDest.load("child"));
					const { modifiedAt: _a, ...stagedSummary } = (await firstSummary(stagingDest))!;
					const { modifiedAt: _b, ...mainSummary } = (await firstSummary(mainDest))!;
					assert.deepEqual(stagedSummary, mainSummary, "listing and search text");
					assert.deepEqual(
						await stagingDest.getBlob("child", sha256(bytesOf(BIG_BLOB_BYTES, 7))),
						bytesOf(BIG_BLOB_BYTES, 7),
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"staged rows are written in transactions of about one batch, each after the source reads it holds returned",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await seedSource(source, "src", "batches", 2 * FORK_STAGING_BATCH_BYTES + 3);
					const destPrefix = `${scope.prefix}d_`;
					const staging = stagingTable(destPrefix);
					const ledger: Ledger = { open: new Map(), overlaps: [], recording: false };
					const counted = instrumented(await scope.connect(), { name: "source", ledger });
					const reader = await SqlSessionStore.open(counted, { prefix: `${scope.prefix}s_` });
					/** The bytes each staging transaction inserted, from its lease renewal on. */
					const batches: number[] = [];
					const pause = (sql: string, inTransaction: boolean, params: readonly unknown[]) => {
						if (!inTransaction) return undefined;
						if (sql.startsWith(`UPDATE ${staging} SET size`)) batches.push(0);
						else if (sql.startsWith(`INSERT INTO ${staging} `) && batches.length > 0)
							batches[batches.length - 1]! += params.reduce<number>(
								(n, p) => n + (typeof p === "string" ? p.length : p instanceof Uint8Array ? p.byteLength : 0),
								0,
							);
						return undefined;
					};
					const dest = await SqlSessionStore.open(
						instrumented(await scope.connect(), { name: "dest", ledger, pause }),
						{ prefix: destPrefix },
					);
					ledger.recording = true;
					await stagedClone(reader, "src", dest, header("child", "src"));
					ledger.recording = false;
					// The writes of the staging transactions, the lease renewal of the publication aside.
					const written = batches.filter((bytes) => bytes > 0);
					const total = written.reduce((n, bytes) => n + bytes, 0);
					assert.ok(total > 2 * FORK_STAGING_BATCH_BYTES, `staged ${total} bytes`);
					assert.ok(
						written.length <= Math.ceil(total / FORK_STAGING_BATCH_BYTES) + 1,
						`${written.length} staging transactions for ${total} bytes`,
					);
					for (const bytes of written)
						assert.ok(
							bytes <= FORK_STAGING_BATCH_BYTES + SESSION_BLOB_CHUNK_BYTES + 4096,
							`a batch of ${bytes} bytes`,
						);
					assert.deepEqual(ledger.overlaps, [], "no source read ran while a staging transaction was open");
					assert.deepEqual(
						await dest.getBlob("child", sha256(bytesOf(2 * FORK_STAGING_BATCH_BYTES + 3, 7))),
						bytesOf(2 * FORK_STAGING_BATCH_BYTES + 3, 7),
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"multi-MiB blobs reach Node in bounded parts and are copied byte for byte, one in the legacy one-row layout without converting it",
			() =>
				withScope(async (scope) => {
					const sourcePrefix = `${scope.prefix}s_`;
					const seeding = await scope.connect();
					await (await SqlSessionStore.open(seeding, { prefix: sourcePrefix })).create(header("src"), [
						user("e1", null, "blobs", 1),
					]);
					// More than two cuts on a SQLite file; a libSQL server caps a row at 5 MB, so its legacy rows were smaller.
					const legacyBytes = bytesOf(
						backend.name === "SQLite file"
							? 2 * FORK_STAGING_BATCH_BYTES + 17
							: 4 * SESSION_BLOB_CHUNK_BYTES + 17,
						11,
					);
					const legacyHash = sha256(legacyBytes);
					// SQLite and libSQL tables written before chunked blobs kept each blob in one row; PostgreSQL never did.
					const legacy = dialectOf(seeding).name === "sqlite";
					const blobs = renderStorageIdentifiers("sessions", SESSION_TABLES, sourcePrefix);
					if (legacy) {
						await seeding.exec(`DROP TABLE ${blobs.blobs}; DROP TABLE ${blobs.blobChunks};
							CREATE TABLE ${blobs.blobs} (session_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
							data BLOB NOT NULL, PRIMARY KEY (session_id, hash)) STRICT`);
						await seeding.run(
							`INSERT INTO ${blobs.blobs} VALUES ('src', ?, ?, ?)`,
							legacyHash,
							legacyBytes.byteLength,
							legacyBytes,
						);
					}
					// The largest bytes value the source database hands Node while the clone runs.
					let largest = 0;
					let measuring = false;
					const measure = <R>(rows: R): R => {
						if (measuring)
							for (const row of Array.isArray(rows) ? rows : rows === undefined ? [] : [rows])
								for (const value of Object.values(row as object))
									if (value instanceof Uint8Array) largest = Math.max(largest, value.byteLength);
						return rows;
					};
					const measured = <E extends SqliteExecutor>(executor: E): E =>
						new Proxy(executor, {
							get(target, key) {
								const value = Reflect.get(target, key, target) as unknown;
								if (typeof value !== "function") return value;
								if (key === "get" || key === "all")
									return async (...args: unknown[]) => measure(await Reflect.apply(value, target, args));
								if (key === "transaction")
									return (body: (tx: SqliteExecutor) => Promise<unknown>, options?: object) =>
										Reflect.apply(value, target, [(tx: SqliteExecutor) => body(measured(tx)), options]);
								return value.bind(target);
							},
						});
					const source = await SqlSessionStore.open(measured(await scope.connect()), { prefix: sourcePrefix });
					const chunkedBytes = bytesOf(5 * SESSION_BLOB_CHUNK_BYTES + 23, 13);
					const chunked = await source.putBlob("src", chunkedBytes);
					await source.append(
						"src",
						[
							...(legacy ? [toolOutput("e2", "e1", legacyHash, legacyBytes.byteLength, 2)] : []),
							toolOutput("e3", legacy ? "e2" : "e1", chunked.hash, chunked.bytes, 3),
						],
						{ expectSeq: 1 },
					);
					const mainDb = await scope.connect();
					const stagingDb = await scope.connect();
					const mainDest = await SqlSessionStore.open(mainDb, { prefix: `${scope.prefix}m_` });
					const stagingDest = await SqlSessionStore.open(stagingDb, { prefix: `${scope.prefix}t_` });
					await mainClone(source, "src", mainDest, header("child", "src"));
					measuring = true;
					const staged = await stagedClone(source, "src", stagingDest, header("child", "src"));
					measuring = false;
					assert.deepEqual(staged.created.remainingBlobs, []);
					// A chunk row; or one cut of a legacy row, which the database reads whole once per cut.
					const bound = legacy
						? forkStagingLegacyCut(legacyBytes.byteLength, SESSION_BLOB_CHUNK_BYTES)
						: SESSION_BLOB_CHUNK_BYTES;
					assert.ok(largest <= bound, `Node received ${largest} bytes at once`);
					assert.deepEqual(
						await stored(stagingDb, `${scope.prefix}t_`, "child"),
						await stored(mainDb, `${scope.prefix}m_`, "child"),
					);
					assert.deepEqual(await stagingDest.getBlob("child", chunked.hash), chunkedBytes);
					if (legacy) {
						assert.deepEqual(await stagingDest.getBlob("child", legacyHash), legacyBytes);
						const kept = await seeding.get(
							`SELECT chunks, length(data) AS bytes FROM ${blobs.blobs} WHERE session_id = 'src' AND hash = ?`,
							legacyHash,
						);
						assert.deepEqual(
							{ chunks: Number(kept?.chunks), bytes: Number(kept?.bytes) },
							{ chunks: -1, bytes: legacyBytes.byteLength },
							"the source keeps its legacy row as it was",
						);
						const converted = await seeding.get(
							`SELECT count(*) AS n FROM ${blobs.blobChunks} WHERE session_id = 'src' AND hash = ?`,
							legacyHash,
						);
						assert.equal(Number(converted?.n), 0, "nothing converts the legacy blob");
					}
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"two stores on one queued connection clone into each other without either waiting on the other",
			() =>
				withScope(async (scope) => {
					const database = await scope.connect();
					const ledger: Ledger = { open: new Map(), overlaps: [], recording: false };
					// The same prefix too: two handles of one store that cannot prove they are one.
					const first = await SqlSessionStore.open(instrumented(database, { name: "first", ledger }), {
						prefix: scope.prefix,
					});
					const second = await SqlSessionStore.open(instrumented(database, { name: "second", ledger }), {
						prefix: scope.prefix,
					});
					await seedSource(first, "a", "first");
					await seedSource(second, "b", "second");
					ledger.recording = true;
					await within(stagedClone(first, "a", second, header("a-child", "a")), "the clone");
					ledger.recording = false;
					assert.deepEqual(ledger.overlaps, [], "no statement ran while the other handle held a transaction");
					// Inverse copies at once, over the one connection: each handle is both a source and a destination.
					await within(
						Promise.all([
							stagedClone(first, "a", second, header("a-again", "a")),
							stagedClone(second, "b", first, header("b-child", "b")),
						]),
						"the inverse clones",
					);
					assert.deepEqual(await listedIds(first), ["a", "a-again", "a-child", "b", "b-child"]);
					for (const id of ["a-child", "a-again"])
						assert.deepEqual((await second.load(id)).entries, (await first.load("a")).entries);
					assert.deepEqual((await first.load("b-child")).entries, (await second.load("b")).entries);
					assert.equal(await stagedRows(database, scope.prefix), 0);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"the child, its entries and every blob become visible in one commit",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await seedSource(source, "src", "atomic");
					const destPrefix = `${scope.prefix}d_`;
					const staging = stagingTable(destPrefix);
					const publishing = gate();
					const publication = new RegExp(`^DELETE FROM ${staging} WHERE transfer_id = \\?$`);
					const dest = await SqlSessionStore.open(
						instrumented(await scope.connect(), {
							pause: (sql, inTransaction) =>
								inTransaction && publication.test(sql) ? publishing.wait() : undefined,
						}),
						{ prefix: destPrefix },
					);
					const observer = await scope.connect();
					const t = renderStorageIdentifiers("sessions", SESSION_TABLES, destPrefix);
					const visible = async () => ({
						sessions: Number(
							(await observer.get(`SELECT count(*) AS n FROM ${t.sessions} WHERE id = 'child'`))!.n,
						),
						entries: Number(
							(await observer.get(`SELECT count(*) AS n FROM ${t.entries} WHERE session_id = 'child'`))!.n,
						),
						chunks: Number(
							(await observer.get(`SELECT count(*) AS n FROM ${t.entryChunks} WHERE session_id = 'child'`))!.n,
						),
						blobs: Number(
							(await observer.get(`SELECT count(*) AS n FROM ${t.blobs} WHERE session_id = 'child'`))!.n,
						),
						blobChunks: Number(
							(await observer.get(`SELECT count(*) AS n FROM ${t.blobChunks} WHERE session_id = 'child'`))!.n,
						),
					});
					const clone = stagedClone(source, "src", dest, header("child", "src"));
					clone.catch(() => {});
					await within(publishing.reached, "the publication");
					// Every row is written and the transaction is still open: another connection sees none of it.
					assert.deepEqual(await visible(), { sessions: 0, entries: 0, chunks: 0, blobs: 0, blobChunks: 0 });
					assert.ok((await stagedRows(observer, destPrefix)) > 0);
					publishing.release();
					await clone;
					assert.deepEqual(await visible(), { sessions: 1, entries: 13, chunks: 2, blobs: 3, blobChunks: 4 });
					assert.equal(await stagedRows(observer, destPrefix), 0);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"inverse clones between two connections both finish within a bound",
			() =>
				withScope(async (scope) => {
					const left = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}l_` });
					const right = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}r_` });
					await seedSource(left, "a", "left");
					await seedSource(right, "b", "right");
					const results = await within(
						Promise.allSettled([
							stagedClone(left, "a", right, header("a-child", "a")),
							stagedClone(right, "b", left, header("b-child", "b")),
						]),
						"the inverse clones",
					);
					assert.deepEqual(
						results.map((result) => result.status),
						["fulfilled", "fulfilled"],
					);
					assert.deepEqual((await right.load("a-child")).entries, (await left.load("a")).entries);
					assert.deepEqual((await left.load("b-child")).entries, (await right.load("b")).entries);
					const check = await scope.connect();
					assert.equal(await stagedRows(check, `${scope.prefix}l_`), 0);
					assert.equal(await stagedRows(check, `${scope.prefix}r_`), 0);
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
