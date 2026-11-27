import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { VERBATIM_COMPACTION_PROMPT_VERSION } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { adoptSubagentCaptures } from "../../packages/coding-agent/src/core/session-worktree-snapshots.js";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { sleep } from "../helpers/runtime.js";
import { gate, instrumented, within } from "./storage-conformance-matrix-fork-staging-helpers.js";

/** Long enough for a local server to answer a read's pipelined commit before the next count starts. */
const COMMIT_SETTLE_MS = 150;
/** Timeout for multi-connection lock interleaving tests under host load. */
const INTERLEAVING_TIMEOUT_MS = 60_000;
/** Timeout for a concurrent operation that must wait while another connection holds a conflicting lock. */
const BLOCKED_CHECK_MS = 200;

interface PostgresRoute {
	readonly name: string;
	readonly skipReason: string | undefined;
	open(scope: PostgresScope): Promise<SqliteDatabase>;
}

const pgbouncerUrl = process.env.ATOMIC_TEST_PGBOUNCER_URL || undefined;

const postgresRoutes: readonly PostgresRoute[] = [
	{
		name: "direct",
		skipReason: postgresSkipReason,
		open: (scope) => scope.open(),
	},
	{
		name: "through PgBouncer in transaction mode",
		skipReason:
			postgresSkipReason ?? (pgbouncerUrl === undefined ? "ATOMIC_TEST_PGBOUNCER_URL is not set" : undefined),
		open: (scope) => {
			const url = new URL(pgbouncerUrl!);
			url.pathname = `/${scope.name}`;
			return openPostgresDatabase({
				url: url.href,
				...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
			});
		},
	},
];

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

const header = (id: string, parent?: string) => ({
	id,
	version: 4 as const,
	cwd: "/work",
	createdAt: "2026-11-26T00:00:00.000Z",
	...(parent === undefined ? {} : { parentSessionId: parent }),
});

function entries(prefix: string, count: number, parentId: string | null = null): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let i = 1; i <= count; i++) {
		out.push({
			type: "message",
			id: `${prefix}-${i}`,
			parentId: i === 1 ? parentId : `${prefix}-${i - 1}`,
			timestamp: "2026-11-26T00:00:01.000Z",
			message: { role: "user", content: `${prefix} message ${i}`, timestamp: i },
		} as SessionEntry);
	}
	return out;
}

