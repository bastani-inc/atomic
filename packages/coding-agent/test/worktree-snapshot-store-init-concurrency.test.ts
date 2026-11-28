import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { takeoverLockPath } from "../src/core/lock-takeover.js";
import { processStartTokenAsync } from "../src/core/process-start-token.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { isWorkspaceRestoreError } from "../src/core/worktree-snapshot/errors.js";
import {
	objectStorePath,
	REPOSITORY_LOCK_REFUSED_MS,
	restoreWorktree,
	withRepositoryLockProgress,
} from "../src/core/worktree-snapshot/restore.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { lockSharedWithHolder } from "../src/core/worktree-snapshot/shared-lock.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

/**
 * How many more times creating a repository lock directory (`<store>.lock`) is refused with EPERM, as Windows refuses a
 * directory of that name while another process's removal of it is pending; and how many times it was.
 */
const lockRefusals = vi.hoisted(() => ({ remaining: 0, refused: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mkdir = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
		if (String(path).endsWith(".git.lock") && lockRefusals.remaining > 0) {
			lockRefusals.remaining--;
			lockRefusals.refused++;
			const callback = rest.at(-1) as (error: NodeJS.ErrnoException) => void;
			const error = Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(path)}'`), {
				code: "EPERM",
				errno: -4048,
				syscall: "mkdir",
				path: String(path),
			});
			process.nextTick(() => callback(error));
			return;
		}
		return (actual.mkdir as (...args: unknown[]) => void)(path, ...rest);
	}) as typeof actual.mkdir;
	return { ...actual, default: { ...actual, mkdir }, mkdir };
});

useTemporaryAgentDir();

