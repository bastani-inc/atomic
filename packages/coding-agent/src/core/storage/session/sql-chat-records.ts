import { storageSchemaCurrent } from "../added-exports.js";
import type { SqliteDatabase, SqliteTransactionOptions, SqliteValue } from "../database.js";
import { dialectOf } from "../dialect.js";
import { ensureStorageSchema } from "../migrations.js";
import { withStorageSchemaCatalog } from "../schema-catalog.js";
import {
	type AnchoredChatRecord,
	boundedChatRecord,
	type ChatOrder,
	decodeChatOrder,
	decodeChatRecord,
	encodeChatOrder,
	firstChatOrders,
	type SessionChatRecords,
} from "./chat-records.js";
import { inJsonList } from "./json-list.js";
import { sessionWriteTransaction } from "./session-transactions.js";

/** Rows one read fetches at most. */
const READ_PAGE_ROWS = 64;
/**
 * The stored bytes (anchor and record) one read returns at most, after its first row. With the server's own overhead
 * for 64 rows it stays under a libSQL server configured for 150 KB responses; a capped record is under 25 KB.
 */
const CHAT_READ_PAGE_BYTES = 120_000;
type PageRow = {
	readonly position: number | bigint;
	readonly anchor: string;
	readonly data: string;
	/** Candidate rows before the page was cut to size: fewer than a page's rows, all returned, is the end. */
	readonly fetched: number | bigint | string;
};
/** Prompt ids one reverse lookup binds at most. */
const ORDER_BATCH = 128;
/**
 * The stored keys of a position's records (`L`) and of a prompt's reverse edge (`O`). Entry ids are any text, so only
 * a tag of its own keeps every position's key apart from every prompt's: a reverse lookup never matches a body.
 */
const lineKey = (anchor: string) => `L${anchor}`;
const orderKey = (promptId: string) => `O${promptId}`;

/**
 * The schema's setup runs in a transaction of its own, on the session writer's connection and in its order. A statement
 * outside a transaction would wait for another process's write lock in node:sqlite's busy handler, which blocks the
 * event loop for up to the busy timeout (#5682); a transaction waits for the lock without blocking it. A transient
 * failure runs it again, as one statement outside a transaction would. Each record's write does the same, as a write
 * of its session's rows (`sessionWriteTransaction`).
 */
const SIDE_WRITE: SqliteTransactionOptions = { retryTransientFailures: true };

/** The chat records' name in the storage ledger: `atomic storage migrate` sets them up as the owner role. */
export const SESSION_CHAT_DOMAIN = "session-chat";
/** The revision of the chat records' table and index: raise it whenever their setup creates anything new. */
const SESSION_CHAT_REVISION = 1;

/** Chat records whose table and index `initialize` creates, unless the ledger records them, before the first write. */
export interface SqlSessionChatRecords extends SessionChatRecords {
	initialize(): Promise<void>;
}

/**
 * A new physical table per format version; the main sessions schema (and all its old readers) stay unchanged. `ledger`
 * is the prefix's storage ledger, which records the table and index once set up, so a runtime role without DDL
 * privileges runs no DDL once the owner created them.
 */
