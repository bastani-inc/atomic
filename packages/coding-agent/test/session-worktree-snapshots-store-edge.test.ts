import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { validateSessionEntryStructure } from "../src/core/storage/session/entry-structure.ts";
import { SessionFormatVersionError } from "../src/core/storage/session/errors.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { isWorkspaceConfigError, type WorktreeRootMapping, type WorktreeSnapshot } from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const snapshot = (id: string, root: string): WorktreeSnapshot =>
	({
		id,
		root,
		tree: `tree-${id}`,
		chain: [],
		omitted: [],
		filters: null,
		bundle: null,
	}) as unknown as WorktreeSnapshot;

const mapping = (from: string, to: string, snapshotId: string): WorktreeRootMapping => ({
	from,
	to,
	snapshotId,
	tree: `tree-${snapshotId}`,
	restoredAt: "2026-01-01T00:00:00.000Z",
});

describe("recording snapshots on a session", () => {
	test("a snapshot is stored once, a reference points at it, and a restore names where it went", async () => {
		const manager = SessionManager.inMemory("/work");
		const first = snapshot("s1", "/work/a");
		const recorded = await manager.appendWorktreeSnapshot("/work/a", "s1", first);
		const reference = await manager.appendWorktreeSnapshot("/work/a", "s1");
		const restoreMapping = mapping("/work/a", "/restored/a", "s1");
		const restored = await manager.appendWorktreeSnapshot("/restored/a", "s1", undefined, restoreMapping);
		const entries = manager.getEntries();
		const [stored, ref, restore] = entries as unknown as Array<Record<string, unknown>>;
		assert.deepEqual(
			entries.map((entry) => entry.id),
			[recorded, reference, restored],
		);
		assert.deepEqual(Object.keys(stored!).sort(), [
			"id",
			"parentId",
			"root",
			"snapshot",
			"snapshotId",
			"timestamp",
			"type",
		]);
		assert.deepEqual(Object.keys(ref!).sort(), ["id", "parentId", "root", "snapshotId", "timestamp", "type"]);
		assert.deepEqual(Object.keys(restore!).sort(), [
			"id",
			"parentId",
			"restore",
			"root",
			"snapshotId",
			"timestamp",
			"type",
		]);
		assert.equal(ref?.parentId, recorded);
		assert.equal(restore?.parentId, reference);
		assert.deepEqual(restore?.restore, restoreMapping);
	});

	test("an inconsistent snapshot, reference or restore is rejected naming the offending argument", async () => {
		const manager = SessionManager.inMemory("/work");
		await manager.appendWorktreeSnapshot("/work/a", "s1", snapshot("s1", "/work/a"));
		const rejects = (call: () => Promise<string>, field: string, expected: string) =>
			assert.rejects(call(), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field, expected });
				return true;
			});
		await rejects(
			() => manager.appendWorktreeSnapshot("/work/a", "other", snapshot("s1", "/work/a")),
			"snapshot",
			"a snapshot whose id is snapshotId",
		);
		await rejects(
			() => manager.appendWorktreeSnapshot("/work/a", "never-recorded"),
			"snapshotId",
			"the id of a snapshot recorded in this session",
		);
		await rejects(
			() => manager.appendWorktreeSnapshot("/elsewhere", "s1", undefined, mapping("/work/a", "/restored", "s1")),
			"restore",
			"a mapping to root for snapshotId",
		);
		await rejects(
			() => manager.appendWorktreeSnapshot("/restored", "s1", undefined, mapping("/work/a", "/restored", "s2")),
			"restore",
			"a mapping to root for snapshotId",
		);
		assert.equal(manager.getEntries().length, 1);
		await manager.appendWorktreeSnapshot("/restored", "s1", undefined, mapping("/work/a", "/restored", "s1"));
		assert.equal(manager.getEntries().length, 2);
	});

	test("the latest snapshot per root and the restores are read from the active branch; every record from the whole session", async () => {
		const manager = SessionManager.inMemory("/work");
		const a1 = snapshot("a1", "/work/a");
		const b1 = snapshot("b1", "/work/b");
		const a2 = snapshot("a2", "/work/a");
		await manager.appendWorktreeSnapshot("/work/a", "a1", a1);
		const fork = await manager.appendWorktreeSnapshot("/work/b", "b1", b1);
		await manager.appendWorktreeSnapshot("/work/a", "a2", a2);
		await manager.appendWorktreeSnapshot("/restored/a", "a2", undefined, mapping("/work/a", "/restored/a", "a2"));
		assert.deepEqual(
			[...manager.getLatestWorktreeSnapshots()],
			[
				["/work/a", a2],
				["/work/b", b1],
				["/restored/a", a2],
			],
		);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((entry) => [entry.from, entry.to]),
			[["/work/a", "/restored/a"]],
		);
		await manager.branch(fork);
		const c1 = snapshot("c1", "/work/c");
		await manager.appendWorktreeSnapshot("/work/c", "c1", c1);
		assert.deepEqual(
			[...manager.getLatestWorktreeSnapshots()],
			[
				["/work/a", a1],
				["/work/b", b1],
				["/work/c", c1],
			],
		);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.deepEqual([...manager.getWorktreeSnapshotRecords().keys()].sort(), ["a1", "a2", "b1", "c1"]);
	});
});