const CHILD = fileURLToPath(new URL("./fixtures/worktree-snapshot-restore-child.ts", import.meta.url));
const CONCURRENT_RESTORES = 8;
/** How long a test holds the repository lock as another process would, while the restore waits for it. */
const LOCK_HELD_MS = 500;
/** A restore on a local remote may do real Git work, but must not wait out the 30-second stale window. */
const RECLAIM_BUDGET_MS = 10_000;
const LEGACY_STALE_MS = 30_000;
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
	into?: string,
): Promise<ChildResult[]> {
	const children = snapshots.map((snapshot, index) => {
		const job = sandbox.path(`job-${index}.json`);
		writeFileSync(job, JSON.stringify({ mode, snapshot, storeDir, into, git: sandbox.executable }));
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

function assertStoreHasNoLeftovers(store: string): void {
	// The advisory mutex file is deliberately permanent; removing it could split the mutex in two.
	const mutexFile = basename(takeoverLockPath(`${store}.lock`));
	assert.deepEqual(
		readdirSync(dirname(store)).filter((name) => name !== mutexFile),
		[basename(store)],
	);
}

function ageLock(path: string, ageMs: number): void {
	const past = new Date(Date.now() - ageMs);
	utimesSync(path, past, past);
}

function exitedPid(): number {
	const exited = spawnSyncCollect([process.execPath, "-e", "console.log(process.pid)"]);
	assert.equal(exited.exitCode, 0);
	const pid = Number(exited.stdout.toString().trim());
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	return pid;
}

/** Stand-in for the record an Atomic holder wrote before it exited. */
function leaveRepositoryLock(store: string, pid: number, started?: string, ageMs?: number): string {
	const lockPath = `${store}.lock`;
	mkdirSync(lockPath, { recursive: true });
	// On APFS backdating the mtime can also change birthtime: record the identity after aging it.
	if (ageMs !== undefined) ageLock(lockPath, ageMs);
	const { dev, ino, birthtimeNs } = statSync(lockPath, { bigint: true });
	const lockId = `${dev}:${ino}:${birthtimeNs}`;
	writeFileSync(`${lockPath}.holder`, JSON.stringify({ host: hostname(), pid, started, lock: lockId, lockId }));
	return lockPath;
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
			const store = objectStorePath(sandbox.path("store"), snapshots[0]!.remotes);
			assertStoreHasNoLeftovers(store);
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

	test("two restores racing to recover a dead lock cannot both publish into the same checkout (#6800)", async () => {
		const snapshots = await snapshotsOfOneRepository(2);
		const storeDir = sandbox.path("store");
		const store = objectStorePath(storeDir, snapshots[0]!.remotes);
		leaveRepositoryLock(store, exitedPid());
		const target = sandbox.path("target");
		const results = await restoreConcurrently("exact", snapshots, storeDir, target);
		const winner = results.findIndex((result) => result.status === "restored");
		assert.equal(results.filter((result) => result.status === "restored").length, 1, JSON.stringify(results));
		assert.equal(await headOf(target), snapshots[winner]!.head);
		assert.equal(readFileSync(join(target, "state.txt"), "utf8"), `state ${winner}\n`);
		assertStoreHasNoLeftovers(store);
	});
});

test("an old holder's release does not remove a replacement lock directory (#6800)", async () => {
	const file = sandbox.path("shared");
	const release = await lockSharedWithHolder(file, { realpath: false, stale: LEGACY_STALE_MS });
	const lockPath = `${file}.lock`;
	// As when an older version reaps a stalled holder's lock, before the holder can see the replacement.
	rmSync(lockPath, { recursive: true });
	mkdirSync(lockPath);
	await release();
	assert.ok(existsSync(lockPath), "the old holder removed the replacement's lock");
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
		assertStoreHasNoLeftovers(store);
	});

	test("a restore into an existing store leaves its configuration alone (#4951)", async () => {
		const [first, second] = await snapshotsOfOneRepository(2);
		const storeDir = sandbox.path("store");
		await restoreWorktree(first!, { storeDir });
		const config = join(objectStorePath(storeDir, first!.remotes), "config");
		// A whole second in the past, which every filesystem stores exactly, so a sub-millisecond rounding never differs.
		const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000);
		utimesSync(config, past, past);
		const before = statSync(config, { bigint: true });
		const content = readFileSync(config, "utf8");
		const { path } = await restoreWorktree(second!, { storeDir });
		assert.equal(await headOf(path), second!.head);
		// Git rewrites a config through a lock file renamed over it: a new file, written now.
		const after = statSync(config, { bigint: true });
		assert.equal(after.ino, before.ino);
		assert.equal(after.mtimeMs / 1000n, BigInt(past.getTime() / 1000));
		assert.equal(readFileSync(config, "utf8"), content);
	});

	test.skipIf(process.platform === "win32")(
		"a restoring process publishes its PID and process start before opening the Git store (#6800)",
		async () => {
			const { snapshot, storeDir, store } = await oneSnapshot();
			const entered = sandbox.path("started-init");
			const resume = sandbox.path("resume-init");
			const shim = sandbox.path("gated-git");
			writeFileSync(
				shim,
				`#!/bin/sh
case " $* " in *' init '*)
  : > "$ENTERED_INIT"
  while [ ! -f "$RESUME_INIT" ]; do sleep 0.05; done
  ;;
esac
exec "$REAL_GIT" "$@"
`,
				{ mode: 0o700 },
			);
			const job = sandbox.path("holder-job.json");
			writeFileSync(
				job,
				JSON.stringify({
					mode: "exact",
					snapshot,
					storeDir,
					git: {
						path: shim,
						env: {
							...sandbox.executable.env,
							ENTERED_INIT: entered,
							RESUME_INIT: resume,
							REAL_GIT: sandbox.executable.path,
						},
					},
				}),
			);
			const child = spawn(bunExecutable(), [CHILD, job], { stdio: ["pipe", "pipe", "pipe"] });
			const output = linesOf(child);
			await output.next("ready");
			child.stdin.end("go\n");
			try {
				await vi.waitFor(() => assert.ok(existsSync(entered), "Git has not entered the gated store init"), {
					timeout: RECLAIM_BUDGET_MS,
				});
				const holder = JSON.parse(readFileSync(`${store}.lock.holder`, "utf8"));
				assert.equal(holder.pid, child.pid);
				const started = await processStartTokenAsync(child.pid!);
				assert.match(started ?? "", /^[0-9a-f]{12}$/);
				assert.equal(holder.started, started);
			} finally {
				writeFileSync(resume, "");
				const result = JSON.parse(await output.next("{")) as ChildResult;
				assert.equal(result.status, "restored", result.error);
			}
		},
	);

	test.skipIf(process.platform === "win32").each([
		{ point: "before moving files", halfMoved: false },
		{ point: "after moving files but before registering the checkout", halfMoved: true },
	])("recovering after a hard kill $point during Git publication (#6805)", async ({ halfMoved }) => {
		const [first, second] = await snapshotsOfOneRepository(2);
		const storeDir = sandbox.path("store");
		const target = sandbox.path("same-target");
		const entered = sandbox.path("entered-move");
		const releaseMove = sandbox.path("release-move");
		const shim = sandbox.path("gated-move-git");
		writeFileSync(
			shim,
			`#!/bin/sh
case " $* " in *' worktree move '*)
  if [ "$HALF_MOVE" = 1 ]; then
    from= to=
    for arg in "$@"; do from=$to; to=$arg; done
    mv -- "$from" "$to" || exit 1
  fi
  echo "$$" > "$ENTERED_MOVE"
  while [ ! -f "$RELEASE_MOVE" ]; do sleep 0.05; done
  ;;
esac
exec "$REAL_GIT" "$@"
`,
			{ mode: 0o700 },
		);
		const job = sandbox.path("orphan-job.json");
		writeFileSync(
			job,
			JSON.stringify({
				mode: "exact",
				snapshot: first,
				storeDir,
				into: target,
				git: {
					path: shim,
					env: {
						...sandbox.executable.env,
						ENTERED_MOVE: entered,
						HALF_MOVE: halfMoved ? "1" : "0",
						RELEASE_MOVE: releaseMove,
						REAL_GIT: sandbox.executable.path,
					},
				},
			}),
		);
		const child = spawn(bunExecutable(), [CHILD, job], { stdio: ["pipe", "pipe", "pipe"] });
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await linesOf(child).next("ready");
		child.stdin.end("go\n");
		let gitPid: number | undefined;
		let gitStart: string | undefined;
		const assertGitStopped = async () => {
			if (process.platform === "linux") {
				const status = await import("node:fs/promises").then(({ readFile }) =>
					readFile(`/proc/${gitPid}/stat`, "utf8").catch(() => ""),
				);
				assert.ok(
					status === "" || status.slice(status.lastIndexOf(")") + 2).startsWith("Z "),
					"the first Git move is still running",
				);
			} else {
				assert.equal(await processStartTokenAsync(gitPid!), undefined, "the first Git move is still running");
			}
		};
		try {
			await vi.waitFor(() => assert.ok(existsSync(entered), "Git has not reached the gated move"), {
				timeout: RECLAIM_BUDGET_MS,
			});
			gitPid = Number(readFileSync(entered, "utf8").trim());
			assert.ok(Number.isSafeInteger(gitPid) && gitPid > 1);
			gitStart = await processStartTokenAsync(gitPid);
			child.kill("SIGKILL");
			await exited;
			const signal = AbortSignal.timeout(RECLAIM_BUDGET_MS);
			if (halfMoved) {
				await vi.waitFor(assertGitStopped, { timeout: RECLAIM_BUDGET_MS });
				await assert.rejects(restoreWorktree(second!, { storeDir, into: target, signal }), {
					code: "unsafe-target",
				});
				const restores = join(storeDir, "restores");
				const recordLock = readdirSync(restores).find((name) => name.endsWith(".json.lock"));
				assert.ok(recordLock);
				ageLock(join(restores, recordLock), LEGACY_STALE_MS + 1_000);
				await restoreWorktree(second!, { storeDir, signal });
				const store = objectStorePath(storeDir, first!.remotes);
				const registered = await sandbox.git(store, "worktree", "list", "--porcelain");
				assert.ok(registered.split("\n").includes(`worktree ${realpathSync(target)}`), registered);
				assert.equal(await headOf(target), first!.head);
				assert.equal(readFileSync(join(target, "state.txt"), "utf8"), "state 0\n");
			} else {
				const restored = await restoreWorktree(second!, { storeDir, into: target, signal });
				assert.equal(await headOf(restored.path), second!.head);
				assert.equal(readFileSync(join(target, "state.txt"), "utf8"), "state 1\n");
				await assertGitStopped();
			}
		} finally {
			if (gitPid !== undefined && gitStart !== undefined && gitStart === (await processStartTokenAsync(gitPid))) {
				try {
					process.kill(gitPid, "SIGKILL");
				} catch {}
			}
			writeFileSync(releaseMove, "");
			child.kill("SIGKILL");
			await exited;
		}
	});

	test("a repository lock with a dead holder is reclaimed without waiting for its heartbeat to expire (#6800)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		const lockPath = leaveRepositoryLock(store, exitedPid());
		const { path } = await restoreWorktree(snapshot, { storeDir, signal: AbortSignal.timeout(RECLAIM_BUDGET_MS) });
		assert.equal(await headOf(path), snapshot.head);
		assert.equal(existsSync(lockPath), false);
		assert.equal(existsSync(`${lockPath}.holder`), false);
	});

	test.skipIf(!["darwin", "linux", "win32"].includes(process.platform))(
		"a repository lock with a reused PID is reclaimed without waiting for the heartbeat (#6800)",
		async () => {
			const { snapshot, storeDir, store } = await oneSnapshot();
			const currentStart = await processStartTokenAsync(process.pid);
			assert.match(currentStart ?? "", /^[0-9a-f]{12}$/);
			// The PID exists but its current process has a different (kernel-reported) start time.
			const recordedStart = currentStart === "0123456789ab" ? "abcd01234567" : "0123456789ab";
			leaveRepositoryLock(store, process.pid, recordedStart);
			const { path } = await restoreWorktree(snapshot, { storeDir, signal: AbortSignal.timeout(RECLAIM_BUDGET_MS) });
			assert.equal(await headOf(path), snapshot.head);
		},
	);

	test("a live holder keeps its repository lock even after the heartbeat expires, and the restore shows why it waits (#6800)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		const lockPath = leaveRepositoryLock(
			store,
			process.pid,
			await processStartTokenAsync(process.pid),
			LEGACY_STALE_MS + 1_000,
		);
		let notice!: (message: string) => void;
		const waiting = new Promise<string>((resolve) => {
			notice = resolve;
		});
		const restoring = withRepositoryLockProgress(notice, () =>
			restoreWorktree(snapshot, { storeDir, signal: AbortSignal.timeout(RECLAIM_BUDGET_MS) }),
		);
		try {
			const message = await Promise.race([waiting, restoring.then(() => assert.fail("restore did not wait"))]);
			assert.match(message, /Waiting for another Atomic process restoring this repository/);
			assert.equal(existsSync(store), false);
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
			await restoring;
		}
		assert.equal(await headOf((await restoring).path), snapshot.head);
	});

	test("a legacy repository lock inside the 30-second window keeps the restore waiting (#6800)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		mkdirSync(`${store}.lock`, { recursive: true });
		ageLock(`${store}.lock`, LEGACY_STALE_MS - 5_000);
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

	test("a legacy repository lock can be reclaimed just past the 30-second window (#6800)", async () => {
		const { snapshot, storeDir, store } = await oneSnapshot();
		mkdirSync(`${store}.lock`, { recursive: true });
		ageLock(`${store}.lock`, LEGACY_STALE_MS + 1_000);
		const { path } = await restoreWorktree(snapshot, { storeDir, signal: AbortSignal.timeout(RECLAIM_BUDGET_MS) });
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

	describe("on Windows, where creating a lock directory another process is removing fails with EPERM", () => {
		const platform = process.platform;
		const setPlatform = (value: NodeJS.Platform) =>
			Object.defineProperty(process, "platform", { value, configurable: true });
		afterEach(() => {
			setPlatform(platform);
			lockRefusals.remaining = 0;
			lockRefusals.refused = 0;
		});

		test("a restore whose repository lock is refused for a moment waits for it, then restores", async () => {
			const { snapshot, storeDir, store } = await oneSnapshot();
			setPlatform("win32");
			lockRefusals.remaining = 3;
			const { path } = await restoreWorktree(snapshot, { storeDir });
			setPlatform(platform);
			assert.equal(lockRefusals.refused, 3);
			assert.equal(await headOf(path), snapshot.head);
			assertStoreHasNoLeftovers(store);
		});

		test(
			"a repository lock refused for 10 seconds on end is an unwritable-path failure",
			async () => {
				const { snapshot, storeDir, store } = await oneSnapshot();
				setPlatform("win32");
				lockRefusals.remaining = Number.POSITIVE_INFINITY;
				const started = Date.now();
				await assert.rejects(restoreWorktree(snapshot, { storeDir }), (error: unknown) => {
					assert.ok(isWorkspaceRestoreError(error));
					assert.equal(error.code, "unwritable-path");
					assert.equal(error.target, `${store}.lock`);
					return true;
				});
				assert.ok(Date.now() - started >= REPOSITORY_LOCK_REFUSED_MS, "it was tried again for the whole budget");
				assert.ok(lockRefusals.refused > 1, "it was tried again");
				assert.equal(existsSync(store), false);
			},
			REPOSITORY_LOCK_REFUSED_MS * 3,
		);

		test.skipIf(process.platform === "win32")("elsewhere a refused repository lock fails at once", async () => {
			const { snapshot, storeDir } = await oneSnapshot();
			lockRefusals.remaining = Number.POSITIVE_INFINITY;
			await assert.rejects(restoreWorktree(snapshot, { storeDir }), { code: "unwritable-path" });
			assert.equal(lockRefusals.refused, 1);
		});
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
					assert.equal(error.snapshotId, snapshot.id);
					return true;
				});
			} finally {
				chmodSync(dirname(store), 0o755);
			}
		},
	);
});
