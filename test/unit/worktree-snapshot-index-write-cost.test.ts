import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import {
	checkpointEvent,
	dropSnapshotIndex,
	messageEntry,
	openSharedSnapshotDatabase,
	type SharedSnapshotDatabase,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
const opened: SharedSnapshotDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-write-cost-"));
});
afterEach(async () => {
	while (opened.length > 0) await opened.pop()?.close();
	rmSync(directory, { recursive: true, force: true });
});

/** A snapshot whose chain has `links` distinct patches and whose bundle is another, all named by `tag`. */
const snapshotWith = (tag: string, links = 10): WorktreeSnapshot =>
	syntheticSnapshot(
		tag,
		Array.from({ length: links }, (_, index) => `${tag}-patch-${index}`),
		{ bundle: `${tag}-bundle` },
	);

interface Writers {
	readonly lease: Lease;
	readonly checkpoint: (snapshots: readonly WorktreeSnapshot[]) => Promise<unknown>;
	readonly status: () => Promise<unknown>;
	readonly entry: (entry: SessionEntry) => Promise<unknown>;
}

/** Rows SQLite changed while `action` ran on `shared`'s connection, triggers' rows included. */
async function rowsChangedBy(shared: SharedSnapshotDatabase, action: () => Promise<unknown>): Promise<number> {
	const total = async () => Number((await shared.database.get<{ n: number }>("SELECT total_changes() AS n"))?.n);
	const before = await total();
	await action();
	return (await total()) - before;
}

/** A fresh database with one run and one session, with or without its index triggers. */
async function writers(name: string, indexed: boolean): Promise<{ shared: SharedSnapshotDatabase } & Writers> {
	const shared = await openSharedSnapshotDatabase(join(directory, `${name}.sqlite`));
	opened.push(shared);
	const lease = await startRun(shared.journal, "run");
	await shared.journal.append(lease, statusEvent("run", { status: "running" }, "RunStarted"));
	const created = await shared.sessions.create(
		{ id: "session", version: 4, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" },
		[],
	);
	let lastSeq = created.lastSeq;
	if (!indexed) await dropSnapshotIndex(shared.database);
	return {
		shared,
		lease,
		checkpoint: (snapshots) => shared.journal.append(lease, checkpointEvent(snapshots)),
		status: () => shared.journal.append(lease, statusEvent("run", { status: "running" })),
		entry: async (entry) => {
			({ lastSeq } = await shared.sessions.append("session", [entry], { expectSeq: lastSeq }));
		},
	};
}

/** Index rows one write costs: what it changes with the triggers installed, less what it changes without them. */
async function indexRowsOf(write: (writers: Writers) => Promise<unknown>, prepare = async (_: Writers) => {}) {
	const costs: number[] = [];
	for (const indexed of [true, false]) {
		const set = await writers(indexed ? "indexed" : "plain", indexed);
		await prepare(set);
		costs.push(await rowsChangedBy(set.shared, () => write(set)));
	}
	return costs[0]! - costs[1]!;
}

describe("what the snapshot reference index adds to each write, in rows, counted by SQLite (#4355)", () => {
	test("a checkpoint that carries no snapshot adds no index row", async () => {
		assert.equal(await indexRowsOf(({ checkpoint }) => checkpoint([])), 0);
	});

	test("a checkpoint that carries one snapshot adds one row for each blob it needs: ten patches and a bundle", async () => {
		assert.equal(await indexRowsOf(({ checkpoint }) => checkpoint([snapshotWith("one")])), 11);
	});

	test("a later checkpoint of the same run that carries the same blobs adds none", async () => {
		const first = snapshotWith("shared");
		assert.equal(
			await indexRowsOf(
				({ checkpoint }) => checkpoint([first]),
				({ checkpoint }) => checkpoint([first]).then(() => undefined),
			),
			0,
		);
	});

	test("a status event adds one row: the run's retention state", async () => {
		assert.equal(await indexRowsOf(({ status }) => status()), 1);
	});

	test("a session entry that carries no snapshot adds no index row", async () => {
		assert.equal(await indexRowsOf(({ entry }) => entry(messageEntry("hello"))), 0);
	});

	test("a session entry that carries a snapshot record adds its reference and a row for each blob: twelve", async () => {
		const record = snapshotWith("session");
		assert.equal(await indexRowsOf(({ entry }) => entry(snapshotEntry("/repo", record.id, record))), 12);
	});

	test("a session entry that only refers to an earlier snapshot adds its reference alone", async () => {
		const record = snapshotWith("session");
		assert.equal(
			await indexRowsOf(
				({ entry }) => entry(snapshotEntry("/repo", record.id)),
				({ entry }) => entry(snapshotEntry("/repo", record.id, record)).then(() => undefined),
			),
			1,
		);
	});
});
