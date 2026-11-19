import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A reservation gate naming `fail:<child>` fails that child's first reservation write in each process, then lets it go. */
const FAIL_ONCE_PREFIX = "fail:";
const failedReservations = new Set<string>();

/**
 * Parks the shared-store write that records a restoring reservation for one child, inside its transaction, until the
 * file at `gate` is removed: the broker that reserves the child has not published the reservation to other brokers. The
 * file names the child; once the adapter has parked the write, it appends the name to `<gate>.parked`, the signal a test
 * waits for. A file naming `fail:<child>` fails the child's first write instead, and appends the name to `<gate>.failed`.
 */
function withReservationGate(database: SqliteDatabase, gate: string): SqliteDatabase {
	const parkIfNamed = async (sql: string, params: readonly SqliteValue[]): Promise<void> => {
		if (!/^\s*INSERT INTO \w*intercom_restoring_reservations\(/u.test(sql)) return;
		let parked = false;
		for (;;) {
			const content = await readFile(gate, "utf8").catch(() => "");
			const failing = content.startsWith(FAIL_ONCE_PREFIX);
			const name = failing ? content.slice(FAIL_ONCE_PREFIX.length) : content;
			if (name === "" || params[4] !== JSON.stringify(name)) return;
			if (failing) {
				if (failedReservations.has(name)) return;
				failedReservations.add(name);
				await appendFile(`${gate}.failed`, `${name}\n`);
				throw new Error(`injected reservation write failure for ${name}`);
			}
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
		run: (sql, ...params) => database.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: (callback) =>
			database.transaction((tx) =>
				callback({
					exec: (sql) => tx.exec(sql),
					run: async (sql, ...params) => (await parkIfNamed(sql, params), tx.run(sql, ...params)),
					get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.get<T>(sql, ...params),
					all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.all<T>(sql, ...params),
				}),
			),
		close: () => database.close(),
	};
}

/**
 * Parks the first read of a presence lease whose key contains the text in the file at `gate`, until the file is removed;
 * later reads go through. Once it has parked the read, it appends the text to `<gate>.parked`, the signal a test waits
 * for.
 */
function withPresenceReadGate(database: SqliteDatabase, gate: string): SqliteDatabase {
	let parked = false;
	const parkIfNamed = async (sql: string, params: readonly SqliteValue[]): Promise<void> => {
		if (parked || params[0] !== "presence" || !/\bholder_id IS NOT NULL\b/u.test(sql)) return;
		const text = await readFile(gate, "utf8").catch(() => "");
		if (text === "" || !String(params[1]).includes(text)) return;
		parked = true;
		await appendFile(`${gate}.parked`, `${text}\n`);
		while ((await readFile(gate, "utf8").catch(() => "")) !== "") {
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
		}
	};
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			await parkIfNamed(sql, params), database.get<T>(sql, ...params)
		),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: (callback) => database.transaction(callback),
		close: () => database.close(),
	};
}

/**
 * #5607: the broker stalls while it claims an id back for the return address named in the file at `gate` (JSON
 * `{ returnAddress, stallMs, overdueCallbackMs? }`). The shared database binds the id but its answer never reaches
 * the broker. After it asks, its event loop does not run for `stallMs`, as on a host that stops scheduling it. Once: the
 * file is removed as it fires, and `<gate>.stalled` names the address.
 */
function withIdClaimStall(database: SqliteDatabase, gate: string): SqliteDatabase {
	const stallIfNamed = async <T>(returnAddress: SqliteValue | undefined, answer: T): Promise<T> => {
		let named: { readonly returnAddress?: unknown; readonly stallMs?: unknown; readonly overdueCallbackMs?: unknown } = {};
		try {
			named = JSON.parse(readFileSync(gate, "utf8")) as typeof named;
		} catch {
			return answer;
		}
		if (returnAddress === undefined || named.returnAddress !== returnAddress || typeof named.stallMs !== "number") {
			return answer;
		}
		rmSync(gate, { force: true });
		writeFileSync(`${gate}.stalled`, `${returnAddress}\n`);
		const stall = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		const { stallMs, overdueCallbackMs } = named;
		if (typeof overdueCallbackMs === "number") {
			// Both timers come due during the stall: the claim deadline first, then this unrelated callback before poll.
			setTimeout(() => stall(overdueCallbackMs), stallMs);
		}
		stall(stallMs);
		return new Promise<T>(() => {});
	};
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: async (callback, options) => {
			let returnAddress: SqliteValue | undefined;
			const answer = await database.transaction(
				(tx) =>
					callback({
						exec: (sql) => tx.exec(sql),
						run: (sql, ...params) => {
							if (/^\s*INSERT INTO \w*intercom_session_bindings\(.*\)\s*VALUES \(\?, \?,/su.test(sql)) {
								returnAddress = params[1];
							}
							return tx.run(sql, ...params);
						},
						get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.get<T>(sql, ...params),
						all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.all<T>(sql, ...params),
					}),
				options,
			);
			return stallIfNamed(returnAddress, answer);
		},
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
		const registrationGated =
			typeof options.registrationGate === "string" ? withRegistrationGate(database, options.registrationGate) : database;
		const presenceGated =
			typeof options.presenceReadGate === "string"
				? withPresenceReadGate(registrationGated, options.presenceReadGate)
				: registrationGated;
		const reservationGated =
			typeof options.reservationGate === "string"
				? withReservationGate(presenceGated, options.reservationGate)
				: presenceGated;
		const gated =
			typeof options.idClaimStallGate === "string"
				? withIdClaimStall(reservationGated, options.idClaimStallGate)
				: reservationGated;
		if (typeof options.callDelayMs === "number") return withCallDelay(gated, options.callDelayMs);
		return gated;
	},
} satisfies StorageAdapterModule & {
	readonly cleanupFailure: StorageUnavailableError;
	readonly cleanupErrorType: typeof StorageUnavailableError;
};
