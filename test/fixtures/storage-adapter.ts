import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { StorageAdapterModule } from "../../packages/coding-agent/src/core/storage/provider.js";

const cleanupFailure = new StorageUnavailableError(
	{ adapter: "test-adapter", location: "cleanup" },
	new Error("injected-close-failure"),
);

/** A database whose every call first waits `ms` on a timer, so each crosses a macrotask as a remote database's would. */
function withCallDelay(database: SqliteDatabase, ms: number): SqliteDatabase {
	const pause = () => new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));
	return {
		descriptor: database.descriptor,
		exec: async (sql) => (await pause(), database.exec(sql)),
		run: async (sql, ...params) => (await pause(), database.run(sql, ...params)),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await pause(), database.get<T>(sql, ...params)
		),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await pause(), database.all<T>(sql, ...params)
		),
		transaction: async (callback) => (await pause(), database.transaction(callback)),
		close: () => database.close(),
	};
}

/**
 * Parks the write that records one session's registration, which is the first shared-store call the broker makes for
 * it: the broker has taken the registration and cannot answer it until the write returns. The file at `gate` names
 * the session to park (its registered name); once the adapter has parked it, it appends the name to `<gate>.parked`,
 * the signal a test waits for. Removing the file lets the write go.
 */
function withRegistrationGate(database: SqliteDatabase, gate: string): SqliteDatabase {
	const parkIfNamed = async (sql: string, params: readonly SqliteValue[]): Promise<void> => {
		if (!/^\s*INSERT INTO \w*intercom_known_sessions\b/u.test(sql)) return;
		let parked = false;
		for (;;) {
			const name = await readFile(gate, "utf8").catch(() => "");
			if (name === "" || params[2] !== JSON.stringify(name)) return;
			if (!parked) {
				parked = true;
				await appendFile(`${gate}.parked`, `${name}\n`);
			}
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
		}
	};
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: async (sql, ...params) => (await parkIfNamed(sql, params), database.run(sql, ...params)),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: (callback) => database.transaction(callback),
		close: () => database.close(),
	};
}

/**
 * Holds the Intercom broker's opening (domain "intercom") on the file at `gate`: missing, it waits; `fail`, the
 * opening fails; `open`, it proceeds.
 */
async function passStorageOpenGate(gate: string): Promise<void> {
	for (;;) {
		const state = await readFile(gate, "utf8").catch(() => "");
		if (state === "open") return;
		if (state === "fail") throw new Error("injected storage opening failure");
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
	}
}

export default {
	atomicStorageAdapter: 1,
	cleanupFailure,
	cleanupErrorType: StorageUnavailableError,
	async openDatabase(options, context) {
		assert.equal(typeof options.path, "string");
		if (typeof options.openGate === "string" && context.domain === "intercom") {
			await passStorageOpenGate(options.openGate);
		}
		const database = await openNodeSqliteDatabase(String(options.path));
		await database.exec("CREATE TABLE IF NOT EXISTS adapter_probe (options TEXT, domain TEXT)");
		await database.run("INSERT INTO adapter_probe VALUES (?, ?)", JSON.stringify(options), context.domain);
		if (typeof options.lifecycle === "string") {
			await appendFile(options.lifecycle, "open\n");
			const close = database.close.bind(database);
			database.close = async () => {
				await close();
				await appendFile(String(options.lifecycle), "close\n");
				if (options.closeFailure === true) {
					throw cleanupFailure;
				}
			};
		}
		const gated =
			typeof options.registrationGate === "string" ? withRegistrationGate(database, options.registrationGate) : database;
		if (typeof options.callDelayMs === "number") return withCallDelay(gated, options.callDelayMs);
		return gated;
	},
} satisfies StorageAdapterModule & {
	readonly cleanupFailure: StorageUnavailableError;
	readonly cleanupErrorType: typeof StorageUnavailableError;
};
