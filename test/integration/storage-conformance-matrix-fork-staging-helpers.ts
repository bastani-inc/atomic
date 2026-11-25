import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { copySessionBlobs, sessionBlobHashes } from "../../packages/coding-agent/src/core/session-tool-output.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	type SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import type { StorageBackend, StorageBackendScope } from "../helpers/storage-backends.js";

export const SERVER_TIMEOUT_MS = 240_000;
/** How long a clone that must not deadlock may take before it counts as stuck. */
export const CLONE_BOUND_MS = 90_000;
const CREATED = "2026-11-19T00:00:00.000Z";
const BIG_TEXT_BYTES = SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2;
export const BIG_BLOB_BYTES = 2 * SESSION_BLOB_CHUNK_BYTES + 12_345;
const SNAPSHOT_WARNING_BYTES = SESSION_ENTRY_CHUNK_BYTES + 200_000;

export function header(id: string, parent?: string): SessionRecordHeader {
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

export function user(id: string, parentId: string | null, text: string, second: number): SessionEntry {
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

export function toolOutput(id: string, parentId: string, hash: string, bytes: number, second: number): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: at(second),
		customType: "atomic.tool-output",
		data: { toolCallId: `call-${id}`, hash, bytes },
	} as SessionEntry;
}

export function bytesOf(length: number, seed: number): Uint8Array {
	const data = new Uint8Array(length);
	for (let i = 0; i < length; i++) data[i] = (i * 31 + seed) & 0xff;
	return data;
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * A session with every shape a clone must keep byte for byte: entries stored whole and in chunks, an oversized
 * snapshot entry stored whole, a branch and a compaction whose links the resume index resolves, a label, a name, and
 * tool outputs whose blobs span several chunks, are empty, or are no longer stored.
 */
export async function seedSource(
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
export async function stagedClone(
	source: SessionStore,
	sourceId: string,
	dest: SqlSessionStore,
	child: SessionRecordHeader,
) {
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
export async function mainClone(
	source: SessionStore,
	sourceId: string,
	dest: SessionStore,
	child: SessionRecordHeader,
) {
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
export async function stored(database: SqliteDatabase, prefix: string, id: string) {
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

export function stagingTable(prefix: string): string {
	return renderStorageIdentifiers("sessions", { forkStaging: "fork_staging" }, prefix).forkStaging;
}

export async function stagedRows(database: SqliteDatabase, prefix: string): Promise<number> {
	const table = stagingTable(prefix);
	const row = await database.get(`SELECT count(*) AS n FROM ${table}`);
	return Number(row!.n);
}

export async function listedIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
	return ids.sort();
}

export function within<T>(promise: Promise<T>, what: string, ms = CLONE_BOUND_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** Which named handle holds a transaction open, and every statement that started on another handle meanwhile. */
export interface Ledger {
	readonly open: Map<string, number>;
	readonly overlaps: string[];
	recording: boolean;
}

/**
 * `database` as one handle a store opens: with `ledger`, records a statement or transaction that starts while another
 * handle holds a transaction open, which on one queued connection would wait on itself; with `pause`, a statement
 * first waits for what `pause` returns for its SQL and whether it runs inside a transaction.
 */
export function instrumented(
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
export function gate() {
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

export async function withBackendScope(
	backend: StorageBackend,
	body: (scope: StorageBackendScope) => Promise<void>,
): Promise<void> {
	const scope = await backend.openScope();
	try {
		await body(scope);
	} finally {
		await scope.close();
	}
}
