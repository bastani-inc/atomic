/**
 * A scan that consumes every page at once, such as an export, asks for more entries a page: the same entries in the
 * same order, still within the byte bound of a page, in a fraction of the store reads, with every page still checked
 * against the generation it started on. The default reader keeps its pages (#5554).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { readSessionHistory } from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../../packages/coding-agent/src/core/storage/session/legacy-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_HISTORY_PAGE_BYTES,
	SESSION_HISTORY_PAGE_ENTRIES,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionHistoryItem,
	type SessionHistoryReadOptions,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { countingDatabase } from "../helpers/counting-database.ts";

const createdAt = "2026-11-16T00:00:00.000Z";
const header = { id: "session", version: 4 as const, createdAt, cwd: "/project" };

function user(id: string, parentId: string | null, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
		message: { role: "user", content: text, timestamp: index },
	} as SessionEntry;
}

/**
 * 700 entries: the selected branch runs through all of them but a sibling branch of ten entries every hundred, and
 * one of its entries is larger than a page. Returns the entries and the stored position of the selected leaf.
 */
function branched(): { entries: SessionEntry[]; leaf: number } {
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	for (let i = 0; i < 700; i++) {
		if (i % 100 === 50) {
			let sibling = parent;
			for (let j = 0; j < 10; j++) {
				const id = `sibling-${i}-${j}`;
				entries.push(user(id, sibling, `sibling ${j}`, entries.length));
				sibling = id;
			}
		}
		const text =
			i === 333 ? "y".repeat(SESSION_HISTORY_PAGE_BYTES + 5) : `turn ${i} ${"x".repeat(i % 7 === 0 ? 3000 : 40)}`;
		entries.push(user(`e${i}`, parent, text, entries.length));
		parent = `e${i}`;
	}
	return { entries, leaf: entries.length };
}

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
const sqlReads = new WeakMap<SessionStore, () => number>();
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

