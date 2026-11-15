import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { isWorkspaceRestoreError } from "../src/core/worktree-snapshot/errors.js";
import { objectStorePath, restoreWorktree } from "../src/core/worktree-snapshot/restore.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const CHILD = fileURLToPath(new URL("./fixtures/worktree-snapshot-restore-child.ts", import.meta.url));
const CONCURRENT_RESTORES = 8;
/** How long a test holds the repository lock as another process would, while the restore waits for it. */
const LOCK_HELD_MS = 500;
/** Eight Bun children that each load the snapshot modules and restore through Git: structural, not a slow test. */
const CONCURRENT_CHILDREN_TIMEOUT_MS = 120_000;

let sandbox: GitSandbox;

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	sandbox.dispose();
});

/** One snapshot per pushed commit of one repository, each of a different commit and tree. */
async function snapshotsOfOneRepository(count: number): Promise<WorktreeSnapshot[]> {
	const { clone } = await sandbox.remoteWithClone();
	const blobs = new MemorySnapshotBlobStore();
	const snapshots: WorktreeSnapshot[] = [];
	for (let index = 0; index < count; index++) {
		sandbox.write(join(clone, "state.txt"), `state ${index}\n`);
		await sandbox.commitAll(clone, `state ${index}`);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const captured = await captureWorktreeSnapshot(clone, { settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, blobs });
		if (captured.status !== "captured") throw new Error(captured.status);
		snapshots.push(captured.snapshot);
	}
	return snapshots;
}

interface ChildResult {
	readonly status: string;
	readonly path?: string;
	readonly error?: string;
}

/** Starts one child per snapshot, releases them together once all are ready, and collects each one's result. */
async function restoreConcurrently(
	mode: "exact" | "best",
	snapshots: readonly WorktreeSnapshot[],
	storeDir: string,
): Promise<ChildResult[]> {
	const children = snapshots.map((snapshot, index) => {
		const job = sandbox.path(`job-${index}.json`);
		writeFileSync(job, JSON.stringify({ mode, snapshot, storeDir, git: sandbox.executable }));
		return spawn(bunExecutable(), [CHILD, job], { stdio: ["pipe", "pipe", "pipe"] });
	});
	const outputs = children.map((child) => linesOf(child));
	await Promise.all(outputs.map((output) => output.next("ready")));
	for (const child of children) child.stdin.end("go\n");
	return Promise.all(outputs.map(async (output) => JSON.parse(await output.next("{")) as ChildResult));
}

/** Reads `child`'s stdout line by line; `next(prefix)` resolves the next line starting with `prefix`. */
function linesOf(child: ChildProcessWithoutNullStreams) {
	let buffered = "";
	let errors = "";
	let exited = false;
	const waiters: Array<() => void> = [];
	const wake = () => {
		for (const waiter of waiters.splice(0)) waiter();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		wake();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		errors += chunk.toString("utf8");
	});
	child.on("exit", () => {
		exited = true;
		wake();
	});
	return {
		async next(prefix: string): Promise<string> {
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					if (line.startsWith(prefix)) return line;
					continue;
				}
				if (exited) throw new Error(`the restore child ended before printing ${prefix}: ${errors}`);
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
}

async function headOf(path: string): Promise<string> {
	return sandbox.git(path, "rev-parse", "HEAD");
}

