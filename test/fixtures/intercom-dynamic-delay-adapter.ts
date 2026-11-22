import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import base from "./storage-adapter.js";

function readDelayMs(delayFile: string): number {
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
			const ms = readDelayMs(delayFile);
			if (ms > 0) await delay(ms);
		};
		const get = database.get.bind(database);
		const all = database.all.bind(database);
		const run = database.run.bind(database);
		const exec = database.exec.bind(database);
		const transaction = database.transaction.bind(database);
		database.get = async <T extends SqliteRow>(sql: string, ...args: readonly SqliteValue[]) => {
			await pause();
			return get<T>(sql, ...args);
		};
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
		return database;
	},
} satisfies StorageAdapterModule;
