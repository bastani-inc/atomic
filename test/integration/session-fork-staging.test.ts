import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { copySessionBlobs, sessionBlobHashes } from "../../packages/coding-agent/src/core/session-tool-output.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import {
	ensureForkStagingTable,
	FORK_STAGING_BATCH_BYTES,
	FORK_STAGING_CLEANUP_ROWS,
	FORK_STAGING_OPEN_CLEANUPS,
} from "../../packages/coding-agent/src/core/storage/session/fork-staging.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import {
	decodeStream,
	makeTempDirectory,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";
import { dropLibsqlScope, type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";

/**
 * A full-session clone between SQL handles whose physical identity cannot be proven goes through the fork staging
 * table (#5594): pages are read from the source and released before they are written, the child is published in one
 * transaction, and what a stopped clone left is removed. Runs on every backend of the storage matrix; a server backend
 * runs when its URL is set (see test/helpers/storage-backends.ts).
 */

const SERVER_TIMEOUT_MS = 240_000;
/** How long a clone that must not deadlock may take before it counts as stuck. */
const CLONE_BOUND_MS = 90_000;
const CREATED = "2026-11-19T00:00:00.000Z";
const BIG_TEXT_BYTES = SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2;
const BIG_BLOB_BYTES = 2 * SESSION_BLOB_CHUNK_BYTES + 12_345;
const SNAPSHOT_WARNING_BYTES = SESSION_ENTRY_CHUNK_BYTES + 200_000;
/** A blob larger than one staging batch. */
const BEYOND_ONE_BATCH = FORK_STAGING_BATCH_BYTES + SESSION_BLOB_CHUNK_BYTES + 7;

function header(id: string, parent?: string): SessionRecordHeader {
	return {
		id,
		version: SESSION_FORMAT_VERSION,
		createdAt: CREATED,
		cwd: "/project",
		...(parent === undefined ? {} : { parentSessionId: parent }),
	};
}

function at(second: number): string {
	return new Date(Date.parse(CREATED) + second * 1_000).toISOString();
}

function user(id: string, parentId: string | null, text: string, second: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(second),
		message: { role: "user", content: text, timestamp: Date.parse(at(second)) },
	} as SessionEntry;
}

function assistant(id: string, parentId: string, text: string, second: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(second),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: Date.parse(at(second)),
		},
	} as SessionEntry;
}

function toolOutput(id: string, parentId: string, hash: string, bytes: number, second: number): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: at(second),
		customType: "atomic.tool-output",
		data: { toolCallId: `call-${id}`, hash, bytes },
	} as SessionEntry;
}

function bytesOf(length: number, seed: number): Uint8Array {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) data[i] = (i * 31 + seed) & 0xff;
	return data;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * A session with every shape a clone must keep byte for byte: entries stored whole and in chunks, an oversized
 * snapshot entry stored whole, a branch and a compaction whose links the resume index resolves, a label, a name, and
 * tool outputs whose blobs span several chunks, are empty, or are no longer stored.
 */
async function seedSource(
	store: SessionStore,
	id: string,
	word: string,
	bigBlobBytes = BIG_BLOB_BYTES,
): Promise<{ readonly missing: string }> {
	await store.create(header(id), [user("e1", null, `hello ${word}`, 1)]);
	const big = await store.putBlob!(id, bytesOf(bigBlobBytes, 7));
	const small = await store.putBlob!(id, bytesOf(100, 9));
	const empty = await store.putBlob!(id, new Uint8Array(0));
	const missing = sha256(`not stored ${word}`);
	const entries: SessionEntry[] = [
		assistant("e2", "e1", `hi ${word}`, 2),
		user("e3", "e2", `${word}-big ${"x".repeat(BIG_TEXT_BYTES)}`, 3),
		toolOutput("e4", "e3", big.hash, big.bytes, 4),
		toolOutput("e5", "e4", small.hash, small.bytes, 5),
		toolOutput("e6", "e5", empty.hash, empty.bytes, 6),
		toolOutput("e7", "e6", missing, 10, 7),
		{ type: "label", id: "e8", parentId: "e7", timestamp: at(8), targetId: "e2", label: "mark" } as SessionEntry,
		user("e9", "e1", `branch ${word}`, 9),
		{ type: "session_info", id: "e10", parentId: "e9", timestamp: at(10), name: `staged ${word}` } as SessionEntry,
		{
			type: "worktree_snapshot",
			id: "e11",
			parentId: "e10",
			timestamp: at(11),
			root: "/project",
			snapshotId: `snap-${word}`,
			restoreWarnings: [{ kind: "note", detail: "w".repeat(SNAPSHOT_WARNING_BYTES) }],
		} as unknown as SessionEntry,
		{
			type: "compaction",
			id: "e12",
			parentId: "e11",
			timestamp: at(12),
			summary: `compacted ${word}`,
			firstKeptEntryId: "e9",
			tokensBefore: 42,
		} as SessionEntry,
		assistant("e13", "e12", `after ${word}`, 13),
	];
	await store.append(id, entries, { expectSeq: 1 });
	return { missing };
}

