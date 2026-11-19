import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { InArgs, InStatement } from "@libsql/client";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import base from "./storage-adapter.js";

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		const gate = options.presenceReadGate;
		if (typeof gate !== "string" || context.domain !== "intercom") return base.openDatabase(options, context);
		const database = await openLibsqlDatabase({ url: `file:${String(options.path).replaceAll("\\", "/")}` });
		const { Sqlite3Client } = await import("@libsql/client/sqlite3");
		const original = Sqlite3Client.prototype.execute;
		let delayed = false;
		// Run the actual SELECT. Delay its response inside the broker's shared connection, not before submitting it.
		Sqlite3Client.prototype.execute = async function (statement: InStatement, args?: InArgs) {
			const sql = typeof statement === "string" ? statement : statement.sql;
			const params = typeof statement === "string" ? args : statement.args;
			const result = await original.call(this, sql, params);
			if (
				!delayed && /\bholder_id IS NOT NULL\b/u.test(sql) && Array.isArray(params) && params[0] === "presence" &&
				existsSync(gate) && String(params[1]).includes(readFileSync(gate, "utf8"))
			) {
				delayed = true;
				await delay(12_000); // Longer than the client's unmodified ten-second send deadline.
			}
			return result;
		};
		// Hold only the response to the selected enqueue, after the actual commit releases the SQLite writer.
		const commitGate = `${options.path}.hold-enqueue`;
		const transaction = database.transaction.bind(database);
		database.transaction = async (callback, txOptions) => {
			if (!existsSync(commitGate)) return transaction(callback, txOptions);
			const messageId = readFileSync(commitGate, "utf8");
			let inserted = false;
			const result = await transaction((tx) => {
				const run = tx.run.bind(tx);
				tx.run = (sql, ...params) => {
					if (/\bINSERT INTO \w*intercom_outbox\(/u.test(sql) && params[0] === messageId) inserted = true;
					return run(sql, ...params);
				};
				return callback(tx);
			}, txOptions);
			if (inserted) {
				writeFileSync(`${commitGate}.committed`, "");
				while (existsSync(commitGate)) await delay(10);
			}
			return result;
		};
		const close = database.close.bind(database);
		database.close = async () => {
			Sqlite3Client.prototype.execute = original;
			await close();
		};
		return database;
	},
} satisfies StorageAdapterModule;
