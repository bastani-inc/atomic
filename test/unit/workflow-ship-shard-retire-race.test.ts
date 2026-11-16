import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test, vi } from "vitest";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const removals = vi.hoisted(() => ({
	/** Runs once, before the first removal of a file whose path starts with `prefix`. */
	before: undefined as undefined | { readonly prefix: string; readonly run: () => Promise<void> },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async rm(path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
			const hook = removals.before;
			if (hook !== undefined && String(path).startsWith(hook.prefix)) {
				removals.before = undefined;
				await hook.run();
			}
			return actual.rm(path, options);
		},
	};
});

const ROOT = "root";
const LEASE_1 = { id: "work-1", generation: 1, worker: "host-b/1", epoch: 1 } as const;
const LEASE_2 = { id: "work-1", generation: 2, worker: "host-c/1", epoch: 1 } as const;
/** How long the retiring close waits for the late opener before it removes the file anyway. */
const LATE_OPEN_GRACE_MS = 1_000;

test("a local checkpoint journal opened while another connection retires it is never one the retire removes (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-retire-race-");
	try {
		const path = shipShardPath(directory, "journal", ROOT);
		const retiring = await ShipShard.open(path, ROOT);
		let opening: Promise<ShipShard> | undefined;
		// Another process opens the file once the retiring close has decided nothing uses it, before it removes it.
		removals.before = {
			prefix: path,
			run: async () => {
				opening = ShipShard.open(path, ROOT);
				await Promise.race([opening, sleep(LATE_OPEN_GRACE_MS)]);
			},
		};
		await retiring.close({ retire: true });
		assert.ok(opening !== undefined, "the late opener opened during the retiring close");
		const late = await opening;
		try {
			await late.hold(LEASE_1, 60_000);
			const accepted = await late.accept(ROOT, LEASE_1, "key-1", "{}", 1);
			assert.equal(accepted.accepted, true);

			const next = await ShipShard.open(path, ROOT);
			try {
				assert.deepEqual(
					(await next.pending(LEASE_1)).map((event) => event.key),
					["key-1"],
					"the late opener's checkpoint is in the file at the journal's path",
				);
				await next.hold(LEASE_2, 60_000);
				await assert.rejects(
					late.accept(ROOT, LEASE_1, "key-2", "{}", 1),
					(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === "generation-mismatch",
					"the generation another connection holds through the path fences the late opener",
				);
			} finally {
				await next.close();
			}
		} finally {
			await late.close();
		}
		assert.ok(existsSync(path));
	} finally {
		removals.before = undefined;
		removeTempDirectory(directory);
	}
});