async function clone(store: SqlSessionStore, parent: string, child: string) {
	const head = await store.readEntrySizes(parent, 1, 0);
	const created = await store.createFork(
		header(child, parent),
		completeSessionForkStream(parent, head.epoch, head.lastSeq),
		{ store, sessionId: parent, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.equal(created?.lastSeq, head.lastSeq);
	return created;
}

async function clearStoredResumeIndex(database: SqliteDatabase, sessionId: string, prefix?: string): Promise<void> {
	const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
	await database.run(
		`UPDATE ${sessions} SET summary_state = ((summary_state::jsonb) - 'resume' - 'windowResume')::text WHERE id = ?`,
		sessionId,
	);
}

async function storedResumeSeq(
	database: SqliteDatabase,
	sessionId: string,
	prefix?: string,
): Promise<number | undefined> {
	const sessions = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).sessions;
	const row = await database.get<SqliteRow & { summary_state: string }>(
		`SELECT summary_state FROM ${sessions} WHERE id = ?`,
		sessionId,
	);
	if (row === undefined) return undefined;
	const parsed = JSON.parse(row.summary_state) as { resume?: { seq?: number }; windowResume?: { seq?: number } };
	return parsed.windowResume?.seq ?? parsed.resume?.seq;
}

function isDeadlock(error: unknown): boolean {
	for (let cause = error, depth = 0; cause instanceof Error && depth < 8; cause = cause.cause, depth++)
		if ((cause as Error & { code?: unknown }).code === "40P01") return true;
	return false;
}

function countingDeadlocks(database: SqliteDatabase): {
	readonly database: SqliteDatabase;
	deadlocks(): number;
} {
	let deadlocks = 0;
	return {
		database: new Proxy(database, {
			get(target, key) {
				if (key !== "transaction") {
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
					target.transaction(
						(tx) =>
							callback(tx).catch((error: unknown) => {
								if (isDeadlock(error)) deadlocks++;
								throw error;
							}),
						options as Parameters<SqliteDatabase["transaction"]>[1],
					);
			},
		}),
		deadlocks: () => deadlocks,
	};
}

for (const route of postgresRoutes) {
	describe.skipIf(route.skipReason !== undefined)(
		`PostgreSQL session resume rebuild and read-mode gate round trips (${route.name}) (#6710)`,
		() => {
			test("resume restores a page of active child records in at most twelve round trips (#6795)", async () => {
				await withPostgresDatabase(async (scope) => {
					const store = await SqlSessionStore.open(await route.open(scope));
					try {
						const session = await SessionManager.create(store, "/work");
						const expected = [];
						for (let index = 0; index < 18; index++) {
							const data = {
								version: 1,
								childId: `child-${index}`,
								runId: "run",
								index,
								agent: "worker",
								cwd: "/work",
								owner: { kind: "session", sessionId: session.getSessionId() },
								state: "running",
								taskId: `task-${index}`,
								launch: { task: `preserve input ${index}` },
							};
							const id = await session.appendCustomEntry("subagent-child", data);
							expected.push({ id, data });
						}
						await session.appendCompaction("cleared", null, 10, {
							strategy: "verbatim-lines",
							promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
							parameters: { query: "test" },
							stats: {
								linesBefore: 1,
								linesDeleted: 1,
								linesKept: 0,
								rangeCount: 1,
								tokensBefore: 10,
								tokensAfter: 0,
								percentReduction: 100,
							},
							form: "cleared",
						});
						await SessionManager.open(store, session.getSessionId(), undefined, { history: "tail" });
						await sleep(COMMIT_SETTLE_MS);

						const trips = countRoundTrips();
						const reopened = await SessionManager.open(store, session.getSessionId(), undefined, {
							history: "tail",
						});
						await sleep(COMMIT_SETTLE_MS);
						assert.deepEqual(
							reopened
								.getEntries()
								.flatMap((entry) =>
									entry.type === "custom" && entry.customType === "subagent-child"
										? [{ id: entry.id, data: entry.data }]
										: [],
								),
							expected,
						);
						const count = trips.take();
						assert.ok(count <= 12, `expected <= 12 round trips for 18 active records, got ${count}`);
					} finally {
						await store.close();
					}
				});
			});

			test("resume finds the newest active-branch snapshot across finished children in bounded round trips (#6795)", async () => {
				await withPostgresDatabase(async (scope) => {
					const store = await SqlSessionStore.open(await route.open(scope));
					try {
						const parent = await SessionManager.create(store, "/work");
						for (let index = 0; index < 20; index++) {
							const donorId = `child-capture-${index}`;
							const childSessionId = index === 19 ? "winner-fork" : donorId;
							const root = index === 19 ? "/restored" : "/work";
							const timestamp = new Date(Date.UTC(2026, 10, 26, 0, 0, index)).toISOString();
							const snapshot: WorktreeSnapshot = {
								version: 1,
								id: `snapshot-${index}`,
								root,
								remotes: [],
								branch: null,
								head: "head",
								snapshot: "commit",
								tree: "tree",
								envHash: "env",
								chain: [],
								bundle: null,
								omitted: [],
								filters: null,
								delta: { base: "head", patch: null, bytes: 0 },
								capturedAt: timestamp,
							};
							const abandoned = { ...snapshot, id: `abandoned-${index}` };
							await store.create(header(donorId), [
								...(index === 19
									? [
											{
												type: "worktree_snapshot" as const,
												id: "restored-root",
												parentId: null,
												timestamp,
												root,
												snapshotId: snapshot.id,
												restore: {
													from: "/work",
													to: root,
													snapshotId: snapshot.id,
													tree: "tree",
													restoredAt: timestamp,
												},
											},
										]
									: []),
								{
									type: "worktree_snapshot",
									id: "capture",
									parentId: index === 19 ? "restored-root" : null,
									timestamp,
									root,
									snapshotId: snapshot.id,
									snapshot,
									captureMs: 1,
								},
								{
									type: "worktree_snapshot",
									id: "abandoned",
									parentId: "capture",
									timestamp: "2026-11-27T00:00:00.000Z",
									root: "/work",
									snapshotId: abandoned.id,
									snapshot: abandoned,
									captureMs: 1,
								},
								{
									type: "message",
									id: "active",
									parentId: "capture",
									timestamp,
									message: { role: "user", content: "active path", timestamp: 0 },
								},
							]);
							if (childSessionId !== donorId) await clone(store, donorId, childSessionId);
							await parent.appendCustomEntry("subagent-child", {
								version: 1,
								childId: `child-${index}`,
								runId: "run",
								index,
								agent: "worker",
								cwd: "/work",
								owner: { kind: "session", sessionId: parent.getSessionId() },
								state: "terminal",
								terminalStatus: "ok",
								childSessionId,
								worktreeCapturedAt: timestamp,
							});
						}
						const single = await SessionManager.create(store, "/work");
						await single.appendCustomEntry("subagent-child", {
							version: 1,
							childId: "child-19",
							runId: "run",
							index: 19,
							agent: "worker",
							cwd: "/work",
							owner: { kind: "session", sessionId: single.getSessionId() },
							state: "terminal",
							terminalStatus: "ok",
							childSessionId: "winner-fork",
							worktreeCapturedAt: "2026-11-26T00:00:19.000Z",
						});
						await store.readResume("child-capture-0");
						await sleep(COMMIT_SETTLE_MS);
						const trips = countRoundTrips();
						assert.deepEqual(await adoptSubagentCaptures(single), ["/work"]);
						await sleep(COMMIT_SETTLE_MS);
						const one = trips.take();
						assert.deepEqual(await adoptSubagentCaptures(parent), ["/work"]);
						await sleep(COMMIT_SETTLE_MS);
						const many = trips.take();
						assert.equal(parent.getLatestWorktreeSnapshots().get("/work")?.id, "snapshot-19");
						assert.ok(
							many <= 20 && many <= one + 2,
							`expected a bounded batch for 20 child snapshots, got ${many} trips versus ${one} for one`,
						);
					} finally {
						await store.close();
					}
				});
			});

			test("the snapshot batch returns the same winners as a full active-branch scan (#6795)", async () => {
				await withPostgresDatabase(async (scope) => {
					const store = await SqlSessionStore.open(await route.open(scope));
					try {
						let seed = 6795;
						const choose = (limit: number) => {
							seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
							return (seed >>> 8) % limit;
						};
						const expected = new Map<string, string[]>();
						for (let example = 0; example < 12; example++) {
							const id = `winner-property-${example}`;
							const history = Array.from({ length: 40 }, (_, seq) => {
								const previous = choose(4) === 0 ? choose(seq + 1) - 1 : seq - 1;
								const root = `/root-${choose(4)}`;
								return {
									type: "worktree_snapshot" as const,
									id: `row-${seq}`,
									parentId: previous < 0 ? null : `row-${previous}`,
									root,
									snapshotId: `snapshot-${seq}`,
									captureMs: 1,
									timestamp:
										example === 11 && seq === 39
											? "2026-11-26T23:00:04-01:00"
											: new Date(Date.UTC(2026, 10, 27, 0, 0, choose(5))).toISOString(),
								};
							});
							await store.create(header(id), history);
							const active = [];
							for (let row = history.at(-1); row; row = history.find(({ id }) => id === row!.parentId))
								active.unshift(row);
							// A non-canonical legacy stamp retains every candidate for the original Date.parse comparison.
							if (example === 11) {
								expected.set(id, active.map(({ snapshotId }) => snapshotId).sort());
								continue;
							}
							const winners = new Map<string, (typeof history)[number]>();
							for (const row of active) {
								const previous = winners.get(row.root);
								if (!previous || Date.parse(previous.timestamp) <= Date.parse(row.timestamp))
									winners.set(row.root, row);
							}
							expected.set(id, [...winners.values()].map(({ snapshotId }) => snapshotId).sort());
						}
						const actual = await store.readBranchSnapshotMetadata([...expected.keys()]);
						for (const [id, winners] of expected) {
							assert.deepEqual(
								actual
									.get(id)
									?.entries.filter(({ capture }) => capture)
									.map(({ snapshotId }) => snapshotId)
									.sort(),
								winners,
								id,
							);
						}
					} finally {
						await store.close();
					}
				});
			});

			test(
				"stale readTail and fork readResume rebuild in one snapshot and persist with conditional UPDATE RETURNING (#6710)",
				async () => {
					await withPostgresDatabase(async (scope) => {
						const setupDb = await route.open(scope);
						const setup = await SqlSessionStore.open(setupDb);
						const opened: SqliteDatabase[] = [setupDb];
						try {
							await setup.create(header("s1"), entries("s1", 20));
							await clone(setup, "s1", "f1");
							await clearStoredResumeIndex(setupDb, "s1");
							await clearStoredResumeIndex(setupDb, "f1");

							const readerDb = await route.open(scope);
							opened.push(readerDb);
							const reader = await SqlSessionStore.open(readerDb);
							try {
								// Warm the reader pool connection before counting.
								await reader.load("s1");
								await sleep(COMMIT_SETTLE_MS);

								const trips = countRoundTrips();
								const tail = await reader.readTail("s1", 16);
								await sleep(COMMIT_SETTLE_MS);
								const staleTailTrips = trips.take();
								assert.deepEqual(
									tail.entries.map((entry) => entry.id),
									["s1-16", "s1-17", "s1-18", "s1-19", "s1-20"],
								);
								assert.equal(await storedResumeSeq(setupDb, "s1"), 20, "rebuilt resume index persisted");
								// Previously 9-10 round trips; now 6-7 (including trailing read-only COMMIT).
								assert.ok(
									staleTailTrips <= 7,
									`expected <= 7 round trips for stale readTail, got ${staleTailTrips}`,
								);

								// Next readTail hits the persisted resume index directly (3 round trips).
								trips.take();
								const warmTail = await reader.readTail("s1", 16);
								await sleep(COMMIT_SETTLE_MS);
								const warmTailTrips = trips.take();
								assert.equal(warmTail.entries.length, 5);
								assert.ok(
									warmTailTrips <= 3,
									`expected <= 3 round trips for warm readTail, got ${warmTailTrips}`,
								);

								const forkResume = await reader.readResume("f1");
								await sleep(COMMIT_SETTLE_MS);
								const staleForkResumeTrips = trips.take();
								assert.equal(forkResume.leafId, "s1-20");
								assert.equal(await storedResumeSeq(setupDb, "f1"), 20, "fork resume index persisted");
								// Previously 10-11 round trips; now 6-7.
								assert.ok(
									staleForkResumeTrips <= 7,
									`expected <= 7 round trips for stale fork readResume, got ${staleForkResumeTrips}`,
								);

								// Historical leaf resume on a fork with a stale index.
								await clearStoredResumeIndex(setupDb, "f1");
								const leafReaderDb = await route.open(scope);
								opened.push(leafReaderDb);
								const leafReader = await SqlSessionStore.open(leafReaderDb);
								try {
									await leafReader.load("f1");
									await sleep(COMMIT_SETTLE_MS);
									trips.take();
									const historical = await leafReader.readResume("f1", "s1-10");
									await sleep(COMMIT_SETTLE_MS);
									const historicalForkTrips = trips.take();
									assert.equal(historical.leafId, "s1-10");
									assert.equal(
										await storedResumeSeq(setupDb, "f1"),
										undefined,
										"historical cut never overwrites current leaf resume index",
									);
									assert.ok(
										historicalForkTrips <= 8,
										`expected <= 8 round trips for fork readResume(leafId), got ${historicalForkTrips}`,
									);
								} finally {
									await leafReader.close();
								}
							} finally {
								await reader.close();
							}
						} finally {
							await setup.close();
							await Promise.allSettled(opened.map((db) => db.close()));
						}
					});
				},
				INTERLEAVING_TIMEOUT_MS,
			);

			test(
				"resumeForkDetaches and sweepForkTombstones gates run read-only in at most 2 round trips (#6710)",
				async () => {
					await withPostgresDatabase(async (scope) => {
						const db = await route.open(scope);
						const store = await SqlSessionStore.open(db);
						try {
							await store.create(header("s1"), entries("s1", 3));
							await sleep(COMMIT_SETTLE_MS);
							const trips = countRoundTrips();
							assert.deepEqual(await store.resumeForkDetaches(), { detached: [], reparented: [] });
							await sleep(COMMIT_SETTLE_MS);
							const resumeGateTrips = trips.take();
							assert.deepEqual(await store.sweepForkTombstones(), []);
							await sleep(COMMIT_SETTLE_MS);
							const sweepGateTrips = trips.take();
							assert.ok(
								resumeGateTrips <= 2,
								`expected <= 2 round trips for idle resumeForkDetaches, got ${resumeGateTrips}`,
							);
							assert.ok(
								sweepGateTrips <= 2,
								`expected <= 2 round trips for idle sweepForkTombstones, got ${sweepGateTrips}`,
							);
						} finally {
							await store.close();
							await db.close();
						}
					});
				},
				INTERLEAVING_TIMEOUT_MS,
			);
		},
	);
}

describe.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL resume-index races, read-mode gates, and narrower delete locks (#6710)",
	() => {
		test(
			"concurrent append and branch during prepareResume never leave a stale resume index marked current (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setup = await SqlSessionStore.open(await scope.open());
					try {
						await setup.create(header("s1"), entries("s1", 10));
						await clearStoredResumeIndex(await scope.open(), "s1");

						// Case 1: Pause stale readTail right before its conditional UPDATE RETURNING,
						// append a branch jump concurrently, then release. The stale UPDATE matches 0 rows
						// (never marking seq 10 current over seq 12), retries, and rebuilds seq 12.
						const beforeUpdate = gate();
						let updateCalls = 0;
						const readerDb = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (
									inTransaction ||
									!sql.includes(
										"SET summary_state = ? WHERE id = ? AND revision = ? AND last_seq = ? RETURNING",
									)
								)
									return undefined;
								updateCalls++;
								return updateCalls === 1 ? beforeUpdate.wait() : undefined;
							},
						});
						const reader = await SqlSessionStore.open(readerDb);
						const writer = await SqlSessionStore.open(await scope.open());
						try {
							const tailPromise = reader.readTail("s1", 8);
							await within(beforeUpdate.reached, "readTail reaching conditional UPDATE RETURNING", 15_000);

							// Append a branch off entry s1-3 while prepareResume's conditional UPDATE is paused.
							await writer.append("s1", entries("branch", 2, "s1-3"), { expectSeq: 10 });
							await clearStoredResumeIndex(await scope.open(), "s1");

							beforeUpdate.release();
							const tail = await tailPromise;
							assert.equal(updateCalls, 2, "first conditional UPDATE matched 0 rows and retried for seq 12");
							assert.equal(
								tail.entries.at(-1)?.id,
								"branch-2",
								"retried readTail reflects the concurrent branch",
							);
							assert.equal(
								await storedResumeSeq(await scope.open(), "s1"),
								12,
								"persisted resume index matches seq 12, never stale seq 10",
							);

							const resumed = await writer.readResume("s1");
							assert.equal(resumed.leafId, "branch-2");
							assert.equal(await storedResumeSeq(await scope.open(), "s1"), 12);
						} finally {
							beforeUpdate.release();
							await reader.close();
							await writer.close();
						}

						// Case 2: Standalone prepareResume (via readChildCatalogCut) racing with a same-last_seq replace:
						// revision changes while last_seq stays 12 -> UPDATE RETURNING matches 0 rows and retries!
						await clearStoredResumeIndex(await scope.open(), "s1");
						const beforeStandaloneUpdate = gate();
						let armedStandalone = true;
						const spanDb = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (
									!armedStandalone ||
									inTransaction ||
									!sql.includes(
										"SET summary_state = ? WHERE id = ? AND revision = ? AND last_seq = ? RETURNING",
									)
								)
									return undefined;
								armedStandalone = false;
								return beforeStandaloneUpdate.wait();
							},
						});
						const spanReader = await SqlSessionStore.open(spanDb);
						const replacer = await SqlSessionStore.open(await scope.open());
						try {
							const cutPromise = spanReader.readChildCatalogCut("s1");
							await within(
								beforeStandaloneUpdate.reached,
								"prepareResume reaching conditional UPDATE RETURNING",
								15_000,
							);
							await replacer.replace("s1", header("s1"), entries("rep", 12), { expectSeq: 12 });
							await clearStoredResumeIndex(await scope.open(), "s1");
							beforeStandaloneUpdate.release();
							const cut = await cutPromise;
							assert.equal(cut.lastSeq, 12);
							assert.equal(await storedResumeSeq(await scope.open(), "s1"), 12);
							assert.equal((await replacer.readResume("s1")).leafId, "rep-12");
						} finally {
							beforeStandaloneUpdate.release();
							await spanReader.close();
							await replacer.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"read-mode gate transactions do not block on the whole-database exclusive lock and still refuse newer schemas (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setupDb = await scope.open();
					const setup = await SqlSessionStore.open(setupDb);
					const holderDb = await scope.open();
					const callerDb = await scope.open();
					const caller = await SqlSessionStore.open(callerDb);
					try {
						await setup.create(header("s1"), entries("s1", 3));
						const releaseLock = gate();
						// Hold the whole-database exclusive advisory lock (same lock as migrations & older builds).
						const holding = holderDb.transaction(
							async () => {
								await releaseLock.wait();
							},
							{ concurrency: { kind: "serial" } },
						);
						await within(releaseLock.reached, "holder acquiring whole-database exclusive lock", 10_000);
						try {
							// All three read-mode gate calls (and idle leftover discovery) complete immediately while whole-DB lock is held.
							assert.deepEqual(await within(caller.resumeForkDetaches(), "resumeForkDetaches", 5_000), {
								detached: [],
								reparented: [],
							});
							assert.deepEqual(await within(caller.sweepForkTombstones(), "sweepForkTombstones", 5_000), []);
							assert.deepEqual(await within(caller.detachForks("s1"), "detachForks", 5_000), {
								detached: [],
								reparented: [],
							});
						} finally {
							releaseLock.release();
							await holding;
						}

						// Raising schema_version past supported version is still refused by all three read-mode gates.
						const meta = renderStorageIdentifiers("sessions", SESSION_TABLES).meta;
						await setupDb.run(`UPDATE ${meta} SET schema_version = 99`);
						await assert.rejects(caller.detachForks("s1"), StorageSchemaVersionError);
						await assert.rejects(caller.resumeForkDetaches(), StorageSchemaVersionError);
						await assert.rejects(caller.sweepForkTombstones(), StorageSchemaVersionError);
					} finally {
						await caller.close();
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"deleting a session does not stall unrelated session writers, with shared history on or off (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setup = await SqlSessionStore.open(await scope.open());
					try {
						await setup.create(header("A"), entries("A", 5));
						await setup.create(header("B"), entries("B", 5));
						await setup.create(header("D"), entries("D", 5));

						const deletePaused = gate();
						let armed = true;
						const deleterDb = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (!armed || !inTransaction || !sql.includes("DELETE FROM session_entries")) return undefined;
								armed = false;
								return deletePaused.wait();
							},
						});
						const deleter = await SqlSessionStore.open(deleterDb);
						const peer = await SqlSessionStore.open(await scope.open());
						try {
							const deleting = deleter.delete("A");
							await within(deletePaused.reached, "delete(A) holding its session lock", 15_000);

							// While delete("A") is open and holding all its locks, unrelated session writes proceed freely!
							await within(
								peer.append("B", entries("B-more", 2, "B-5"), { expectSeq: 5 }),
								"unrelated append(B) beside delete(A)",
								5_000,
							);
							await within(
								peer.create(header("C"), entries("C", 2)),
								"unrelated create(C) beside delete(A)",
								5_000,
							);
							await within(peer.delete("D"), "unrelated delete(D) beside delete(A)", 5_000);

							deletePaused.release();
							await deleting;

							assert.equal(await peer.readHeader("A"), undefined);
							assert.equal(await peer.readHeader("D"), undefined);
							assert.equal((await peer.load("B")).entries.length, 7);
							assert.equal((await peer.load("C")).entries.length, 2);
						} finally {
							deletePaused.release();
							await deleter.close();
							await peer.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"post-delete tombstone sweep does not stall unrelated session writers (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setup = await SqlSessionStore.open(await scope.open());
					try {
						await setup.create(header("P"), entries("P", 5));
						await setup.create(header("U"), entries("U", 5));
						await clone(setup, "P", "F");
						await setup.delete("P");

						const sweepPaused = gate();
						let armed = true;
						const deleterDb = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (!armed || !inTransaction || !sql.includes("DELETE FROM session_fork_tombstones"))
									return undefined;
								armed = false;
								return sweepPaused.wait();
							},
						});
						const deleter = await SqlSessionStore.open(deleterDb);
						const peer = await SqlSessionStore.open(await scope.open());
						try {
							const deleting = deleter.delete("F");
							await within(sweepPaused.reached, "post-delete sweep holding tombstone(P) lock", 15_000);

							await within(
								peer.append("U", entries("U-more", 2, "U-5"), { expectSeq: 5 }),
								"unrelated append(U) beside sweepBatch(P)",
								5_000,
							);

							sweepPaused.release();
							await deleting;
							assert.equal((await peer.load("U")).entries.length, 7);
							const tombstones = sessionForkTables().forkTombstones;
							const left = await (await scope.open()).get<SqliteRow & { n: number }>(
								`SELECT count(*) AS n FROM ${tombstones} WHERE session_id = ?`,
								"P",
							);
							assert.equal(Number(left?.n), 0);
						} finally {
							sweepPaused.release();
							await deleter.close();
							await peer.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"concurrent fork and narrowed delete serialize on the parent row without leaving an orphan or broken parent (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setup = await SqlSessionStore.open(await scope.open());
					try {
						// Case A: fork locks parent FOR KEY SHARE first; delete waits, then sees the new fork and leaves a tombstone.
						await setup.create(header("P1"), entries("P1", 5));
						const forkPaused = gate();
						let armedFork = true;
						const forkerDb = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (!armedFork || !inTransaction || !sql.includes("INSERT INTO session_fork_segments"))
									return undefined;
								armedFork = false;
								return forkPaused.wait();
							},
						});
						const forker = await SqlSessionStore.open(forkerDb);
						const deleter = await SqlSessionStore.open(await scope.open());
						try {
							const forking = clone(forker, "P1", "C1");
							await within(forkPaused.reached, "fork holding P1 FOR KEY SHARE", 15_000);

							let deleteDone = false;
							const deleting = deleter.delete("P1").finally(() => {
								deleteDone = true;
							});
							await sleep(BLOCKED_CHECK_MS);
							assert.equal(deleteDone, false, "delete(P1) must wait while fork holds P1 FOR KEY SHARE");

							forkPaused.release();
							await Promise.all([forking, deleting]);

							assert.equal(await deleter.readHeader("P1"), undefined);
							assert.deepEqual(
								(await deleter.load("C1")).entries.map((e) => e.id),
								["P1-1", "P1-2", "P1-3", "P1-4", "P1-5"],
								"fork keeps full parent history under tombstone",
							);
						} finally {
							forkPaused.release();
							await forker.close();
							await deleter.close();
						}

						// Case B: delete locks parent FOR UPDATE first; fork waits, then finds parent gone.
						await setup.create(header("P2"), entries("P2", 5));
						const deletePaused = gate();
						let armedDel = true;
						const deleter2Db = instrumented(await scope.open(), {
							pause: (sql, inTransaction) => {
								if (!armedDel || !inTransaction || !sql.includes("DELETE FROM session_entries"))
									return undefined;
								armedDel = false;
								return deletePaused.wait();
							},
						});
						const deleter2 = await SqlSessionStore.open(deleter2Db);
						const forker2 = await SqlSessionStore.open(await scope.open());
						try {
							const head = await forker2.readEntrySizes("P2", 1, 0);
							const deleting = deleter2.delete("P2");
							await within(deletePaused.reached, "delete holding P2 FOR UPDATE", 15_000);

							let forkDone = false;
							const forking = forker2
								.createFork(header("C2", "P2"), completeSessionForkStream("P2", head.epoch, head.lastSeq), {
									store: forker2,
									sessionId: "P2",
									epoch: head.epoch,
									hashes: [],
									receipts: new Map(),
								})
								.finally(() => {
									forkDone = true;
								});
							await sleep(BLOCKED_CHECK_MS);
							assert.equal(forkDone, false, "createFork(C2, P2) must wait while delete(P2) holds P2 FOR UPDATE");

							deletePaused.release();
							await deleting;
							await assert.rejects(forking, /not found|SessionNotFound/i);
							assert.equal(await forker2.readHeader("C2"), undefined, "refused fork created no session");
						} finally {
							deletePaused.release();
							await deleter2.close();
							await forker2.close();
						}

						// Case C: Transitive fork (G forked from F, which reads P3) racing with narrowed delete(P3).
						await setup.create(header("P3"), entries("P3", 5));
						await clone(setup, "P3", "F3");
						const deleteP3Paused = gate();
						let armedP3 = true;
						const deleter3Counter = countingDeadlocks(
							instrumented(await scope.open(), {
								pause: (sql, inTransaction) => {
									if (!armedP3 || !inTransaction || !sql.includes("INSERT INTO session_fork_tombstones"))
										return undefined;
									armedP3 = false;
									return deleteP3Paused.wait();
								},
							}),
						);
						const forker3Counter = countingDeadlocks(await scope.open());
						const deleter3 = await SqlSessionStore.open(deleter3Counter.database);
						const forker3 = await SqlSessionStore.open(forker3Counter.database);
						try {
							const deletingP3 = deleter3.delete("P3");
							await within(deleteP3Paused.reached, "delete(P3) holding P3 FOR UPDATE", 15_000);
							const forkingG = clone(forker3, "F3", "G3");
							await sleep(BLOCKED_CHECK_MS);
							deleteP3Paused.release();
							await Promise.all([deletingP3, forkingG]);
							assert.deepEqual([deleter3Counter.deadlocks(), forker3Counter.deadlocks()], [0, 0]);
							const expectedP3 = ["P3-1", "P3-2", "P3-3", "P3-4", "P3-5"];
							assert.deepEqual(
								(await forker3.load("F3")).entries.map((e) => e.id),
								expectedP3,
							);
							assert.deepEqual(
								(await forker3.load("G3")).entries.map((e) => e.id),
								expectedP3,
							);
						} finally {
							deleteP3Paused.release();
							await deleter3.close();
							await forker3.close();
						}

						// Case D: Deleting a fork whose parent is still live does not acquire a write lock on the live parent.
						await setup.create(header("LiveParent"), entries("LP", 4));
						await clone(setup, "LiveParent", "LiveFork");
						const parentAppendPaused = gate();
						let armedParent = true;
						const parentWriter = await SqlSessionStore.open(
							instrumented(await scope.open(), {
								pause: (sql, inTransaction) => {
									if (!armedParent || !inTransaction || !sql.includes("INSERT INTO session_entries"))
										return undefined;
									armedParent = false;
									return parentAppendPaused.wait();
								},
							}),
						);
						const forkDeleter = await SqlSessionStore.open(await scope.open());
						try {
							const appendingParent = parentWriter.append("LiveParent", entries("LP2", 1, "LP-4"), {
								expectSeq: 4,
							});
							await within(
								parentAppendPaused.reached,
								"append(LiveParent) holding LiveParent session lock",
								15_000,
							);
							await within(
								forkDeleter.delete("LiveFork"),
								"delete(LiveFork) completing while LiveParent is locked",
								5_000,
							);
							parentAppendPaused.release();
							await appendingParent;
							assert.equal(await forkDeleter.readHeader("LiveFork"), undefined);
							assert.equal((await forkDeleter.load("LiveParent")).entries.length, 5);
						} finally {
							parentAppendPaused.release();
							await parentWriter.close();
							await forkDeleter.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"two concurrent forks into mutually referenced tombstones lock tombstones in id order without deadlocking (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setup = await SqlSessionStore.open(await scope.open());
					try {
						// D reads both tombstones P2 and P3 (chain: P2 -> P3 -> D, then delete P2 and P3).
						await setup.create(header("P2"), entries("p2", 3));
						await clone(setup, "P2", "P3");
						await setup.append("P3", entries("p3", 2, "p2-3"), { expectSeq: 3 });
						await clone(setup, "P3", "D");
						await setup.delete("P2");
						await setup.delete("P3");

						const c1 = countingDeadlocks(await scope.open());
						const c2 = countingDeadlocks(await scope.open());
						const s1 = await SqlSessionStore.open(c1.database);
						const s2 = await SqlSessionStore.open(c2.database);
						try {
							await Promise.all([clone(s1, "D", "P3"), clone(s2, "D", "P2")]);
							assert.deepEqual(
								[c1.deadlocks(), c2.deadlocks()],
								[0, 0],
								"concurrent forks over two tombstones incurred zero deadlocks",
							);
							const expected = ["p2-1", "p2-2", "p2-3", "p3-1", "p3-2"];
							for (const id of ["P2", "P3", "D"])
								assert.deepEqual(
									(await s1.load(id)).entries.map((e) => e.id),
									expected,
									id,
								);
						} finally {
							await s1.close();
							await s2.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);

		test(
			"older builds remain safely excluded by narrowed delete (whole-DB lock and v2 FOR SHARE fork) (#6710)",
			async () => {
				await withPostgresDatabase(async (scope) => {
					const setupDb = await scope.open();
					const setup = await SqlSessionStore.open(setupDb);
					try {
						await setup.create(header("A"), entries("A", 4));
						await setup.create(header("B"), entries("B", 4));

						// 1. Older build holding whole-database exclusive advisory lock excludes narrowed delete(A).
						const oldBuildDb = await scope.open();
						const deleter = await SqlSessionStore.open(await scope.open());
						const oldRelease = gate();
						const oldTx = oldBuildDb.transaction(
							async () => {
								await oldRelease.wait();
							},
							{ concurrency: { kind: "serial" } },
						);
						await within(oldRelease.reached, "older build acquiring whole-DB exclusive lock", 10_000);
						try {
							let deleteSettled = false;
							const deleting = deleter.delete("A").finally(() => {
								deleteSettled = true;
							});
							await sleep(BLOCKED_CHECK_MS);
							assert.equal(deleteSettled, false, "narrowed delete(A) waits for older whole-DB transaction");
							oldRelease.release();
							await Promise.all([oldTx, deleting]);
							assert.equal(await deleter.readHeader("A"), undefined);
						} finally {
							oldRelease.release();
							await deleter.close();
						}

						// 2. Reverse: while narrowed delete(B) runs, an older whole-DB transaction cannot acquire DB_LOCK(X).
						const delPaused = gate();
						let armedDel = true;
						const deleter2 = await SqlSessionStore.open(
							instrumented(await scope.open(), {
								pause: (sql, inTransaction) => {
									if (!armedDel || !inTransaction || !sql.includes("DELETE FROM session_entries"))
										return undefined;
									armedDel = false;
									return delPaused.wait();
								},
							}),
						);
						const probeDb = await scope.open();
						try {
							const deleting = deleter2.delete("B");
							await within(delPaused.reached, "narrowed delete(B) holding its locks", 15_000);
							const gotWhole = await probeDb.get<SqliteRow & { locked: boolean | number }>(
								"SELECT pg_try_advisory_xact_lock(hashtextextended(CASE WHEN current_schema() = 'public' THEN 'atomic' ELSE current_schema() || ':atomic' END, 0)) AS locked",
							);
							assert.equal(
								Number(gotWhole?.locked),
								0,
								"narrowed delete holds shared DB lock excluding older builds",
							);
							delPaused.release();
							await deleting;
						} finally {
							delPaused.release();
							await deleter2.close();
						}

						// 3. Schema v2 (shared history OFF) + older 0.10.11-alpha.1 FOR SHARE fork:
						//    narrowed delete still locks sessions(id) FOR UPDATE, waiting for FOR SHARE while leaving other sessions free.
						await setup.create(header("V2A"), entries("V2A", 3));
						await setup.create(header("V2B"), entries("V2B", 3));
						const meta = renderStorageIdentifiers("sessions", SESSION_TABLES).meta;
						await setupDb.run(`UPDATE ${meta} SET schema_version = 2`);

						const v2Deleter = await SqlSessionStore.open(await scope.open());
						const v2Peer = await SqlSessionStore.open(await scope.open());
						const oldForkDb = await scope.open();
						const shareRelease = gate();
						const oldForkTx = oldForkDb.transaction(
							async (tx) => {
								await tx.get("SELECT id FROM session_sessions WHERE id = ? FOR SHARE", "V2A");
								await shareRelease.wait();
								// While FOR SHARE is held, V2A's entries must still be intact!
								const count = await tx.get<SqliteRow & { n: number }>(
									"SELECT count(*) AS n FROM session_entries WHERE session_id = ?",
									"V2A",
								);
								assert.equal(Number(count?.n), 3, "older FOR SHARE fork sees intact donor entries");
							},
							{ concurrency: { kind: "serial", domain: "session_sessions:V2Child" } },
						);
						await within(shareRelease.reached, "older v2 fork locking V2A FOR SHARE", 10_000);
						try {
							let v2DeleteDone = false;
							const v2Deleting = v2Deleter.delete("V2A").finally(() => {
								v2DeleteDone = true;
							});
							await sleep(BLOCKED_CHECK_MS);
							assert.equal(v2DeleteDone, false, "narrowed v2 delete(V2A) waits for older FOR SHARE fork");

							// Unrelated session V2B still appends freely!
							await within(
								v2Peer.append("V2B", entries("V2B-more", 1, "V2B-3"), { expectSeq: 3 }),
								"unrelated v2 append(V2B) beside blocked delete(V2A)",
								5_000,
							);

							shareRelease.release();
							await Promise.all([oldForkTx, v2Deleting]);
							assert.equal(await v2Peer.readHeader("V2A"), undefined);
							assert.equal((await v2Peer.load("V2B")).entries.length, 4);
						} finally {
							shareRelease.release();
							await v2Deleter.close();
							await v2Peer.close();
						}
					} finally {
						await setup.close();
					}
				});
			},
			INTERLEAVING_TIMEOUT_MS,
		);
	},
);
