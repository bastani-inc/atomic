import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.ts";

const stamp = "2026-11-16T00:00:00.000Z";
const PAGE = 4096;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function user(id: string, parentId: string | null, lines = 1): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: stamp,
		message: {
			role: "user",
			content: Array.from({ length: lines }, (_, i) => `${id} ${i}`).join("\n"),
			timestamp: 1,
		},
	};
}

test("locates a tail-resumed compaction by saved entry without reading older history (#5250)", async () => {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 2 * PAGE + 100; i++) entries.push(user(`h${i}`, entries.at(-1)?.id ?? null, (i % 3) + 1));
	const boundary: CompactionEntry = {
		type: "compaction",
		id: "boundary",
		parentId: entries.at(-1)!.id,
		timestamp: stamp,
		summary: "summary\nsecond line",
		tokensBefore: 100,
		firstKeptEntryId: entries.at(-2)!.id,
		details: { strategy: "verbatim-lines", backend: "summary" },
	};
	entries.push(boundary, user("abandoned", "boundary", 4), user("abandoned-reply", "abandoned", 2));
	entries.push(user("active", "boundary", 3), user("active-reply", "active", 2));
	const header = {
		id: "session",
		version: 4 as const,
		createdAt: stamp,
		cwd: "/project",
		workflow: { runId: "run", stageId: "stage", stageName: "stage" },
	};
	const dir = await mkdtemp(join(tmpdir(), "tail-compaction-history-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	const db = await openNodeSqliteDatabase(join(dir, "s.sqlite"));
	cleanups.push(() => db.close());
	const store = await SqlSessionStore.open(db);
	cleanups.push(() => store.close());
	await store.create(header, entries);
	const manager = await SessionManager.open(store, "session", undefined, { history: "tail" });
	assert.equal(manager.hasFullHistory(), false);
	assert.equal(
		manager.getEntries().some((entry) => entry.id === "abandoned"),
		false,
	);
	const load = vi.spyOn(store, "load");
	const readRange = vi.spyOn(store, "readRange");

	const details: VerbatimCompactionDetails = {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "test" },
		form: "cleared",
		stats: {
			linesBefore: 2,
			linesDeleted: 2,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 10,
			percentReduction: 90,
		},
	};
	const counts: number[] = [];
	const appendBoundary = () =>
		manager.appendCompaction(
			(count) => {
				counts.push(count);
				return { text: "Context cleared.", details };
			},
			null,
			100,
			details,
		);
	const first = await appendBoundary();
	assert.deepEqual(counts, [entries.length]);
	assert.equal(manager.getEntrySeq(first), entries.length + 1);
	const append = manager.appendMessage({ role: "user", content: "later\nnote", timestamp: 2 });
	const boundaryAppend = appendBoundary();
	await Promise.all([append, boundaryAppend]);
	assert.deepEqual(counts, [entries.length, entries.length + 2]);
	assert.equal(manager.hasFullHistory(), false);
	assert.equal(load.mock.calls.length, 0);
	assert.equal(readRange.mock.calls.length, 0);
});
