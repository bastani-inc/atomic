import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	SessionConflictError,
	SessionNotFoundError,
} from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { WorkspaceSnapshotError } from "../../packages/coding-agent/src/core/workspace/errors.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { syntheticSnapshot } from "../helpers/snapshot-reference-index.js";

/** Counts the round trips to the server until the test ends. */
function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
function message(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

const postgresPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");

/** Runs `atomic storage migrate` on the scope's database, as the role the test server's URL logs in as. */
async function migrate(scope: PostgresScope): Promise<void> {
	const root = makeTempDirectory("storage-postgres-append-function-");
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [postgresPackage] }));
		const passwordFile = join(root, "password");
		writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
		const err: string[] = [];
		const code = await runStorageCommand(["migrate", "--db", scope.url, "--password-file", passwordFile], {
			cwd: root,
			agentDir,
			log: () => {},
			error: (line) => err.push(line),
			loadBrokerState: () => import("../../packages/intercom/broker/open-broker-state.js"),
		});
		assert.equal(code, 0, err.join("\n"));
	} finally {
		removeTempDirectory(root);
	}
}

/** The session's entries, as a fresh read of `database` finds them, by seq. */
async function storedEntries(database: SqliteDatabase, sessionId: string) {
	return database.all<{ seq: number; entry_id: string }>(
		"SELECT seq, entry_id FROM session_entries WHERE session_id = ? ORDER BY seq",
		sessionId,
	);
}