/** What the staged path of `createFork` does for a complete-session feed, then `createForkArchive`'s blob copy. */
async function stagedClone(source: SessionStore, sourceId: string, dest: SqlSessionStore, child: SessionRecordHeader) {
	const head = await source.readEntrySizes!(sourceId, 1, 0);
	const missing: string[] = [];
	const stream = completeSessionForkStream(sourceId, head.epoch, head.lastSeq);
	assert.equal(stream.kind, "complete-session");
	const created = await dest.createStagedFork(child, stream, {
		store: source,
		sessionId: sourceId,
		epoch: head.epoch,
		hashes: [],
		receipts: new Map(),
	});
	if (created.remainingBlobs.length > 0)
		await copySessionBlobs(source, sourceId, dest, child.id, created.remainingBlobs, {
			onMissingBlob: (error) => missing.push(String(error.message)),
		});
	return { created, missing };
}

/** Main's `forkTo`: the whole source loaded, created in the destination, then its blobs copied one at a time. */
async function mainClone(source: SessionStore, sourceId: string, dest: SessionStore, child: SessionRecordHeader) {
	const { entries } = await source.load(sourceId);
	await dest.create(child, entries);
	const missing: string[] = [];
	await copySessionBlobs(source, sourceId, dest, child.id, sessionBlobHashes(source, entries), {
		onMissingBlob: (error) => missing.push(String(error.message)),
	});
	return { missing };
}

const int = (value: SqliteValue) => (value === null ? null : Number(value));
const digest = (value: SqliteValue) => sha256(value as Uint8Array);

/** Every stored row of `id`, normalized only where each write picks a fresh random generation. */
async function stored(database: SqliteDatabase, prefix: string, id: string) {
	const t = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);
	const session = await database.get(
		`SELECT cwd, created_at, header_json, internal, last_seq, modified_at, message_count, first_message, name, has_name, summary, summarized_through_id, summary_state FROM ${t.sessions} WHERE id = ?`,
		id,
	);
	assert.ok(session, `session ${id} exists`);
	const { epoch: _epoch, ...state } = JSON.parse(String(session.summary_state)) as Record<string, unknown> & {
		resume?: Record<string, unknown>;
	};
	if (state.resume !== undefined) {
		const { epoch: _resumeEpoch, ...resume } = state.resume;
		state.resume = resume;
	}
	return {
		session: {
			...session,
			internal: int(session.internal!),
			last_seq: int(session.last_seq!),
			message_count: int(session.message_count!),
			has_name: int(session.has_name!),
			summary_state: state,
		},
		entries: (
			await database.all(
				`SELECT seq, entry_id, entry_json, chunks FROM ${t.entries} WHERE session_id = ? ORDER BY seq`,
				id,
			)
		).map((row) => ({
			seq: int(row.seq!),
			entry_id: row.entry_id,
			entry_json: row.entry_json,
			chunks: int(row.chunks!),
		})),
		entryChunks: (
			await database.all(`SELECT seq, idx, data FROM ${t.entryChunks} WHERE session_id = ? ORDER BY seq, idx`, id)
		).map((row) => ({ seq: int(row.seq!), idx: int(row.idx!), data: digest(row.data!) })),
		searchTexts: (
			await database.all(`SELECT seq, text_json FROM ${t.searchTexts} WHERE session_id = ? ORDER BY seq`, id)
		).map((row) => ({ ...row, seq: int(row.seq!) })),
		blobs: (
			await database.all(`SELECT hash, bytes, chunks FROM ${t.blobs} WHERE session_id = ? ORDER BY hash`, id)
		).map((row) => ({ ...row, bytes: int(row.bytes!), chunks: int(row.chunks!) })),
		blobChunks: (
			await database.all(`SELECT hash, idx, data FROM ${t.blobChunks} WHERE session_id = ? ORDER BY hash, idx`, id)
		).map((row) => ({ hash: row.hash, idx: int(row.idx!), data: digest(row.data!) })),
		meta: (await database.all(`SELECT schema_version FROM ${t.meta}`)).map((row) => int(row.schema_version!)),
	};
}

function stagingTable(prefix: string): string {
	return renderStorageIdentifiers("sessions", { forkStaging: "fork_staging" }, prefix).forkStaging;
}

async function stagedRows(database: SqliteDatabase, prefix: string): Promise<number> {
	const table = stagingTable(prefix);
	const row = await database.get(`SELECT count(*) AS n FROM ${table}`);
	return Number(row!.n);
}

async function listedIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
	return ids.sort();
}

