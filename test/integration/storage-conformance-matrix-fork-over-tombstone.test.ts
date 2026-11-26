import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteTransactionOptions,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	gate,
	header,
	instrumented,
	SERVER_TIMEOUT_MS,
	stagedClone,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A session deleted while forks still read its rows leaves them under a tombstone (#6560). A new session under its ID
 * starts empty however it is made, by `create` or by any fork path: the forks reading the old rows get their own copies
 * first, and the old rows go, so they never show in the new session and their sweep never takes the new session's
 * rows. Runs on every backend of the storage matrix; the interleaving with a fork of a reader runs on Postgres.
 */

useTemporaryAgentDir();

/** How long the Postgres interleaving waits for the fork to queue behind the create's locks. */
const LOCK_WAIT_POLL_MS = 30_000;
/** How long the Postgres interleaving waits for the create to reach the statement it stops before. */
const PAUSE_REACH_MS = 60_000;

/**
 * Whether `sql`, with `params`, locks the row of session `id` in `sessions` for update, whatever form the statement
 * names its rows in: a list of placeholders, or one JSON list (#6644).
 */
function locksRowForUpdate(sessions: string, sql: string, params: readonly unknown[], id: string): boolean {
	if (!sql.includes(`FROM ${sessions} WHERE`) || !/FOR UPDATE/i.test(sql)) return false;
	return params.some(
		(param) =>
			param === id ||
			(typeof param === "string" && param.startsWith("[") && (JSON.parse(param) as unknown[]).includes(id)),
	);
}

/**
 * Resolves once `operation` has stopped at the statement `reached` marks. Fails with what went wrong, never waiting
 * forever, when the operation settles without sending that statement, as after a change to its SQL, or does not reach
 * it within {@link PAUSE_REACH_MS}.
 */
async function stoppedAt(reached: Promise<void>, operation: Promise<unknown>, what: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			reached,
			operation.then(
				() => Promise.reject(new Error(`${what}: it finished without sending that statement`)),
				(error: Error) => Promise.reject(new Error(`${what}: it failed first: ${error.message}`)),
			),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${what}: not reached within ${PAUSE_REACH_MS} ms`)),
					PAUSE_REACH_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Entries with `texts` as their user messages, each the child of the one before. */
function chain(texts: readonly string[]): SessionEntry[] {
	return texts.map((text, index) => user(text, index === 0 ? null : texts[index - 1]!, text, index + 1));
}

/** The user messages of `id`, as a read of the session returns them. */
async function texts(store: SqlSessionStore, id: string): Promise<unknown[]> {
	return (await store.load(id)).entries.map(
		(entry) => (entry as { message?: { content?: unknown } }).message?.content,
	);
}

/** What `forkTo` does for a whole-session fork in one store: `createFork` with the complete feed. */
async function forkWhole(store: SqlSessionStore, sourceId: string, child: string): Promise<void> {
	const head = await store.readEntrySizes(sourceId, 1, 0);
	const created = await store.createFork(
		header(child, sourceId),
		completeSessionForkStream(sourceId, head.epoch, head.lastSeq),
		{ store, sessionId: sourceId, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.ok(created, "the store takes the fork");
}

/** A fork of the entries a caller holds, all of the source's as it read them. */
async function forkHeld(store: SqlSessionStore, sourceId: string, child: string): Promise<void> {
	const head = await store.readEntrySizes(sourceId, 1, 0);
	const { entries } = await store.load(sourceId);
	const created = await store.createFork(header(child, sourceId), entries, {
		store,
		sessionId: sourceId,
		epoch: head.epoch,
		hashes: [],
		receipts: new Map(),
	});
	assert.ok(created, "the store takes the fork");
}

async function tombstones(database: SqliteDatabase, prefix: string, id: string): Promise<number> {
	const row = await database.get(
		`SELECT count(*) AS n FROM ${sessionForkTables(prefix).forkTombstones} WHERE session_id = ?`,
		id,
	);
	return Number(row?.n);
}

/** `database`, counting the runs of its transactions' callbacks: a transaction run again after a failure counts twice. */
function countingRuns(database: SqliteDatabase): { readonly database: SqliteDatabase; runs(): number } {
	let runs = 0;
	return {
		database: new Proxy(database, {
			get(target, key) {
				if (key !== "transaction") return Reflect.get(target, key, target);
				return (callback: (tx: SqliteExecutor) => Promise<unknown>, options?: SqliteTransactionOptions) =>
					target.transaction(async (tx) => {
						runs++;
						return callback(tx);
					}, options);
			},
		}),
		runs: () => runs,
	};
}

/**
 * The ways a new session is made under an ID: `donor` is the session whose entries it starts with, in `store` or, for
 * the staged fork, in `other`, a store with tables of its own.
 */
const paths: readonly {
	readonly name: string;
	readonly make: (store: SqlSessionStore, other: SqlSessionStore, donor: string, child: string) => Promise<void>;
}[] = [
	{
		name: "create",
		make: async (store, _other, donor, child) => {
			await store.create(header(child), (await store.load(donor)).entries);
		},
	},
	{ name: "a fork of the whole session", make: (store, _other, donor, child) => forkWhole(store, donor, child) },
	{
		name: "a fork of the entries a caller holds",
		make: (store, _other, donor, child) => forkHeld(store, donor, child),
	},
	{
		name: "a staged fork from another store",
		make: async (store, other, donor, child) => {
			await stagedClone(other, donor, store, header(child, donor));
		},
	},
];

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`a new session under a deleted session's ID on ${name}`, () => {
		const withScope = (body: (scope: StorageBackendScope) => Promise<void>) => withBackendScope(backend, body);

		for (const path of paths)
			test(
				`made by ${path.name}, it starts empty, and the old rows' sweep leaves it whole (#6560)`,
				() =>
					withScope(async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						const other = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}o_` });
						const donor = path.name.includes("staged") ? other : store;
						await store.create(header("P"), chain(["p1", "p2", "p3"]));
						await donor.create(header("D"), chain(["d1", "d2", "d3", "d4"]));
						await forkWhole(store, "P", "F");
						await store.delete("P");
						assert.equal(await tombstones(database, scope.prefix, "P"), 1, "the fork keeps P's rows");

						await path.make(store, other, "D", "P");
						const head = await store.readEntrySizes("P", 1, 0);
						await store.append("P", chain(["new-p5"]), { expectSeq: head.lastSeq });

						const expected = ["d1", "d2", "d3", "d4", "new-p5"];
						assert.deepEqual(await texts(store, "P"), expected, "the new P reads none of the old P's rows");
						assert.deepEqual(await texts(store, "F"), ["p1", "p2", "p3"], "the fork reads what it read");
						assert.equal(
							await tombstones(database, scope.prefix, "P"),
							0,
							"the old rows went with the tombstone",
						);
						await store.delete("F");
						assert.deepEqual(await texts(store, "P"), expected, "deleting the fork leaves the new P whole");
					}),
				SERVER_TIMEOUT_MS,
			);
	});

	// Creating over a tombstone locks the forks that read it, then the tombstone, as a fork locks its sources' rows, then
	// their tombstones: a fork of such a reader never holds what the create waits for while it waits for the create.
	describe.skipIf(backend.skipReason !== undefined || backend.name !== "Postgres")(
		`creating over a tombstone beside a fork of its reader on ${name}`,
		() => {
			test(
				"neither waits for the other in a cycle, and each runs once (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const { prefix } = scope;
						const setup = await SqlSessionStore.open(await scope.connect(), { prefix });
						await setup.create(header("P"), chain(["p1", "p2", "p3"]));
						await forkWhole(setup, "P", "F");
						await setup.delete("P");
						await setup.close();

						const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
						const reached = gate();
						let paused = false;
						// The create stops before its first lock of the reader's row, until the fork has run or queues for a lock.
						const creating = countingRuns(
							instrumented(await scope.connect(), {
								pause: (sql, inTransaction, params) => {
									if (paused || !inTransaction || !locksRowForUpdate(sessions, sql, params, "F"))
										return undefined;
									paused = true;
									return reached.wait();
								},
							}),
						);
						const forking = countingRuns(await scope.connect());
						const creator = await SqlSessionStore.open(creating.database, { prefix });
						const forker = await SqlSessionStore.open(forking.database, { prefix });
						await forker.readEntrySizes("F", 1, 0);
						const createRuns = creating.runs();
						const forkRuns = forking.runs();

						const created = creator.create(header("P"), chain(["new-p1"]));
						created.catch(() => {});
						await stoppedAt(reached.reached, created, "the create stopping before it locks F's row");
						let forkSettled = false;
						const forked = forkWhole(forker, "F", "C").finally(() => {
							forkSettled = true;
						});
						forked.catch(() => {});
						const probe = await scope.connect();
						for (const start = Date.now(); !forkSettled; ) {
							assert.ok(Date.now() - start < LOCK_WAIT_POLL_MS, "the fork runs or queues for a lock");
							const waiting = await probe.get(
								`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
							);
							if (Number(waiting?.n) > 0) break;
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
						reached.release();
						await Promise.all([created, forked]);

						assert.equal(creating.runs() - createRuns, 1, "the create ran once: no deadlock rolled it back");
						assert.equal(forking.runs() - forkRuns, 1, "the fork ran once: no deadlock rolled it back");
						assert.deepEqual(await texts(forker, "P"), ["new-p1"]);
						assert.deepEqual(await texts(forker, "F"), ["p1", "p2", "p3"]);
						assert.deepEqual(await texts(forker, "C"), ["p1", "p2", "p3"]);
						assert.equal(await tombstones(probe, prefix, "P"), 0);
						await forker.delete("F");
						assert.deepEqual(await texts(forker, "C"), ["p1", "p2", "p3"], "the fork's fork reads its own copy");
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
