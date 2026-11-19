/**
 * A JSONL export of a resumed session streams the selected ancestry from the store instead of loading the whole
 * session into the manager, and writes the bytes main's full-history export writes (#5554).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { exportToJsonl } from "../src/core/agent-session-export.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getBranchPath } from "../src/core/session-manager-history.ts";
import { inlineToolOutput, TOOL_OUTPUT_ENTRY_TYPE, withoutInlineToolOutput } from "../src/core/session-tool-output.ts";
import { inlineSnapshotBlobs, sessionSnapshotBlobs } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { SESSION_HISTORY_PAGE_BYTES, type SessionStore } from "../src/core/storage/session/types.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-export-jsonl-window-"));
	directories.push(directory);
	return directory;
}

type StoreKind = "memory" | "jsonl" | "sqlite";

async function openStore(kind: StoreKind, directory: string): Promise<SessionStore> {
	if (kind === "memory") {
		const store = new MemorySessionStore();
		closers.push(() => store.close());
		return store;
	}
	if (kind === "jsonl") {
		const store = await JsonlSessionStore.open(join(directory, "sessions"), { exactDirectory: true });
		closers.push(() => store.close());
		return store;
	}
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

const SESSION = "01a1f50b-074b-7715-aa80-f62a14fe3a0a";
const createdAt = "2026-11-16T00:00:00.000Z";
const at = (index: number) => new Date(Date.parse(createdAt) + index * 1000).toISOString();
const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const base64 = (data: string) => Buffer.from(data).toString("base64");

const PATCH_A = "patch A\n";
const PATCH_B = "patch B\n";
const PATCH_C = "patch C\n";
const PATCH_D = "patch D, kept nowhere\n";
const OUTPUT = `BEGIN\n${"exported output ".repeat(512)}\nEND`;
const OFF_BRANCH = "off-branch-5554-marker";

function record(id: string, patches: readonly string[]): WorktreeSnapshot {
	return {
		version: 1,
		id,
		root: "/repo",
		remotes: [],
		branch: "main",
		head: "1".repeat(40),
		snapshot: "2".repeat(40),
		tree: "3".repeat(40),
		envHash: "env",
		delta: { base: "head", patch: sha256(patches.at(-1)!), bytes: patches.at(-1)!.length },
		chain: patches.map((patch, i) => ({ tree: `${i}`.repeat(40), patch: sha256(patch), bytes: patch.length })),
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: createdAt,
	};
}

function user(id: string, parentId: string | null, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(index),
		message: { role: "user", content: text, timestamp: index },
	} as SessionEntry;
}

function assistant(id: string, parentId: string, text: string, index: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: at(index),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "test",
			model: "model",
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: index,
		},
	} as SessionEntry;
}

function snapshotEntry(
	id: string,
	parentId: string,
	snapshotId: string,
	index: number,
	carried: { snapshot?: WorktreeSnapshot; blobs?: Record<string, string> } = {},
): SessionEntry {
	return {
		type: "worktree_snapshot",
		id,
		parentId,
		timestamp: at(index),
		root: "/repo",
		snapshotId,
		...carried,
	} as SessionEntry;
}

/**
 * A compacted session with a sibling branch and entries larger than a history page on and off the selected branch.
 * The selected branch records snapshot S1 with its patch inline, records it again as unchanged after the boundary,
 * keeps a tool output as a session blob, and records snapshot S3 whose second patch is in the store's own blob table
 * where it has one.
 */