describe("validating persisted snapshot entries", () => {
	const base = { type: "worktree_snapshot", id: "e1", parentId: null, timestamp: "t" } as const;
	const check = (entry: object) => () =>
		validateSessionEntryStructure([{ ...base, ...entry } as never], "/sessions/file.jsonl");
	const record = { id: "s1", tree: "t1", chain: [] };
	const restored = { from: "/old", to: "/r", snapshotId: "s1", tree: "t", restoredAt: "x" };

	test("accepts a reference, a stored snapshot, a restore and carried blobs", () => {
		assert.doesNotThrow(check({ root: "/r", snapshotId: "s1" }));
		assert.doesNotThrow(check({ root: "/r", snapshotId: "s1", snapshot: record }));
		assert.doesNotThrow(
			check({
				root: "/r",
				snapshotId: "s1",
				restore: { from: "/old", to: "/r", snapshotId: "s1", tree: "t", restoredAt: "x" },
			}),
		);
		assert.doesNotThrow(
			check({
				root: "/r",
				snapshotId: "s1",
				restore: { from: "/old", to: "/r", snapshotId: "s1", tree: "t", restoredAt: "x" },
				restoreWarnings: [
					{ code: "lfs-objects-unavailable", paths: ["a.bin"] },
					{ code: "stale-restore-retained", path: "/host/restores" },
				],
			}),
		);
		assert.doesNotThrow(check({ root: "/r", snapshotId: "s1", blobs: { a: "AA==", b: "BB==" } }));
		assert.doesNotThrow(check({ root: "/r", snapshotId: "s1", blobs: {} }));
	});

	test("rejects every malformed field with the unsupported-format error naming the file", () => {
		const invalid: Array<[string, object]> = [
			["root not a string", { root: 5, snapshotId: "s1" }],
			["no root", { snapshotId: "s1" }],
			["snapshotId not a string", { root: "/r", snapshotId: 5 }],
			["no snapshotId", { root: "/r" }],
			["null snapshot", { root: "/r", snapshotId: "s1", snapshot: null }],
			["string snapshot", { root: "/r", snapshotId: "s1", snapshot: "s1" }],
			["snapshot of another id", { root: "/r", snapshotId: "s1", snapshot: { ...record, id: "s2" } }],
			["snapshot without a tree", { root: "/r", snapshotId: "s1", snapshot: { id: "s1", chain: [] } }],
			["snapshot with a numeric tree", { root: "/r", snapshotId: "s1", snapshot: { ...record, tree: 5 } }],
			["snapshot without a chain", { root: "/r", snapshotId: "s1", snapshot: { id: "s1", tree: "t1" } }],
			["snapshot with an object chain", { root: "/r", snapshotId: "s1", snapshot: { ...record, chain: {} } }],
			["null restore", { root: "/r", snapshotId: "s1", restore: null }],
			["string restore", { root: "/r", snapshotId: "s1", restore: "x" }],
			["restore without from", { root: "/r", snapshotId: "s1", restore: { to: "/r", snapshotId: "s1" } }],
			[
				"restore with a numeric from",
				{ root: "/r", snapshotId: "s1", restore: { from: 5, to: "/r", snapshotId: "s1" } },
			],
			[
				"restore to another root",
				{ root: "/r", snapshotId: "s1", restore: { from: "/o", to: "/elsewhere", snapshotId: "s1" } },
			],
			[
				"restore of another snapshot",
				{ root: "/r", snapshotId: "s1", restore: { from: "/o", to: "/r", snapshotId: "s2" } },
			],
			["null blobs", { root: "/r", snapshotId: "s1", blobs: null }],
			["string blobs", { root: "/r", snapshotId: "s1", blobs: "AA==" }],
			["array blobs", { root: "/r", snapshotId: "s1", blobs: ["AA=="] }],
			["blobs with a non-string value", { root: "/r", snapshotId: "s1", blobs: { a: "AA==", b: 5 } }],
			["blobs whose first value is not a string", { root: "/r", snapshotId: "s1", blobs: { a: 5, b: "AA==" } }],
			...(
				[
					["restore warnings without a restore", undefined, []],
					["restore warnings that are not a list", restored, { code: "stale-restore-retained", path: "/p" }],
					["a null restore warning", restored, [null]],
					[
						"a restore warning the snapshot record reproduces",
						restored,
						[{ code: "omitted-content", omitted: [] }],
					],
					["LFS paths that are not a list", restored, [{ code: "lfs-objects-unavailable", paths: "a.bin" }]],
					["an LFS path that is not a string", restored, [{ code: "lfs-objects-unavailable", paths: ["a", 5] }]],
					["a leftover without a path", restored, [{ code: "stale-restore-retained" }]],
					[
						"a valid warning beside a malformed one",
						restored,
						[{ code: "stale-restore-retained", path: "/p" }, { code: "stale-restore-retained" }],
					],
				] as const
			).map(([name, restore, restoreWarnings]): [string, object] => [
				name,
				{ root: "/r", snapshotId: "s1", ...(restore ? { restore } : {}), restoreWarnings },
			]),
		];
		for (const [name, entry] of invalid) {
			assert.throws(
				check(entry),
				(error: unknown) => error instanceof SessionFormatVersionError && error.path === "/sessions/file.jsonl",
				name,
			);
		}
	});
});