describe("concurrent first restores of one repository into a new store (#4951)", () => {
	test(
		"eight processes restoring different snapshots of one repository into a new store all restore exactly (#4951)",
		async () => {
			const snapshots = await snapshotsOfOneRepository(CONCURRENT_RESTORES);
			const results = await restoreConcurrently("exact", snapshots, sandbox.path("store"));
			assert.deepEqual(
				results.map((result) => result.status),
				snapshots.map(() => "restored"),
				JSON.stringify(results),
			);
			assert.deepEqual(
				await Promise.all(results.map((result) => headOf(result.path!))),
				snapshots.map((snapshot) => snapshot.head),
			);
			// Neither a temporary store nor a lock outlives the restores.
			const store = objectStorePath(sandbox.path("store"), snapshots[0]!.remotes);
			assert.deepEqual(readdirSync(dirname(store)), [basename(store)]);
		},
		CONCURRENT_CHILDREN_TIMEOUT_MS,
	);

	test(
		"eight processes best-restoring different snapshots of one repository into a new store leave none unrestored (#4951)",
		async () => {
			const snapshots = await snapshotsOfOneRepository(CONCURRENT_RESTORES);
			const results = await restoreConcurrently("best", snapshots, sandbox.path("store"));
			assert.deepEqual(
				results.map((result) => result.status),
				snapshots.map(() => "restored"),
				JSON.stringify(results),
			);
			assert.deepEqual(
				await Promise.all(results.map((result) => headOf(result.path!))),
				snapshots.map((snapshot) => snapshot.head),
			);
		},
		CONCURRENT_CHILDREN_TIMEOUT_MS,
	);
});

describe("the shared store's cross-process lock and initialisation (#4951)", () => {
	async function oneSnapshot() {
		const [snapshot] = await snapshotsOfOneRepository(1);
		const storeDir = sandbox.path("store");
		return { snapshot: snapshot!, storeDir, store: objectStorePath(storeDir, snapshot!.remotes) };
	}

	test("a store directory an earlier build left without its configuration is initialized in place (#4951)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		sandbox.write(join(store, "objects", "leftover"), "");
		const { path } = await restoreWorktree(snapshot, { storeDir });
		assert.equal(await headOf(path), snapshot.head);
		assert.equal(existsSync(join(store, "objects", "leftover")), true);
		assert.deepEqual(readdirSync(dirname(store)), [basename(store)]);
	});

	test("a restore waits for another process's repository lock, then restores (#4951)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		mkdirSync(`${store}.lock`, { recursive: true });
		let restored = false;
		const restoring = restoreWorktree(snapshot, { storeDir }).then((result) => {
			restored = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, LOCK_HELD_MS));
		assert.equal(restored, false);
		assert.equal(existsSync(store), false);
		rmSync(`${store}.lock`, { recursive: true });
		assert.equal(await headOf((await restoring).path), snapshot.head);
	});

	test("a repository lock its stopped holder no longer refreshes is taken once stale (#4951)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		mkdirSync(`${store}.lock`, { recursive: true });
		const past = new Date(Date.now() - 120_000);
		utimesSync(`${store}.lock`, past, past);
		const { path } = await restoreWorktree(snapshot, { storeDir });
		assert.equal(await headOf(path), snapshot.head);
		assert.equal(existsSync(`${store}.lock`), false);
	});

	test("a restore waiting for the repository lock stops when its signal aborts (#4951)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		mkdirSync(`${store}.lock`, { recursive: true });
		const controller = new AbortController();
		const reason = new Error("stopped");
		setTimeout(() => controller.abort(reason), LOCK_HELD_MS);
		await assert.rejects(restoreWorktree(snapshot, { storeDir, signal: controller.signal }), reason);
		assert.equal(existsSync(store), false);
	});

	test.skipIf(process.platform === "win32")(
		"a repository lock that cannot be written is an unwritable-path failure (#4951)",
		async () => {
			const { snapshot, storeDir, store } = await oneSnapshot();
			mkdirSync(dirname(store), { recursive: true });
			chmodSync(dirname(store), 0o555);
			try {
				await assert.rejects(restoreWorktree(snapshot, { storeDir }), (error: unknown) => {
					assert.ok(isWorkspaceRestoreError(error));
					assert.equal(error.code, "unwritable-path");
					assert.equal(error.target, `${store}.lock`);
					return true;
				});
			} finally {
				chmodSync(dirname(store), 0o755);
			}
		},
	);
});