describe.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL session append through the append function (#6599)",
	() => {
		test("after storage migrate an append takes one round trip, where it took two, and stores what it stored (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				// Opened before the function exists, it appends in a transaction as before: the reference.
				const reference = await SqlSessionStore.open(await open());
				await migrate(scope);
				const database = await open();
				const store = await SqlSessionStore.open(database);
				try {
					const appends = [
						[message("m1", "first", null)],
						[message("m2", "second", "m1"), message("m3", "third", "m1")],
						[message("m4", "fourth", "m3")],
					];
					const trips = countRoundTrips();
					const counted: number[] = [];
					for (const [sessionId, writer] of [
						["s1", store],
						["r1", reference],
					] as const) {
						const created = await writer.create(header(sessionId), []);
						let lastSeq = created.lastSeq;
						for (const entries of appends) {
							trips.take();
							({ lastSeq } = await writer.append(sessionId, entries, {
								expectSeq: lastSeq,
								epoch: created.epoch,
							}));
							counted.push(trips.take());
						}
					}
					assert.deepEqual(counted, [1, 1, 1, 2, 2, 2]);
					const rows = await database.all<Record<string, string | number | null>>(
						`SELECT id, cwd, created_at, header_json, internal, last_seq, message_count, first_message, name, has_name,
						summary, summarized_through_id, summary_state FROM session_sessions ORDER BY id`,
					);
					const [reference1, s1] = rows.map(({ id: _id, header_json, summary_state, ...row }) => ({
						...row,
						header: { ...JSON.parse(String(header_json)), id: undefined },
						summary_state: withoutEpochs(JSON.parse(String(summary_state))),
					}));
					assert.deepEqual(s1, reference1);
					for (const table of ["session_entries", "session_search_texts"]) {
						const stored = await database.all<{ session_id: string; row_order: number }>(
							`SELECT * FROM ${table} ORDER BY session_id, seq`,
						);
						const of = (id: string) =>
							stored
								.filter((row) => row.session_id === id)
								.map(({ session_id: _id, row_order: _order, ...row }) => row);
						assert.deepEqual(of("s1"), of("r1"), table);
					}
					const resumed = async (writer: SqlSessionStore, sessionId: string) => {
						const { header: _header, epoch: _epoch, ...resume } = await writer.readResume(sessionId);
						return resume;
					};
					assert.deepEqual(await resumed(store, "s1"), await resumed(reference, "r1"));
				} finally {
					await store.close();
					await reference.close();
				}
			});
		});

		test("a store opened before the function exists appends in two round trips, and so does one whose row another writer changed (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				const database = await open();
				const before = await SqlSessionStore.open(database);
				await migrate(scope);
				const after = await SqlSessionStore.open(await open());
				try {
					const created = await before.create(header("s1"), []);
					const trips = countRoundTrips();
					await before.append("s1", [message("m1", "first", null)], { expectSeq: 0, epoch: created.epoch });
					assert.equal(trips.take(), 2, "the store opened before the function appends as before");
					// `after` remembers no row of s1: its first append reads it in a transaction, its next goes through the function.
					await after.append("s1", [message("m2", "second", "m1")], { expectSeq: 1, epoch: created.epoch });
					assert.equal(trips.take(), 2);
					await after.append("s1", [message("m3", "third", "m2")], { expectSeq: 2, epoch: created.epoch });
					assert.equal(trips.take(), 1);
					// A refresh of the summary state that keeps the revision, as a resume read's does: the function finds the row
					// changed, writes nothing, and the append goes through a transaction that reads the row as it is now.
					await database.run(
						"UPDATE session_sessions SET summary_state = summary_state::jsonb::text WHERE id = ?",
						"s1",
					);
					trips.take();
					await after.append("s1", [message("m4", "fourth", "m3")], { expectSeq: 3, epoch: created.epoch });
					assert.equal(trips.take(), 3);
					// An earlier build's append in between: the row `after` remembers is behind the expected seq, so it appends
					// through a transaction at once.
					await before.append("s1", [message("m5", "fifth", "m4")], { expectSeq: 4, epoch: created.epoch });
					trips.take();
					await after.append("s1", [message("m6", "sixth", "m5")], { expectSeq: 5, epoch: created.epoch });
					assert.equal(trips.take(), 2);
					// An earlier build's header update in between, which keeps the seq and starts a new epoch: the epoch the caller
					// expects is not the remembered row's, so it appends through a transaction at once.
					const updated = await before.updateHeader({ ...header("s1"), cwd: "/elsewhere" }, { expectSeq: 6 });
					trips.take();
					await after.append("s1", [message("m7", "seventh", "m6")], { expectSeq: 6, epoch: updated.epoch });
					assert.equal(trips.take(), 2);
					assert.equal((await before.readHeader("s1"))?.cwd, "/elsewhere");
					assert.deepEqual(
						(await storedEntries(database, "s1")).map((row) => [Number(row.seq), row.entry_id]),
						[
							[1, "m1"],
							[2, "m2"],
							[3, "m3"],
							[4, "m4"],
							[5, "m5"],
							[6, "m6"],
							[7, "m7"],
						],
					);
					assert.deepEqual(
						(await before.load("s1")).entries.map((entry) => entry.id),
						["m1", "m2", "m3", "m4", "m5", "m6", "m7"],
					);
					const row = await database.get<{ message_count: number }>(
						"SELECT message_count FROM session_sessions WHERE id = ?",
						"s1",
					);
					assert.equal(Number(row?.message_count), 7);
				} finally {
					await before.close();
					await after.close();
				}
			});
		});

		test("the function refuses what an append's transaction refuses, with the same errors, and writes nothing (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				await migrate(scope);
				// Opened after the migration: an open reads the catalog the store finds the function in.
				const database = await open();
				const store = await SqlSessionStore.open(database);
				const other = await SqlSessionStore.open(await open());
				try {
					const created = await store.create(header("s1"), []);
					const trips = countRoundTrips();
					// Another process appended meanwhile: the stored seq is not the one expected.
					await other.append("s1", [message("o1", "other", null)], { expectSeq: 0, epoch: created.epoch });
					trips.take();
					const conflict = await store
						.append("s1", [message("m1", "first", null)], { expectSeq: 0, epoch: created.epoch })
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					assert.ok(conflict instanceof SessionConflictError, String(conflict));
					assert.equal(trips.take(), 1, "the conflict is the function's answer");

					// A newer sessions schema, as a later build leaves it.
					const fresh = await store.create(header("s2"), []);
					await database.run("UPDATE session_meta SET schema_version = 99");
					trips.take();
					const newer = await store
						.append("s2", [message("m1", "first", null)], { expectSeq: 0, epoch: fresh.epoch })
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					assert.ok(newer instanceof StorageSchemaVersionError, String(newer));
					assert.equal(trips.take(), 1);
					await database.run("UPDATE session_meta SET schema_version = 1");

					// A snapshot record whose blob is not stored.
					const bundle = createHash("sha256").update("never stored").digest("hex");
					const snapshot = {
						type: "worktree_snapshot",
						id: "w1",
						parentId: null,
						timestamp: "2026-11-25T00:00:01.000Z",
						root: "/w",
						snapshotId: "S1",
						snapshot: syntheticSnapshot("S1", [], { bundle, root: "/w" }),
					} as SessionEntry;
					trips.take();
					const collected = await store.append("s2", [snapshot], { expectSeq: 0, epoch: fresh.epoch }).then(
						() => undefined,
						(error: unknown) => error,
					);
					assert.ok(collected instanceof WorkspaceSnapshotError, String(collected));
					assert.equal(collected.code, "blobs-collected");
					assert.equal(collected.subject, bundle);
					assert.equal(trips.take(), 1);
					// With the blob stored, the same append records it.
					await store.snapshotBlobs.putBlobs([{ hash: bundle, data: new TextEncoder().encode("never stored") }]);
					await store.append("s2", [snapshot], { expectSeq: 0, epoch: fresh.epoch });
					assert.deepEqual(
						(await storedEntries(database, "s2")).map((row) => row.entry_id),
						["w1"],
					);

					// The session was deleted meanwhile.
					await other.delete("s2");
					trips.take();
					const missing = await store
						.append("s2", [message("m2", "second", "w1")], { expectSeq: 1, epoch: fresh.epoch })
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					assert.ok(missing instanceof SessionNotFoundError, String(missing));
					assert.equal(trips.take(), 1);
					assert.deepEqual(await storedEntries(database, "s2"), []);
					assert.deepEqual(
						(await storedEntries(database, "s1")).map((row) => row.entry_id),
						["o1"],
					);
				} finally {
					await store.close();
					await other.close();
				}
			});
		});

		test("appends racing through the function on separate connections: one commits, the rest conflict, seqs stay dense (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				await migrate(scope);
				const stores = await Promise.all([0, 1, 2, 3].map(async () => SqlSessionStore.open(await open())));
				try {
					const created = await stores[0]!.create(header("s1"), []);
					await stores[0]!.append("s1", [message("m0", "start", null)], { expectSeq: 0, epoch: created.epoch });
					// The winner of each round remembers the row it wrote and races through the function; the others, whose
					// remembered row is behind, race through a transaction.
					for (let round = 0; round < 5; round++) {
						const expectSeq = 1 + round;
						const outcomes = await Promise.allSettled(
							stores.map((store, index) =>
								store.append("s1", [message(`r${round}-${index}`, `racer ${index}`, null)], {
									expectSeq,
									epoch: created.epoch,
								}),
							),
						);
						assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
						for (const outcome of outcomes)
							if (outcome.status === "rejected")
								assert.ok(outcome.reason instanceof SessionConflictError, String(outcome.reason));
					}
					const seqs = (await storedEntries(await open(), "s1")).map((row) => Number(row.seq));
					assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
					assert.equal((await stores[3]!.load("s1")).lastSeq, 6);
				} finally {
					await Promise.all(stores.map((store) => store.close()));
				}
			});
		});

		test("a write the server refuses inside the function commits nothing and fails with its own error (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				await migrate(scope);
				// Opened after the migration: an open reads the catalog the store finds the function in.
				const database = await open();
				const store = await SqlSessionStore.open(database);
				try {
					const created = await store.create(header("s1"), []);
					// A row in the way of the append's first entry, as no Atomic writer leaves one.
					await database.run(
						"INSERT INTO session_entries (session_id, seq, entry_id, entry_json, chunks) VALUES (?, ?, ?, ?, ?)",
						"s1",
						1,
						"in-the-way",
						"{}",
						0,
					);
					const trips = countRoundTrips();
					const failure = await store
						.append("s1", [message("m1", "first", null)], { expectSeq: created.lastSeq, epoch: created.epoch })
						.then(
							() => undefined,
							(error: Error) => error,
						);
					assert.equal(trips.take(), 1);
					assert.ok(failure, "the append committed");
					assert.match(causes(failure).join("\n"), /duplicate key/);
					const row = await database.get<{ last_seq: number }>(
						"SELECT last_seq FROM session_sessions WHERE id = ?",
						"s1",
					);
					assert.equal(row?.last_seq, 0);
					const searchTexts = await database.get<{ count: number }>(
						"SELECT count(*)::int AS count FROM session_search_texts WHERE session_id = ?",
						"s1",
					);
					assert.equal(searchTexts?.count, 0);
				} finally {
					await store.close();
				}
			});
		});

		test("a long entry, stored in chunks, appends through a transaction as before, and the next append through the function (#6599)", async () => {
			await withPostgresDatabase(async (scope) => {
				const { open } = scope;
				await migrate(scope);
				// Opened after the migration: an open reads the catalog the store finds the function in.
				const database = await open();
				const store = await SqlSessionStore.open(database);
				try {
					const created = await store.create(header("s1"), []);
					const long = message("m1", "x".repeat(1_200_000), null);
					const trips = countRoundTrips();
					await store.append("s1", [long], { expectSeq: 0, epoch: created.epoch });
					assert.ok(trips.take() > 1);
					await store.append("s1", [message("m2", "short", "m1")], { expectSeq: 1, epoch: created.epoch });
					assert.equal(trips.take(), 1);
					const chunks = await database.get<{ chunks: number }>(
						"SELECT chunks FROM session_entries WHERE session_id = ? AND seq = 1",
						"s1",
					);
					assert.ok(Number(chunks?.chunks) > 1);
					const version = await database.get<{ schema_version: number }>(
						"SELECT schema_version FROM session_meta",
					);
					// A new database is at the version with chunked entries and shared-history forks (#6560).
					assert.equal(Number(version?.schema_version), 3);
					const loaded = await store.load("s1");
					assert.equal((loaded.entries[0] as { message: { content: string } }).message.content.length, 1_200_000);
					assert.equal(loaded.entries[1]?.id, "m2");
				} finally {
					await store.close();
				}
			});
		});

		test("a clone of a live session shares the entries it appended through the function (#6560)", async () => {
			await withPostgresDatabase(async (scope) => {
				await migrate(scope);
				const database = await scope.open();
				const store = await SqlSessionStore.open(database);
				try {
					const parent = await SessionManager.create(store, "/work");
					const trips = countRoundTrips();
					const perAppend: number[] = [];
					for (let index = 0; index < 20; index++) {
						trips.take();
						await parent.appendMessage({ role: "user", content: `turn ${index}`, timestamp: index });
						perAppend.push(trips.take());
					}
					assert.deepEqual(new Set(perAppend), new Set([1]), "every append went through the function");

					const clone = (await parent.forkTo("/work", store)).getSessionId();

					assert.deepEqual(await storedEntries(database, clone), [], "the clone stores none of them");
					const segments = await database.all<{
						source_id: string;
						from_seq: number;
						to_seq: number;
						base_seq: number;
					}>(
						"SELECT source_id, from_seq, to_seq, base_seq FROM session_fork_segments WHERE session_id = ? ORDER BY idx",
						clone,
					);
					assert.deepEqual(
						segments.map((row) => [
							row.source_id,
							Number(row.from_seq),
							Number(row.to_seq),
							Number(row.base_seq),
						]),
						[[parent.getSessionId(), 1, 20, 0]],
					);
					assert.deepEqual((await store.load(clone)).entries, (await store.load(parent.getSessionId())).entries);
				} finally {
					await store.close();
				}
			});
		});
	},
);
/** `value` with every `epoch`, a random revision of the session's resume index, left out. */
function withoutEpochs(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutEpochs);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "epoch")
			.map(([key, inner]) => [key, withoutEpochs(inner)]),
	);
}

/** The messages of `error` and its causes. */
function causes(error: unknown): string[] {
	const messages: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
	return messages;
}
