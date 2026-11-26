// An Atomic writer for writers'-queue tests. It opens the database, prints "ready", waits for a line on stdin, then
// runs `transactions` transactions, `concurrency` at a time, each inserting (label, seq) into `writes` and busy for
// `busyMs` while it holds the lock. It prints one JSON line: its pid, how many committed, the storage errors it got
// (serialized by `serializeStorageError`), and its `getWriterQueueStats`.
//
// Options come as one JSON argument: { label, transactions, concurrency, busyMs, lockWaitMs, clockSkewMs, blobBytes,
// fillDatabase }. `clockSkewMs` shifts this process's wall clock (`Date`), as a process on a host whose clock jumped
// would see it. `fillDatabase` caps the file at its current size, so a growing write fails with SQLITE_FULL.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [path, optionsJson] = process.argv.slice(2);
const options = JSON.parse(optionsJson ?? "{}");
const {
	label = String(process.pid),
	transactions = 1,
	concurrency = 1,
	busyMs = 0,
	lockWaitMs,
	clockSkewMs = 0,
	blobBytes = 0,
	fillDatabase = false,
	mode = "plain",
} = options;

if (clockSkewMs !== 0) {
	const RealDate = Date;
	globalThis.Date = class SkewedDate extends RealDate {
		constructor(...args) {
			super(...(args.length === 0 ? [RealDate.now() + clockSkewMs] : args));
		}
		static now() {
			return RealDate.now() + clockSkewMs;
		}
	};
}

const jiti = createJiti(import.meta.url, { fsCache: false });
const { getWriterQueueStats, openNodeSqliteDatabase } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/node-sqlite.ts", import.meta.url)),
);
const { serializeStorageError } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/errors.ts", import.meta.url)),
);
const { transactionFinisher } = await jiti.import(
	fileURLToPath(new URL("../../packages/coding-agent/src/core/storage/statement-sequence.ts", import.meta.url)),
);
const database = await openNodeSqliteDatabase(path, lockWaitMs === undefined ? {} : { lockWaitMs });
if (fillDatabase) {
	const { page_count } = await database.get("PRAGMA page_count");
	await database.exec(`PRAGMA max_page_count = ${page_count}`);
}
process.stdout.write("ready\n");
await new Promise((resolve) => process.stdin.once("data", resolve));

let committed = 0;
const errors = [];
let next = 0;
async function lane() {
	while (next < transactions) {
		const seq = next++;
		try {
			const payload = blobBytes > 0 ? new Uint8Array(blobBytes) : null;
			const insert = {
				sql: "INSERT INTO writes(writer, seq, payload) VALUES (?, ?, ?)",
				params: [label, seq, payload],
			};
			if (mode === "leadingOnly") {
				await database.transaction(
					async (tx) => {
						await tx.run(insert.sql, ...insert.params);
					},
					{ leading: [insert], leadingOnly: true },
				);
			} else if (mode === "finisher") {
				const read = { sql: "SELECT count(*) AS n FROM writes WHERE writer = ?", params: [label] };
				await database.transaction(
					async (tx) => {
						await tx.get(read.sql, ...read.params);
						const until = performance.now() + busyMs;
						while (performance.now() < until) {
							// Work done while holding the lock.
						}
						if (transactionFinisher(tx)?.([insert]) !== true) await tx.run(insert.sql, ...insert.params);
					},
					{ leading: [read] },
				);
			} else {
				await database.transaction(async (tx) => {
					await tx.run(insert.sql, ...insert.params);
					const until = performance.now() + busyMs;
					while (performance.now() < until) {
						// Work done while holding the lock.
					}
				});
			}
			committed += 1;
		} catch (error) {
			errors.push(serializeStorageError(error));
		}
	}
}
await Promise.all(Array.from({ length: concurrency }, lane));
process.stdout.write(
	`${JSON.stringify({ pid: process.pid, label, committed, errors, stats: getWriterQueueStats(database) })}\n`,
);
await database.close();
