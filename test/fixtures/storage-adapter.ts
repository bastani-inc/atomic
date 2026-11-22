import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase, wrapNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
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
 * While the file at `gate` exists, every statement fails as one to an unreachable database does: the shared store is
 * down for this broker alone, which keeps running.
 */
function withOutageGate(database: SqliteDatabase, gate: string): SqliteDatabase {
	const down = () => {
		if (existsSync(gate))
			throw new StorageUnavailableError({ adapter: "test-adapter", location: "outage" }, new Error("injected outage"));
	};
	return {
		descriptor: database.descriptor,
		exec: async (sql) => (down(), database.exec(sql)),
		run: async (sql, ...params) => (down(), database.run(sql, ...params)),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			down(), database.get<T>(sql, ...params)
		),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => (
			down(), database.all<T>(sql, ...params)
		),
		transaction: async (callback) => (down(), database.transaction(callback)),
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
 * #5607: stall the broker during the named return address's preferred claim, after SQLite commits. Only this process
 * stops. The client deadline and the service time of a request already issued continue to elapse.
 */
function withIdClaimStall(database: SqliteDatabase, gate: string): SqliteDatabase {
	let nextBindingDelayMs: number | undefined;
	let slowBindings: { address: string; ms: number } | undefined;
	let slowRecord: { address: string; ms: number } | undefined;
	/** A transaction on the bindings, sent by the broker, that the database has not answered yet. */
	let bindingsAnswering: Promise<unknown> | undefined;
	type Named = {
		readonly returnAddress?: unknown;
		readonly stallMs?: unknown;
		readonly overdueCallbackMs?: unknown;
		readonly writeDelayMs?: unknown;
		readonly slowWrite?: unknown;
	};
	const readNamed = (): Named | undefined => {
		try {
			return JSON.parse(readFileSync(gate, "utf8")) as Named;
		} catch {
			return undefined;
		}
	};
	const stall = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	/**
	 * While a broker stalls on its claim and on the callback overdue after it, the other brokers hold off their writes,
	 * as a stall test assumes: the binding write the stalled registration makes then finds the database free, and is under
	 * way before that overdue callback runs. Another broker's write that held the lock just then (a lease renewal, every
	 * few seconds) would make it wait for the lock past that callback, and the registration would miss its client's
	 * deadline by the whole length of that stall.
	 */
	const quiet = `${gate}.quiet`;
	const quietBeyondStallMs = 1_000;
	const holdOffWhileAnotherStalls = async (): Promise<void> => {
		let until: number | undefined;
		try {
			const [pid, at] = readFileSync(quiet, "utf8").split(" ").map(Number);
			if (pid !== process.pid) until = at;
		} catch {
			return;
		}
		if (until !== undefined && until > Date.now()) await delay(until - Date.now());
	};
	/**
	 * #5607 `uncommitted`: the broker stalls while its claim's binding is still being written, and the database holds that
	 * write open for `writeDelayMs`, then refuses it, so the id is never bound by this claim.
	 */
	const holdUncommitted = async (returnAddress: SqliteValue): Promise<void> => {
		const named = readNamed();
		if (named?.slowWrite !== "uncommitted" || named.returnAddress !== returnAddress) return;
		if (typeof named.stallMs !== "number") return;
		rmSync(gate, { force: true });
		writeFileSync(`${gate}.stalled`, `${returnAddress}\n`);
		stall(named.stallMs);
		await delay(typeof named.writeDelayMs === "number" ? named.writeDelayMs : 0);
		throw new Error("injected: the binding was not written");
	};
	const stallIfNamed = async <T>(returnAddress: SqliteValue | undefined, answer: T): Promise<T> => {
		const named = readNamed();
		if (named === undefined) return answer;
		if (returnAddress === undefined || named.returnAddress !== returnAddress || typeof named.stallMs !== "number") {
			return answer;
		}
		rmSync(gate, { force: true });
		writeFileSync(`${gate}.stalled`, `${returnAddress}\n`);
		const { stallMs, overdueCallbackMs } = named;
		writeFileSync(
			quiet,
			`${process.pid} ${Date.now() + stallMs + (typeof overdueCallbackMs === "number" ? overdueCallbackMs : 0) + quietBeyondStallMs}`,
		);
		if (typeof named.writeDelayMs === "number" && typeof returnAddress === "string") {
			if (named.slowWrite === "serial bindings") slowBindings = { address: returnAddress, ms: named.writeDelayMs };
			else if (named.slowWrite === "known session") slowRecord = { address: returnAddress, ms: named.writeDelayMs };
			else nextBindingDelayMs = named.writeDelayMs;
		}
		// Store I/O that became ready during suspension is dispatched after the overdue timers.
		const reply = named.slowWrite === "serial bindings"
			? new Promise<T>((resolve) => setTimeout(() => setImmediate(() => resolve(answer)), 25))
			: new Promise<T>(() => {});
		if (typeof overdueCallbackMs === "number") {
			// Both timers come due during the stall: the claim deadline first, then this unrelated callback before poll. A
			// binding write the broker sent before it that the database is still answering (it waits for the write lock) is
			// answered first, as it is when the lock is free, and the callback comes right after.
			const overdue = () => {
				writeFileSync(quiet, `${process.pid} ${Date.now() + overdueCallbackMs + quietBeyondStallMs}`);
				stall(overdueCallbackMs);
			};
			setTimeout(() => {
				const answering = bindingsAnswering;
				if (answering === undefined) overdue();
				else {
					const after = () => setImmediate(overdue);
					void answering.then(after, after);
				}
			}, stallMs);
		}
		stall(stallMs);
		return reply;
	};
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: async (sql, ...params) => {
			await holdOffWhileAnotherStalls();
			if (slowRecord && /^\s*INSERT INTO \w*intercom_known_sessions\b/u.test(sql) && params[4] === slowRecord.address) {
				const { ms } = slowRecord;
				slowRecord = undefined;
				await delay(ms);
			}
			return database.run(sql, ...params);
		},
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: async (callback, options) => {
			await holdOffWhileAnotherStalls();
			const concurrency = options?.concurrency;
			if (
				nextBindingDelayMs !== undefined &&
				concurrency?.kind === "serial" &&
				concurrency.domain?.endsWith("intercom_session_bindings")
			) {
				// Store service starts at request issue and need not stop just because the broker later stalls.
				const delay = nextBindingDelayMs;
				nextBindingDelayMs = undefined;
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
			}
			let returnAddress: SqliteValue | undefined;
			const answering = database.transaction(
				(tx) =>
					callback({
						exec: (sql) => tx.exec(sql),
						run: async (sql, ...params) => {
							if (/^\s*INSERT INTO \w*intercom_session_bindings\(.*\)\s*VALUES \(\?, \?,/su.test(sql)) {
								returnAddress = params[1];
								await holdUncommitted(returnAddress);
								if (slowBindings && returnAddress === slowBindings.address) await delay(slowBindings.ms);
							}
							return tx.run(sql, ...params);
						},
						get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.get<T>(sql, ...params),
						all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => tx.all<T>(sql, ...params),
					}),
				options,
			);
			if (concurrency?.kind === "serial" && concurrency.domain?.endsWith("intercom_session_bindings"))
				bindingsAnswering = answering;
			let answer: Awaited<typeof answering>;
			try {
				answer = await answering;
			} finally {
				if (bindingsAnswering === answering) bindingsAnswering = undefined;
			}
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
		// A caller-owned connection can complete an uncontended binding before the next overdue broker callback.
		const path = String(options.path);
		const connection = typeof options.idClaimStallGate === "string" ? new (await import("node:sqlite")).DatabaseSync(path) : undefined;
		const database = connection ? wrapNodeSqliteDatabase(connection) : await openNodeSqliteDatabase(path);
		if (connection) {
			const close = database.close.bind(database);
			database.close = async () => {
				try {
					await close();
				} finally {
					connection.close();
				}
			};
		}
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
		const stallable =
			typeof options.idClaimStallGate === "string"
				? withIdClaimStall(reservationGated, options.idClaimStallGate)
				: reservationGated;
		const gated =
			typeof options.outageGate === "string" ? withOutageGate(stallable, options.outageGate) : stallable;
		if (typeof options.callDelayMs === "number") return withCallDelay(gated, options.callDelayMs);
		return gated;
	},
} satisfies StorageAdapterModule & {
	readonly cleanupFailure: StorageUnavailableError;
	readonly cleanupErrorType: typeof StorageUnavailableError;
};
