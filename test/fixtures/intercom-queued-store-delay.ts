import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import base from "./storage-adapter.js";

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		const gate = options.presenceReadGate;
		if (typeof gate !== "string" || context.domain !== "intercom") return base.openDatabase(options, context);
		const database = await openNodeSqliteDatabase(String(options.path));
		let delayed = false;
		// Run the actual SELECT, then delay its answer: the read has seen the database, and the broker waits for it.
		const delayAnswer = async <T>(sql: string, params: readonly SqliteValue[], answer: T): Promise<T> => {
			if (
				!delayed &&
				/\bholder_id IS NOT NULL\b/u.test(sql) &&
				params[0] === "presence" &&
				existsSync(gate) &&
				String(params[1]).includes(readFileSync(gate, "utf8"))
			) {
				delayed = true;
				await delay(12_000); // Longer than the client's unmodified ten-second send deadline.
			}
			return answer;
		};
		const delayedReads = <E extends SqliteExecutor>(executor: E): E => {
			const get = executor.get.bind(executor);
			const all = executor.all.bind(executor);
			executor.get = async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				delayAnswer(sql, params, await get<T>(sql, ...params));
			executor.all = async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				delayAnswer(sql, params, await all<T>(sql, ...params));
			return executor;
		};
		delayedReads(database);
		// Hold only the response to the selected enqueue, after the actual commit releases the SQLite writer.
		const commitGate = `${options.path}.hold-enqueue`;
		const transaction = database.transaction.bind(database);
		database.transaction = async (callback, txOptions) => {
			if (!existsSync(commitGate)) return transaction((tx) => callback(delayedReads(tx)), txOptions);
			const messageId = readFileSync(commitGate, "utf8");
			let inserted = false;
			const result = await transaction((tx) => {
				const writes = (sql: string, params: readonly unknown[]) => {
					if (/\bINSERT INTO \w*intercom_outbox\(/u.test(sql) && params[0] === messageId) inserted = true;
				};
				const run = tx.run.bind(tx);
				tx.run = (sql, ...params) => {
					writes(sql, params);
					return run(sql, ...params);
				};
				// The insert of a row for an offline recipient reads the row back from the insert itself (#5607).
				const get = tx.get.bind(tx);
				tx.get = (sql, ...params) => {
					writes(sql, params);
					return get(sql, ...params);
				};
				return callback(delayedReads(tx));
			}, txOptions);
			if (inserted) {
				writeFileSync(`${commitGate}.committed`, "");
				while (existsSync(commitGate)) await delay(10);
			}
			return result;
		};
		return database satisfies SqliteDatabase;
	},
} satisfies StorageAdapterModule;
