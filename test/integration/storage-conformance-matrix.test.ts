import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteTransactionOptions,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { sessionWriteTransaction } from "../../packages/coding-agent/src/core/storage/session/session-transactions.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SqlSnapshotBlobStore,
	snapshotIndexTables,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { snapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/env-hash.js";
import { databaseSubject, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { gate, instrumented } from "./storage-conformance-matrix-fork-staging-helpers.js";
import { backendLabel, runnerFor, withSqlSessionStore } from "./storage-conformance-matrix-helpers.js";

/**
 * Every store's behavioural contract on every storage backend (#4793): the database facade and same-handle sessions
 * on a SQLite file, a libSQL server and Postgres. Reopen sessions and Intercom's multi-node routing state run in
 * sibling `storage-conformance-matrix-*.test.ts` files.
 */

useTemporaryAgentDir();

/** Generous for the concurrent rows below, which each run some hundred transactions on a shared server. */
const CONCURRENT_SESSION_WRITES_TIMEOUT_MS = 120_000;

/** A blob of `chunks` chunk rows, its bytes derived from `seed`. */
function chunkedBlob(seed: number, chunks = 2) {
	const data = new Uint8Array(SNAPSHOT_BLOB_CHUNK_BYTES * (chunks - 1) + 500);
	for (let index = 0; index < data.length; index++) data[index] = (index * 7 + seed) % 253;
	return snapshotBlob(data);
}

function customEntry(id: string): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-11-25T00:00:00.000Z", customType: "concurrency" };
}

function sessionHeader(id: string) {
	return { id, version: 4 as const, createdAt: "2026-11-25T00:00:00.000Z", cwd: "/project" };
}

/** `database`, counting the runs of its transactions' callbacks: a transaction run again after a failure counts twice. */
function countingRuns(database: SqliteDatabase): { readonly database: SqliteDatabase; runs(): number } {
	let runs = 0;
	return {
		database: new Proxy(database, {
			get(target, key) {
				if (key !== "transaction") return Reflect.get(target, key, target);
				return (callback: (tx: SqliteExecutor) => Promise<unknown>, options?: SqliteTransactionOptions) =>
					target.transaction(async (tx) => {
						runs++;
						return callback(tx);
					}, options);
			},
		}),
		runs: () => runs,
	};
}

function textEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	} as SessionEntry;
}

/** Appends `entries` to `sessionId` one at a time, taking the session's new end after each conflict; the conflicts. */
async function appendEach(
	store: SqlSessionStore,
	sessionId: string,
	entries: readonly SessionEntry[],
): Promise<number> {
	let conflicts = 0;
	let expectSeq = 0;
	for (const entry of entries) {
		for (;;) {
			try {
				expectSeq = (await store.append(sessionId, [entry], { expectSeq })).lastSeq;
				break;
			} catch (error) {
				if (!(error instanceof SessionConflictError)) throw error;
				conflicts++;
				expectSeq = error.actualSeq;
			}
		}
	}
	return conflicts;
}