async function openStore(kind: "memory" | "jsonl" | "sqlite" | "legacy"): Promise<SessionStore> {
	if (kind === "memory") {
		const store = new MemorySessionStore();
		closers.push(() => store.close());
		return store;
	}
	const directory = mkdtempSync(join(tmpdir(), "atomic-history-scan-"));
	directories.push(directory);
	if (kind === "legacy") {
		const store = new LegacySessionStore(new MemorySessionStore(), {
			legacyDirectory: directory,
			databasePath: join(directory, "deletions.sqlite"),
		});
		closers.push(() => store.close());
		return store;
	}
	if (kind === "jsonl") {
		const store = await JsonlSessionStore.open(join(directory, "sessions"), { exactDirectory: true });
		closers.push(() => store.close());
		return store;
	}
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const db = countingDatabase(database);
	const store = await SqlSessionStore.open(db.wrapped);
	sqlReads.set(store, () => db.statements.length);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/** The calls to each store read that `read` makes. */
async function countReads<T>(store: SessionStore, read: () => Promise<T>): Promise<[T, Record<string, number>]> {
	const counts: Record<string, number> = {};
	const names = ["readBranchSpan", "readEntrySizes", "readRange", "readScanPage", "readEntryChunk"] as const;
	const own = store as unknown as Record<string, unknown>;
	for (const name of names) {
		const original = store[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
		if (!original) continue;
		own[name] = (...args: unknown[]) => {
			counts[name] = (counts[name] ?? 0) + 1;
			return original.apply(store, args);
		};
	}
	try {
		const sql = sqlReads.get(store),
			before = sql?.();
		const result = await read();
		if (sql && before !== undefined) counts.statements = sql() - before;
		return [result, counts];
	} finally {
		for (const name of names) delete own[name];
	}
}

async function pagesOf(store: SessionStore, options: SessionHistoryReadOptions): Promise<SessionHistoryItem[][]> {
	const pages: SessionHistoryItem[][] = [];
	for await (const page of readSessionHistory(store, "session", options)) pages.push([...page.items]);
	return pages;
}

const bySeq = (a: SessionHistoryItem, b: SessionHistoryItem) => a.seq - b.seq;

const pageBytes = (page: readonly SessionHistoryItem[]) =>
	page.reduce((sum, item) => sum + ("entry" in item ? Buffer.byteLength(JSON.stringify(item.entry)) : item.bytes), 0);

describe.each(["memory", "jsonl", "sqlite", "legacy"] as const)("a scan of a %s store", (kind) => {
	it("reads the same entries in the same order as the default pages, within a page's bytes, in fewer reads (#5554)", async () => {
		const store = await openStore(kind);
		const { entries, leaf } = branched();
		await store.create(header, entries);
		for (const options of [
			{},
			{ branchLeafSeq: leaf },
			{ branchLeafSeq: leaf, fromSeq: 40, toSeq: 600 },
			{ branchLeafSeq: leaf, direction: "backward" },
			{ direction: "backward", fromSeq: 3 },
		] satisfies SessionHistoryReadOptions[]) {
			const [pages, defaultReads] = await countReads(store, () => pagesOf(store, options));
			const [scanned, scanReads] = await countReads(store, () =>
				pagesOf(store, { ...options, pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
			);

			const label = JSON.stringify(options);
			// Pages are visited newest first going backward; each holds its entries oldest first.
			const inOrder = (read: SessionHistoryItem[][]) =>
				(options.direction === "backward" ? read.toReversed() : read).flat().map((item) => item.seq);
			assert.deepEqual(inOrder(scanned), inOrder(pages), label);
			assert.ok(isDeepStrictEqual(scanned.flat().toSorted(bySeq), pages.flat().toSorted(bySeq)), label);
			assert.ok(
				pages.every((page) => page.length <= SESSION_HISTORY_PAGE_ENTRIES),
				label,
			);
			assert.ok(
				scanned.every((page) => page.length === 1 || pageBytes(page) <= SESSION_HISTORY_PAGE_BYTES),
				`${label}: a scanned page holds no more than a page's bytes`,
			);
			assert.ok(scanned.length <= pages.length, label);
			if (defaultReads.statements !== undefined) {
				// Default SQL pages size and read inside a single database snapshot, without calling readRange.
				// Count the actual database work so both routes include the reads they really performed.
				assert.ok(
					scanReads.statements! <= defaultReads.statements,
					`${label}: scan ${scanReads.statements}, ordinary ${defaultReads.statements} SQL statements`,
				);
			}
			if (defaultReads.readEntrySizes !== undefined || defaultReads.statements === undefined) {
				assert.ok((scanReads.readEntrySizes ?? 0) <= (defaultReads.readEntrySizes ?? 0), label);
				assert.ok(
					(scanReads.readRange ?? 0) + (scanReads.readScanPage ?? 0) <= (defaultReads.readRange ?? 0),
					label,
				);
			}
		}
		const [whole, wholeReads] = await countReads(store, () =>
			pagesOf(store, { pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
		);
		// Before the entry larger than a page, that entry, and after it.
		assert.equal(whole.length, 3);
		if (store.readScanPage) {
			// One read of the session's head, then one read a page, which sizes it too (#5571).
			assert.equal(wholeReads.readScanPage, 3);
			assert.equal(wholeReads.readRange ?? 0, 0);
			assert.equal(wholeReads.readEntrySizes, 1);
		} else {
			assert.equal(wholeReads.readRange, 2);
			// One read of the session's head, and the sizes read for the first page serve the other two.
			assert.equal(wholeReads.readEntrySizes, 2);
		}
		const [, branchReads] = await countReads(store, () =>
			pagesOf(store, { branchLeafSeq: leaf, pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
		);
		// The stored ancestry has fifteen runs: one before each of the seven sibling branches, the entry after each
		// fork point, and the last; each is located once, not once a page.
		assert.equal(branchReads.readBranchSpan, 15);
	});

	it("still stops when aborted and still rejects a session replaced while it is read (#5554)", async () => {
		const store = await openStore(kind);
		const { entries, leaf } = branched();
		await store.create(header, entries);
		for (const options of [{}, { branchLeafSeq: leaf }] satisfies SessionHistoryReadOptions[]) {
			const controller = new AbortController();
			const aborted = readSessionHistory(store, "session", {
				...options,
				pageEntries: SESSION_HISTORY_SCAN_ENTRIES,
				signal: controller.signal,
			});
			assert.equal((await aborted.next()).done, false);
			controller.abort();
			await assert.rejects(aborted.next(), { name: "AbortError" });

			const replaced = readSessionHistory(store, "session", {
				...options,
				pageEntries: SESSION_HISTORY_SCAN_ENTRIES,
			});
			assert.equal((await replaced.next()).done, false);
			await store.delete("session");
			await store.create(header, entries);
			await assert.rejects(async () => {
				for await (const _page of replaced);
			}, SessionConflictError);
		}
	});

	it("asks the store for more sizes only for a scan, and never more than a scan's entries (#5554)", async () => {
		const store = await openStore(kind);
		const { entries } = branched();
		await store.create(header, entries);
		assert.equal((await store.readEntrySizes!("session", 1, 5000)).sizes.length, SESSION_HISTORY_PAGE_ENTRIES);
		assert.equal((await store.readEntrySizes!("session", 1, 5000, 500)).sizes.length, 500);
		assert.equal((await store.readEntrySizes!("session", 1, 5000, 10_000)).sizes.length, entries.length);
		await assert.rejects(pagesOf(store, { pageEntries: SESSION_HISTORY_SCAN_ENTRIES + 1 }), RangeError);
		await assert.rejects(pagesOf(store, { pageEntries: 0 }), RangeError);
	});
});
