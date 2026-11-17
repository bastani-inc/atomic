import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	retireEndedShipShards,
	ShipShard,
	shipJournalDirectory,
	shipShardPath,
} from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

for (const race of ["another sweep", "the root retiring"] as const) {
	test(`crash cleanup racing ${race} leaves no lock for the removed journal (#5317)`, async () => {
		const directory = makeTempDirectory("ship-cleanup-race-");
		const journalDir = shipJournalDirectory(directory, "journal");
		const path = shipShardPath(directory, "journal", "ended");
		const live = await ShipShard.open(shipShardPath(directory, "journal", "live"), "live");
		try {
			const shard = await ShipShard.open(path, "ended");
			await shard.close();
			const ended = { roots: new Set(["ended"]), works: new Set<string>() };
			if (race === "another sweep") {
				let arrived = 0;
				let release!: () => void;
				const bothRead = new Promise<void>((resolve) => {
					release = resolve;
				});
				const findEnded = async () => {
					if (++arrived === 2) release();
					await bothRead;
					return ended;
				};
				await Promise.all([
					retireEndedShipShards(journalDir, findEnded),
					retireEndedShipShards(journalDir, findEnded),
				]);
			} else {
				await retireEndedShipShards(journalDir, async () => {
					const reopened = await ShipShard.open(path, "ended");
					await reopened.close({ retire: true });
					return ended;
				});
			}
			assert.equal(existsSync(path), false);
			assert.equal(existsSync(`${path}.lock`), false, "no root lock is recreated after removal");
			await retireEndedShipShards(journalDir, async () => ended);
			await live.close({ retire: true });
			assert.equal(existsSync(journalDir), false, "no leftover lock keeps the journal directory");
		} finally {
			await live.close();
			removeTempDirectory(directory);
		}
	});
}

test("retirement and crash cleanup remove journals under long agent directory paths (#5317)", async () => {
	const directory = makeTempDirectory("ship-long-path-");
	let stateDirectory = directory;
	while (stateDirectory.length < 280) stateDirectory = join(stateDirectory, "agent-directory-segment");
	const path = shipShardPath(stateDirectory, "journal", "root");
	try {
		let shard = await ShipShard.open(path, "root");
		await shard.close({ retire: true });
		assert.equal(existsSync(path), false, "normal retirement removes the long-path journal");
		shard = await ShipShard.open(path, "root");
		await shard.close();
		await retireEndedShipShards(shipJournalDirectory(stateDirectory, "journal"), async (roots) => ({
			roots: new Set(roots),
			works: new Set(),
		}));
		assert.equal(existsSync(path), false, "crash cleanup removes the long-path journal");
		assert.deepEqual(
			readdirSync(join(stateDirectory, "ship")).filter((name) => name.endsWith(".sqlite")),
			[],
		);
	} finally {
		removeTempDirectory(directory);
	}
});
