import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { exportToJsonl } from "../../src/core/agent-session-export.ts";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../src/core/session-manager.ts";
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
			const full = await SessionManager.open(store, id, undefined, { history: "full" });
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
		const full = await SessionManager.open(store, id, undefined, { history: "full" });
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
		const full = await SessionManager.open(store, id, undefined, { history: "full" });
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

	it("states what an export file carries as a manager holding the whole history does", async () => {
		const store = await stores[kind]!();
		const { id } = await snapshotHistory(store, 30);
		const full = await SessionManager.open(store, id, undefined, { history: "full" });
		const path = join(directory(), "export.jsonl");
		await exportToJsonl.call({ sessionManager: full } as unknown as AgentSession, path);

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
			const full = await SessionManager.open(store, id, undefined, { history: "full" });
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

		const reopened = await SessionManager.open(store, id, undefined, { history: "full" });
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
	Object.assign(store, { readRange: unavailable, readEntrySizes: unavailable, load: unavailable });

	expect(window.getWorktreeSnapshotRecords().has("a-1")).toBe(false);
	await expect(window.loadWorktreeSnapshotRecords(["a-1"])).rejects.toThrow(
		`Storage unavailable: ${store.descriptor.adapter} at ${store.descriptor.location}`,
	);
	await expect(window.readWorktreeSnapshotPages().next()).rejects.toBeInstanceOf(StorageUnavailableError);
	// What the resume holds stays readable.
	expect(window.getLatestWorktreeSnapshots().get(A)?.id).toBe("a-19");
});
