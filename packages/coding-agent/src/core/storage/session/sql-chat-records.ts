import type { SqliteDatabase, SqliteValue } from "../database.js";
import { dialectOf } from "../dialect.js";
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
 * The anchor of a prompt's reverse edge. An anchored read never asks for it, and finds no `ChatRecord` in it if an
 * entry id ever spelled the same: the edge's record has a kind of its own.
 */
const orderAnchor = (promptId: string) => `\u001forder\u001f${promptId}`;

/** A new physical table per format version; the main sessions schema (and all its old readers) stay unchanged. */
export function sqlChatRecords(
	database: SqliteDatabase,
	sessions: string,
	table: string,
	index: string,
): SessionChatRecords {
	const dialect = dialectOf(database);
	let initialized: Promise<void> | undefined;
	function initialize(): Promise<void> {
		const create = () =>
			database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			position ${dialect.types.serialKey}, session_id TEXT NOT NULL REFERENCES ${sessions}(id) ON DELETE CASCADE,
			epoch TEXT NOT NULL, anchor TEXT NOT NULL, data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS ${index} ON ${table}(session_id, epoch, anchor, position);`);
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
		async append(owner, anchor, record) {
			record = boundedChatRecord(record);
			await initialize();
			const rows: [anchor: string, data: string][] = [[anchor, JSON.stringify({ v: 1, ...record })]];
			// A prompt's reverse edge commits in the same statement as the record it indexes.
			if (record.kind === "promptBefore")
				rows.push([orderAnchor(record.promptId), encodeChatOrder({ anchor, promptId: record.promptId })]);
			// Use the session writer's own connection and serialization. A replacement with the same public ID
			// cannot accept a delayed record from the old session. No revision or last-modified column is touched.
			await database.run(
				`INSERT INTO ${table} (session_id,epoch,anchor,data) ${rows
					.map(() => `SELECT id,?,?,? FROM ${sessions} WHERE id=? AND ${current}=?`)
					.join(" UNION ALL ")}`,
				...rows.flatMap(([key, data]) => [owner.epoch, key, data, owner.id, owner.epoch]),
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
							WHERE session_id=? AND epoch=? AND position>? AND anchor IN (${anchors.map(() => "?").join(",")})
							ORDER BY position LIMIT ${READ_PAGE_ROWS}) AS candidates
					) AS page WHERE page_row=1 OR page_bytes<=? ORDER BY position`,
					owner.id,
					owner.epoch,
					after,
					...anchors,
					CHAT_READ_PAGE_BYTES,
				);
				for (const { anchor, data } of rows) {
					const record = decodeChatRecord(data);
					if (record) result.push({ anchor, record });
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
				const keys = promptIds.slice(i, i + ORDER_BATCH).map(orderAnchor);
				const rows = await database.all<{ data: string }>(
					`SELECT data FROM ${table} WHERE session_id=? AND epoch=? AND anchor IN (${keys.map(() => "?").join(",")}) ORDER BY position`,
					owner.id,
					owner.epoch,
					...keys,
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
