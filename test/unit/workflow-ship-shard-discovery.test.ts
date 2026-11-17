import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test, vi } from "vitest";
import {
	retireEndedShipShards,
	ShipShard,
	shipJournalDirectory,
	shipShardPath,
} from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const discovery = vi.hoisted(() => ({ heartbeat: false, yielded: undefined as boolean | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
			if (args[0] !== "/proc") return actual.readdirSync(...args);
			setImmediate(() => {
				discovery.heartbeat = true;
			});
			discovery.yielded = discovery.heartbeat;
			return [];
		}) as typeof actual.readdirSync,
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readdir: (async (...args: Parameters<typeof actual.readdir>) => {
			if (args[0] !== "/proc") return actual.readdir(...args);
			setImmediate(() => {
				discovery.heartbeat = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			discovery.yielded = discovery.heartbeat;
			return [];
		}) as typeof actual.readdir,
	};
});

test.skipIf(process.platform !== "linux")(
	"sweeping checkpoint journals lets the host run while it discovers other processes' open files (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-shard-discovery-");
		try {
			const path = shipShardPath(directory, "journal", "root");
			const shard = await ShipShard.open(path, "root");
			await shard.close();
			await retireEndedShipShards(shipJournalDirectory(directory, "journal"), async (roots) => ({
				roots: new Set(roots),
				works: new Set(),
			}));
			assert.equal(discovery.yielded, true, "process discovery lets the host's queued work run");
			assert.equal(existsSync(path), false, "the ended journal is still retired");
		} finally {
			removeTempDirectory(directory);
		}
	},
);
