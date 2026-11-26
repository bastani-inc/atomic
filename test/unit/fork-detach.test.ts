import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	detachFork,
	detachForkChildren,
	type ForkDetachHost,
	resumeForkDetaches,
} from "../../packages/coding-agent/src/core/storage/session/fork-detach.js";
import { deleteForkedSessionWithin } from "../../packages/coding-agent/src/core/storage/session/fork-pins.js";
import { type ForkSegment, forkPieces } from "../../packages/coding-agent/src/core/storage/session/fork-segments.js";
import { sweepForkTombstones } from "../../packages/coding-agent/src/core/storage/session/fork-sweep.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Detaching forks that share their parent's history, against a small store kept in SQLite: sessions with their own
 * rows and fork segments in the shape the session store keeps them, so each transaction of a detach commits or rolls
 * back as it would there, and a crash is a process that stops after a commit.
 */

let directory: string;
let database: SqliteDatabase;

beforeEach(async () => {
	directory = makeTempDirectory("fork-detach-");
	database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	await database.exec(`
		CREATE TABLE sessions (id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, epoch TEXT NOT NULL);
		CREATE TABLE entries (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, seq));
		CREATE TABLE entry_chunks (session_id TEXT NOT NULL, seq INTEGER NOT NULL);
		CREATE TABLE search_texts (session_id TEXT NOT NULL, seq INTEGER NOT NULL);
		CREATE TABLE blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL);
		CREATE TABLE blob_chunks (session_id TEXT NOT NULL, hash TEXT NOT NULL);
		CREATE TABLE fork_segments (
			session_id TEXT NOT NULL, idx INTEGER NOT NULL, source_id TEXT NOT NULL,
			from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, base_seq INTEGER NOT NULL, PRIMARY KEY(session_id, idx)
		);
		CREATE TABLE fork_lineage (session_id TEXT NOT NULL PRIMARY KEY);
		CREATE TABLE fork_tombstones (session_id TEXT NOT NULL PRIMARY KEY, deleted_at TEXT NOT NULL);
		CREATE TABLE fork_detach (
			parent_id TEXT NOT NULL, child_id TEXT NOT NULL, reparent INTEGER NOT NULL,
			original_segments TEXT NOT NULL, parent_epoch TEXT, child_epoch TEXT, PRIMARY KEY(parent_id, child_id)
		);
	`);
});

afterEach(async () => {
	await database.close();
	removeTempDirectory(directory);
});

class Crash extends Error {}

/** The store's hooks over the tables above; `crashAfterCommits` stops the process after that many more commits. */
function storeHost(): ForkDetachHost & { crashAfterCommits?: number; commits: number } {
	const segmentsOf = async (tx: SqliteExecutor, id: string): Promise<ForkSegment[]> =>
		(
			await tx.all<{ source_id: string; from_seq: number; to_seq: number; base_seq: number }>(
				"SELECT source_id, from_seq, to_seq, base_seq FROM fork_segments WHERE session_id = ? ORDER BY base_seq",
				id,
			)
		).map((row) => ({
			sourceId: row.source_id,
			fromSeq: Number(row.from_seq),
			toSeq: Number(row.to_seq),
			baseSeq: Number(row.base_seq),
		}));
	const host: ForkDetachHost & { crashAfterCommits?: number; commits: number } = {
		commits: 0,
		forkDetachTable: "fork_detach",
		pinTables: {
			entries: "entries",
			entryChunks: "entry_chunks",
			blobs: "blobs",
			blobChunks: "blob_chunks",
			searchTexts: "search_texts",
			tombstones: "fork_tombstones",
			forkSegments: "fork_segments",
			forkLineage: "fork_lineage",
		},
		async forkTransaction(body) {
			const result = await database.transaction(body);
			host.commits++;
			if (host.crashAfterCommits !== undefined && --host.crashAfterCommits < 0) throw new Crash("crashed");
			return result;
		},
		forkSegments: segmentsOf,
		async forkChildren(tx, sourceId) {
			const rows = await tx.all<{ session_id: string }>(
				"SELECT DISTINCT session_id FROM fork_segments WHERE source_id = ? ORDER BY session_id",
				sourceId,
			);
			return rows.map((row) => row.session_id);
		},
		async materializeForkSegments(tx, childId, pieces) {
			const remaining: ForkSegment[] = [];
			for (const segment of await segmentsOf(tx, childId)) {
				const piece = pieces.find(
					(candidate) =>
						candidate.sourceId === segment.sourceId &&
						candidate.fromSeq >= segment.fromSeq &&
						candidate.toSeq <= segment.toSeq &&
						candidate.baseSeq - candidate.fromSeq === segment.baseSeq - segment.fromSeq,
				);
				if (piece === undefined) {
					remaining.push(segment);
					continue;
				}
				if (piece.fromSeq > segment.fromSeq) remaining.push({ ...segment, toSeq: piece.fromSeq - 1 });
				if (piece.toSeq < segment.toSeq)
					remaining.push({
						...segment,
						fromSeq: piece.toSeq + 1,
						baseSeq: segment.baseSeq + (piece.toSeq + 1 - segment.fromSeq),
					});
			}
			for (const segment of pieces) {
				const { changes } = await tx.run(
					"INSERT INTO entries (session_id, seq, body) SELECT ?, seq - ? + ?, body FROM entries WHERE session_id = ? AND seq BETWEEN ? AND ?",
					childId,
					segment.fromSeq,
					segment.baseSeq + 1,
					segment.sourceId,
					segment.fromSeq,
					segment.toSeq,
				);
				assert.equal(
					Number(changes),
					segment.toSeq - segment.fromSeq + 1,
					"a source keeps every row a segment names",
				);
			}
			await host.writeForkSegments(tx, childId, remaining);
		},
		async writeForkSegments(tx, sessionId, segments) {
			await tx.run("DELETE FROM fork_segments WHERE session_id = ?", sessionId);
			for (const [idx, segment] of segments.entries())
				await tx.run(
					"INSERT INTO fork_segments (session_id, idx, source_id, from_seq, to_seq, base_seq) VALUES (?, ?, ?, ?, ?, ?)",
					sessionId,
					idx,
					segment.sourceId,
					segment.fromSeq,
					segment.toSeq,
					segment.baseSeq,
				);
		},
		async lockForkSources() {
			// One SQLite writer at a time.
		},
		async forkRewriteEpoch(tx, sessionId) {
			return (await tx.get<{ epoch: string }>("SELECT epoch FROM sessions WHERE id = ?", sessionId))?.epoch;
		},
	};
	return host;
}

