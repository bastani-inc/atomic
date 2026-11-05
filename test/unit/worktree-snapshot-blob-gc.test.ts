import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	MemorySnapshotBlobStore,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	DEFAULT_BLOB_GRACE_SECONDS,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import {
	isWorkspaceConfigError,
	type SnapshotBlob,
	type SnapshotBlobStore,
	snapshotBlob,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/index.ts";

let directory: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-blob-gc-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

const blob = (text: string): SnapshotBlob => snapshotBlob(new TextEncoder().encode(text));
const referencing = (...blobs: SnapshotBlob[]): WorktreeSnapshot =>
	({
		chain: blobs.map((entry) => ({ tree: "t", patch: entry.hash, bytes: 1 })),
		bundle: null,
	}) as unknown as WorktreeSnapshot;

interface OpenedStore {
	readonly store: SnapshotBlobStore;
	/** Stores `blobs` as if they had been stored `seconds` ago. */
	putAged(blobs: readonly SnapshotBlob[], seconds: number): Promise<void>;
}

async function sqlStore(): Promise<OpenedStore> {
	const database = await openNodeSqliteDatabase(join(directory, "blobs.sqlite"));
	cleanups.push(() => database.close());
	const store = await SqlSnapshotBlobStore.open(database);
	return {
		store,
		// The database's own clock is the one that counts, so age the rows there.
		putAged: async (blobs, seconds) => {
			await store.putBlobs(blobs);
			for (const { hash } of blobs) {
				await database.run(`UPDATE ${store.table} SET created_at = unixepoch() - ? WHERE hash = ?`, seconds, hash);
			}
		},
	};
}

/** A memory store on a clock the test moves by hand. */
function memoryStore(): OpenedStore & { readonly clock: { seconds: number } } {
	const clock = { seconds: 1_000_000 };
	const store = new MemorySnapshotBlobStore({ now: () => clock.seconds });
	return {
		store,
		clock,
		putAged: async (blobs, seconds) => {
			clock.seconds -= seconds;
			await store.putBlobs(blobs);
			clock.seconds += seconds;
		},
	};
}

const stores: readonly (readonly [string, () => Promise<OpenedStore> | OpenedStore])[] = [
	["memory", memoryStore],
	["SQL", sqlStore],
] as const;

describe.each(stores)("garbage collection of the %s blob store", (_name, open) => {
	test("a blob stored by a capture whose reference is not published yet survives collection and stays after publication (#4245)", async () => {
		const { store } = await open();
		const patch = blob("patch of a capture in flight");
		await store.putBlobs([patch]);

		assert.deepEqual((await collectSnapshotGarbage(store, [])).deleted, [], "the reference is not published yet");
		assert.deepEqual(await store.listBlobHashes(), [patch.hash]);

		assert.deepEqual((await collectSnapshotGarbage(store, [referencing(patch)])).deleted, []);
		assert.deepEqual(await store.getBlob(patch.hash), patch.data);
	});

	test("an unreferenced blob older than the grace window is deleted, and the result names exactly the hashes deleted", async () => {
		const { store, putAged } = await open();
		const [old, fresh, kept] = [blob("old"), blob("fresh"), blob("referenced")];
		await putAged([old, kept], DEFAULT_BLOB_GRACE_SECONDS + 10);
		await store.putBlobs([fresh]);

		const { deleted } = await collectSnapshotGarbage(store, [referencing(kept)]);

		assert.deepEqual(deleted, [old.hash]);
		assert.deepEqual([...(await store.listBlobHashes())].sort(), [fresh.hash, kept.hash].sort());
	});

	test("a blob stored again after it aged is protected again, because a re-put restarts its age", async () => {
		const { store, putAged } = await open();
		const patch = blob("shared by two captures");
		await putAged([patch], DEFAULT_BLOB_GRACE_SECONDS + 10);
		await store.putBlobs([patch]);

		assert.deepEqual((await collectSnapshotGarbage(store, [])).deleted, []);
		assert.deepEqual(await store.getBlob(patch.hash), patch.data);
	});

	test("a blob stored again while collection is between listing and deleting survives it", async () => {
		const { store, putAged } = await open();
		const patch = blob("stored again during collection");
		await putAged([patch], DEFAULT_BLOB_GRACE_SECONDS + 10);
		const racing: SnapshotBlobStore = {
			putBlobs: (blobs) => store.putBlobs(blobs),
			getBlob: (hash) => store.getBlob(hash),
			deleteBlobs: (hashes, options) => store.deleteBlobs(hashes, options),
			listBlobHashes: async () => {
				const listed = await store.listBlobHashes();
				await store.putBlobs([patch]);
				return listed;
			},
		};

		assert.deepEqual((await collectSnapshotGarbage(racing, [])).deleted, []);
		assert.deepEqual(await store.getBlob(patch.hash), patch.data);
	});

	test("the default window is one hour, and a blob exactly that old is deleted while one a second younger is kept", async () => {
		assert.equal(DEFAULT_BLOB_GRACE_SECONDS, 3600);
		const { putAged, store } = await open();
		const [exact, younger] = [blob("exactly an hour"), blob("a second younger")];
		await putAged([exact], 3600);
		await putAged([younger], 3590);

		assert.deepEqual((await collectSnapshotGarbage(store, [])).deleted, [exact.hash]);
	});

	test("graceSeconds 0 collects an unreferenced blob at once, and a larger window is honoured", async () => {
		const { store, putAged } = await open();
		const patch = blob("short lived");
		await putAged([patch], 120);

		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 600 })).deleted, []);
		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 60 })).deleted, [patch.hash]);
		await store.putBlobs([patch]);
		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 0 })).deleted, [patch.hash]);
		assert.deepEqual(await store.listBlobHashes(), []);
	});
});

