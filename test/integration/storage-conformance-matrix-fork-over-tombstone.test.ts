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

/**
 * Resolves once `operation` has settled or a session of the scope's database waits for a row lock, whichever comes
 * first: the operation then either ran to its end or holds what it locked so far while it waits.
 */
async function settledOrQueued(probe: SqliteDatabase, settled: () => boolean): Promise<void> {
	for (const start = Date.now(); !settled(); ) {
		assert.ok(Date.now() - start < LOCK_WAIT_POLL_MS, "the operation runs or queues for a lock");
		const waiting = await probe.get(
			`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
		);
		if (Number(waiting?.n) > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** `operation`, and whether it has settled yet; its failure is left to whoever awaits it. */
function tracked<T>(operation: Promise<T>): { readonly done: Promise<T>; settled(): boolean } {
	let settled = false;
	const done = operation.finally(() => {
		settled = true;
	});
	done.catch(() => {});
	return { done, settled: () => settled };
}

/** Whether `error`, or an error it was caused by, is PostgreSQL's deadlock_detected. */
function isDeadlock(error: unknown): boolean {
	for (let cause = error, depth = 0; cause instanceof Error && depth < 8; cause = cause.cause, depth++)
		if ((cause as Error & { code?: unknown }).code === "40P01") return true;
	return false;
}

/**
 * `database`, counting the runs of its transactions' callbacks, a transaction run again after a failure counting twice,
 * and the runs a deadlock rolled back.
 */
function countingRuns(database: SqliteDatabase): {
	readonly database: SqliteDatabase;
	runs(): number;
	deadlocks(): number;
} {
	let runs = 0;
	let deadlocks = 0;
	return {
		database: new Proxy(database, {
			get(target, key) {
				if (key !== "transaction") return Reflect.get(target, key, target);
				return (callback: (tx: SqliteExecutor) => Promise<unknown>, options?: SqliteTransactionOptions) =>
					target.transaction(async (tx) => {
						runs++;
						return callback(tx).catch((error: unknown) => {
							if (isDeadlock(error)) deadlocks++;
							throw error;
						});
					}, options);
			},
		}),
		runs: () => runs,
		deadlocks: () => deadlocks,
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

		test(
			"a fork of the deleted session's own fork into its ID reads the fork's history, and keeps it (#6560)",
			() =>
				withScope(async (scope) => {
					const database = await scope.connect();
					const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
					await store.create(header("P"), chain(["p1", "p2", "p3"]));
					await forkWhole(store, "P", "F");
					const head = await store.readEntrySizes("F", 1, 0);
					await store.append("F", chain(["f4"]), { expectSeq: head.lastSeq });
					await store.delete("P");

					await forkWhole(store, "F", "P");

					const expected = ["p1", "p2", "p3", "f4"];
					assert.deepEqual(await texts(store, "P"), expected, "the new P reads the fork's history");
					assert.deepEqual(await texts(store, "F"), expected);
					assert.equal(await tombstones(database, scope.prefix, "P"), 0);
					await store.delete("F");
					assert.deepEqual(await texts(store, "P"), expected, "deleting the fork leaves the new P whole");
				}),
			SERVER_TIMEOUT_MS,
		);
	});

	// Creating over a tombstone locks the tombstone, then the forks that read it, as a fork locks the tombstones among its
	// sources, then their rows: a fork of such a reader never holds what the create waits for while it waits for the
	// create, and no fork adds a reader once the create holds the tombstone.
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
						const forked = tracked(forkWhole(forker, "F", "C"));
						const probe = await scope.connect();
						await settledOrQueued(probe, forked.settled);
						reached.release();
						await Promise.all([created, forked.done]);

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

			test(
				"a reader a fork adds while the create runs, and a fork of that reader, wait for it without a cycle (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const { prefix } = scope;
						const setup = await SqlSessionStore.open(await scope.connect(), { prefix });
						await setup.create(header("P"), chain(["p1", "p2", "p3"]));
						await forkWhole(setup, "P", "F");
						await setup.delete("P");
						await setup.close();

						// The create stops before its first lock of F's row and again before its first of R's: each time, until a
						// fork has run or queues for a lock. A fork of F that commits while the create holds nothing makes R a new
						// reader of P; a fork of R then runs while the create holds what it locked before R.
						const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
						const stops = new Map([
							["F", gate()],
							["R", gate()],
						]);
						const creating = countingRuns(
							instrumented(await scope.connect(), {
								pause: (sql, inTransaction, params) => {
									if (!inTransaction) return undefined;
									for (const [id, stop] of stops)
										if (locksRowForUpdate(sessions, sql, params, id)) {
											stops.delete(id);
											return stop.wait();
										}
									return undefined;
								},
							}),
						);
						const stopF = stops.get("F")!;
						const stopR = stops.get("R")!;
						const forking = countingRuns(await scope.connect());
						const forkingAgain = countingRuns(await scope.connect());
						const creator = await SqlSessionStore.open(creating.database, { prefix });
						const forker = await SqlSessionStore.open(forking.database, { prefix });
						const forkerAgain = await SqlSessionStore.open(forkingAgain.database, { prefix });
						await forker.readEntrySizes("F", 1, 0);
						const runs = () => [creating.runs(), forking.runs(), forkingAgain.runs()];
						const before = runs();
						const probe = await scope.connect();

						const created = tracked(creator.create(header("P"), chain(["new-p1"])));
						await stoppedAt(stopF.reached, created.done, "the create stopping before it locks F's row");
						const forkedF = tracked(forkWhole(forker, "F", "R"));
						await settledOrQueued(probe, forkedF.settled);
						stopF.release();
						// The create reaches R only where R committed before the create's list of P's readers.
						await Promise.race([stopR.reached, created.done.catch(() => {})]);
						let forkedR: ReturnType<typeof tracked> | undefined;
						if (!created.settled()) {
							await forkedF.done;
							forkedR = tracked(forkWhole(forkerAgain, "R", "S"));
							await settledOrQueued(probe, forkedR.settled);
						}
						stopR.release();
						await Promise.all([created.done, forkedF.done]);
						forkedR ??= tracked(forkWhole(forkerAgain, "R", "S"));
						await forkedR.done;

						const after = runs();
						assert.deepEqual(
							after.map((count, index) => count - before[index]!),
							[1, 1, 1],
							"the create and both forks each ran once: no deadlock rolled one back",
						);
						assert.deepEqual(await texts(forker, "P"), ["new-p1"]);
						for (const id of ["F", "R", "S"]) assert.deepEqual(await texts(forker, id), ["p1", "p2", "p3"], id);
						assert.equal(await tombstones(probe, prefix, "P"), 0);
						await forker.delete("F");
						await forker.delete("R");
						assert.deepEqual(await texts(forker, "S"), ["p1", "p2", "p3"], "the last fork reads its own copy");
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);

	// A replace locks the session's row and the rows of the forks reading it in one statement, in id order, as a fork
	// locks its donor's row with the rows of the sessions its segments name: neither waits for the other in a cycle.
	describe.skipIf(backend.skipReason !== undefined || backend.name !== "Postgres")(
		`replacing a session beside a fork of its reader on ${name}`,
		() => {
			test(
				"a fork of a reader that sorts before the session waits for the replace, and each runs once (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const { prefix } = scope;
						const setup = await SqlSessionStore.open(await scope.connect(), { prefix });
						await setup.create(header("D"), chain(["d1", "d2", "d3"]));
						await forkWhole(setup, "D", "B");
						await setup.close();

						const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
						const reached = gate();
						let paused = false;
						// The replace stops before its detach locks B's row, until the fork of B has run or queues for a lock.
						const replacing = countingRuns(
							instrumented(await scope.connect(), {
								pause: (sql, inTransaction, params) => {
									if (paused || !inTransaction || !locksRowForUpdate(sessions, sql, params, "B"))
										return undefined;
									paused = true;
									return reached.wait();
								},
							}),
						);
						const forking = countingRuns(await scope.connect());
						const replacer = await SqlSessionStore.open(replacing.database, { prefix });
						const forker = await SqlSessionStore.open(forking.database, { prefix });
						await replacer.readEntrySizes("D", 1, 0);
						await forker.readEntrySizes("B", 1, 0);
						const before = [replacing.runs(), forking.runs()];

						const replaced = tracked(replacer.replace("D", header("D"), chain(["r1"]), { expectSeq: 3 }));
						await stoppedAt(reached.reached, replaced.done, "the replace stopping before it locks B's row");
						const forked = tracked(forkWhole(forker, "B", "C"));
						const probe = await scope.connect();
						await settledOrQueued(probe, forked.settled);
						reached.release();
						await Promise.all([replaced.done, forked.done]);

						assert.deepEqual(
							[replacing.runs() - before[0]!, forking.runs() - before[1]!],
							[1, 1],
							"the replace and the fork each ran once: no deadlock rolled one back",
						);
						assert.deepEqual(await texts(forker, "D"), ["r1"]);
						assert.deepEqual(await texts(forker, "B"), ["d1", "d2", "d3"]);
						assert.deepEqual(await texts(forker, "C"), ["d1", "d2", "d3"]);
						await forker.delete("B");
						assert.deepEqual(await texts(forker, "C"), ["d1", "d2", "d3"], "the fork's fork reads its own copy");
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a fork of a reader made while the replace waits for its locks is detached too (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const { prefix } = scope;
						const setup = await SqlSessionStore.open(await scope.connect(), { prefix });
						await setup.create(header("D"), chain(["d1", "d2", "d3"]));
						await forkWhole(setup, "D", "B");
						await setup.close();

						// The fork of B stops before its first write, holding B's and D's rows, while the replace queues for them.
						const segments = sessionForkTables(prefix).forkSegments;
						const reached = gate();
						let paused = false;
						const forking = instrumented(await scope.connect(), {
							pause: (sql, inTransaction) => {
								if (paused || !inTransaction || !sql.includes(`INSERT INTO ${segments}`)) return undefined;
								paused = true;
								return reached.wait();
							},
						});
						const replacer = await SqlSessionStore.open(await scope.connect(), { prefix });
						const forker = await SqlSessionStore.open(forking, { prefix });
						await replacer.readEntrySizes("D", 1, 0);
						await forker.readEntrySizes("B", 1, 0);

						const forked = tracked(forkWhole(forker, "B", "C"));
						await stoppedAt(reached.reached, forked.done, "the fork of B stopping before its first write");
						const replaced = tracked(replacer.replace("D", header("D"), chain(["r1"]), { expectSeq: 3 }));
						const probe = await scope.connect();
						await settledOrQueued(probe, replaced.settled);
						reached.release();
						await Promise.all([replaced.done, forked.done]);

						assert.deepEqual(await texts(replacer, "D"), ["r1"]);
						for (const id of ["B", "C"]) assert.deepEqual(await texts(replacer, id), ["d1", "d2", "d3"], id);
						await replacer.delete("B");
						assert.deepEqual(
							await texts(replacer, "C"),
							["d1", "d2", "d3"],
							"the fork made meanwhile holds its own copy",
						);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a fork into the ID of a deleted session its donor read locks that session's readers in order with the donor (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const { prefix } = scope;
						// D reads P's rows and adds one; B, a fork of D that sorts before it, reads both. P is deleted.
						const setup = await SqlSessionStore.open(await scope.connect(), { prefix });
						await setup.create(header("P"), chain(["p1", "p2", "p3"]));
						await forkWhole(setup, "P", "D");
						await setup.append("D", chain(["d4"]), { expectSeq: 3 });
						await forkWhole(setup, "D", "B");
						await setup.delete("P");
						await setup.close();

						const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
						const reached = gate();
						let paused = false;
						// The fork of D into P stops before its detach of B locks B's row, until the replace of D, which locks B
						// and D in id order, has run or queues for a lock.
						const forking = countingRuns(
							instrumented(await scope.connect(), {
								pause: (sql, inTransaction, params) => {
									if (paused || !inTransaction || !locksRowForUpdate(sessions, sql, params, "B"))
										return undefined;
									paused = true;
									return reached.wait();
								},
							}),
						);
						const replacing = countingRuns(await scope.connect());
						const forker = await SqlSessionStore.open(forking.database, { prefix });
						const replacer = await SqlSessionStore.open(replacing.database, { prefix });
						await forker.readEntrySizes("D", 1, 0);
						await replacer.readEntrySizes("D", 1, 0);

						const forked = tracked(forkWhole(forker, "D", "P"));
						await stoppedAt(reached.reached, forked.done, "the fork stopping before it locks B's row");
						const replaced = tracked(replacer.replace("D", header("D"), chain(["r1"]), { expectSeq: 4 }));
						const probe = await scope.connect();
						await settledOrQueued(probe, replaced.settled);
						reached.release();
						await Promise.all([forked.done, replaced.done]);

						assert.deepEqual(
							[forking.deadlocks(), replacing.deadlocks()],
							[0, 0],
							"no deadlock rolled back the fork or the replace",
						);
						const history = ["p1", "p2", "p3", "d4"];
						assert.deepEqual(await texts(forker, "P"), history, "the new P reads D's history as it forked it");
						assert.deepEqual(await texts(forker, "B"), history);
						assert.deepEqual(await texts(forker, "D"), ["r1"]);
						assert.equal(await tombstones(probe, prefix, "P"), 0);
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
