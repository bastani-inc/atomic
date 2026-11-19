import { describe, expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { STORED_JSON_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
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
					const release = observeSqlReads(database, {
						after(rows) {
							const bytes = rows.reduce(
								(total, row) =>
									total +
									Object.values(row).reduce<number>(
										(sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0),
										0,
									),
								0,
							);
							if (bytes > 4 * 1024 * 1024 + Buffer.byteLength(tail) + 128)
								throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
						},
					});
					try {
						const keys: (string | undefined)[] = [];
						for await (const entry of journal.read("run")) keys.push(entry.key);
						expect(keys).toEqual(Array.from({ length: 96 }, (_, i) => `key-${i + 1}${tail}`));
						const byKey = await Array.fromAsync(SqlRunJournal.readKeyRange(journal, "run", "key-", "key."));
						expect(byKey.map((entry) => entry.key)).toEqual([...keys].sort());
					} finally {
						release();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("turns the event loop before retrying a refused event page (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1025)
						INSERT INTO ${runJournalTables(scope.prefix).events}(run_id, seq, epoch, key, type, payload, at, chunks)
						SELECT 'run', i, 1, NULL, 'RunStarted', '{}', i, 0 FROM n`);
					const release = observeSqlReads(database, {
						after(rows) {
							if (rows.length > 128) throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
						},
					});
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
						release();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("after a response refusal does not hydrate chunked events beyond the accepted page (#5537)", async () => {
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
					let chunksRead = 0;
					const release = observeSqlReads(database, {
						after(rows) {
							if (rows.length > 1 && rows.some((row) => "chunks" in row))
								throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
							if (rows[0]?.data instanceof Uint8Array) chunksRead++;
						},
					});
					const iterator = journal.read("run")[Symbol.asyncIterator]();
					try {
						const first = await iterator.next();
						expect(first.done).toBe(false);
						expect(first.value?.seq).toBe(1);
						expect(first.value?.event.payload).toEqual(payload);
						expect(chunksRead).toBe(chunksPerEvent);
					} finally {
						await iterator.return?.();
						release();
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
