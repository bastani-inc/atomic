import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LEASE = { id: "work-1", generation: 1, worker: "host-a/1", epoch: 1 } as const;

/** Every file under the journal's directory, which a retire removes once no root's journal is left in it. */
function journalFiles(journalDirectory: string): string[] {
	if (!existsSync(journalDirectory)) return [];
	return readdirSync(journalDirectory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => join(entry.parentPath, entry.name));
}

test("retiring local checkpoint journals whose checkpoints all shipped removes per-root database and lock files (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-cleanup-");
	try {
		const journalDirectory = dirname(shipShardPath(directory, "journal", "root-1"));
		for (const root of ["root-1", "root-2", "root-3"]) {
			const shard = await ShipShard.open(shipShardPath(directory, "journal", root), root);
			await shard.hold(LEASE, 60_000);
			const { localSeq } = await shard.accept(root, LEASE, "step:1", '{"ok":true}', 1);
			await shard.shipped(LEASE, localSeq);
			shard.release(LEASE);
			await shard.close({ retire: true });
		}
		assert.deepEqual(journalFiles(journalDirectory), []);

		const unshippedPath = shipShardPath(directory, "journal", "root-unshipped");
		const unshipped = await ShipShard.open(unshippedPath, "root-unshipped");
		await unshipped.hold(LEASE, 60_000);
		await unshipped.accept("root-unshipped", LEASE, "step:pending", '{"ok":true}', 2);
		await unshipped.close({ retire: true });
		assert.equal(existsSync(unshippedPath), true);

		const reopened = await ShipShard.open(unshippedPath, "root-unshipped");
		assert.deepEqual(await reopened.leftover(), [{ lease: LEASE }]);
		const [pending] = await reopened.pending(LEASE);
		assert.ok(pending);
		await reopened.shipped(LEASE, pending.localSeq);
		reopened.release(LEASE);
		await reopened.close({ retire: true });
		assert.deepEqual(journalFiles(journalDirectory), []);
	} finally {
		removeTempDirectory(directory);
	}
});

test("a retired journal is removed even when a crashed predecessor left a holder record with this process's id (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-own-pid-record-");
	try {
		const path = shipShardPath(directory, "journal", "root-restarted");
		const crashed = await ShipShard.open(path, "root-restarted");
		await crashed.close();
		mkdirSync(`${path}-holders`, { recursive: true });
		const record = join(`${path}-holders`, `${process.pid}-987654`);
		writeFileSync(record, "");
		const before = (performance.timeOrigin - 60_000) / 1000;
		utimesSync(record, before, before);

		const shard = await ShipShard.open(path, "root-restarted");
		await shard.hold(LEASE, 60_000);
		const { localSeq } = await shard.accept("root-restarted", LEASE, "step:1", '{"ok":true}', 1);
		await shard.shipped(LEASE, localSeq);
		shard.release(LEASE);
		await shard.close({ retire: true });
		assert.deepEqual(journalFiles(dirname(path)), []);
	} finally {
		removeTempDirectory(directory);
	}
});
