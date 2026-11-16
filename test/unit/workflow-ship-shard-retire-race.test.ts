import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import { test, vi } from "vitest";
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
/** How long an opener may take once the process that held the journals' lock is gone. */
const OPEN_AFTER_HOLDER_DIED_MS = 10_000;
/** Byte 18 of a SQLite database header: 2 once the database writes ahead to a log. */
const WRITE_VERSION_OFFSET = 18;

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

			await assert.rejects(ShipShard.open(path, ROOT), /already open/, "the late opener owns the root's journal");
			const reader = await openNodeSqliteDatabase(path);
			try {
				assert.deepEqual(
					(await reader.all<{ event_key: string }>("SELECT event_key FROM ship_events")).map(
						(row) => row.event_key,
					),
					["key-1"],
					"the late opener's checkpoint is in the file at the journal's path",
				);
			} finally {
				await reader.close();
			}
		} finally {
			await late.close();
		}
		assert.ok(existsSync(path));
		const next = await ShipShard.open(path, ROOT);
		try {
			assert.deepEqual(
				(await next.pending(LEASE_1)).map((event) => event.key),
				["key-1"],
				"the next opener recovers the late opener's checkpoint",
			);
			await next.hold(LEASE_2, 60_000);
			assert.deepEqual(
				await next.pending(LEASE_1),
				[],
				"a replacement generation drops the displaced one's checkpoint",
			);
		} finally {
			await next.close();
		}
	} finally {
		removals.before = undefined;
		removeTempDirectory(directory);
	}
});

test("a retire that finds a checkpoint left to ship keeps the journal, and the next opener writes and ships through its write-ahead log (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-retire-kept-");
	try {
		const path = shipShardPath(directory, "journal", ROOT);
		const first = await ShipShard.open(path, ROOT);
		await first.hold(LEASE_1, 60_000);
		await first.accept(ROOT, LEASE_1, "unshipped", "{}", 1);
		await first.close({ retire: true });
		assert.ok(existsSync(path), "a journal with a checkpoint left to ship is kept");
		assert.equal(readFileSync(path)[WRITE_VERSION_OFFSET], 2, "a kept journal stays in write-ahead log mode (#5317)");

		const next = await ShipShard.open(path, ROOT);
		try {
			await next.hold(LEASE_1, 60_000);
			assert.deepEqual(
				(await next.pending(LEASE_1)).map((event) => event.key),
				["unshipped"],
			);
			const { localSeq } = await next.accept(ROOT, LEASE_1, "next", "{}", 2);
			await next.shipped(LEASE_1, localSeq);
			assert.deepEqual(
				(await next.pending(LEASE_1)).map((event) => event.key),
				["unshipped"],
			);
			assert.equal(readFileSync(path)[WRITE_VERSION_OFFSET], 2, "the journal writes ahead to a log again");
			assert.ok(existsSync(`${path}-wal`));
		} finally {
			await next.close();
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test("an opener waits while another process holds the journals' lock, and opens once that process was killed (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-lock-holder-killed-");
	try {
		const path = shipShardPath(directory, "journal", ROOT);
		const lock = `${dirname(path)}.lock`;
		mkdirSync(dirname(lock), { recursive: true });
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite");
				const database = new DatabaseSync(process.argv[1]);
				database.exec("PRAGMA journal_mode=WAL");
				database.exec("BEGIN IMMEDIATE");
				process.stdout.write("locked\\n");
				setInterval(() => {}, 1000);`,
				lock,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await once(holder.stdout, "data");
			const opening = ShipShard.open(path, ROOT);
			assert.equal(
				await Promise.race([opening.then(() => "opened"), sleep(LATE_OPEN_GRACE_MS).then(() => "waiting")]),
				"waiting",
				"the opener waits for the lock",
			);
			const exited = once(holder, "exit");
			holder.kill("SIGKILL");
			await exited;
			const shard = await Promise.race([
				opening,
				sleep(OPEN_AFTER_HOLDER_DIED_MS).then(() => assert.fail("the opener still waits for a dead holder")),
			]);
			try {
				await shard.hold(LEASE_1, 60_000);
				assert.equal((await shard.accept(ROOT, LEASE_1, "key-1", "{}", 1)).accepted, true);
			} finally {
				await shard.close();
			}
		} finally {
			holder.kill("SIGKILL");
		}
	} finally {
		removeTempDirectory(directory);
	}
});
