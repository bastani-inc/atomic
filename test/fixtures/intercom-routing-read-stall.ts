import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import base from "./storage-adapter.js";

// Stop only the broker: the real client's deadline and the service time of an already issued read keep running.
function stall(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readDynamicDelayMs(delayFile: string): number {
	if (!existsSync(delayFile)) return 0;
	const parsed = Number(readFileSync(delayFile, "utf8").trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		const database = await base.openDatabase(options, context);
		const delayFile = `${String(options.path)}.delay`;
		const pause = async () => {
			const ms = readDynamicDelayMs(delayFile);
			if (ms > 0) await delay(ms);
		};
		const get = database.get.bind(database);
		const all = database.all.bind(database);
		const run = database.run.bind(database);
		const exec = database.exec.bind(database);
		const transaction = database.transaction.bind(database);
		database.all = async <T extends SqliteRow>(sql: string, ...args: readonly SqliteValue[]) => {
			await pause();
			return all<T>(sql, ...args);
		};
		database.run = async (sql: string, ...args: readonly SqliteValue[]) => {
			await pause();
			return run(sql, ...args);
		};
		database.exec = async (sql: string) => {
			await pause();
			return exec(sql);
		};
		database.transaction = async (callback, txOptions) => {
			await pause();
			return transaction(callback, txOptions);
		};
		database.get = async <T extends SqliteRow>(sql: string, ...args: readonly SqliteValue[]) => {
			await pause();
			const result = await get<T>(sql, ...args);
			const id = process.env.TEST_STALLED_OUTBOX_ID;
			if (id && args.includes(id) && /\bFROM \w*intercom_outbox WHERE message_id = \?/u.test(sql)) {
				appendFileSync(`${options.path}.reads`, "outbox\n");
				const response = delay(6_100);
				stall(2_200);
				setTimeout(() => stall(2_700), 55);
				await response;
			}
			const question = process.env.TEST_STALLED_REPLY_TO;
			if (question && args.includes(question)) {
				if (/^SELECT 1 AS found FROM \w*intercom_pending_asks WHERE/u.test(sql)) {
					appendFileSync(`${options.path}.reads`, "route\n");
					const response = delay(8_600);
					stall(2_500);
					await response;
				} else if (/^SELECT 1 AS found FROM \w*intercom_settled_asks WHERE/u.test(sql)) {
					appendFileSync(`${options.path}.reads`, "settled\n");
					await delay(3_800);
				}
			}
			return result;
		};
		return database;
	},
} satisfies StorageAdapterModule;
