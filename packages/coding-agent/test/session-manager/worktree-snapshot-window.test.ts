import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { exportToJsonl } from "../../src/core/agent-session-export.ts";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SessionEntry } from "../../src/core/session-manager-types.ts";
import {
	archivedSnapshotBlobs,
	currentWorktreeSnapshots,
	degradedRestorePin,
	describeExportedSnapshots,
	describeLastCapture,
	describeSnapshotExport,
	describeWorktreeRestoreStatus,
	lapsedDegradedRestores,
	latestRestoreTargets,
	missingSnapshotRecords,
	sessionManagerRunsInRecordedCheckout,
	sessionSnapshotBlobs,
	worktreeRestoreNotices,
} from "../../src/core/session-worktree-snapshots.ts";
import { StorageUnavailableError } from "../../src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";
import { sha256Hex } from "../../src/core/worktree-snapshot/env-hash.js";
import type { WorktreeRootMapping, WorktreeSnapshot } from "../../src/core/worktree-snapshot/types.js";

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 6,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "atomic-snapshot-window-"));
	directories.push(path);
	return path;
}

const stores: Record<string, () => Promise<SessionStore>> = {
	sql: async () => {
		const database = await openNodeSqliteDatabase(join(directory(), "sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		closers.push(async () => {
			await store.close();
			await database.close();
		});
		return store;
	},
	jsonl: async () => {
		const store = await JsonlSessionStore.open(directory(), { exactDirectory: true, scanExisting: false });
		closers.push(() => store.close());
		return store;
	},
	memory: async () => new MemorySessionStore(),
};

const A = "/work/repo-a";
const B = "/work/repo-b";
const RESTORED = "/host/worktrees/repo-a";

/** `store`, and how many entries its reads have returned since the count was last taken. */
function counting(store: SessionStore): { readonly store: SessionStore; read(): number } {
	let entries = 0;
	const counts: Record<string, (result: never) => number> = {
		load: (result: { entries: unknown[] }) => result.entries.length,
		readRange: (result: { entries: unknown[] }) => result.entries.length,
		readEntryRange: (result: { entries: unknown[] }) => result.entries.length,
		readSelectedPage: (result: { items: unknown[] }) => result.items.length,
		readTail: (result: { entries: unknown[]; state: unknown[] }) => result.entries.length + result.state.length,
		readResume: (result: { branch: unknown[]; state: unknown[] }) => result.branch.length + result.state.length,
		readResumeAt: (result: { branch: unknown[]; state: unknown[] }) => result.branch.length + result.state.length,
	};
	const counted = new Proxy(store, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			const count = typeof key === "string" ? counts[key] : undefined;
			if (count === undefined) return value.bind(target);
			return async (...args: unknown[]) => {
				const result = await value.apply(target, args);
				entries += count(result as never);
				return result;
			};
		},
	});
	return {
		store: counted,
		read: () => {
			const read = entries;
			entries = 0;
			return read;
		},
	};
}

async function snapshotEntries(
	pages: AsyncIterable<readonly { readonly entry: SessionEntry }[]>,
	direction: "forward" | "backward" = "forward",
): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	for await (const page of pages)
		if (direction === "forward") entries.push(...page.map(({ entry }) => entry));
		else entries.unshift(...page.map(({ entry }) => entry));
	return entries;
}

let copies = 0;
/**
 * What `{ history: "full" }` returned before it was removed: a manager holding every stored entry. The same entries
 * are saved again under another id, in the same store and its snapshot blobs, with each boundary turned into a plain
 * message, so the reopened copy retires nothing. No worktree reading depends on a boundary.
 */
async function wholeHistory(store: SessionStore, id: string): Promise<SessionManager> {
	const { header, entries } = await store.load(id);
	const copy = `${id}-whole-${++copies}`;
	await store.create(
		{ ...header, id: copy },
		entries.map((entry): SessionEntry => {
			if (entry.type !== "compaction") return entry;
			const { id, parentId, timestamp } = entry;
			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message: { role: "user", content: "boundary", timestamp: 0 },
			};
		}),
	);
	const manager = await SessionManager.open(store, copy);
	expect(manager.hasFullHistory()).toBe(true);
	return manager;
}