async function seed(
	kind: StoreKind,
	store: SessionStore,
	options: { readonly crossBranch?: boolean } = {},
): Promise<readonly SessionEntry[]> {
	const large = "y".repeat(SESSION_HISTORY_PAGE_BYTES + 17);
	const hasPrimary = store.snapshotBlobs !== undefined;
	const entries: SessionEntry[] = [
		{ type: "model_change", id: "m0", parentId: null, timestamp: at(0), provider: "test", modelId: "model" },
		user("u0", "m0", "first question", 1),
		snapshotEntry("w1", "u0", "S1", 2, {
			snapshot: record("S1", [PATCH_A]),
			blobs: { [sha256(PATCH_A)]: base64(PATCH_A) },
		}),
		assistant("a0", "w1", `archived ${large}`, 3),
		user("x0", "u0", `${OFF_BRANCH} question`, 4),
		assistant("x1", "x0", `${OFF_BRANCH} ${large}`, 5),
		user("u1", "a0", "second question", 6),
		snapshotEntry("w2", "u1", "S1", 7),
		{
			type: "custom",
			id: "t1",
			parentId: "w2",
			timestamp: at(8),
			customType: TOOL_OUTPUT_ENTRY_TYPE,
			data: { toolCallId: "call-1", hash: sha256(OUTPUT), bytes: Buffer.byteLength(OUTPUT) },
		} as SessionEntry,
		user("k0", "t1", "kept question", 9),
		assistant("a1", "k0", "kept answer", 10),
		{
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: at(11),
			summary: "compacted",
			firstKeptEntryId: "k0",
			tokensBefore: 1000,
			details: { strategy: "verbatim-lines" },
		} as SessionEntry,
		user("u2", "c1", "after question", 12),
		assistant("a2", "u2", "after answer", 13),
		snapshotEntry("w3", "a2", "S3", 14, {
			snapshot: record("S3", [PATCH_A, PATCH_C]),
			...(hasPrimary ? {} : { blobs: { [sha256(PATCH_C)]: base64(PATCH_C) } }),
		}),
	];
	if (options.crossBranch)
		entries.push(
			// Recorded on the sibling branch only, with its second patch inline there.
			snapshotEntry("x2", "x0", "S2", 15, {
				snapshot: record("S2", [PATCH_A, PATCH_B]),
				blobs: { [sha256(PATCH_B)]: base64(PATCH_B) },
			}),
			snapshotEntry("w4", "w3", "S2", 16),
			snapshotEntry("w5", "w4", "S4", 17, { snapshot: record("S4", [PATCH_D]) }),
			assistant("a3", "w5", "last answer", 18),
		);
	await store.create({ id: SESSION, version: 4, createdAt, cwd: "/project" }, entries);
	if (hasPrimary) await store.snapshotBlobs!.putBlobs([{ hash: sha256(PATCH_C), data: Buffer.from(PATCH_C) }]);
	if (kind !== "jsonl") await store.putBlob!(SESSION, Buffer.from(OUTPUT));
	return entries;
}

const OFF_BRANCH_SEQS = [5, 6];

/** Every stored sequence the store was asked for the body of, through any read. */
function observeBodyReads(store: SessionStore): { readonly seqs: Set<number>; loads: number } {
	const observed = { seqs: new Set<number>(), loads: 0 };
	const readRange = store.readRange?.bind(store);
	if (readRange)
		store.readRange = (sessionId, start, end, epoch) => {
			for (let seq = start; seq <= Math.min(end, 1000); seq++) observed.seqs.add(seq);
			return readRange(sessionId, start, end, epoch);
		};
	const readEntryChunk = store.readEntryChunk?.bind(store);
	if (readEntryChunk)
		store.readEntryChunk = (reference, offset) => {
			observed.seqs.add(reference.seq);
			return readEntryChunk(reference, offset);
		};
	const load = store.load.bind(store);
	store.load = (sessionId) => {
		observed.loads++;
		return load(sessionId);
	};
	return observed;
}

interface ExportOptions {
	readonly includeShareContext?: boolean;
	readonly snapshotContent?: boolean;
	readonly toolOutputContent?: boolean;
}

/** The export as the session's agent runs it. */
async function exportManager(manager: SessionManager, path: string, options: ExportOptions = {}): Promise<string> {
	const surface = { sessionManager: manager, systemPrompt: "system", agent: { state: { tools: [] } } };
	return exportToJsonl.call(surface as never, path, options);
}

/**
 * The lines main's export writes after the header: the whole session loaded, the branch to `leafId`, snapshot records
 * and inline blobs from every entry, and tool outputs from the store, re-chained into one line of descent.
 */