/** A session of `own` rows of its own. */
async function session(id: string, own: number): Promise<void> {
	await database.run("INSERT INTO sessions (id, last_seq, epoch) VALUES (?, ?, 'e1')", id, own);
	for (let seq = 1; seq <= own; seq++)
		await database.run("INSERT INTO entries (session_id, seq, body) VALUES (?, ?, ?)", id, seq, `${id}:${seq}`);
}

/** A fork of `parent`'s first `cut` seqs, with `own` rows after them, composed the way the store composes it. */
async function fork(id: string, parent: string, cut: number, own: number): Promise<void> {
	const parentSegments = await storeHost().forkSegments(database, parent);
	const segments = forkPieces(parent, parentSegments, 1, cut).map((piece) => ({
		sourceId: piece.sessionId,
		fromSeq: piece.fromSeq,
		toSeq: piece.toSeq,
		baseSeq: piece.firstSeq - 1,
	}));
	await database.run("INSERT INTO sessions (id, last_seq, epoch) VALUES (?, ?, 'e1')", id, cut + own);
	await storeHost().writeForkSegments(database, id, segments);
	for (let seq = cut + 1; seq <= cut + own; seq++)
		await database.run("INSERT INTO entries (session_id, seq, body) VALUES (?, ?, ?)", id, seq, `${id}:${seq}`);
}

/** What a read of the whole session returns: its seqs resolved through its segments. */
async function view(id: string): Promise<string[]> {
	const lastSeq = (await database.get<{ last_seq: number }>("SELECT last_seq FROM sessions WHERE id = ?", id))!
		.last_seq;
	const segments = await storeHost().forkSegments(database, id);
	const bodies: string[] = [];
	for (const piece of forkPieces(id, segments, 1, Number(lastSeq))) {
		const rows = await database.all<{ body: string }>(
			"SELECT body FROM entries WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
			piece.sessionId,
			piece.fromSeq,
			piece.toSeq,
		);
		assert.equal(
			rows.length,
			piece.toSeq - piece.fromSeq + 1,
			`${id} reads every seq ${piece.fromSeq}-${piece.toSeq}`,
		);
		bodies.push(...rows.map((row) => row.body));
	}
	return bodies;
}

async function rowCount(): Promise<number> {
	return Number((await database.get<{ n: number }>("SELECT count(*) AS n FROM entries"))!.n);
}

/** Deletes a session's own rows and its sessions row, as deleting it does once nothing reads them. */
async function removeSession(id: string): Promise<void> {
	await database.run("DELETE FROM entries WHERE session_id = ?", id);
	await database.run("DELETE FROM sessions WHERE id = ?", id);
}