describe("snapshot blobs live in the session store's own table", () => {
	test("a prefixed store keeps its blobs in the prefixed table and reports the prefix in its descriptor", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-store-edge-"));
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const database = await openNodeSqliteDatabase(join(directory, "db.sqlite"));
		cleanups.push(() => database.close());
		const prefixed = await SqlSessionStore.open(database, { prefix: "team_" });
		const plain = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await prefixed.close();
			await plain.close();
		});
		assert.deepEqual(prefixed.descriptor.prefix, "team_");
		assert.equal(Object.hasOwn(plain.descriptor, "prefix"), false);
		await prefixed.snapshotBlobs?.putBlobs([{ hash: "a".repeat(64), data: new Uint8Array([1]) }]);
		await plain.snapshotBlobs?.putBlobs([{ hash: "b".repeat(64), data: new Uint8Array([2]) }]);
		const tables = (
			await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE '%snapshot_blobs'")
		)
			.map((row) => row.name)
			.sort();
		assert.deepEqual(tables, ["snapshot_blobs", "team_snapshot_blobs"]);
		assert.deepEqual(await prefixed.snapshotBlobs?.listBlobHashes(), ["a".repeat(64)]);
		assert.deepEqual(await plain.snapshotBlobs?.listBlobHashes(), ["b".repeat(64)]);
	});
});

describe("snapshot settings from settings.json", () => {
	test("the manager returns the defaults, merges set fields over them and names the setting that is wrong", () => {
		const defaults = SettingsManager.inMemory().getWorktreeSnapshotSettings();
		assert.deepEqual(defaults, {
			enabled: true,
			includeUntracked: true,
			maxFileBytes: 5 * 1024 * 1024,
			maxSnapshotBytes: 50 * 1024 * 1024,
			fullEvery: 10,
		});
		const merged = SettingsManager.inMemory({
			snapshots: { enabled: false, maxFileBytes: 7 },
		}).getWorktreeSnapshotSettings();
		assert.deepEqual(merged, { ...defaults, enabled: false, maxFileBytes: 7 });
		assert.throws(
			() => SettingsManager.inMemory({ snapshots: { fullEvery: 0 } }).getWorktreeSnapshotSettings(),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, {
					source: "settings",
					field: "snapshots.fullEvery",
					expected: "a positive integer",
				});
				return true;
			},
		);
	});
});