async function mainExportLines(
	store: SessionStore,
	leafId: string | null,
	options: ExportOptions = {},
	edit: (entries: readonly SessionEntry[]) => void = () => {},
): Promise<string[]> {
	const { entries } = await store.load(SESSION);
	edit(entries);
	const records = new Map<string, WorktreeSnapshot>();
	for (const entry of entries)
		if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
	const branch = getBranchPath(leafId, new Map(entries.map((entry) => [entry.id, entry])));
	const snapshotEntries = await inlineSnapshotBlobs(
		branch,
		records,
		options.snapshotContent === false ? undefined : sessionSnapshotBlobs(store.snapshotBlobs, entries),
	);
	const lines: string[] = [];
	let prevId: string | null = null;
	for await (const entry of options.toolOutputContent === false
		? withoutInlineToolOutput(snapshotEntries)
		: inlineToolOutput(snapshotEntries, store, SESSION)) {
		lines.push(JSON.stringify({ ...entry, parentId: prevId }));
		prevId = entry.id;
	}
	return lines;
}

function exportedLines(path: string): { header: Record<string, unknown>; lines: string[] } {
	const [header, ...lines] = readFileSync(path, "utf8").split("\n");
	assert.equal(lines.pop(), "", "the file ends with a line break");
	return { header: JSON.parse(header!) as Record<string, unknown>, lines };
}

