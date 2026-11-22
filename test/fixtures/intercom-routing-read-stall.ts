import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import base from "./storage-adapter.js";

// Stop only the broker: the real client's deadline and the service time of an already issued read keep running.
function stall(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		const database = await base.openDatabase(options, context);
		const get = database.get.bind(database);
		database.get = async <T extends SqliteRow>(sql: string, ...args: readonly SqliteValue[]) => {
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
