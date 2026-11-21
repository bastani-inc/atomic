import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import base from "./storage-adapter.js";

/**
 * #5607: a broker's id-binding writes once `<path>.race` exists. The first, a returning session's claim, is written and
 * never answered. The second, that session's binding write once the claim went unanswered, is written, then reports
 * `.selected` and answers only after `.resume`. Any later one that starts after `.resume` reports `.fresh` and waits
 * for `.allow-fresh` before it is written.
 */
export default {
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		const database = await base.openDatabase(options, context);
		if (context.domain !== "intercom") return database;
		const marker = `${String(options.path)}.race`;
		let writes = 0;
		const transaction = database.transaction.bind(database);
		database.transaction = async (callback, transactionOptions) => {
			const concurrency = transactionOptions?.concurrency;
			const binding = concurrency?.kind === "serial" && concurrency.domain?.endsWith("intercom_session_bindings");
			if (!binding || !existsSync(marker)) return transaction(callback, transactionOptions);
			const write = ++writes;
			if (write > 2 && existsSync(`${marker}.resume`)) {
				writeFileSync(`${marker}.fresh`, "");
				while (!existsSync(`${marker}.allow-fresh`)) await delay(10);
			}
			const result = await transaction(callback, transactionOptions);
			if (write === 1) return new Promise<never>(() => {});
			if (write === 2) {
				writeFileSync(`${marker}.selected`, "");
				while (!existsSync(`${marker}.resume`)) await delay(10);
			}
			return result;
		};
		return database;
	},
} satisfies StorageAdapterModule;