for (const backend of storageBackends) {
	const name = backendLabel(backend);
	const run = backend.skipReason === undefined ? test : test.skip;
	registerSqliteDatabaseConformance(runnerFor(backend), `database facade on ${name}`, databaseSubject(backend));

	registerSessionStoreConformance(
		runnerFor(backend, { includeSuite: (suite) => !suite.endsWith(" (reopen)") }),
		`SqlSessionStore on ${name}`,
		withSqlSessionStore(backend),
	);

	run(
		`concurrent snapshot blob puts and refreshes on ${name}, of the same and of different hashes, leave every blob whole (#6560)`,
		async () => {
			const scope = await backend.openScope();
			try {
				// One store per connection, as separate hosts would open the database; opened in turn, as hosts start.
				const stores: SqlSnapshotBlobStore[] = [];
				for (let index = 0; index < 4; index++)
					stores.push(await SqlSnapshotBlobStore.open(await scope.connect(), scope.prefix));
				const encoder = new TextEncoder();
				const shared = [snapshotBlob(encoder.encode("shared by every writer")), chunkedBlob(1)];
				const own = stores.map((_, index) =>
					index === 0 ? chunkedBlob(2) : snapshotBlob(encoder.encode(`writer ${index}'s own`)),
				);
				for (let round = 0; round < 3; round++) {
					const refreshed = await Promise.all(
						stores.flatMap((store, index) => [
							// Each writer lists the shared blobs in its own order.
							store.putBlobs(index % 2 === 0 ? [...shared, own[index]!] : [own[index]!, ...shared].reverse()),
							round === 0 ? Promise.resolve(true) : store.refreshBlobs(shared.map((blob) => blob.hash)),
						]),
					);
					assert.ok(refreshed.every((result) => result !== false));
				}
				const all = [...shared, ...own];
				for (const store of stores)
					for (const blob of all) assert.deepEqual(await store.getBlob(blob.hash), blob.data, blob.hash);
				assert.deepEqual([...(await stores[1]!.listBlobHashes())].sort(), all.map((blob) => blob.hash).sort());
				const chunks = await (await scope.connect()).all<{ hash: string; rows: number }>(
					`SELECT hash, count(*) AS rows FROM ${snapshotIndexTables(scope.prefix).blobChunks} GROUP BY hash ORDER BY hash`,
				);
				assert.deepEqual(
					chunks.map((row) => [row.hash, Number(row.rows)]),
					[shared[1]!.hash, own[0]!.hash].sort().map((hash) => [hash, 2]),
				);
			} finally {
				await scope.close();
			}
		},
		CONCURRENT_SESSION_WRITES_TIMEOUT_MS,
	);

	run(
		`concurrent appends on ${name} keep each session's seqs dense and its loads whole, across sessions and connections`,
		async () => {
			const scope = await backend.openScope();
			try {
				// One store per connection, as separate hosts would open the database.
				const stores = await Promise.all(
					[0, 1, 2].map(async () => SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix })),
				);
				const own = ["own-0", "own-1", "own-2", "own-3", "own-4", "own-5"];
				const shared = ["shared-0", "shared-1"];
				for (const id of [...own, ...shared]) await stores[0]!.create(sessionHeader(id), []);
				const perWriter = 6;
				const entriesOf = (writer: string) =>
					Array.from({ length: perWriter }, (_, index) => customEntry(`${writer}-${index}`));
				let writing = true;
				const observed = new Map<string, { readonly ids: readonly string[]; readonly lastSeq: number }[]>(
					shared.map((id) => [id, []]),
				);
				const loads = stores.map(async (store) => {
					while (writing)
						for (const id of shared) {
							const snapshot = await store.load(id);
							observed
								.get(id)!
								.push({ ids: snapshot.entries.map((entry) => entry.id), lastSeq: snapshot.lastSeq });
						}
				});
				// Each session of its own has one writer, so it never meets a conflict, whatever the other sessions' writers do.
				const ownConflicts = own.map((id, index) => appendEach(stores[index % stores.length]!, id, entriesOf(id)));
				const sharedWriters = shared.flatMap((id) =>
					stores.map((store, index) => appendEach(store, id, entriesOf(`${id}-w${index}`))),
				);
				const settled = await Promise.all([...ownConflicts, ...sharedWriters]);
				writing = false;
				await loads;
				assert.deepEqual(settled.slice(0, own.length), [0, 0, 0, 0, 0, 0]);
				for (const id of own) {
					const range = await stores[1]!.readRange!(id, 1, perWriter);
					assert.deepEqual(range.seqs, [1, 2, 3, 4, 5, 6]);
					assert.deepEqual(
						range.entries.map((entry) => entry.id),
						[0, 1, 2, 3, 4, 5].map((index) => `${id}-${index}`),
					);
				}
				for (const id of shared) {
					const final = await stores[2]!.load(id);
					assert.equal(final.lastSeq, 18);
					const ids = final.entries.map((entry) => entry.id);
					assert.deepEqual(
						[...ids].sort(),
						["w0", "w1", "w2"].flatMap((writer) => entriesOf(`${id}-${writer}`).map((entry) => entry.id)).sort(),
					);
					const range = await stores[0]!.readRange!(id, 1, 18);
					assert.deepEqual(
						range.seqs,
						Array.from({ length: 18 }, (_, index) => index + 1),
					);
					// Every load saw a committed prefix of the final order: as many entries as its end, none of another order.
					for (const load of observed.get(id)!) {
						assert.equal(load.ids.length, load.lastSeq);
						assert.deepEqual(load.ids, ids.slice(0, load.lastSeq));
					}
				}
				for (const store of stores) await store.close();
			} finally {
				await scope.close();
			}
		},
		CONCURRENT_SESSION_WRITES_TIMEOUT_MS,
	);

	if (backend.name === "Postgres")
		run(`a write of one session on ${name} waits for neither other sessions' writes nor loads`, async () => {
			const scope = await backend.openScope();
			try {
				const holder = await scope.connect();
				const [store, other] = await Promise.all(
					[0, 1].map(async () => SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix })),
				);
				for (const id of ["held", "free"]) await store!.create(sessionHeader(id), [customEntry(`${id}-0`)]);
				const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
				let release!: () => void;
				let holding!: () => void;
				const held = new Promise<void>((resolve) => {
					holding = resolve;
				});
				// Another writer of the session "held", stalled with its transaction open.
				const stalled = holder.transaction(
					async () => {
						holding();
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					},
					sessionWriteTransaction(table, "held"),
				);
				await held;
				assert.equal((await store!.append("free", [customEntry("free-1")], { expectSeq: 1 })).lastSeq, 2);
				assert.deepEqual(
					(await store!.load("held")).entries.map((entry) => entry.id),
					["held-0"],
				);
				let appended = false;
				const waiting = other!.append("held", [customEntry("held-1")], { expectSeq: 1 }).then((result) => {
					appended = true;
					return result;
				});
				await new Promise((resolve) => setTimeout(resolve, 300));
				assert.equal(appended, false);
				release();
				await stalled;
				assert.equal((await waiting).lastSeq, 2);
				await store!.close();
				await other!.close();
			} finally {
				await scope.close();
			}
		});

	if (backend.name === "Postgres")
		run(
			`a streamed fork and an append on ${name} take the shared index and schema rows in one order (#6560)`,
			async () => {
				const scope = await backend.openScope();
				try {
					const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
					const sources = `${scope.prefix}snapshot_index_sources`;
					const entriesInsert = new RegExp(`^INSERT INTO ${tables.entries} \\(`);
					const metaUpdate = new RegExp(`^UPDATE ${tables.meta} SET schema_version`);
					const control = await scope.connect();
					const paused = gate();
					let metaSeen = false;
					let entriesSeen = 0;
					let pausing = false;
					// The fork stops right after it took the schema row, before the entries insert that takes the index row
					// next, or before it takes the schema row once every entry is in.
					const forking = countingRuns(
						instrumented(await scope.connect(), {
							pause: (sql, inTransaction) => {
								if (!pausing || !inTransaction) return undefined;
								if (entriesInsert.test(sql)) {
									entriesSeen++;
									if (metaSeen) {
										pausing = false;
										return paused.wait();
									}
								} else if (metaUpdate.test(sql)) {
									// The fork copies the source's rows in one statement for each run of them (#6560).
									if (entriesSeen >= 1) {
										pausing = false;
										return paused.wait();
									}
									metaSeen = true;
								}
								return undefined;
							},
						}),
					);
					const appending = countingRuns(await scope.connect());
					const forker = await SqlSessionStore.open(forking.database, { prefix: scope.prefix });
					const appender = await SqlSessionStore.open(appending.database, { prefix: scope.prefix });
					await SqlSnapshotBlobStore.open(control, scope.prefix);
					const big = "x".repeat(SESSION_ENTRY_CHUNK_BYTES + 1_000);
					await forker.create(sessionHeader("src"), [textEntry("s1", null, "first")]);
					await forker.append("src", [textEntry("s2", "s1", big), textEntry("s3", "s2", "last")], {
						expectSeq: 1,
					});
					await appender.create(sessionHeader("other"), [textEntry("o1", null, "other")]);
					// A database a build before chunked entries wrote, whose snapshot reference index is not complete: an
					// entries insert takes the index's progress row, and a first chunked entry takes the schema row.
					await control.run(`UPDATE ${tables.meta} SET schema_version = 1`);
					await control.run(
						`UPDATE ${sources} SET watermark = 9223372036854775000, backfilled_through = 0 WHERE source = 'session-entries'`,
					);
					const head = await forker.readEntrySizes!("src", 1, 0);
					const runsBefore = { fork: forking.runs(), append: appending.runs() };
					pausing = true;
					const fork = forker.createFork!(
						sessionHeader("child"),
						completeSessionForkStream("src", head.epoch, head.lastSeq),
						{
							store: forker,
							sessionId: "src",
							epoch: head.epoch,
							hashes: [],
							receipts: new Map(),
						},
					);
					fork.catch(() => {});
					await paused.reached;
					// From here an entries insert takes the progress row.
					await control.run(
						`UPDATE ${sources} SET watermark = 0, backfilled_through = -1 WHERE source = 'session-entries'`,
					);
					const append = appender.append("other", [textEntry("o2", "o1", big)], { expectSeq: 1 });
					append.catch(() => {});
					await new Promise((resolve) => setTimeout(resolve, 500));
					paused.release();
					const [forked, appended] = await Promise.all([fork, append]);
					assert.equal(forked?.lastSeq, 3);
					assert.equal(appended.lastSeq, 2);
					// Neither was chosen as a deadlock victim and run again.
					assert.deepEqual(
						{ fork: forking.runs() - runsBefore.fork, append: appending.runs() - runsBefore.append },
						{ fork: 1, append: 1 },
					);
					assert.deepEqual(
						(await appender.load("child")).entries.map((entry) => entry.id),
						["s1", "s2", "s3"],
					);
					await forker.close();
					await appender.close();
				} finally {
					await scope.close();
				}
			},
			CONCURRENT_SESSION_WRITES_TIMEOUT_MS,
		);

	run(`projects an older session's resume state on ${name} without decoding its transcript (#5249)`, async () => {
		const scope = await backend.openScope();
		try {
			const database = await scope.connect();
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			const header = {
				id: "projected",
				version: 4 as const,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: "/project",
			};
			const entries: SessionEntry[] = [
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: header.createdAt,
					provider: "{provider}",
					modelId: "[model]",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "model",
					timestamp: header.createdAt,
					thinkingLevel: "high",
				},
				{
					type: "custom",
					customType: "intercom_session_identity",
					id: "identity",
					parentId: "thinking",
					timestamp: header.createdAt,
					data: { sessionId: header.id },
				},
				{
					type: "custom",
					customType: "atomic-pooled-delivery-op",
					id: "receipt",
					parentId: "identity",
					timestamp: header.createdAt,
					data: { op: "delivered-op" },
				},
				{
					type: "custom_message",
					id: "ask",
					parentId: "receipt",
					timestamp: header.createdAt,
					customType: "intercom_message",
					content: "old body".repeat(500),
					display: true,
					details: { message: { id: "ask-id", expectsReply: true } },
				},
				{
					type: "message",
					id: "kept",
					parentId: "ask",
					timestamp: header.createdAt,
					message: { role: "user", content: "kept", timestamp: 1 },
				},
				{
					type: "compaction",
					id: "boundary",
					parentId: "kept",
					timestamp: header.createdAt,
					summary: "summary",
					tokensBefore: 100,
					firstKeptEntryId: "kept",
					details: { strategy: "verbatim-lines" },
				},
			];
			await store.create(header, entries);
			const expected = await store.readResume(header.id);
			const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
			const row = await database.get<{ summary_state: string }>(
				`SELECT summary_state FROM ${table} WHERE id = ?`,
				header.id,
			);
			const { resume: _resume, ...summary } = JSON.parse(row!.summary_state) as Record<string, unknown>;
			await database.run(`UPDATE ${table} SET summary_state = ? WHERE id = ?`, JSON.stringify(summary), header.id);
			assert.deepEqual(expected.recovery.deliveryOpIds, ["delivered-op"]);
			assert.deepEqual(await store.readResume(header.id), expected);
			await store.close();
		} finally {
			await scope.close();
		}
	});
}