test("a detach stopped after any page resumes, and the fork reads the same at every commit", async () => {
	await session("A", 4);
	await fork("P", "A", 3, 5);
	await fork("C", "P", 7, 2);
	const expected = ["A:1", "A:2", "A:3", "P:4", "P:5", "P:6", "P:7", "C:8", "C:9"];
	assert.deepEqual(await view("C"), expected);
	const host = storeHost();
	// Pages of 2 rows over C's 4 rows of P: a start, two pages and a sweep.
	for (let commits = 0; ; commits++) {
		host.crashAfterCommits = commits;
		const finished = await detachFork(host, "P", "C", { pageRows: 2 }).then(
			() => true,
			(error: Error) => {
				if (!(error instanceof Crash)) throw error;
				return false;
			},
		);
		assert.deepEqual(await view("C"), expected, `C after ${commits + 1} commits`);
		if (finished) break;
		assert.ok(commits < 10, "the detach finishes");
	}
	host.crashAfterCommits = undefined;
	assert.deepEqual(await resumeForkDetaches(host), { detached: [], reparented: [] });
	assert.deepEqual(await host.forkSegments(database, "C"), [{ sourceId: "A", fromSeq: 1, toSeq: 3, baseSeq: 0 }]);
	// P's rows can go: C reads only its own and A's.
	await removeSession("P");
	assert.deepEqual(await view("C"), expected);
});

test("a detach a crash stopped is finished by resumeForkDetaches, with the siblings it was to re-point", async () => {
	await session("P", 6);
	await fork("C", "P", 5, 1);
	await fork("S", "P", 4, 1);
	const host = storeHost();
	host.crashAfterCommits = 1; // the start and one page commit, then the process stops
	await assert.rejects(detachFork(host, "P", "C", { pageRows: 2 }), Crash);
	host.crashAfterCommits = undefined;
	assert.deepEqual(await resumeForkDetaches(host), { detached: ["C"], reparented: ["S"] });
	assert.deepEqual(await host.forkChildren(database, "P"), []);
	await removeSession("P");
	assert.deepEqual(await view("C"), ["P:1", "P:2", "P:3", "P:4", "P:5", "C:6"]);
	assert.deepEqual(await view("S"), ["P:1", "P:2", "P:3", "P:4", "S:5"]);
});

test("detaching 50 sibling forks copies the parent's rows once and re-points the rest", async () => {
	await session("P", 40);
	await fork("C", "P", 30, 1);
	const siblings = Array.from({ length: 50 }, (_, index) => `S${String(index).padStart(2, "0")}`);
	for (const [index, id] of siblings.entries()) await fork(id, "P", 1 + (index % 30), 2);
	const before = new Map<string, string[]>();
	for (const id of ["C", ...siblings]) before.set(id, await view(id));
	const rows = await rowCount();

	const report = await detachForkChildren(storeHost(), "P");

	assert.deepEqual(report.detached, ["C"], "the fork holding most of P's rows copies them");
	assert.deepEqual([...report.reparented].sort(), siblings);
	assert.equal(await rowCount(), rows + 30, "C's copy, and nothing for the 50 re-pointed forks");
	await removeSession("P");
	for (const [id, bodies] of before) assert.deepEqual(await view(id), bodies, id);
});

test("a parent rewritten during a detach keeps its other forks off the child's copy", async () => {
	await session("P", 6);
	await fork("C", "P", 5, 1);
	await fork("S", "P", 3, 1);
	const host = storeHost();
	host.crashAfterCommits = 0; // only the start commits
	await assert.rejects(detachFork(host, "P", "C", { pageRows: 2 }), Crash);
	// P's replace, between the start and the end, gives its forks their copies first and starts a new epoch.
	await database.run("UPDATE sessions SET epoch = 'e2' WHERE id = 'P'");
	host.crashAfterCommits = undefined;
	assert.deepEqual(await resumeForkDetaches(host), { detached: ["C"], reparented: [] });
	assert.deepEqual(await host.forkSegments(database, "S"), [{ sourceId: "P", fromSeq: 1, toSeq: 3, baseSeq: 0 }]);
});

test("a deleted parent's rows stay while a fork reads them and are swept once its last reader is detached", async () => {
	await session("P", 4);
	await fork("C", "P", 3, 1);
	const host = storeHost();
	assert.equal(
		(await database.transaction((tx) => deleteForkedSessionWithin(host, tx, "P", "2026-11-25T00:00:00.000Z")))
			.keepRows,
		true,
	);
	await database.run("DELETE FROM sessions WHERE id = 'P'");
	assert.deepEqual(await view("C"), ["P:1", "P:2", "P:3", "C:4"]);
	await detachFork(host, "P", "C");
	assert.deepEqual(await view("C"), ["P:1", "P:2", "P:3", "C:4"]);
	assert.deepEqual(await sweepForkTombstones(host, ["P"], { batchEntries: 2 }), ["P"]);
	assert.equal(
		Number((await database.get<{ n: number }>("SELECT count(*) AS n FROM entries WHERE session_id = 'P'"))!.n),
		0,
	);
	assert.equal(await database.get("SELECT session_id FROM fork_tombstones"), undefined);
});
