import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "vitest";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LEASE = { id: "work-1", generation: 1, worker: "host-a/1", epoch: 1 } as const;

test("closing local checkpoint journals whose checkpoints all shipped removes per-root database and lock files (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-cleanup-");
	try {
		const journalDirectory = dirname(shipShardPath(directory, "journal", "root-1"));
		for (const root of ["root-1", "root-2", "root-3"]) {
			const shard = await ShipShard.open(shipShardPath(directory, "journal", root), root);
			await shard.hold(LEASE, 60_000);
			const { localSeq } = await shard.accept(root, LEASE, "step:1", '{"ok":true}', 1);
			await shard.shipped(LEASE, localSeq);
			shard.release(LEASE);
			await shard.close();
		}
		assert.deepEqual(readdirSync(journalDirectory), [".lock"]);

		const unshippedPath = shipShardPath(directory, "journal", "root-unshipped");
		const unshipped = await ShipShard.open(unshippedPath, "root-unshipped");
		await unshipped.hold(LEASE, 60_000);
		await unshipped.accept("root-unshipped", LEASE, "step:pending", '{"ok":true}', 2);
		await unshipped.close();
		assert.equal(
			readdirSync(journalDirectory).some((entry) => entry.endsWith(".sqlite")),
			true,
		);

		const reopened = await ShipShard.open(unshippedPath, "root-unshipped");
		assert.deepEqual(await reopened.leftover(), [{ lease: LEASE }]);
		const [pending] = await reopened.pending(LEASE);
		assert.ok(pending);
		await reopened.shipped(LEASE, pending.localSeq);
		reopened.release(LEASE);
		await reopened.close();
		assert.deepEqual(readdirSync(journalDirectory), [".lock"]);
	} finally {
		removeTempDirectory(directory);
	}
});