/** A snapshot record whose patch the store holds, as a capture leaves it. */
async function record(store: SessionStore, id: string, root: string, index: number): Promise<WorktreeSnapshot> {
	const data = new TextEncoder().encode(`patch of ${id}`);
	const patch = sha256Hex(data);
	await store.snapshotBlobs?.putBlobs([{ hash: patch, data }]);
	return {
		version: 1,
		id,
		root,
		remotes: [],
		branch: "main",
		head: index.toString(16).padStart(40, "0"),
		snapshot: "s".repeat(40),
		tree: id.padEnd(40, "t"),
		envHash: "e",
		delta: { base: "head", patch, bytes: data.length },
		chain: [{ base: "head", patch, bytes: data.length }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: new Date(index * 1000).toISOString(),
	} as unknown as WorktreeSnapshot;
}

function restore(from: string, to: string, snapshotId: string, degraded = false): WorktreeRootMapping {
	return {
		from,
		to,
		snapshotId,
		tree: snapshotId.padEnd(40, "t"),
		restoredAt: new Date(10_000_000).toISOString(),
		...(degraded
			? {
					degraded: {
						stage: "closest-commit",
						head: "c".repeat(40),
						tree: "d".repeat(40),
						basis: "earlier-snapshot",
						missingLinks: [0],
						missingPaths: ["file.txt"],
						missingCommits: [],
						cause: "blob-missing",
						hint: "recapture",
					},
				}
			: {}),
	} as WorktreeRootMapping;
}

/**
 * A session that recorded `turns` new snapshots of A, references back to earlier ones, two snapshots of B, a degraded
 * restore of A whose pin later captures keep naming, and a compaction after all of it.
 */
async function snapshotHistory(store: SessionStore, turns: number): Promise<{ id: string; ids: string[] }> {
	const writer = await SessionManager.create(store, A);
	const ids: string[] = [];
	await writer.appendWorktreeSnapshot(B, "b-0", await record(store, "b-0", B, 0), undefined, [], undefined, 5);
	for (let turn = 0; turn < turns; turn++) {
		await writer.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: turn });
		const id = `a-${turn}`;
		ids.push(id);
		await writer.appendWorktreeSnapshot(A, id, await record(store, id, A, turn), undefined, [], undefined, turn);
		// An unchanged capture refers back to an earlier snapshot of the checkout.
		if (turn % 7 === 6)
			await writer.appendWorktreeSnapshot(A, `a-${turn - 3}`, undefined, undefined, [], undefined, 1);
	}
	await writer.appendWorktreeSnapshot(B, "b-1", await record(store, "b-1", B, 1));
	await writer.appendWorktreeSnapshot(B, "b-0", undefined);
	const pinned = ids[ids.length - 4]!;
	await writer.appendWorktreeSnapshot(RESTORED, pinned, undefined, restore(A, RESTORED, pinned, true));
	await writer.appendWorktreeSnapshot(
		RESTORED,
		"w-1",
		await record(store, "w-1", RESTORED, 900),
		undefined,
		[],
		undefined,
		7,
		pinned,
	);
	await writer.appendMessage({ role: "user", content: "before compaction", timestamp: 1 });
	await writer.appendCompaction("compacted", null, 1000, details);
	await writer.appendMessage({ role: "user", content: "after compaction", timestamp: 2 });
	return { id: writer.getSessionId(), ids: [...ids, "b-0", "b-1", "w-1"] };
}

