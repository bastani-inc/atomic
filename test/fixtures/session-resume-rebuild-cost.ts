import { cpuUsage, resourceUsage } from "node:process";

// Measure in a fresh process: the previous rebuild's allocator high-water mark would hide the next peak.
const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
const { SqlSessionStore } = await import("../../packages/coding-agent/src/core/storage/session/sql-session-store.js");
const [path, mode] = process.argv.slice(2);
const db = await openNodeSqliteDatabase(path!);
try {
	const store = await SqlSessionStore.open(db);
	await db.run("UPDATE session_sessions SET summary_state = '{}' WHERE id = 'session'");
	globalThis.gc?.();
	const before = resourceUsage();
	const start = cpuUsage();
	let toolCalls: number;
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
		toolCalls = rows.reduce((total, row) => total + Number(row.tools), 0);
	} else {
		await store.findLatestCompaction("session");
		const row = await db.get<{ summary_state: string }>("SELECT summary_state FROM session_sessions WHERE id = 'session'");
		toolCalls = JSON.parse(row!.summary_state).resume.totals.toolCalls;
	}
	const cpu = cpuUsage(start);
	console.log(JSON.stringify({
		micros: cpu.system + cpu.user,
		peakBytes: (resourceUsage().maxRSS - before.maxRSS) * 1024,
		toolCalls,
	}));
	await store.close();
} finally {
	await db.close();
}