function within<T>(promise: Promise<T>, what: string, ms = CLONE_BOUND_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** Which named handle holds a transaction open, and every statement that started on another handle meanwhile. */
interface Ledger {
	readonly open: Map<string, number>;
	readonly overlaps: string[];
	recording: boolean;
}

/**
 * `database` as one handle a store opens: with `ledger`, records a statement or transaction that starts while another
 * handle holds a transaction open, which on one queued connection would wait on itself; with `pause`, a statement
 * first waits for what `pause` returns for its SQL and whether it runs inside a transaction.
 */
function instrumented(
	database: SqliteDatabase,
	options: {
		readonly name?: string;
		readonly ledger?: Ledger;
		readonly pause?: (sql: string, inTransaction: boolean, params: readonly unknown[]) => Promise<void> | undefined;
	},
): SqliteDatabase {
	const { name = "", ledger, pause } = options;
	const enter = (what: string) => {
		if (ledger?.recording !== true) return;
		for (const [other, open] of ledger.open)
			if (other !== name && open > 0) ledger.overlaps.push(`${name} ${what} inside ${other}`);
	};
	const statements = <E extends SqliteExecutor>(executor: E, inTransaction: boolean) =>
		new Proxy(executor, {
			get(target, key) {
				const value = Reflect.get(target, key, target) as unknown;
				if (typeof value !== "function") return value;
				if (key === "get" || key === "all" || key === "run" || key === "exec")
					return async (...args: unknown[]) => {
						enter(`${String(key)} ${String(args[0]).slice(0, 60)}`);
						const wait = pause?.(String(args[0]), inTransaction, args.slice(1));
						if (wait !== undefined) await wait;
						return Reflect.apply(value, target, args);
					};
				return value.bind(target);
			},
		});
	const outer = statements(database, false);
	return new Proxy(outer, {
		get(target, key) {
			if (key !== "transaction") return Reflect.get(target, key, target);
			return (callback: (tx: SqliteExecutor) => Promise<unknown>, transactionOptions?: object) => {
				enter("transaction");
				return database.transaction(async (tx) => {
					ledger?.open.set(name, (ledger.open.get(name) ?? 0) + 1);
					try {
						return await callback(statements(tx, true));
					} finally {
						ledger?.open.set(name, ledger.open.get(name)! - 1);
					}
				}, transactionOptions);
			};
		},
	}) as SqliteDatabase;
}

/** A gate: `reached` once something waits on it, which goes on once `release` is called. */
function gate() {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return {
		reached,
		release,
		wait: () => {
			reach();
			return released;
		},
	};
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`fork staging on ${name} (#5594)`, () => {
		const withScope = async (body: (scope: StorageBackendScope) => Promise<void>) => {
			const scope = await backend.openScope();
			try {
				await body(scope);
			} finally {
				await scope.close();
			}
		};

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

					// Its process stopped: the lease lapses, and the next open removes the rows.
					await destDb.run(`UPDATE ${stagingTable(destPrefix)} SET size = 0 WHERE kind = 0`);
					await (await SqlSessionStore.open(await scope.connect(), { prefix: destPrefix })).close();
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

					// Once the lease lapsed, the next open removes them, and nothing of the child was ever published.
					await destDb.run(`UPDATE ${stagingTable(destPrefix)} SET size = 0 WHERE kind = 0`);
					await (await SqlSessionStore.open(await target.connect(), { prefix: destPrefix })).close();
					assert.equal(await stagedRows(destDb, destPrefix), 0);
					assert.equal(await dest.readHeader("child"), undefined);
					assert.deepEqual(await listedIds(dest), []);
				}),
			SERVER_TIMEOUT_MS,
		);

		test(
			"each open removes a bounded share of a stopped clone's rows and never a live clone's",
			() =>
				withScope(async (scope) => {
					const destPrefix = `${scope.prefix}d_`;
					const database = await scope.connect();
					await (await SqlSessionStore.open(database, { prefix: destPrefix })).close();
					const table = stagingTable(destPrefix);
					await ensureForkStagingTable(database, dialectOf(database), table);
					const rows = 3 * FORK_STAGING_OPEN_CLEANUPS * FORK_STAGING_CLEANUP_ROWS;
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
					let opens = 0;
					for (let before = await left("stopped"); before > 0; opens++) {
						await (await SqlSessionStore.open(await scope.connect(), { prefix: destPrefix })).close();
						const after = await left("stopped");
						assert.ok(after < before, "every open makes progress");
						assert.ok(
							before - after <= FORK_STAGING_OPEN_CLEANUPS * FORK_STAGING_CLEANUP_ROWS,
							`one open removed ${before - after} rows`,
						);
						before = after;
					}
					assert.ok(opens > 1, `the cleanup took ${opens} opens`);
					assert.equal(await left("live"), rows + 1, "a clone whose lease runs keeps every row");
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

/** The first summary a store lists. */
async function firstSummary(store: SessionStore) {
	for await (const summary of store.list({ includeInternal: true })) return summary;
	return undefined;
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
