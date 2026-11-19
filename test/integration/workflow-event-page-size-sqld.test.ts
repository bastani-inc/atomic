import { describe, expect, it } from "vitest";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { STORED_JSON_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`event page size: ${backend.name}`, () => {
		it("counts large event keys in the response budget (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
					const tail = "x".repeat(128 * 1024);
					await database.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 96)
						INSERT INTO ${runJournalTables(scope.prefix).events}(run_id, seq, epoch, key, type, payload, at, chunks)
						SELECT 'run', i, 1, 'key-' || i || ?, 'RunStarted', '{}', i, 0 FROM n`,
						tail,
					);
					const all = database.all.bind(database);
					database.all = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						const rows = await all<Row>(sql, ...params);
						const bytes = rows.reduce(
							(total, row) =>
								total +
								Object.values(row).reduce<number>(
									(sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0),
									0,
								),
							0,
						);
						expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024 + Buffer.byteLength(tail) + 128);
						return rows;
					};
					try {
						const keys: (string | undefined)[] = [];
						for await (const entry of journal.read("run")) keys.push(entry.key);
						expect(keys).toEqual(Array.from({ length: 96 }, (_, i) => `key-${i + 1}${tail}`));
					} finally {
						database.all = all;
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("turns the event loop between ordinary event pages (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1025)
						INSERT INTO ${runJournalTables(scope.prefix).events}(run_id, seq, epoch, key, type, payload, at, chunks)
						SELECT 'run', i, 1, NULL, 'RunStarted', '{}', i, 0 FROM n`);
					let turns = 0;
					let counting = true;
					let timer: ReturnType<typeof setImmediate>;
					const tick = () => {
						turns++;
						if (counting) timer = setImmediate(tick);
					};
					timer = setImmediate(tick);
					try {
						let entries = 0;
						for await (const _entry of journal.read("run")) entries++;
						expect(entries).toBe(1_025);
						expect(turns).toBeGreaterThan(0);
					} finally {
						counting = false;
						clearImmediate(timer);
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("does not hydrate later chunked events before the first event is consumed (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
					const lease = await journal.acquire("run", "reader");
					if (lease.status !== "acquired") throw new Error("lease not acquired");
					const payload = { inputs: { text: "x".repeat(6 * 1024 * 1024) } };
					await journal.append(lease.lease, { type: "RunStarted", payload });
					await journal.append(lease.lease, { type: "RunStarted", payload });
					const chunksPerEvent = Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / STORED_JSON_CHUNK_BYTES);
					const get = database.get.bind(database);
					let chunksRead = 0;
					database.get = async <Row extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
						const row = await get<Row>(sql, ...params);
						if (row?.data instanceof Uint8Array) chunksRead++;
						return row;
					};
					const iterator = journal.read("run")[Symbol.asyncIterator]();
					try {
						const first = await iterator.next();
						expect(first.done).toBe(false);
						expect(first.value?.seq).toBe(1);
						expect(first.value?.event.payload).toEqual(payload);
						expect(chunksRead).toBe(chunksPerEvent);
					} finally {
						await iterator.return?.();
						database.get = get;
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