export function sqlChatRecords(
	database: SqliteDatabase,
	sessions: string,
	table: string,
	index: string,
	ledger: string,
): SqlSessionChatRecords {
	const dialect = dialectOf(database);
	const schema = { ledger, domain: SESSION_CHAT_DOMAIN, revision: SESSION_CHAT_REVISION };
	let initialized: Promise<void> | undefined;
	function initialize(): Promise<void> {
		const create = async () => {
			// The first record of a process, long after the store opened: a current table is found in one read of the
			// catalog, without a transaction or the database's write lock (#6560).
			if (await withStorageSchemaCatalog(database, ledger, () => storageSchemaCurrent(database, schema))) return;
			await database.transaction(
				(tx) =>
					ensureStorageSchema(tx, dialect, schema, async () => {
						// An earlier build created them on a first record and recorded nothing: found, no DDL runs, which a role
						// without the privilege to create objects in the schema could not run even with IF NOT EXISTS.
						const probe = dialect.schemaObjects([table, index]);
						if ((await tx.all(probe.sql, ...probe.params)).length === 2) return;
						await tx.exec(`CREATE TABLE IF NOT EXISTS ${table} (
				position ${dialect.types.serialKey}, session_id TEXT NOT NULL REFERENCES ${sessions}(id) ON DELETE CASCADE,
				epoch TEXT NOT NULL, anchor TEXT NOT NULL, data TEXT NOT NULL)`);
						await tx.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(session_id, epoch, anchor, position)`);
					}),
				SIDE_WRITE,
			);
		};
		// PostgreSQL fails one of two first diagnostics creating the table together; it then exists for the retry.
		initialized ??= create()
			.catch(() => create())
			.catch((error: Error) => {
				initialized = undefined;
				throw error;
			});
		return initialized;
	}
	const current = dialect.jsonText("summary_state", "epoch");
	const bytes = (column: string) => dialect.textByteLength(column);
	return {
		initialize,
		async append(owner, anchor, record) {
			record = boundedChatRecord(record);
			await initialize();
			const rows: [key: string, data: string][] = [[lineKey(anchor), JSON.stringify({ v: 1, ...record })]];
			// A prompt's reverse edge commits in the same statement as the record it indexes.
			if (record.kind === "promptBefore")
				rows.push([orderKey(record.promptId), encodeChatOrder({ anchor, promptId: record.promptId })]);
			// Use the session writer's own connection and serialization. A replacement with the same public ID
			// cannot accept a delayed record from the old session. No revision or last-modified column is touched.
			await database.transaction(
				(tx) =>
					tx.run(
						`INSERT INTO ${table} (session_id,epoch,anchor,data) ${rows
							.map(() => `SELECT id,?,?,? FROM ${sessions} WHERE id=? AND ${current}=?`)
							.join(" UNION ALL ")}`,
						...rows.flatMap(([key, data]) => [owner.epoch, key, data, owner.id, owner.epoch]),
					),
				sessionWriteTransaction(sessions, owner.id),
			);
		},
		async has(owner) {
			// The table is absent until the first diagnostic. A read-only reopen never installs the schema.
			return !!(await database
				.get(`SELECT 1 AS present FROM ${table} WHERE session_id=? AND epoch=? LIMIT 1`, owner.id, owner.epoch)
				.catch(() => undefined));
		},
		async read(owner, anchors) {
			if (!anchors.length) return [];
			const result: AnchoredChatRecord[] = [];
			let after: SqliteValue = 0;
			for (;;) {
				// Each page is the next rows in order, cut at a size every supported server returns in one response.
				const rows: PageRow[] = await database.all<PageRow>(
					`SELECT position,anchor,data,fetched FROM (
						SELECT position,anchor,data,count(*) OVER () AS fetched,
							row_number() OVER (ORDER BY position) AS page_row,
							sum(${bytes("anchor")}+${bytes("data")}) OVER (ORDER BY position) AS page_bytes
						FROM (SELECT position,anchor,data FROM ${table}
							WHERE session_id=? AND epoch=? AND position>? AND ${inJsonList(dialect, "anchor")}
							ORDER BY position LIMIT ${READ_PAGE_ROWS}) AS candidates
					) AS page WHERE page_row=1 OR page_bytes<=? ORDER BY position`,
					owner.id,
					owner.epoch,
					after,
					JSON.stringify(anchors.map(lineKey)),
					CHAT_READ_PAGE_BYTES,
				);
				for (const { anchor, data } of rows) {
					const record = decodeChatRecord(data);
					if (record) result.push({ anchor: anchor.slice(1), record });
				}
				const last: PageRow | undefined = rows[rows.length - 1];
				if (!last || (Number(last.fetched) < READ_PAGE_ROWS && rows.length === Number(last.fetched))) return result;
				after = last.position;
			}
		},
		async readOrders(owner, promptIds) {
			const orders: ChatOrder[] = [];
			// Only the reverse edges' rows: ids, never a diagnostic body.
			for (let i = 0; i < promptIds.length; i += ORDER_BATCH) {
				const keys = promptIds.slice(i, i + ORDER_BATCH).map(orderKey);
				const rows = await database.all<{ data: string }>(
					`SELECT data FROM ${table} WHERE session_id=? AND epoch=? AND ${inJsonList(dialect, "anchor")} ORDER BY position`,
					owner.id,
					owner.epoch,
					JSON.stringify(keys),
				);
				for (const { data } of rows) {
					const order = decodeChatOrder(data);
					if (order) orders.push(order);
				}
			}
			return firstChatOrders(orders, promptIds);
		},
	};
}
