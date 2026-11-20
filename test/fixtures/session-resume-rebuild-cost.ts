import { cpuUsage, resourceUsage } from "node:process";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";

// Measure in a fresh process: the previous rebuild's allocator high-water mark would hide the next peak.
const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
const { SqlSessionStore } = await import("../../packages/coding-agent/src/core/storage/session/sql-session-store.js");
const [path, mode] = process.argv.slice(2);

/** The database, plus the number of bytes of column values its reads have handed back to JavaScript. */
function countingReadBytes(database: SqliteDatabase): { database: SqliteDatabase; readBytes: () => number } {
	let readBytes = 0;
	const count = (row: SqliteRow): void => {
		for (const value of Object.values(row)) {
			if (typeof value === "string") readBytes += Buffer.byteLength(value);
			else if (value instanceof Uint8Array) readBytes += value.byteLength;
		}
	};
	const wrap = <T extends SqliteExecutor>(executor: T): T =>
		new Proxy(executor, {
			get(target, key) {
				if (key === "get")
					return async <R extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						const row = await target.get<R>(sql, ...params);
						if (row !== undefined) count(row);
						return row;
					};
				if (key === "all")
					return async <R extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						const rows = await target.all<R>(sql, ...params);
						for (const row of rows) count(row);
						return rows;
					};
				if (key === "transaction")
					return (callback: (tx: SqliteExecutor) => Promise<unknown>, options?: unknown) =>
						(target as unknown as SqliteDatabase).transaction(
							(tx) => callback(wrap(tx)),
							options as Parameters<SqliteDatabase["transaction"]>[1],
						);
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	return { database: wrap(database), readBytes: () => readBytes };
}

const opened = await openNodeSqliteDatabase(path!);
const { database: db, readBytes } = countingReadBytes(opened);
try {
	const store = await SqlSessionStore.open(db);
	await db.run("UPDATE session_sessions SET summary_state = '{}' WHERE id = 'session'");
	globalThis.gc?.();
	const before = resourceUsage();
	const bytesBefore = readBytes();
	const start = cpuUsage();
	let toolCalls: number;
	let operationReadBytes: number;
	if (mode === "joined") {
		// The previous algorithm's ordered join and native metadata projection, on exactly the stored rows.
		// These fixtures need only the tool count; the kept user row has empty content and compaction has none.
		const rows = await db.all<{ tools: number }>(`WITH encoded AS MATERIALIZED (
			SELECT seq,entry_id,chunks,entry_json FROM session_entries WHERE session_id='session' ORDER BY seq LIMIT 512
		), payloads AS MATERIALIZED (
			SELECT seq,entry_id,CASE WHEN chunks=0 THEN entry_json ELSE (SELECT group_concat(text,'') FROM (
				SELECT CAST(data AS TEXT) AS text FROM session_entry_chunks WHERE session_id='session' AND seq=encoded.seq ORDER BY idx
			)) END AS entry_json FROM encoded
		) SELECT seq,entry_id,json_extract(entry_json,'$.parentId'),json_extract(entry_json,'$.timestamp'),
			json_extract(entry_json,'$.message.role'),json_extract(entry_json,'$.message.usage'),
			(SELECT count(*) FROM json_each(json_extract(entry_json,'$.message.content'))
			WHERE json_extract(value,'$.type')='toolCall') AS tools FROM payloads ORDER BY seq`);
		operationReadBytes = readBytes() - bytesBefore;
		toolCalls = rows.reduce((total, row) => total + Number(row.tools), 0);
	} else {
		await store.findLatestCompaction("session");
		operationReadBytes = readBytes() - bytesBefore;
		const row = await db.get<{ summary_state: string }>("SELECT summary_state FROM session_sessions WHERE id = 'session'");
		toolCalls = JSON.parse(row!.summary_state).resume.totals.toolCalls;
	}
	const cpu = cpuUsage(start);
	console.log(JSON.stringify({
		micros: cpu.system + cpu.user,
		peakBytes: (resourceUsage().maxRSS - before.maxRSS) * 1024,
		readBytes: operationReadBytes,
		toolCalls,
	}));
	await store.close();
} finally {
	await opened.close();
}
