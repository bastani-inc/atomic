import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

/**
 * Parks the ended-child queue's `load()` size scan (`SELECT seq, bytes FROM ...intercom_ended_child_queue`) while the
 * file at `gate` contains `"closed"`, after appending `"parked\n"` to `<gate>.parked`. Removing the file or writing
 * anything else lets `load()` proceed, so tests can deterministically run registrations, presence renames, and live
 * sends while the restarted broker is in `loading` before `restoreEndedQueue` executes.
 */
function withEndedQueueLoadGate(database: SqliteDatabase, gate: string): SqliteDatabase {
	let parkedOnce = false;
	const maybePark = async (sql: string): Promise<void> => {
		if (
			parkedOnce ||
			!sql.trimStart().startsWith("SELECT seq, bytes FROM ") ||
			!sql.includes("intercom_ended_child_queue")
		) {
			return;
		}
		const initial = await readFile(gate, "utf8").catch(() => "");
		if (initial.trim() !== "closed") return;
		parkedOnce = true;
		await appendFile(`${gate}.parked`, "parked\n");
		for (;;) {
			const state = await readFile(gate, "utf8").catch(() => "");
			if (state.trim() !== "closed") return;
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
		}
	};
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await maybePark(sql), database.all<T>(sql, ...params)
		),
		transaction: (callback, options) => {
			if (options?.readOnly === true) {
				// Run read-only queries without holding the single-connection write-transaction mutex while parked.
				return callback({
					exec: (sql) => database.exec(sql),
					run: (sql, ...params) => database.run(sql, ...params),
					get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
					all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
						await maybePark(sql), database.all<T>(sql, ...params)
					),
				});
			}
			return database.transaction(callback, options);
		},
		close: () => database.close(),
	};
}

export default {
	atomicStorageAdapter: 1,
	async openDatabase(options) {
		assert.equal(typeof options.path, "string");
		const database = await openNodeSqliteDatabase(String(options.path));
		if (typeof options.loadGate === "string") return withEndedQueueLoadGate(database, options.loadGate);
		return database;
	},
} satisfies StorageAdapterModule;