describe.each(["memory", "jsonl", "sqlite"] as const)("a JSONL export from a %s store", (kind) => {
	test("streams the selected ancestry of a resumed session, leaving the window as it was, in main's bytes (#5554)", async () => {
		const directory = temporaryDirectory();
		const store = await openStore(kind, directory);
		await seed(kind, store);
		const manager = await SessionManager.open(store, SESSION);
		assert.equal(manager.hasFullHistory(), false, "the resumed session holds only its window");
		const held = manager.getEntries().length;
		const reads = observeBodyReads(store);

		for (const options of [{}, { snapshotContent: false, toolOutputContent: false }] as const) {
			const path = await exportManager(
				manager,
				join(directory, `export-${Object.keys(options).length}.jsonl`),
				options,
			);

			const { header, lines } = exportedLines(path);
			assert.deepEqual(
				{ ...header, createdAt: undefined },
				{ type: "session", version: 4, id: SESSION, createdAt: undefined, cwd: manager.getCwd() },
			);
			assert.deepEqual(lines, await mainExportLines(store, manager.getLeafId(), options));
			assert.equal(lines.join("\n").includes(OFF_BRANCH), false);
		}
		reads.loads = 0;
		reads.seqs.clear();
		await exportManager(manager, join(directory, "observed.jsonl"));

		assert.equal(manager.hasFullHistory(), false, "the export did not load the whole session");
		assert.equal(manager.getEntries().length, held, "the export added no archived entry to the manager");
		assert.equal(reads.loads, 0, "the export did not load the whole session from the store");
		assert.deepEqual(
			OFF_BRANCH_SEQS.filter((seq) => reads.seqs.has(seq)),
			[],
			"the export read no entry off the selected branch",
		);
	});

	test("carries a snapshot record and content recorded only off the selected branch, as main does, reading the rest of the session at most once (#5554)", async () => {
		const directory = temporaryDirectory();
		const store = await openStore(kind, directory);
		await seed(kind, store, { crossBranch: true });
		const manager = await SessionManager.open(store, SESSION);
		assert.equal(manager.getLeafId(), "a3");
		assert.equal(manager.hasFullHistory(), false);
		const held = manager.getEntries().length;
		const reads = observeBodyReads(store);
		const sibling = store.readRange!.bind(store);
		let siblingReads = 0;
		store.readRange = (sessionId, start, end, epoch) => {
			if (start <= 5 && end >= 5) siblingReads++;
			return sibling(sessionId, start, end, epoch);
		};

		const { lines } = exportedLines(await exportManager(manager, join(directory, "cross.jsonl")));

		const s2 = lines.map((line) => JSON.parse(line) as SessionEntry).find((entry) => entry.id === "w4");
		assert.ok(s2?.type === "worktree_snapshot");
		assert.equal(s2.snapshot?.id, "S2");
		assert.deepEqual(s2.blobs, { [sha256(PATCH_B)]: base64(PATCH_B) });
		// At most once for all three lookups; a store that indexes its snapshot entries reads none of the sibling's.
		assert.ok(siblingReads <= 1, `the rest of the session was read ${siblingReads} times`);
		assert.equal(reads.loads, 0);
		assert.equal(manager.hasFullHistory(), false);
		assert.equal(manager.getEntries().length, held);
		assert.deepEqual(lines, await mainExportLines(store, "a3"));
	});

	test("writes an archived leaf's ancestry and the caller's edits to held entries, as main does (#5554)", async () => {
		const directory = temporaryDirectory();
		const store = await openStore(kind, directory);
		await seed(kind, store);
		const manager = await SessionManager.open(store, SESSION);
		const kept = manager.getEntries().find((entry) => entry.id === "a2");
		assert.ok(kept?.type === "message" && kept.message.role === "assistant");
		kept.message.content = [{ type: "text", text: "edited by an SDK caller" }];
		const edit = (entries: readonly SessionEntry[]) => {
			const stored = entries.find((entry) => entry.id === "a2");
			assert.ok(stored?.type === "message" && stored.message.role === "assistant");
			stored.message.content = [{ type: "text", text: "edited by an SDK caller" }];
		};

		const edited = exportedLines(await exportManager(manager, join(directory, "edited.jsonl")));
		assert.deepEqual(edited.lines, await mainExportLines(store, "w3", {}, edit));
		assert.ok(edited.lines.join("\n").includes("edited by an SDK caller"));

		await manager.branch("u1");
		const archived = exportedLines(
			await exportManager(manager, join(directory, "archived.jsonl"), { includeShareContext: true }),
		);
		const share = JSON.parse(archived.lines.pop()!) as { customType: string; parentId: string | null };
		assert.equal(share.customType, "atomic.share");
		assert.equal(share.parentId, "u1");
		assert.deepEqual(archived.lines, await mainExportLines(store, "u1"));
	});

	test("reads no stored entry for a session the manager holds whole, as main did not (#5554)", async () => {
		const directory = temporaryDirectory();
		const store = await openStore(kind, directory);
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
		await manager.appendMessage({ role: "user", content: "follow-up", timestamp: 2 });
		assert.equal(manager.hasFullHistory(), true);
		const reads = observeBodyReads(store);

		const { lines } = exportedLines(await exportManager(manager, join(directory, "whole.jsonl")));

		assert.equal(lines.length, 2);
		assert.equal(reads.loads, 0);
		assert.deepEqual([...reads.seqs], []);
	});

	test("an export whose archive read fails part way leaves the file it was to replace as it was (#5554)", async () => {
		const directory = temporaryDirectory();
		const store = await openStore(kind, directory);
		await seed(kind, store);
		const manager = await SessionManager.open(store, SESSION);
		const target = join(directory, "export.jsonl");
		writeFileSync(target, "previous export");
		const failure = new Error("archive read failed");
		const readRange = store.readRange!.bind(store);
		store.readRange = (sessionId, start, end, epoch) =>
			start <= 7 && end >= 7 ? Promise.reject(failure) : readRange(sessionId, start, end, epoch);
		// A SQL store reads a scan's pages in one read each (#5571).
		const readScanPage = store.readScanPage?.bind(store);
		if (readScanPage)
			store.readScanPage = (sessionId, start, end, epoch, limit) =>
				start <= 7 && end >= 7 ? Promise.reject(failure) : readScanPage(sessionId, start, end, epoch, limit);

		await assert.rejects(exportManager(manager, target), (error) => error === failure);

		assert.equal(readFileSync(target, "utf8"), "previous export");
		assert.deepEqual(
			readdirSync(directory).filter((name) => name.endsWith(".partial")),
			[],
		);
	});
});