describe.each(Object.keys(stores))("worktree snapshots of a resumed window on the %s store (#5554)", (kind) => {
	it("holds the records the latest checkouts and restores need, as many for a long history as for a short one", async () => {
		const held: { entries: number; records: number }[] = [];
		for (const turns of [30, 90]) {
			const store = await stores[kind]!();
			const { id } = await snapshotHistory(store, turns);
			const full = await wholeHistory(store, id);
			const window = await SessionManager.open(store, id);

			expect(full.getWorktreeSnapshotRecords().size).toBe(turns + 3);
			expect([...window.getLatestWorktreeSnapshots()]).toEqual([...full.getLatestWorktreeSnapshots()]);
			held.push({
				entries: window.getEntries().filter((entry) => entry.type === "worktree_snapshot").length,
				records: window.getWorktreeSnapshotRecords().size,
			});
		}
		expect(held[1]).toEqual(held[0]);
		// At most the first, latest and last different plain entry of each of three roots, and the two restore entries.
		expect(held[0]!.entries).toBeLessThanOrEqual(11);
		expect(held[0]!.records).toBeLessThanOrEqual(9);
	});

	it("gives every snapshot reading the same result as a manager holding the whole history", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 30);
		const full = await wholeHistory(store, id);
		const window = await SessionManager.open(store, id);

		for (const manager of [full, window]) expect(manager.hasFullHistory()).toBe(manager === full);
		const read = async (manager: SessionManager) => ({
			latest: [...manager.getLatestWorktreeSnapshots()],
			mappings: manager.getWorktreeRootMappings(),
			continuations: manager.getWorktreePathContinuations(),
			current: [...(await currentWorktreeSnapshots(manager))],
			targets: [...(await latestRestoreTargets(manager))],
			missing: await missingSnapshotRecords(manager),
			lapsed: await lapsedDegradedRestores(manager),
			pins: [A, B, RESTORED].map((root) => degradedRestorePin(manager, root)),
			status: [A, B, RESTORED].map((root) => describeWorktreeRestoreStatus(manager, root)),
			captures: await Promise.all([A, B, RESTORED].map((root) => describeLastCapture(manager, root))),
			notices: worktreeRestoreNotices(manager, new Date(0).toISOString()),
			recorded: sessionManagerRunsInRecordedCheckout(manager),
		});
		expect(await read(window)).toEqual(await read(full));
	});

	it("reads archived snapshot records on demand, equal to the whole-history map", async () => {
		const store = await stores[kind]!();
		const { id, ids } = await snapshotHistory(store, 30);
		const full = await wholeHistory(store, id);
		const window = await SessionManager.open(store, id);

		const all = full.getWorktreeSnapshotRecords();
		expect(await window.loadWorktreeSnapshotRecords([...ids, "never-recorded"])).toEqual(all);
		const stored = full.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		const paged: unknown[] = [];
		for await (const page of window.readWorktreeSnapshotPages()) {
			expect(page.length).toBeLessThanOrEqual(64);
			paged.push(...page.map(({ entry }) => entry));
		}
		expect(paged).toEqual(stored);
		const branch: unknown[] = [];
		for await (const page of window.readWorktreeSnapshotPages({ branch: true, direction: "backward" }))
			branch.unshift(...page.map(({ entry }) => entry));
		expect(branch).toEqual(full.getBranch().filter((entry) => entry.type === "worktree_snapshot"));
	});

	it("reads only the archived snapshot entries a reading needs, however long the history", async () => {
		const { store, read } = counting(await stores[kind]!());
		const { id } = await snapshotHistory(store, 60);
		const full = await wholeHistory(store, id);
		const window = await SessionManager.open(store, id);
		const stored = full.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		expect(full.getEntries().length).toBeGreaterThan(stored.length + 60);
		read();

		const all = full.getWorktreeSnapshotRecords();
		expect(await window.loadWorktreeSnapshotRecords(["a-1", "a-2", "never-recorded"])).toEqual(
			new Map(["a-1", "a-2"].map((id) => [id, all.get(id)])),
		);
		// The entries carrying the two records, found by their ids.
		expect(read()).toBeLessThanOrEqual(2);

		const branch = await snapshotEntries(window.readWorktreeSnapshotPages({ branch: true }));
		expect(branch).toEqual(full.getBranch().filter((entry) => entry.type === "worktree_snapshot"));
		expect(read()).toBeLessThanOrEqual(stored.length);
		const backward = await snapshotEntries(window.readWorktreeSnapshotPages({ direction: "backward" }), "backward");
		expect(backward).toEqual(stored);
		expect(read()).toBeLessThanOrEqual(stored.length);
	});

	it("reads archived snapshots as the session stood when the manager read it, though later entries record them again", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 30);
		const window = await SessionManager.open(store, id);
		const before = await wholeHistory(store, id);
		const writer = await SessionManager.open(store, id);
		await writer.appendWorktreeSnapshot(A, "a-1", await record(store, "a-1", A, 77));
		await writer.appendWorktreeSnapshot(A, "a-40", await record(store, "a-40", A, 40));
		const after = await wholeHistory(store, id);
		expect(after.getWorktreeSnapshotRecords().get("a-1")).not.toEqual(before.getWorktreeSnapshotRecords().get("a-1"));

		const records = before.getWorktreeSnapshotRecords();
		expect(await window.loadWorktreeSnapshotRecords(["a-1", "a-2", "a-40"])).toEqual(
			new Map(["a-1", "a-2"].map((id) => [id, records.get(id)])),
		);
		const stored = before.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		expect(await snapshotEntries(window.readWorktreeSnapshotPages())).toEqual(stored);
		expect(await snapshotEntries(window.readWorktreeSnapshotPages({ branch: true }))).toEqual(
			before.getBranch().filter((entry) => entry.type === "worktree_snapshot"),
		);
		const reopened = await SessionManager.open(store, id);
		expect(await reopened.loadWorktreeSnapshotRecords(["a-1", "a-40"])).toEqual(
			new Map(["a-1", "a-40"].map((id) => [id, after.getWorktreeSnapshotRecords().get(id)])),
		);
	});

	it("reads the snapshot entries and records of an abandoned branch with the whole history, and not with the active branch", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 30);
		const writer = await SessionManager.open(store, id);
		const fork = writer.getLeafId()!;
		const moved = "/host/worktrees/repo-a-2";
		await writer.appendWorktreeSnapshot(moved, "a-3", undefined, restore(A, moved, "a-3"));
		await writer.appendWorktreeSnapshot(
			moved,
			"x-1",
			await record(store, "x-1", moved, 51),
			undefined,
			[],
			undefined,
			3,
			"a-3",
		);
		await writer.appendWorktreeSnapshot(A, "a-5", undefined);
		await writer.appendMessage({ role: "user", content: "abandoned", timestamp: 3 });
		await writer.branch(fork);
		await writer.appendMessage({ role: "user", content: "active", timestamp: 4 });
		await writer.appendWorktreeSnapshot(B, "b-1", undefined);
		const window = await SessionManager.open(store, id);
		expect(
			window.getEntries().some((entry) => entry.type === "worktree_snapshot" && entry.snapshotId === "x-1"),
		).toBe(false);

		// No manager holds an abandoned branch any more: what one holding every entry read, from the stored rows.
		const { entries } = await store.load(id);
		const stored = entries.filter((entry) => entry.type === "worktree_snapshot");
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const path: SessionEntry[] = [];
		for (let entry = byId.get(window.getLeafId()!); entry; entry = byId.get(entry.parentId ?? ""))
			path.unshift(entry);
		const records = new Map(stored.flatMap((entry) => (entry.snapshot ? [[entry.snapshotId, entry.snapshot]] : [])));
		expect(stored.some((entry) => entry.restore?.to === moved)).toBe(true);
		expect(records.has("x-1")).toBe(true);
		expect(await snapshotEntries(window.readWorktreeSnapshotPages())).toEqual(stored);
		expect(await snapshotEntries(window.readWorktreeSnapshotPages({ branch: true }))).toEqual(
			path.filter((entry) => entry.type === "worktree_snapshot"),
		);
		expect(await window.loadWorktreeSnapshotRecords(["x-1", "a-3"])).toEqual(
			new Map(["x-1", "a-3"].map((id) => [id, records.get(id)])),
		);
	});

	it("states what an export file carries as a manager holding the whole history does", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 30);
		const full = await wholeHistory(store, id);
		const window = await SessionManager.open(store, id);
		const path = join(directory(), "export.jsonl");
		await exportToJsonl.call({ sessionManager: window } as unknown as AgentSession, path);

		const expected = describeSnapshotExport(full.getBranch(), full.getWorktreeSnapshotRecords());
		expect(expected).toContain("Includes 33 worktree snapshot(s)");
		expect(await describeExportedSnapshots(path)).toBe(expected);
	});

	// Storage with a blob table moves imported content into it instead.
	it.skipIf(kind === "sql")(
		"restores from content an archived entry carries inline, as an imported session does",
		async () => {
			const source = await stores[kind]!();
			const { id } = await snapshotHistory(source, 20);
			const stored = await source.load(id);
			const carried = new TextEncoder().encode("inline patch of a-1");
			const hash = sha256Hex(carried);
			const entries = stored.entries.map((entry) =>
				entry.type === "worktree_snapshot" && entry.snapshotId === "a-1" && entry.snapshot
					? { ...entry, blobs: { [hash]: Buffer.from(carried).toString("base64") } }
					: entry,
			);
			const store = await stores[kind]!();
			await store.create({ ...stored.header }, entries);
			const full = await wholeHistory(store, id);
			const window = await SessionManager.open(store, id);
			expect(window.getEntries().some((entry) => entry.type === "worktree_snapshot" && entry.blobs)).toBe(false);

			const whole = sessionSnapshotBlobs(undefined, full.getEntries());
			const archived = archivedSnapshotBlobs(window, undefined);
			expect(await archived.getBlob(hash)).toEqual(await whole.getBlob(hash));
			expect(await archived.getBlob("0".repeat(64))).toBeUndefined();
			expect(await archived.refreshBlobs([hash])).toBe(true);
			expect(await archived.listBlobHashes()).toEqual(await whole.listBlobHashes());
		},
	);

	it("records a reference to an archived snapshot as a manager holding the whole history does", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 20);
		const window = await SessionManager.open(store, id);
		expect(window.getWorktreeSnapshotRecords().has("a-1")).toBe(false);

		await window.appendWorktreeSnapshot(A, "a-1", undefined);
		await expect(window.appendWorktreeSnapshot(A, "never-recorded", undefined)).rejects.toThrow(/snapshotId/);

		const reopened = await wholeHistory(store, id);
		expect(reopened.getLatestWorktreeSnapshots().get(A)?.id).toBe("a-1");
		expect((await SessionManager.open(store, id)).getLatestWorktreeSnapshots().get(A)?.id).toBe("a-1");
	});
});

it("an unreachable store fails an archived snapshot read with the error naming it, never an empty map (#5554)", async () => {
	const store = new MemorySessionStore();
	const { id } = await snapshotHistory(store, 20);
	const window = await SessionManager.open(store, id);
	const unavailable = () => {
		throw new StorageUnavailableError(store.descriptor, new Error("connection refused"));
	};
	Object.assign(store, {
		readRange: unavailable,
		readEntrySizes: unavailable,
		load: unavailable,
		readSnapshotCut: unavailable,
		readSelectedPage: unavailable,
	});

	expect(window.getWorktreeSnapshotRecords().has("a-1")).toBe(false);
	await expect(window.loadWorktreeSnapshotRecords(["a-1"])).rejects.toThrow(
		`Storage unavailable: ${store.descriptor.adapter} at ${store.descriptor.location}`,
	);
	await expect(window.readWorktreeSnapshotPages().next()).rejects.toBeInstanceOf(StorageUnavailableError);
	// What the resume holds stays readable.
	expect(window.getLatestWorktreeSnapshots().get(A)?.id).toBe("a-19");
});