describe("garbage collection decides by the database's clock, not the client's", () => {
	test("a client clock two hours ahead neither exposes a fresh blob nor hides an old one", async () => {
		const { store, putAged } = await sqlStore();
		const [fresh, old] = [blob("fresh"), blob("old")];
		await store.putBlobs([fresh]);
		await putAged([old], DEFAULT_BLOB_GRACE_SECONDS + 10);
		const real = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(real + 2 * 3600_000);

		assert.deepEqual((await collectSnapshotGarbage(store, [])).deleted, [old.hash]);
		assert.deepEqual(await store.listBlobHashes(), [fresh.hash]);
	});
});

describe("collectSnapshotGarbage validates graceSeconds at the boundary", () => {
	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number])(
		"%s is refused as a typed config error before the store is touched",
		async (graceSeconds) => {
			const calls: string[] = [];
			const store: SnapshotBlobStore = {
				putBlobs: async () => void calls.push("put"),
				getBlob: async () => void calls.push("get"),
				listBlobHashes: async () => {
					calls.push("list");
					return [];
				},
				deleteBlobs: async () => {
					calls.push("delete");
					return [];
				},
			};
			await assert.rejects(collectSnapshotGarbage(store, [], { graceSeconds }), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.equal(error.code, "invalid-setting");
				assert.deepEqual(error.fields, {
					source: "sdk",
					field: "graceSeconds",
					expected: "a non-negative integer number of seconds",
				});
				return true;
			});
			assert.deepEqual(calls, []);
		},
	);

	test("the refusal tells the caller what to set", async () => {
		await assert.rejects(
			collectSnapshotGarbage(memoryStore().store, [], { graceSeconds: -5 }),
			(error: unknown) =>
				(error as Error).message ===
				"Invalid worktree snapshot setting: graceSeconds from sdk (invalid-setting). Set graceSeconds to a non-negative integer number of seconds.",
		);
	});
});

describe("blob store deletion", () => {
	test("deleting hashes that are not stored deletes nothing and reports nothing", async () => {
		for (const open of [memoryStore, sqlStore]) {
			const { store } = await open();
			const patch = blob("stored");
			await store.putBlobs([patch]);
			assert.deepEqual(await store.deleteBlobs(["absent"], { olderThanSeconds: 0 }), []);
			assert.deepEqual(await store.listBlobHashes(), [patch.hash]);
		}
	});

	test("a memory blob stored again keeps its first bytes and a new age", async () => {
		const { store, clock } = memoryStore();
		await store.putBlobs([{ hash: "h", data: new Uint8Array([1]) }]);
		clock.seconds += 100;
		await store.putBlobs([{ hash: "h", data: new Uint8Array([9]) }]);
		clock.seconds += 50;
		assert.deepEqual(await store.deleteBlobs(["h"], { olderThanSeconds: 60 }), []);
		assert.deepEqual([...(await store.getBlob("h"))!], [1]);
		assert.deepEqual(await store.deleteBlobs(["h"], { olderThanSeconds: 50 }), ["h"]);
	});
});
