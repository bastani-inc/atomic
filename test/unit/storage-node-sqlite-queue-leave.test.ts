import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, readStreamText, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

const HOLDER = fileURLToPath(new URL("../fixtures/sqlite-stalling-holder.mjs", import.meta.url));
/** How long removing a file of the writers' queue takes here: a disk slower than the transaction that leaves it. */
const SLOW_QUEUE_UNLINK_MS = 50;
/** The other connection's busy wait, which holds this thread until the lock is free or it gives up. */
const OTHER_WRITER_BUSY_TIMEOUT_MS = 1_000;
/** A child process, the adapter it loads and a lock handed over through the queue. */
const QUEUE_LEAVE_TEST_TIMEOUT_MS = 60_000;

const queueFiles = vi.hoisted(() => ({ onUnlink: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async unlink(path: Parameters<typeof actual.unlink>[0]) {
			if (/-(writers|wakes)[\\/]/.test(String(path))) {
				const onUnlink = queueFiles.onUnlink;
				queueFiles.onUnlink = undefined;
				onUnlink?.();
				await new Promise((resolve) => setTimeout(resolve, SLOW_QUEUE_UNLINK_MS));
			}
			return actual.unlink(path);
		},
	};
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	queueFiles.onUnlink = undefined;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test(
	"another connection in this process writes while a writer that queued behind another process leaves the queue holding the lock (#4316)",
	async () => {
		const directory = makeTempDirectory("atomic-queue-leave-");
		cleanups.push(() => removeTempDirectory(directory));
		const path = join(directory, "queue.sqlite");
		// The test setup loads the adapter before this file's slow disk applies; load it again on that disk.
		vi.resetModules();
		const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
		const first = await openNodeSqliteDatabase(path);
		cleanups.push(() => first.close());
		await first.exec("CREATE TABLE items (value TEXT NOT NULL)");
		// A statement outside a transaction waits for the lock in SQLite's busy handler, which blocks this thread.
		const second = await openNodeSqliteDatabase(path, { busyTimeoutMs: OTHER_WRITER_BUSY_TIMEOUT_MS });
		cleanups.push(() => second.close());

		const holder = spawnProcess([process.execPath, HOLDER, path, "stdin"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanups.push(async () => {
			holder.kill("SIGKILL");
			await holder.exited;
		});
		const output = holder.stdout!.getReader();
		const line = async () => new TextDecoder().decode((await output.read()).value);
		const locked = await line();
		if (locked !== "locked\n")
			assert.fail(`the holder did not take the lock: ${await readStreamText(holder.stderr)}`);

		const transaction = first.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')"));
		// The first connection waits in the writers' queue for the other process; once it takes the lock, it leaves the
		// queue, and the other connection of this process writes while that leaving is still on the slow disk.
		const statement = new Promise((resolve, reject) => {
			queueFiles.onUnlink = () =>
				setImmediate(() => void second.run("INSERT INTO items VALUES ('second')").then(resolve, reject));
		});
		const queued = () =>
			existsSync(`${path}-writers`) &&
			readdirSync(`${path}-writers`).some((name) => name.includes(`-${process.pid}-`));
		while (!queued()) await new Promise((resolve) => setTimeout(resolve, 5));
		holder.stdin!.end("commit\n");

		await Promise.all([transaction, statement]);
		assert.deepEqual(
			(await first.all<{ value: string }>("SELECT value FROM items ORDER BY value")).map((row) => row.value),
			["first", "second"],
		);
	},
	QUEUE_LEAVE_TEST_TIMEOUT_MS,
);
