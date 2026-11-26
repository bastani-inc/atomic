import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteTransactionOptions,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	cleanupForkStaging,
	ensureForkStagingTable,
	FORK_STAGING_BATCH_BYTES,
} from "../../packages/coding-agent/src/core/storage/session/fork-staging.js";
import { FORK_STAGING_CLEANUP_ROWS } from "../../packages/coding-agent/src/core/storage/session/fork-staging-maintenance.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import {
	decodeStream,
	makeTempDirectory,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";
import { dropLibsqlScope, storageBackends } from "../helpers/storage-backends.js";
import {
	gate,
	header,
	instrumented,
	listedIds,
	mainClone,
	SERVER_TIMEOUT_MS,
	seedSource,
	stagedClone,
	stagedRows,
	stagingTable,
	stored,
	user,
	withBackendScope,
	within,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * Compatibility layouts, crash recovery, lease cleanup and failure fallbacks for staged full-session clones (#5594).
 * Runs on every backend of the storage matrix; a server backend runs when its URL is set (see
 * test/helpers/storage-backends.ts).
 */

/**
 * `database`, recording in `claims` the transfer of each takeover of a lapsed lease (a cleanup's claim) that changed a
 * row, once its transaction committed.
 */
function recordingTakeovers(database: SqliteDatabase, table: string, claims: string[]): SqliteDatabase {
	const takeover = `UPDATE ${table} SET body = ?`;
	const bound = <T extends object>(target: T, key: string | symbol) => {
		const value = Reflect.get(target, key, target) as unknown;
		return typeof value === "function" ? value.bind(target) : value;
	};
	return new Proxy(database, {
		get(target, key) {
			if (key !== "transaction") return bound(target, key);
			return <T>(callback: (tx: SqliteExecutor) => Promise<T>, options?: SqliteTransactionOptions) =>
				target
					.transaction(async (tx) => {
						const made: string[] = [];
						const recording = new Proxy(tx, {
							get(inner, name) {
								if (name !== "run") return bound(inner, name);
								return async (sql: string, ...params: SqliteValue[]) => {
									const result = await inner.run(sql, ...params);
									if (sql.startsWith(takeover) && result.changes === 1) made.push(String(params[2]));
									return result;
								};
							},
						});
						return { value: await callback(recording), made };
					}, options)
					.then(({ value, made }) => {
						claims.push(...made);
						return value;
					});
		},
	});
}

/** A blob larger than one staging batch. */
const BEYOND_ONE_BATCH = FORK_STAGING_BATCH_BYTES + SESSION_BLOB_CHUNK_BYTES + 7;

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`fork staging on ${name} (#5594)`, () => {
		const withScope = (body: Parameters<typeof withBackendScope>[1]) => withBackendScope(backend, body);

		test(
			"a clone from a store that only reads whole blobs, such as the memory store, also matches main",
			() =>
				withScope(async (scope) => {
					const source = new MemorySessionStore();
					const { missing } = await seedSource(source, "src", "memory");
					const mainDb = await scope.connect();
					const stagingDb = await scope.connect();
					const mainDest = await SqlSessionStore.open(mainDb, { prefix: `${scope.prefix}m_` });
					const stagingDest = await SqlSessionStore.open(stagingDb, { prefix: `${scope.prefix}t_` });
					const child = header("child", "src");
					await mainClone(source, "src", mainDest, child);
					const staged = await stagedClone(source, "src", stagingDest, child);
					assert.deepEqual(staged.created.remainingBlobs, [missing]);
					assert.deepEqual(
						await stored(stagingDb, `${scope.prefix}t_`, "child"),
						await stored(mainDb, `${scope.prefix}m_`, "child"),
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a snapshot entry a compatible older writer stored in chunks stays in chunks; one stored whole stays whole",
			() =>
				withScope(async (scope) => {
					const sourcePrefix = `${scope.prefix}s_`;
					const sourceDb = await scope.connect();
					const source = await SqlSessionStore.open(sourceDb, { prefix: sourcePrefix });
					await seedSource(source, "src", "older");
					await seedSource(source, "kept", "whole");
					// e11, the oversized snapshot entry, in the chunked layout an older writer could leave.
					const t = renderStorageIdentifiers("sessions", SESSION_TABLES, sourcePrefix);
					const json = String(
						(await sourceDb.get(`SELECT entry_json FROM ${t.entries} WHERE session_id = 'src' AND seq = 11`))!
							.entry_json,
					);
					const bytes = Buffer.from(json, "utf8");
					const parts = Math.ceil(bytes.byteLength / SESSION_ENTRY_CHUNK_BYTES);
					await sourceDb.transaction(async (tx) => {
						await tx.run(
							`UPDATE ${t.entries} SET entry_json = ?, chunks = ? WHERE session_id = 'src' AND seq = 11`,
							JSON.stringify({ type: "worktree_snapshot", id: "e11", parentId: "e10" }),
							parts,
						);
						for (let idx = 0; idx < parts; idx++)
							await tx.run(
								`INSERT INTO ${t.entryChunks} (session_id, seq, idx, data) VALUES ('src', 11, ?, ?)`,
								idx,
								bytes.subarray(idx * SESSION_ENTRY_CHUNK_BYTES, (idx + 1) * SESSION_ENTRY_CHUNK_BYTES),
							);
					});
					const destPrefix = `${scope.prefix}d_`;
					const destDb = await scope.connect();
					const dest = await SqlSessionStore.open(destDb, { prefix: destPrefix });
					await stagedClone(source, "src", dest, header("child", "src"));
					await stagedClone(source, "kept", dest, header("whole", "kept"));
					const [streamed, whole, original] = await Promise.all([
						stored(destDb, destPrefix, "child"),
						stored(destDb, destPrefix, "whole"),
						stored(sourceDb, sourcePrefix, "src"),
					]);
					assert.deepEqual(streamed.entries[10], original.entries[10], "the chunked snapshot keeps its stub row");
					assert.equal(streamed.entries[10]!.chunks, parts);
					assert.deepEqual(
						streamed.entryChunks.filter((row) => row.seq === 11),
						original.entryChunks.filter((row) => row.seq === 11),
					);
					assert.equal(whole.entries[10]!.chunks, 0, "the snapshot stored whole stays whole");
					const keptSnapshot = await sourceDb.get(
						`SELECT entry_json FROM ${t.entries} WHERE session_id = 'kept' AND seq = 11`,
					);
					assert.equal(whole.entries[10]!.entry_json, keptSnapshot!.entry_json);
					assert.deepEqual((await dest.load("child")).entries[10], (await source.load("src")).entries[10]);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a clone that stops mid-copy is invisible, its rows are removed on reopen once its lease lapsed, and it never publishes",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					// More than one batch before the clone stops: some of it is written to the staging table.
					await seedSource(source, "src", "crash", BEYOND_ONE_BATCH);
					const destPrefix = `${scope.prefix}d_`;
					const destDb = await scope.connect();
					const dest = await SqlSessionStore.open(destDb, { prefix: destPrefix });
					await dest.create(header("bystander"), [user("b1", null, "bystander", 1)]);
					const paused = pausingSource(source, "getBlob", 2);
					const clone = stagedClone(paused.store, "src", dest, header("child", "src"));
					clone.catch(() => {});
					await within(paused.reached, "the paused clone");
					const staged = await stagedRows(destDb, destPrefix);
					assert.ok(staged > 5, `the clone staged rows before it stopped (${staged})`);

					// While it is stopped: listings, searches and snapshot collection do not see the child.
					assert.deepEqual(await listedIds(dest), ["bystander"]);
					const listed = [];
					for await (const summary of dest.list({ includeInternal: true })) listed.push(summary.searchText);
					assert.ok(listed.every((text) => !text.includes("crash")));
					assert.equal(await dest.readHeader("child"), undefined);
					assert.deepEqual(await dest.snapshotBlobs.collectGarbage({ graceSeconds: 0 }), []);

					// Its process stopped. Explicit migration reclaims the lapsed transfer on all backends.
					await destDb.run(`UPDATE ${stagingTable(destPrefix)} SET size = 0 WHERE kind = 0`);
					const reopened = await SqlSessionStore.open(await scope.connect(), { prefix: destPrefix });
					await reopened.prepareForkStaging();
					await reopened.close();
					assert.equal(await stagedRows(destDb, destPrefix), 0);

					// Should it run again after all, it fails rather than publishing part of a child.
					paused.release();
					await assert.rejects(clone, /lost its lease/);
					assert.equal(await dest.readHeader("child"), undefined);
					assert.deepEqual(await listedIds(dest), ["bystander"]);
					assert.equal(await stagedRows(destDb, destPrefix), 0);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a clone whose process is killed mid-copy leaves staged rows only, kept while its lease runs and removed once it lapsed",
			() =>
				withCrashDatabase(backend.name, async (target) => {
					const sourcePrefix = `${target.prefix}s_`;
					const destPrefix = `${target.prefix}d_`;
					const source = await SqlSessionStore.open(await target.connect(), { prefix: sourcePrefix });
					await seedSource(source, "src", "killed", BEYOND_ONE_BATCH);
					const destDb = await target.connect();
					const dest = await SqlSessionStore.open(destDb, { prefix: destPrefix });
					const config = { database: target.config, sourcePrefix, destPrefix, sourceId: "src", childId: "child" };
					const child = spawnProcess(
						[process.execPath, "--import", "jiti/register", CRASH_FIXTURE, JSON.stringify(config)],
						{ stdout: "pipe", stderr: "inherit" },
					);
					let staged: number;
					try {
						assert.equal(await within(firstLine(child), "the clone process"), "paused");
						staged = await stagedRows(destDb, destPrefix);
					} finally {
						child.kill("SIGKILL");
						await child.exited;
					}
					assert.ok(staged > 5, `the killed clone had staged rows (${staged})`);
					assert.equal(await stagedRows(destDb, destPrefix), staged, "what it committed stays");
					assert.equal(await dest.readHeader("child"), undefined);
					assert.deepEqual(await listedIds(dest), []);

					// Its lease runs on: another open keeps the rows, which a live clone would still publish.
					await (await SqlSessionStore.open(await target.connect(), { prefix: destPrefix })).close();
					assert.equal(await stagedRows(destDb, destPrefix), staged);

					// Another clone reclaims the lapsed transfer on all backends; nothing of the killed child was published.
					await destDb.run(`UPDATE ${stagingTable(destPrefix)} SET size = 0 WHERE kind = 0`);
					await source.create(header("next"), []);
					await stagedClone(source, "next", dest, header("later", "next"));
					await dest.delete("later");
					assert.equal(await stagedRows(destDb, destPrefix), 0);
					assert.equal(await dest.readHeader("child"), undefined);
					assert.deepEqual(await listedIds(dest), []);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"open and the first read do not wait for a peer to release an expired transfer's write lock",
			() =>
				withScope(async (scope) => {
					const prefix = `${scope.prefix}d_`;
					const seeded = await scope.connect();
					const dest = await SqlSessionStore.open(seeded, { prefix });
					await dest.create(header("visible"), []);
					await dest.prepareForkStaging();
					const table = stagingTable(prefix);
					await seeded.run(
						`INSERT INTO ${table} (transfer_id,kind,seq,idx,size,body) VALUES ('old',0,0,0,0,'old')`,
					);
					const reader = await scope.connect();
					const peer = await scope.connect();
					const holder = gate();
					const writing = peer.transaction(
						async (tx) => {
							await tx.run(`UPDATE ${table} SET size=0 WHERE transfer_id='old'`);
							await holder.wait();
						},
						{ concurrency: { kind: "serial", domain: table } },
					);
					await holder.reached;
					try {
						await within(
							(async () => {
								const reopened = await SqlSessionStore.open(reader, { prefix });
								assert.ok(await reopened.readHeader("visible"));
								await reopened.close();
							})(),
							"open and first read while the peer holds its writer lock",
							3000,
						);
					} finally {
						holder.release();
						await writing;
					}
					assert.equal(
						await stagedRows(seeded, prefix),
						1,
						"a skipped open does not queue a sweep behind its first caller",
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"an idle open can sweep a bounded share when the driver supports a no-wait write; maintenance never sweeps a live clone",
			() =>
				withScope(async (scope) => {
					const destPrefix = `${scope.prefix}d_`;
					const database = await scope.connect();
					await (await SqlSessionStore.open(database, { prefix: destPrefix })).close();
					const table = stagingTable(destPrefix);
					await ensureForkStagingTable(database, dialectOf(database), table);
					const rows = 3 * FORK_STAGING_CLEANUP_ROWS;
					await database.transaction(async (tx) => {
						for (const [transfer, size] of [
							["stopped", 0],
							["live", Number.MAX_SAFE_INTEGER],
						] as const) {
							await tx.run(
								`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, 0, 0, 0, 'child', ?, 'token')`,
								transfer,
								size,
							);
							for (let seq = 1; seq <= rows; seq++)
								await tx.run(
									`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, 1, ?, 0, ?, 0, '{}')`,
									transfer,
									seq,
									`e${seq}`,
								);
						}
					});
					const left = async (transfer: string) =>
						Number((await database.get(`SELECT count(*) AS n FROM ${table} WHERE transfer_id = ?`, transfer))!.n);
					if (!database.tryMaintenance) {
						const opened = await SqlSessionStore.open(await scope.connect(), { prefix: destPrefix });
						assert.equal(await left("stopped"), rows + 1, "no unbounded cleanup on open");
						await opened.prepareForkStaging();
						await opened.close();
						assert.equal(await left("stopped"), 0);
						assert.equal(await left("live"), rows + 1);
						return;
					}
					let opens = 0;
					for (let before = await left("stopped"); before > 0; opens++) {
						await (await SqlSessionStore.open(await scope.connect(), { prefix: destPrefix })).close();
						const after = await left("stopped");
						assert.ok(after < before, "every open makes progress");
						assert.ok(before - after <= FORK_STAGING_CLEANUP_ROWS + 1, `one open removed ${before - after} rows`);
						before = after;
					}
					assert.ok(opens > 1, `the cleanup took ${opens} opens`);
					assert.equal(await left("live"), rows + 1, "a clone whose lease runs keeps every row");
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"concurrent cleanups take each lapsed transfer over once and never a live one, beside staging clones (#6560)",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await seedSource(source, "src", "sweep");
					const destPrefix = `${scope.prefix}d_`;
					const table = stagingTable(destPrefix);
					const database = await scope.connect();
					await (await SqlSessionStore.open(database, { prefix: destPrefix })).prepareForkStaging();
					const lapsed = ["l0", "l1", "l2", "l3", "l4"];
					const live = ["v0", "v1"];
					const rows = FORK_STAGING_CLEANUP_ROWS + 3;
					await database.transaction(async (tx) => {
						for (const transfer of [...lapsed, ...live]) {
							await tx.run(
								`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, 0, 0, 0, 'child', ?, 'token')`,
								transfer,
								live.includes(transfer) ? Number.MAX_SAFE_INTEGER : 0,
							);
							for (let seq = 1; seq <= rows; seq++)
								await tx.run(
									`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES (?, 1, ?, 0, ?, 0, '{}')`,
									transfer,
									seq,
									`e${seq}`,
								);
						}
					});
					// Every committed takeover, by transfer, from the cleanups and from the clones' own cleanups alike.
					const claims: string[] = [];
					const cleaners = await Promise.all(
						[0, 1, 2, 3].map(async () => recordingTakeovers(await scope.connect(), table, claims)),
					);
					const cloners = await Promise.all(
						[0, 1].map(async () =>
							SqlSessionStore.open(recordingTakeovers(await scope.connect(), table, claims), {
								prefix: destPrefix,
							}),
						),
					);
					const dialect = dialectOf(database);
					const results = await within(
						Promise.allSettled([
							...cleaners.map((cleaner) =>
								cleanupForkStaging(cleaner, dialect, table, Number.POSITIVE_INFINITY),
							),
							...cloners.map((dest, index) => stagedClone(source, "src", dest, header(`child-${index}`, "src"))),
						]),
						"the cleanups and the clones",
					);
					for (const result of results)
						assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
					assert.deepEqual(
						[...claims].sort(),
						lapsed,
						"each lapsed transfer is taken over once, a live one never",
					);
					const left = async (transfer: string) =>
						Number((await database.get(`SELECT count(*) AS n FROM ${table} WHERE transfer_id = ?`, transfer))!.n);
					for (const transfer of lapsed) assert.equal(await left(transfer), 0, transfer);
					for (const transfer of live) assert.equal(await left(transfer), rows + 1, transfer);
					const expected = (await source.load("src")).entries;
					for (const id of ["child-0", "child-1"])
						assert.deepEqual((await cloners[0]!.load(id)).entries, expected, id);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a role that may not create the staging table clones as main did; any other failure to create it fails the clone",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await seedSource(source, "src", "privileges");
					const mainDb = await scope.connect();
					const mainDest = await SqlSessionStore.open(mainDb, { prefix: `${scope.prefix}m_` });
					await mainClone(source, "src", mainDest, header("child", "src"));
					/** A store on `prefix` whose creation of the staging table is refused with `refusal()`; `meanwhile` runs
					 * between the refusal and the next look for the table. */
					const refusing = async (prefix: string, refusal: () => Error, meanwhile?: () => Promise<void>) => {
						const database = await scope.connect();
						const create = new RegExp(`^\\s*CREATE TABLE IF NOT EXISTS ${stagingTable(prefix)} `);
						const look = dialectOf(database).tableExists(stagingTable(prefix)).sql;
						let refused = false;
						const pause = (sql: string, inTransaction: boolean) => {
							if (inTransaction && create.test(sql)) {
								refused = true;
								return Promise.reject(refusal());
							}
							if (!inTransaction && refused && sql === look) {
								refused = false;
								return meanwhile?.();
							}
							return undefined;
						};
						return { database, store: await SqlSessionStore.open(instrumented(database, { pause }), { prefix }) };
					};
					const denied = () =>
						Object.assign(new Error("permission denied for schema"), { reason: "missing-privilege" });

					// No privilege and no table: main's clone, byte for byte, with one hint.
					const lowPrefix = `${scope.prefix}p_`;
					const low = await refusing(lowPrefix, denied);
					const warnings: string[] = [];
					const warned = (warning: Error) => warnings.push(warning.message);
					process.on("warning", warned);
					try {
						const fallback = await stagedClone(source, "src", low.store, header("child", "src"));
						assert.ok(fallback.created.remainingBlobs.length > 1, "main copies the blobs after the child");
						await new Promise((resolve) => setImmediate(resolve));
					} finally {
						process.off("warning", warned);
					}
					assert.ok(warnings.length <= 1, warnings.join("\n"));
					assert.deepEqual(
						await stored(low.database, lowPrefix, "child"),
						await stored(mainDb, `${scope.prefix}m_`, "child"),
					);
					const probe = dialectOf(low.database).tableExists(stagingTable(lowPrefix));
					assert.equal(await low.database.get(probe.sql, ...probe.params), undefined);

					// Another failure to create it fails the clone, and nothing is published.
					const brokenPrefix = `${scope.prefix}b_`;
					const failure = new Error("disk full");
					const broken = await refusing(brokenPrefix, () => failure);
					await assert.rejects(
						stagedClone(source, "src", broken.store, header("child", "src")),
						(error) => error === failure,
					);
					assert.equal(await broken.store.readHeader("child"), undefined);

					// Refused, but created meanwhile by a role that may: the clone is staged into it.
					const racedPrefix = `${scope.prefix}c_`;
					const raced = await refusing(racedPrefix, denied, async () => {
						const owner = await scope.connect();
						await ensureForkStagingTable(owner, dialectOf(owner), stagingTable(racedPrefix));
					});
					const staged = await stagedClone(source, "src", raced.store, header("child", "src"));
					assert.equal(staged.created.remainingBlobs.length, 1, "only the blob the source lacks is left over");
					assert.deepEqual(
						await stored(raced.database, racedPrefix, "child"),
						await stored(mainDb, `${scope.prefix}m_`, "child"),
					);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a full staging disk rolls back the private transfer and tries the original clone once",
			() =>
				withScope(async (scope) => {
					const prefix = `${scope.prefix}d_`;
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await source.create(header("src"), [user("u", null, "kept", 1)]);
					const database = await scope.connect();
					const entries = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).entries;
					const diskFull = Object.assign(
						new Error("No space for private transfer"),
						backend.name === "Postgres"
							? { code: "53100" }
							: backend.name === "SQLite file"
								? { code: "ERR_SQLITE_ERROR", errcode: 13 }
								: { code: "SQLITE_FULL" },
					);
					const finalError = new Error("the original clone also failed");
					let stagedFailures = 0,
						directWrites = 0,
						failDirect = false;
					const dest = await SqlSessionStore.open(
						instrumented(database, {
							pause(sql) {
								if (!sql.startsWith(`INSERT INTO ${entries} `)) return;
								if (sql.includes("SELECT")) {
									stagedFailures++;
									return Promise.reject(diskFull);
								}
								directWrites++;
								if (failDirect) return Promise.reject(finalError);
							},
						}),
						{ prefix },
					);
					await stagedClone(source, "src", dest, header("fits", "src"));
					assert.deepEqual((await dest.load("fits")).entries, (await source.load("src")).entries);
					assert.deepEqual([stagedFailures, directWrites, await stagedRows(database, prefix)], [1, 1, 0]);
					failDirect = true;
					await assert.rejects(
						stagedClone(source, "src", dest, header("no-room", "src")),
						(error) => error === finalError,
					);
					assert.equal(await dest.readHeader("no-room"), undefined);
					assert.deepEqual([stagedFailures, directWrites, await stagedRows(database, prefix)], [2, 2, 0]);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"a clone whose source read fails publishes nothing and removes its rows",
			() =>
				withScope(async (scope) => {
					const source = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}s_` });
					await seedSource(source, "src", "failing");
					const destPrefix = `${scope.prefix}d_`;
					const destDb = await scope.connect();
					const dest = await SqlSessionStore.open(destDb, { prefix: destPrefix });
					const failure = new Error("source read failed");
					const failing = new Proxy(source, {
						get(target, key) {
							const value = Reflect.get(target, key, target) as unknown;
							if (key === "readEntryChunk") return async () => Promise.reject(failure);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					await assert.rejects(
						stagedClone(failing, "src", dest, header("child", "src")),
						(error) => error === failure,
					);
					assert.equal(await dest.readHeader("child"), undefined);
					assert.equal(await stagedRows(destDb, destPrefix), 0);
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}

const CRASH_FIXTURE = fileURLToPath(new URL("../fixtures/fork-staging-crash.ts", import.meta.url));

type CrashDatabaseConfig =
	| { readonly kind: "sqlite"; readonly path: string }
	| { readonly kind: "libsql"; readonly url: string }
	| { readonly kind: "postgres"; readonly url: string; readonly password?: string };

interface CrashDatabase {
	/** How the crash fixture opens this database itself. */
	readonly config: CrashDatabaseConfig;
	readonly prefix: string;
	connect(): Promise<SqliteDatabase>;
}

/** A database of `backend` that another process can open too, removed with everything opened on it afterwards. */
async function withCrashDatabase(backend: string, body: (database: CrashDatabase) => Promise<void>): Promise<void> {
	const prefix = `k${randomBytes(4).toString("hex")}_`;
	const opened: SqliteDatabase[] = [];
	const tracked = (open: () => Promise<SqliteDatabase>) => async () => {
		const database = await open();
		opened.push(database);
		return database;
	};
	const closeAll = () => Promise.allSettled(opened.splice(0).map((database) => database.close()));
	if (backend === "SQLite file") {
		const directory = makeTempDirectory("atomic-fork-staging-crash-");
		const path = join(directory, "database.sqlite");
		try {
			await body({ config: { kind: "sqlite", path }, prefix, connect: tracked(() => openNodeSqliteDatabase(path)) });
		} finally {
			await closeAll();
			removeTempDirectory(directory);
		}
	} else if (backend === "libSQL server (sqld)") {
		const url = process.env.ATOMIC_TEST_LIBSQL_URL!;
		try {
			await body({ config: { kind: "libsql", url }, prefix, connect: tracked(() => openLibsqlDatabase({ url })) });
		} finally {
			await closeAll();
			const database = await openLibsqlDatabase({ url });
			try {
				await dropLibsqlScope(database, prefix);
			} finally {
				await database.close();
			}
		}
	} else {
		await withPostgresDatabase((scope) =>
			body({
				config: {
					kind: "postgres",
					url: scope.url,
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				},
				prefix,
				connect: () => scope.open(),
			}),
		);
	}
}

/** The first line `child` prints. */
async function firstLine(child: SpawnedProcess): Promise<string> {
	const reader = decodeStream(child.stdout!).getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) break;
			text += next.value;
		}
	} finally {
		reader.releaseLock();
	}
	return text.split("\n")[0]!;
}

/** `store`, whose `method` stops at its `call`th call until released. */
function pausingSource(store: SqlSessionStore, method: "getBlob" | "readEntryChunk", call: number) {
	let calls = 0;
	const stop = gate();
	const paused = new Proxy(store, {
		get(target, key) {
			const value = Reflect.get(target, key, target) as unknown;
			if (key === method && typeof value === "function")
				return async (...args: unknown[]) => {
					if (++calls === call) await stop.wait();
					return Reflect.apply(value, target, args);
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { store: paused, reached: stop.reached, release: stop.release };
}
