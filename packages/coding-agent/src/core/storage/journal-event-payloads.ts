import type { SqliteExecutor, SqliteRow, SqliteValue } from "./database.js";
import { StorageError } from "./errors.js";

/**
 * The most bytes of JSON one row holds for a workflow journal event payload, a pool work item's inputs or a pool
 * result. A longer one is stored as rows of at most this many bytes of its UTF-8, written in the transaction that writes
 * it (#4965). Like the session entry chunks it stays well under the smallest backend limit, sqld's 5,000,000 bytes per
 * value and per row, and a chunk read stays under its 10 MB response limit.
 */
export const STORED_JSON_CHUNK_BYTES = 1024 * 1024;

/**
 * The most characters of one top-level field of a large event payload its stub keeps inline. The fields SQL reads from a
 * payload (`kind`, `status`, `workflowId`, `completedAt` and the like) are scalars far below this.
 */
const STUB_FIELD_CHARS = 4096;
/** The most characters of fields a stub keeps besides `worktreeSnapshots`. */
const STUB_CHARS = 64 * 1024;
/** Kept in a stub whatever its size: the snapshot reference index reads it whole. */
const STUB_KEPT_FIELDS: ReadonlySet<string> = new Set(["worktreeSnapshots"]);

/** The UTF-8 chunks of `json` when it is longer than one chunk, or undefined when one row holds it. */
export function storedJsonChunks(json: string): Uint8Array[] | undefined {
	// Every UTF-16 code unit is at most three bytes of UTF-8, so short JSON needs no encoding to be measured.
	if (json.length * 3 <= STORED_JSON_CHUNK_BYTES) return undefined;
	const bytes = Buffer.from(json, "utf8");
	if (bytes.byteLength <= STORED_JSON_CHUNK_BYTES) return undefined;
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += STORED_JSON_CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, offset + STORED_JSON_CHUNK_BYTES));
	}
	return chunks;
}

/**
 * The JSON text of `count` chunks, read one statement each: `sql` selects a chunk's `data` given `params` and the
 * chunk's index as its last parameter. `what` names the value in the error a missing chunk raises.
 */
export async function readStoredJsonChunks(
	executor: SqliteExecutor,
	sql: string,
	params: readonly SqliteValue[],
	count: number,
	what: string,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	for (let index = 0; index < count; index++) {
		const chunk = await executor.get<SqliteRow & { data: Uint8Array }>(sql, ...params, index);
		if (chunk === undefined) throw new StorageError(`${what} is missing chunk ${index} of ${count}`);
		chunks.push(chunk.data);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * What the events row of a payload stored in chunks holds instead of it: the payload's top-level fields that are short,
 * and `worktreeSnapshots` whole, so every SQL that reads a payload's JSON (the snapshot reference index, the run's
 * snapshot tail, status reads) reads the same values from it. A payload that is not an object has `null`.
 */
export function journalPayloadStub(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "null";
	const stub: Record<string, unknown> = {};
	let chars = 0;
	for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
		if (field === undefined) continue;
		if (STUB_KEPT_FIELDS.has(key)) {
			stub[key] = field;
			continue;
		}
		const json = JSON.stringify(field);
		if (json === undefined || json.length > STUB_FIELD_CHARS || chars + json.length > STUB_CHARS) continue;
		chars += json.length;
		stub[key] = field;
	}
	return JSON.stringify(stub);
}

/** A journal event payload as its events row and its chunk rows store it. */
export interface StoredJournalPayload {
	/** The `payload` column: the JSON itself, or its stub when it is stored in chunks. */
	readonly payload: string;
	/** The chunks of the JSON, none when the row holds it. */
	readonly chunks: readonly Uint8Array[];
}

/** How a journal event payload whose JSON is `json` is stored; `value` is the parsed payload, when the caller has it. */
export function storedJournalPayload(json: string, value?: unknown): StoredJournalPayload {
	const chunks = storedJsonChunks(json);
	if (chunks === undefined) return { payload: json, chunks: [] };
	return { payload: journalPayloadStub(value === undefined ? JSON.parse(json) : value), chunks };
}

/**
 * Writes the chunks of the event `seq` of `runId` into `table`, the journal's event chunks table, replacing any that a
 * deleted event with the same sequence left. Nothing for an event stored whole.
 */
export async function writeJournalPayloadChunks(
	tx: SqliteExecutor,
	table: string,
	runId: string,
	seq: number,
	chunks: readonly Uint8Array[],
): Promise<void> {
	if (chunks.length === 0) return;
	await tx.run(`DELETE FROM ${table} WHERE run_id = ? AND seq = ?`, runId, seq);
	for (const [index, data] of chunks.entries())
		await tx.run(`INSERT INTO ${table} (run_id, seq, idx, data) VALUES (?, ?, ?, ?)`, runId, seq, index, data);
}

/** An events row with its payload, and how many chunks hold it (absent or 0: the row holds it). */
export type JournalPayloadRow = SqliteRow & {
	readonly run_id: string;
	readonly seq: number | bigint;
	payload: string;
	chunks?: number | bigint | null;
};

/**
 * `rows` with the payload of each one stored in chunks read from `table`, the journal's event chunks table, and its
 * `chunks` set to 0, so a caller reads every row's payload the same way. Rows stored whole are returned as they are.
 */
export async function withJournalPayloads<Row extends JournalPayloadRow>(
	executor: SqliteExecutor,
	table: string,
	rows: readonly Row[],
): Promise<Row[]> {
	const loaded: Row[] = [];
	for (const row of rows) {
		const count = Number(row.chunks ?? 0);
		if (count === 0) {
			loaded.push(row);
			continue;
		}
		const payload = await readStoredJsonChunks(
			executor,
			`SELECT data FROM ${table} WHERE run_id = ? AND seq = ? AND idx = ?`,
			[row.run_id, Number(row.seq)],
			count,
			`Workflow run ${row.run_id} event ${row.seq}`,
		);
		loaded.push({ ...row, payload, chunks: 0 });
	}
	return loaded;
}
