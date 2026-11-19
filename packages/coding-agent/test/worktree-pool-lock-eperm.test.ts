import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	admitPooledWorktree,
	claimIdleWorktree,
	confirmPooledWorktreeLease,
	discardPooledWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	POOL_LOCK_REFUSED_MS,
	type PoolSlotRecord,
	pooledWorktreePath,
	releaseRestoredWorktree,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import { restoreWorktreeAt } from "../src/core/worktree-snapshot/restore.js";
import {
	adoptPrebuiltSeed,
	SEED_LOCK_REFUSED_MS,
	seedDirectory,
	seedManifestPath,
	withSeedLock,
	writeSeedManifest,
} from "../src/core/worktree-snapshot/seeds.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

const pollClock = vi.hoisted(() => ({
	enabled: false,
	elapsedMs: 0,
	delays: [] as number[],
	onSleep: undefined as (() => void) | undefined,
	/**
	 * Whether the filesystem's clock reads the poll clock too. Locks judge staleness by the filesystem's clock, measured
	 * with a probe file (#5050); with this off the probe reads the real clock, so real time spent before the first
	 * staleness check, which a loaded machine stretches, counts toward a lock's age on top of the polled time.
	 */
	filesystem: false,
}));

vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	const setTimeout: typeof actual.setTimeout = async (delay, value, options) => {
		if (!pollClock.enabled) return actual.setTimeout(delay, value, options);
		pollClock.delays.push(delay ?? 0);
		pollClock.elapsedMs += delay ?? 0;
		pollClock.onSleep?.();
		if (options?.signal?.aborted) return actual.setTimeout(0, value, options);
		return value as never;
	};
	return { ...actual, setTimeout };
});

const lockRefusals = vi.hoisted(() => ({
	remaining: 0,
	refused: 0,
	attempts: 0,
	code: "EPERM" as string,
	suffix: ".lock" as string,
	targets: new Set<string>(),
	refusedByTarget: new Map<string, number>(),
	onAttempt: undefined as
		| ((attempt: number, path: string) => boolean | Promise<boolean | undefined> | undefined)
		| undefined,
	onRefusal: undefined as ((refused: number, path: string) => void) | undefined,
	onCompromised: undefined as ((path: string) => void) | undefined,
	deleteOnCloseUnavailable: false,
	afterWrite: undefined as ((path: string) => void) | undefined,
	onRecordWrite: undefined as ((path: string, data: string) => Promise<void>) | undefined,
	onRemove: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("../src/core/worktree-snapshot/shared-clock.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/worktree-snapshot/shared-clock.js")>();
	const lockShared: typeof actual.lockShared = (path, options) =>
		actual.lockShared(path, {
			...options,
			onCompromised: (error) => {
				options.onCompromised?.(error);
				lockRefusals.onCompromised?.(path);
			},
		});
	return {
		...actual,
		lockShared,
		windowsTemporaryFiles: () => (lockRefusals.deleteOnCloseUnavailable ? undefined : actual.windowsTemporaryFiles()),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const writeFile: typeof actual.writeFile = async (path, data, options) => {
		if (typeof data === "string") await lockRefusals.onRecordWrite?.(String(path), data);
		await actual.writeFile(path, data, options);
		lockRefusals.afterWrite?.(String(path));
	};
	const rm: typeof actual.rm = async (path, options) => {
		await lockRefusals.onRemove?.(String(path));
		return actual.rm(path, options);
	};
	const stat = (async (path: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
		const stats = await actual.stat(path, options);
		if (!pollClock.enabled || !pollClock.filesystem || !/\.clock-[0-9a-f]{16}\.probe$/.test(String(path)))
			return stats;
		return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mtimeMs: Date.now() });
	}) as typeof actual.stat;
	return { ...actual, writeFile, rm, stat };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mkdir = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
		const target = String(path);
		const matchesTarget =
			lockRefusals.targets.size > 0
				? lockRefusals.targets.has(target)
				: target.endsWith(lockRefusals.suffix) && !target.endsWith(".git.lock");
		if (matchesTarget) {
			lockRefusals.attempts++;
			const finish = (forced: boolean | undefined) => {
				if (forced === true || (forced === undefined && lockRefusals.remaining > 0)) {
					if (forced === undefined) lockRefusals.remaining--;
					lockRefusals.refused++;
					lockRefusals.refusedByTarget.set(target, (lockRefusals.refusedByTarget.get(target) ?? 0) + 1);
					const code = lockRefusals.code;
					lockRefusals.onRefusal?.(lockRefusals.refused, target);
					const callback = rest.at(-1) as (error: NodeJS.ErrnoException) => void;
					const error = Object.assign(new Error(`${code}: operation not permitted, mkdir '${target}'`), {
						code,
						errno: code === "EPERM" ? -4048 : -4092,
						syscall: "mkdir",
						path: target,
					});
					process.nextTick(() => callback(error));
					return;
				}
				(actual.mkdir as (...args: unknown[]) => void)(path, ...rest);
			};
			const decision = lockRefusals.onAttempt?.(lockRefusals.attempts, target);
			if (decision instanceof Promise) {
				void decision.then(finish, (error: Error) => {
					const callback = rest.at(-1) as (error: Error) => void;
					callback(error);
				});
				return;
			}
			finish(decision);
			return;
		}
		return (actual.mkdir as (...args: unknown[]) => void)(path, ...rest);
	}) as typeof actual.mkdir;
	const stat = ((
		path: import("node:fs").PathLike,
		callback: (error: NodeJS.ErrnoException | null, stats: import("node:fs").Stats) => void,
	) =>
		actual.stat(path, (error, stats) => {
			if (!error && pollClock.enabled && pollClock.filesystem && /\.clock-[0-9a-f]{16}\.probe$/.test(String(path)))
				stats.mtimeMs = Date.now();
			callback(error, stats);
		})) as typeof actual.stat;
	return { ...actual, default: { ...actual, mkdir, stat }, mkdir, stat };
});

useTemporaryAgentDir();

const EXPECTED_LOCK_REFUSED_MS = 10_000;
const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
const POOL_MODULE_PATH = fileURLToPath(new URL("../src/core/worktree-snapshot/pool.ts", import.meta.url));

let sandbox: GitSandbox;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
	sandbox = new GitSandbox();
});

afterEach(() => {
	setPlatform(originalPlatform);
	pollClock.enabled = false;
	pollClock.elapsedMs = 0;
	pollClock.delays = [];
	pollClock.onSleep = undefined;
	pollClock.filesystem = false;
	vi.restoreAllMocks();
	lockRefusals.remaining = 0;
	lockRefusals.refused = 0;
	lockRefusals.attempts = 0;
	lockRefusals.code = "EPERM";
	lockRefusals.suffix = ".lock";
	lockRefusals.targets.clear();
	lockRefusals.refusedByTarget.clear();
	lockRefusals.onAttempt = undefined;
	lockRefusals.onRefusal = undefined;
	lockRefusals.onCompromised = undefined;
	lockRefusals.onRecordWrite = undefined;
	lockRefusals.onRemove = undefined;
	lockRefusals.deleteOnCloseUnavailable = false;
	lockRefusals.afterWrite = undefined;
	sandbox.dispose();
});

function admissionChild(script: string) {
	const child = spawn(bunExecutable(), ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout });
	const iterator = lines[Symbol.asyncIterator]();
	const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
		child.once("exit", (code) => resolve({ code }));
		child.once("error", (error) => {
			resolve({ code: null, error });
			lines.close();
		});
	});
	return {
		child,
		exited,
		nextLine: async () => {
			const line = await iterator.next();
			if (!line.done) return line.value;
			const result = await exited;
			throw result.error ?? new Error(`admission child exited with ${result.code} before replying`);
		},
		close: async () => {
			lines.close();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		},
	};
}

async function capturedPair(): Promise<{
	first: WorktreeSnapshot;
	second: WorktreeSnapshot;
	blobs: MemorySnapshotBlobStore;
}> {
	const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "build/\n", "README.md": "hello\n" });
	const blobs = new MemorySnapshotBlobStore();
	sandbox.write(join(clone, "state.txt"), "first\n");
	const firstCapture = await captureWorktreeSnapshot(clone, { settings, blobs });
	if (firstCapture.status !== "captured") throw new Error(firstCapture.status);
	sandbox.write(join(clone, "state.txt"), "second\n");
	const secondCapture = await captureWorktreeSnapshot(clone, { settings, blobs });
	if (secondCapture.status !== "captured") throw new Error(secondCapture.status);
	return { first: firstCapture.snapshot, second: secondCapture.snapshot, blobs };
}

async function parkedSeed(
	storeDir: string,
): Promise<{ snapshot: WorktreeSnapshot; repository: ReturnType<typeof repositoryIdOf> }> {
	const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "build/\n", "README.md": "hello\n" });
	const captured = await captureWorktreeSnapshot(clone, { settings, blobs: new MemorySnapshotBlobStore() });
	if (captured.status !== "captured") throw new Error(captured.status);
	const snapshot = captured.snapshot;
	const repository = repositoryIdOf(snapshot.remotes);
	const buildOut = join(seedDirectory(storeDir, repository), "build", "out.txt");
	mkdirSync(dirname(buildOut), { recursive: true });
	writeFileSync(buildOut, "built\n");
	await writeSeedManifest(storeDir, {
		version: 1,
		repository,
		head: snapshot.head,
		tree: snapshot.tree,
		envHash: snapshot.envHash,
		paths: ["build"],
		worktree: pooledWorktreePath(storeDir, repository, 0 as SlotNumber),
		parkedAt: new Date().toISOString(),
	});
	return { snapshot, repository };
}

async function withIntermittentRefusalReset<T>(lockDir: string, suffix: string, action: () => Promise<T>): Promise<T> {
	setPlatform("win32");
	const realNow = Date.now.bind(Date);
	let clockOffsetMs = 0;
	const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
	try {
		lockRefusals.suffix = suffix;
		lockRefusals.attempts = 0;
		lockRefusals.refused = 0;
		lockRefusals.onAttempt = (attempt) => {
			if (attempt === 1) {
				clockOffsetMs = 6_000;
				return true;
			}
			if (attempt === 2) {
				mkdirSync(lockDir, { recursive: true });
				return false;
			}
			if (attempt === 3) {
				rmSync(lockDir, { recursive: true, force: true });
				clockOffsetMs = 17_000;
				return true;
			}
			return false;
		};
		return await action();
	} finally {
		nowSpy.mockRestore();
	}
}

async function measureRefusedOperation<T>(
	targetLock: string,
	action: () => Promise<T>,
	verify: (result: T) => void,
): Promise<void> {
	const startedAt = Date.now();
	const result = await action();
	const elapsedMs = Date.now() - startedAt;
	verify(result);
	const targetRefusals = lockRefusals.refusedByTarget.get(targetLock) ?? 0;
	assert.ok(targetRefusals > 1, `expected > 1 refusal for ${targetLock}, got ${targetRefusals}`);
	assert.ok(
		elapsedMs >= EXPECTED_LOCK_REFUSED_MS,
		`expected >= ${EXPECTED_LOCK_REFUSED_MS}ms for ${targetLock}, got ${elapsedMs}ms`,
	);
	assert.ok(
		elapsedMs < EXPECTED_LOCK_REFUSED_MS + 8_000,
		`expected < ${EXPECTED_LOCK_REFUSED_MS + 8_000}ms for ${targetLock}, got ${elapsedMs}ms`,
	);
}

function usePollClock(): void {
	const startedAt = Date.now();
	pollClock.enabled = true;
	vi.spyOn(Date, "now").mockImplementation(() => startedAt + pollClock.elapsedMs);
}

describe("worktree pool and seed locks on Windows when a lock directory is briefly refused with EPERM (#5320)", () => {
	test.each([
		"seed",
		"slot",
		"lease",
		"admission-repository",
		"admission-slot",
		"admission-lease",
		"hold-lease",
		"eviction",
	] as const)("cancelling %s acquisition interrupts persistent Windows EPERM polling (#5320)", async (target) => {
		const storeDir = sandbox.path("store");
		const { snapshot, repository } = await parkedSeed(storeDir);
		const owner = { kind: "session" as const, id: "owner" };
		const state = { snapshotId: snapshot.id, head: snapshot.head, tree: snapshot.tree };
		const adopting = target === "seed" || target.startsWith("admission-");
		if (!adopting) {
			const admitted = await admitPooledWorktree(
				{ storeDir, remotes: snapshot.remotes, root: snapshot.root, lastState: state, envHash: snapshot.envHash },
				owner,
			);
			await restoreWorktreeAt(snapshot, admitted.path, { storeDir });
			await releaseRestoredWorktree(admitted, state);
		}
		setPlatform("win32");
		lockRefusals.suffix =
			target === "seed"
				? `${repository}.json.lock`
				: target === "admission-repository"
					? `${repository}.lock`
					: target.endsWith("lease")
						? ".lease.lock"
						: "0.json.lock";
		lockRefusals.remaining = Number.POSITIVE_INFINITY;
		const controller = new AbortController();
		usePollClock();
		pollClock.onSleep = () => {
			if (pollClock.elapsedMs >= 200) controller.abort();
		};
		if (target === "eviction") {
			assert.deepEqual(
				await evictIdleWorktrees(storeDir, repository, {
					settings,
					maxIdle: 0,
					signal: controller.signal,
				}),
				[],
			);
		} else {
			const action = adopting
				? adoptPrebuiltSeed(snapshot, { storeDir, signal: controller.signal })
				: target === "hold-lease"
					? holdRestoredWorktree(
							storeDir,
							pooledWorktreePath(storeDir, repository, 0 as SlotNumber),
							owner,
							controller.signal,
						)
					: claimIdleWorktree(snapshot, { storeDir, owner, settings, signal: controller.signal });
			await assert.rejects(action, { name: "AbortError" });
		}
		assert.equal(pollClock.elapsedMs, 200);
		assert.equal(lockRefusals.refused, 4);
		assert.equal(existsSync(join(storeDir, "pool", repository, "0.json.lock")), false);
		if (adopting) assert.equal(existsSync(seedManifestPath(storeDir, repository)), true);
		else {
			const record = JSON.parse(
				readFileSync(join(storeDir, "pool", repository, "0.json"), "utf8"),
			) as PoolSlotRecord;
			assert.equal(record.resetting, undefined);
			assert.ok(record.releasedAt);
		}
	});

	test.each(["repository", "slot", "seed"] as const)(
		"waiting for a live %s lock stops at its held-lock budget with 50 ms polls (#5320)",
		async (target) => {
			const storeDir = sandbox.path("store");
			const remotes = ["https://example.com/acme/repo.git"];
			const repository = repositoryIdOf(remotes);
			const owner = { kind: "session" as const, id: "owner" };
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			const admission = { storeDir, remotes, lastState: state, envHash: "env" };
			const slot = target === "slot" ? await admitPooledWorktree(admission, owner) : undefined;
			if (slot !== undefined) await releaseRestoredWorktree(slot, state);
			const lock =
				target === "seed"
					? `${seedManifestPath(storeDir, repository)}.lock`
					: target === "slot"
						? join(storeDir, "pool", repository, "0.json.lock")
						: join(storeDir, "pool", `${repository}.lock`);
			mkdirSync(lock, { recursive: true });
			const realNow = Date.now.bind(Date);
			lockRefusals.targets.add(lock);
			lockRefusals.onAttempt = (attempt) => {
				const refreshed = new Date(realNow() + attempt);
				utimesSync(lock, refreshed, refreshed);
				return false;
			};
			const expectedWaitMs = target === "seed" ? 120_000 : 60_000;
			usePollClock();
			pollClock.onSleep = () =>
				assert.ok(pollClock.elapsedMs <= expectedWaitMs, "held-lock wait exceeded its budget");
			const action =
				target === "seed"
					? withSeedLock(storeDir, repository, true, async () => "acquired")
					: target === "slot"
						? holdRestoredWorktree(storeDir, slot!.path, owner)
						: admitPooledWorktree(admission, owner);
			await assert.rejects(action, { code: "ELOCKED" });
			assert.equal(pollClock.elapsedMs, expectedWaitMs);
			assert.ok(pollClock.delays.every((delay) => delay === 50));
			assert.equal(existsSync(lock), true);
		},
	);

	test.each(["repository", "slot", "seed"] as const)(
		"waiting for a stopped %s lock holder outlasts its stale time and acquires it (#5320)",
		async (target) => {
			const storeDir = sandbox.path("store");
			const remotes = ["https://example.com/acme/repo.git"];
			const repository = repositoryIdOf(remotes);
			const owner = { kind: "session" as const, id: "owner" };
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			const admission = { storeDir, remotes, lastState: state, envHash: "env" };
			const slot = target === "slot" ? await admitPooledWorktree(admission, owner) : undefined;
			if (slot !== undefined) await releaseRestoredWorktree(slot, state);
			const lock =
				target === "seed"
					? `${seedManifestPath(storeDir, repository)}.lock`
					: target === "slot"
						? join(storeDir, "pool", repository, "0.json.lock")
						: join(storeDir, "pool", `${repository}.lock`);
			mkdirSync(lock, { recursive: true });
			usePollClock();
			// The stopped holder last refreshed its lock when the wait began, by the one clock the lock and the poll share.
			pollClock.filesystem = true;
			const stoppedAt = new Date(Date.now());
			utimesSync(lock, stoppedAt, stoppedAt);
			pollClock.onSleep = () => assert.ok(pollClock.elapsedMs <= 30_100, "stale holder was not replaced");
			if (target === "seed") {
				assert.equal(await withSeedLock(storeDir, repository, true, async () => "acquired"), "acquired");
			} else {
				const lease =
					target === "slot"
						? await holdRestoredWorktree(storeDir, slot!.path, owner)
						: await admitPooledWorktree(admission, owner);
				assert.ok(lease);
				await releaseRestoredWorktree(lease, state);
			}
			assert.ok(pollClock.elapsedMs >= 30_000);
			assert.ok(pollClock.delays.every((delay) => delay === 50));
			assert.equal(existsSync(lock), false);
		},
	);

	test("admitPooledWorktree waits out transient Windows EPERM on the repository, slot, and lease locks (#5320)", async () => {
		const storeDir = sandbox.path("store");
		const remotes = ["https://example.com/acme/repo.git"];
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		const owner = { kind: "session" as const, id: "owner-1" };

		setPlatform("win32");
		lockRefusals.suffix = `${repositoryIdOf(remotes)}.lock`;
		lockRefusals.remaining = 3;
		const leaseFromRepoLock = await admitPooledWorktree(
			{ storeDir, remotes, lastState: state, envHash: "env" },
			owner,
		);
		assert.equal(lockRefusals.refused, 3);
		assert.equal(leaseFromRepoLock.slot, 0);
		await discardPooledWorktree(leaseFromRepoLock);

		lockRefusals.refused = 0;
		lockRefusals.suffix = "0.json.lock";
		lockRefusals.remaining = 3;
		const leaseFromSlotLock = await admitPooledWorktree(
			{ storeDir, remotes, lastState: state, envHash: "env" },
			owner,
		);
		assert.equal(lockRefusals.refused, 3);
		assert.equal(leaseFromSlotLock.slot, 0);
		await discardPooledWorktree(leaseFromSlotLock);

		lockRefusals.refused = 0;
		lockRefusals.suffix = ".lease.lock";
		lockRefusals.remaining = 3;
		const leaseFromLeaseLock = await admitPooledWorktree(
			{ storeDir, remotes, lastState: state, envHash: "env" },
			owner,
		);
		assert.equal(lockRefusals.refused, 3);
		assert.equal(leaseFromLeaseLock.slot, 0);
		await discardPooledWorktree(leaseFromLeaseLock);
	});

	test("claimIdleWorktree, holdRestoredWorktree, releaseRestoredWorktree, and evictIdleWorktrees wait out transient Windows EPERM (#5320)", async () => {
		const { first, second, blobs } = await capturedPair();
		const storeDir = sandbox.path("store");
		const ownerA = { kind: "session" as const, id: "owner-a" };
		const ownerB = { kind: "session" as const, id: "owner-b" };
		const stateA = { snapshotId: first.id, head: first.head, tree: first.tree };

		const admitted = await admitPooledWorktree(
			{ storeDir, remotes: first.remotes, root: first.root, lastState: stateA, envHash: first.envHash },
			ownerA,
		);
		await restoreWorktreeAt(first, admitted.path, { storeDir, blobs });

		setPlatform("win32");
		lockRefusals.suffix = "0.json.lock";
		lockRefusals.remaining = 3;
		assert.equal(await releaseRestoredWorktree(admitted, stateA), true);
		assert.equal(lockRefusals.refused, 3);

		lockRefusals.refused = 0;
		lockRefusals.remaining = 3;
		const heldAgain = await holdRestoredWorktree(storeDir, admitted.path, ownerA);
		assert.ok(heldAgain);
		assert.equal(lockRefusals.refused, 3);
		assert.equal(await releaseRestoredWorktree(heldAgain, stateA), true);

		lockRefusals.refused = 0;
		lockRefusals.remaining = 3;
		const claimed = await claimIdleWorktree(second, { storeDir, owner: ownerB, settings, blobs });
		assert.equal(lockRefusals.refused, 3);
		assert.equal(claimed.claimed, true);
		if (!claimed.claimed) throw new Error(claimed.reason);
		const stateB = { snapshotId: second.id, head: second.head, tree: second.tree };
		assert.equal(await releaseRestoredWorktree(claimed.lease, stateB), true);

		lockRefusals.refused = 0;
		lockRefusals.remaining = 3;
		const evicted = await evictIdleWorktrees(storeDir, repositoryIdOf(second.remotes), { maxIdle: 0, settings });
		assert.equal(lockRefusals.refused, 3);
		assert.deepEqual(evicted, [claimed.lease.path]);
	});

	test("a claim cancelled while committing its reset finishes the record update and keeps its lease (#5320)", async () => {
		const { first, second, blobs } = await capturedPair();
		const storeDir = sandbox.path("store-claim-commit");
		const before = { snapshotId: first.id, head: first.head, tree: first.tree };
		const admitted = await admitPooledWorktree(
			{ storeDir, remotes: first.remotes, root: first.root, lastState: before, envHash: first.envHash },
			{ kind: "session", id: "owner-a" },
		);
		await restoreWorktreeAt(first, admitted.path, { storeDir, blobs });
		await releaseRestoredWorktree(admitted, before);
		const file = join(storeDir, "pool", admitted.repository, "0.json");
		const controller = new AbortController();
		lockRefusals.targets.add(`${file}.lock`);
		lockRefusals.code = "ELOCKED";
		lockRefusals.attempts = 0;
		lockRefusals.onAttempt = (attempt) => attempt === 2;
		lockRefusals.onRefusal = () => controller.abort(new Error("cancelled while committing the claim"));
		const owner = { kind: "session" as const, id: "owner-b" };

		const claimed = await claimIdleWorktree(second, { storeDir, owner, settings, blobs, signal: controller.signal });

		assert.equal(controller.signal.aborted, true);
		assert.equal(claimed.claimed, true);
		if (!claimed.claimed) throw new Error(claimed.reason);
		try {
			const record = JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord;
			assert.deepEqual(record.holder, owner);
			assert.deepEqual(record.lastState, { snapshotId: second.id, head: second.head, tree: second.tree });
			assert.equal(record.resetting, undefined);
			assert.equal(readFileSync(join(claimed.lease.path, "state.txt"), "utf8"), "second\n");
			assert.equal(await confirmPooledWorktreeLease(claimed.lease), true);
		} finally {
			await releaseRestoredWorktree(claimed.lease);
		}
	});

	test("adoptPrebuiltSeed and withSeedLock wait out transient Windows EPERM and adopt the seed (#5320)", async () => {
		const storeDir = sandbox.path("store");
		const { snapshot, repository } = await parkedSeed(storeDir);

		setPlatform("win32");
		lockRefusals.suffix = `${repository}.json.lock`;
		lockRefusals.remaining = 3;
		const lockRan = await withSeedLock(storeDir, repository, false, async () => "ok");
		assert.equal(lockRan, "ok");
		assert.equal(lockRefusals.refused, 3);

		lockRefusals.refused = 0;
		lockRefusals.remaining = 3;
		const waitedRan = await withSeedLock(storeDir, repository, true, async () => "waited");
		assert.equal(waitedRan, "waited");
		assert.equal(lockRefusals.refused, 3);

		lockRefusals.refused = 0;
		lockRefusals.remaining = 3;
		const adoption = await adoptPrebuiltSeed(snapshot, { storeDir });
		assert.equal(lockRefusals.refused, 3);
		assert.equal(adoption.adopted, true);
		if (!adoption.adopted) throw new Error(adoption.reason);
		assert.deepEqual(adoption.moved, ["build"]);
	});

	test("a slot or seed lock refused with EPERM on Windows while another process takes it is treated as busy (#5320)", async () => {
		const storeDir = sandbox.path("store");
		const { snapshot, repository } = await parkedSeed(storeDir);
		const remotes = snapshot.remotes;
		const state = { snapshotId: null, head: snapshot.head, tree: snapshot.tree };
		const owner = { kind: "session" as const, id: "owner-1" };
		const slot0Lock = join(storeDir, "pool", repository, "0.json.lock");
		const seedLock = `${seedManifestPath(storeDir, repository)}.lock`;

		setPlatform("win32");
		lockRefusals.suffix = `${repository}.json.lock`;
		lockRefusals.remaining = 2;
		lockRefusals.onRefusal = (refused) => {
			if (refused === 2) mkdirSync(seedLock, { recursive: true });
		};
		const seedBusy = await adoptPrebuiltSeed(snapshot, { storeDir });
		assert.equal(lockRefusals.refused, 2);
		assert.deepEqual(seedBusy, { adopted: false, reason: "busy" });

		lockRefusals.refused = 0;
		lockRefusals.suffix = "0.json.lock";
		lockRefusals.remaining = 2;
		lockRefusals.onRefusal = (refused) => {
			if (refused === 2) mkdirSync(slot0Lock, { recursive: true });
		};
		const admitted = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
		assert.equal(lockRefusals.refused, 2);
		assert.equal(admitted.slot, 1);
		await discardPooledWorktree(admitted);

		writeFileSync(
			join(storeDir, "pool", repository, "0.json"),
			JSON.stringify({
				version: 1,
				repository,
				slot: 0,
				path: join(storeDir, "worktrees", `${repository}-0`),
				holder: owner,
				lastState: state,
				envHash: "env",
				blueprintDigest: null,
				releasedAt: new Date().toISOString(),
			}),
		);
		lockRefusals.refused = 0;
		lockRefusals.remaining = 2;
		lockRefusals.onRefusal = undefined;
		const claimed = await claimIdleWorktree(snapshot, {
			storeDir,
			owner: { kind: "session", id: "owner-2" },
			settings,
		});
		assert.equal(lockRefusals.refused, 2);
		assert.deepEqual(claimed, { claimed: false, reason: "busy" });
	});

	test("intermittent Windows EPERM separated by ELOCKED resets the refusal timer on pool and seed locks (#5320)", async () => {
		const storeDir = sandbox.path("store");
		const { snapshot, repository } = await parkedSeed(storeDir);
		const state = { snapshotId: null, head: snapshot.head, tree: snapshot.tree };
		const owner = { kind: "session" as const, id: "owner-1" };
		const lease = await admitPooledWorktree(
			{ storeDir, remotes: snapshot.remotes, lastState: state, envHash: "env" },
			owner,
		);
		await releaseRestoredWorktree(lease, state);
		const slot0Lock = join(storeDir, "pool", repository, "0.json.lock");
		const seedLock = `${seedManifestPath(storeDir, repository)}.lock`;

		const held = await withIntermittentRefusalReset(slot0Lock, "0.json.lock", () =>
			holdRestoredWorktree(storeDir, lease.path, owner),
		);
		assert.ok(held);
		assert.equal(lockRefusals.refused, 2);
		await releaseRestoredWorktree(held, state);

		const seedResult = await withIntermittentRefusalReset(seedLock, `${repository}.json.lock`, () =>
			withSeedLock(storeDir, repository, true, async () => "acquired"),
		);
		assert.equal(seedResult, "acquired");
		assert.equal(lockRefusals.refused, 2);
	});

	test("admitPooledWorktree never overwrites another process's slot when the repository lock is taken over (#5320)", async () => {
		const remotes = ["https://example.com/acme/repo.git"];
		const repository = repositoryIdOf(remotes);
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		const ownerA = { kind: "session" as const, id: "owner-a" };
		const ownerB = { kind: "session" as const, id: "owner-b" };

		const storePreHeartbeat = sandbox.path("store-pre-heartbeat");
		const preSlot0Lock = join(storePreHeartbeat, "pool", repository, "0.json.lock");
		const preRepoLock = join(storePreHeartbeat, "pool", `${repository}.lock`);
		let childPre: ReturnType<typeof admissionChild> | undefined;
		try {
			lockRefusals.targets.add(preSlot0Lock);
			let pausedOnce = false;
			lockRefusals.onAttempt = async (_attempt, target) => {
				if (target !== preSlot0Lock || pausedOnce) return false;
				pausedOnce = true;
				rmSync(preRepoLock, { recursive: true, force: true });
				const admissionB = { storeDir: storePreHeartbeat, remotes, lastState: state, envHash: "env" };
				const script = [
					`import { admitPooledWorktree, discardPooledWorktree } from ${JSON.stringify(POOL_MODULE_PATH)};`,
					`import { createInterface } from "node:readline";`,
					`const lease = await admitPooledWorktree(${JSON.stringify(admissionB)}, ${JSON.stringify(ownerB)});`,
					`process.stdout.write(JSON.stringify({ slot: lease.slot, path: lease.path }) + "\\n");`,
					`const rl = createInterface({ input: process.stdin });`,
					`await new Promise((resolve) => rl.once("line", resolve));`,
					`rl.close();`,
					`await discardPooledWorktree(lease);`,
				].join("\n");
				childPre = admissionChild(script);
				const line = await childPre.nextLine();
				const childLease = JSON.parse(line) as { slot: number; path: string };
				assert.equal(childLease.slot, 0);
				return false;
			};
			const leaseA = await admitPooledWorktree(
				{ storeDir: storePreHeartbeat, remotes, lastState: state, envHash: "env" },
				ownerA,
			);
			assert.equal(leaseA.slot, 1);
			const slot0Record = JSON.parse(
				readFileSync(join(storePreHeartbeat, "pool", repository, "0.json"), "utf8"),
			) as PoolSlotRecord;
			assert.deepEqual(slot0Record.holder, ownerB);
			await discardPooledWorktree(leaseA);
			childPre?.child.stdin.end("done\n");
			if (childPre) assert.equal((await childPre.exited).code, 0);
			childPre = undefined;
		} finally {
			await childPre?.close();
		}

		const storeCompromised = sandbox.path("store-compromised");
		const compSlot0Lock = join(storeCompromised, "pool", repository, "0.json.lock");
		const compRepoLock = join(storeCompromised, "pool", `${repository}.lock`);
		const realSetTimeout = globalThis.setTimeout;
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: (...args: unknown[]) => void,
			ms?: number,
			...args: unknown[]
		) => {
			const clamped = typeof ms === "number" && ms >= 1_000 ? 40 : ms;
			return realSetTimeout(fn, clamped, ...args);
		}) as typeof setTimeout);
		let childComp: ReturnType<typeof admissionChild> | undefined;
		const compromised = new Promise<void>((resolve) => {
			lockRefusals.onCompromised = (path) => {
				if (path === join(storeCompromised, "pool", repository)) resolve();
			};
		});
		try {
			lockRefusals.targets.clear();
			lockRefusals.targets.add(compSlot0Lock);
			let pausedComp = false;
			lockRefusals.onAttempt = async (_attempt, target) => {
				if (target !== compSlot0Lock || pausedComp) return false;
				pausedComp = true;
				rmSync(compRepoLock, { recursive: true, force: true });
				const admissionB = { storeDir: storeCompromised, remotes, lastState: state, envHash: "env" };
				const script = [
					`import { admitPooledWorktree, discardPooledWorktree } from ${JSON.stringify(POOL_MODULE_PATH)};`,
					`import { createInterface } from "node:readline";`,
					`const lease = await admitPooledWorktree(${JSON.stringify(admissionB)}, ${JSON.stringify(ownerB)});`,
					`process.stdout.write(JSON.stringify({ slot: lease.slot, path: lease.path }) + "\\n");`,
					`const rl = createInterface({ input: process.stdin });`,
					`await new Promise((resolve) => rl.once("line", resolve));`,
					`rl.close();`,
					`await discardPooledWorktree(lease);`,
				].join("\n");
				childComp = admissionChild(script);
				const line = await childComp.nextLine();
				const childLease = JSON.parse(line) as { slot: number; path: string };
				assert.equal(childLease.slot, 0);
				await compromised;
				return false;
			};
			await assert.rejects(
				admitPooledWorktree({ storeDir: storeCompromised, remotes, lastState: state, envHash: "env" }, ownerA),
				{ code: "ECOMPROMISED" },
			);
			const slot0Record = JSON.parse(
				readFileSync(join(storeCompromised, "pool", repository, "0.json"), "utf8"),
			) as PoolSlotRecord;
			assert.deepEqual(slot0Record.holder, ownerB);
			childComp?.child.stdin.end("done\n");
			if (childComp) assert.equal((await childComp.exited).code, 0);
			childComp = undefined;
		} finally {
			timeoutSpy.mockRestore();
			await childComp?.close();
		}
	});

	test.runIf(process.platform === "win32")(
		"admission and release leave no temporary record after a brief delete refusal (#5636)",
		async () => {
			const storeDir = sandbox.path("store-brief-refusal");
			const remotes = ["https://example.com/acme/repo.git"];
			const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			let temporary: string | undefined;
			lockRefusals.onRecordWrite = async (path, data) => {
				if (path.startsWith(`${file}.`) && data.includes('"holder"')) temporary = path;
			};
			lockRefusals.onRemove = async (path) => {
				if (path !== temporary) return;
				lockRefusals.onRemove = undefined;
				throw Object.assign(new Error("temporary record cleanup refused"), { code: "EPERM" });
			};
			let reader: number | undefined;
			lockRefusals.afterWrite = (path) => {
				if (path === temporary) reader ??= openSync(path, "r");
			};
			try {
				const owner = { kind: "session" as const, id: "record-owner" };
				const lease = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
				assert.ok(temporary);
				assert.notEqual(reader, undefined);
				lockRefusals.onRecordWrite = undefined;
				assert.equal(await releaseRestoredWorktree(lease, state), true);
				assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord).holder, owner);
				assert.equal(existsSync(temporary), false);
				assert.equal(readdirSync(dirname(file)).includes(basename(temporary)), false);
			} finally {
				if (reader !== undefined) closeSync(reader);
			}
		},
	);

	test.runIf(process.platform === "win32").each([false, true])(
		"retrying a refused removal preserves a replacement at the temporary slot name (restored hard links: %s) (#5636)",
		async (restoreBoth) => {
			const storeDir = sandbox.path("store-replaced-link");
			const remotes = ["https://example.com/acme/repo.git"];
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
			let replaced: string | undefined;
			lockRefusals.onRemove = async (path) => {
				if (replaced || !path.startsWith(`${file}.`) || !path.endsWith(".tmp")) return;
				rmSync(path);
				if (restoreBoth) {
					// Simulate restoring the record and its hard link. Even identical bytes do not prove ownership.
					const bytes = readFileSync(file);
					rmSync(file);
					writeFileSync(file, bytes);
					linkSync(file, path);
				} else {
					writeFileSync(path, "a different file");
				}
				replaced = path;
				throw Object.assign(new Error("temporary removal refused"), { code: "EPERM" });
			};
			const owner = { kind: "session" as const, id: "record-owner" };
			const lease = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
			try {
				assert.ok(replaced);
				assert.equal(readFileSync(replaced, "utf8"), restoreBoth ? readFileSync(file, "utf8") : "a different file");
				assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).holder, owner);
			} finally {
				await releaseRestoredWorktree(lease, state);
			}
		},
	);

	test("a failed temporary record write is cleaned up without delete-on-close (#5636)", async () => {
		setPlatform("win32");
		const storeDir = sandbox.path("store-partial-temp");
		const remotes = ["https://example.com/acme/repo.git"];
		const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		lockRefusals.deleteOnCloseUnavailable = true;
		let failed: string | undefined;
		lockRefusals.onRecordWrite = async (path, data) => {
			if (path.startsWith(`${file}.`) && data.includes('"holder"')) {
				failed = path;
				writeFileSync(path, "partial");
				throw Object.assign(new Error("partial record"), { code: "EIO" });
			}
		};
		await assert.rejects(
			admitPooledWorktree(
				{ storeDir, remotes, lastState: state, envHash: "env" },
				{ kind: "session", id: "record-owner" },
			),
			{ code: "EIO" },
		);
		assert.ok(failed);
		assert.equal(existsSync(failed), false);
		assert.equal(existsSync(file), false);
	});

	test("temporary-file cleanup refusal does not orphan a published pool admission (#5320)", async () => {
		// Simulate a filesystem requiring an explicit delete, so this still exercises an actual cleanup refusal.
		lockRefusals.deleteOnCloseUnavailable = true;
		const storeDir = sandbox.path("store-cleanup-refused");
		const remotes = ["https://example.com/acme/repo.git"];
		const repository = repositoryIdOf(remotes);
		const file = join(storeDir, "pool", repository, "0.json");
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		const admission = { storeDir, remotes, lastState: state, envHash: "env" };
		const ownerA = { kind: "session" as const, id: "owner-a" };
		let recordTemporary: string | undefined;
		let cleanupRefusals = 0;
		lockRefusals.onRecordWrite = async (path, data) => {
			if (path.startsWith(`${file}.`) && path.endsWith(".tmp") && data.includes('"holder"')) {
				recordTemporary = path;
			}
		};
		lockRefusals.onRemove = async (path) => {
			if (path === recordTemporary) {
				cleanupRefusals++;
				throw Object.assign(new Error("temporary record cleanup refused"), { code: "EPERM" });
			}
		};
		const lease = await admitPooledWorktree(admission, ownerA);
		assert.equal(cleanupRefusals, 1);
		assert.equal(lease.slot, 0);
		assert.equal(await confirmPooledWorktreeLease(lease), true);
		lockRefusals.onRecordWrite = undefined;
		lockRefusals.onRemove = undefined;
		assert.equal(await releaseRestoredWorktree(lease, state), true);
		const other = await admitPooledWorktree(admission, { kind: "session", id: "owner-b" });
		assert.equal(other.slot, 1);
		assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord).holder, ownerA);
		await discardPooledWorktree(other);
		await discardPooledWorktree(lease);
	});

	test("a retained admission temporary file cannot corrupt its slot during a later failed write (#5320)", async () => {
		lockRefusals.deleteOnCloseUnavailable = true;
		const storeDir = sandbox.path("store-retained-temporary");
		const remotes = ["https://example.com/acme/repo.git"];
		const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		let recordTemporary: string | undefined;
		lockRefusals.onRecordWrite = async (path, data) => {
			if (data.includes('"holder"')) recordTemporary = path;
		};
		lockRefusals.onRemove = async (path) => {
			if (path === recordTemporary) {
				throw Object.assign(new Error("temporary record cleanup refused"), { code: "EPERM" });
			}
		};
		const lease = await admitPooledWorktree(
			{ storeDir, remotes, lastState: state, envHash: "env" },
			{ kind: "session", id: "owner-a" },
		);
		const published = readFileSync(file, "utf8");
		lockRefusals.onRecordWrite = async (path, data) => {
			if (data.includes('"holder"')) {
				writeFileSync(path, "");
				throw Object.assign(new Error("record write failed after truncation"), { code: "EIO" });
			}
		};
		assert.equal(await releaseRestoredWorktree(lease, state), true);
		assert.equal(readFileSync(file, "utf8"), published);
		lockRefusals.onRecordWrite = undefined;
		lockRefusals.onRemove = undefined;
	});

	test.each(["temporary", "taken"])(
		"cleanup of a %s record cannot turn a published pool hold into a failure (#5320)",
		async (cleanupTarget) => {
			lockRefusals.deleteOnCloseUnavailable = true;
			const storeDir = sandbox.path("store-hold-cleanup");
			const remotes = ["https://example.com/acme/repo.git"];
			const file = join(storeDir, "pool", repositoryIdOf(remotes), "0.json");
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			const owner = { kind: "session" as const, id: "owner-a" };
			const first = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
			await releaseRestoredWorktree(first, state);
			let recordTemporary: string | undefined;
			let cleanupRefusals = 0;
			lockRefusals.onRecordWrite = async (path, data) => {
				if (data.includes('"holder"')) recordTemporary = path;
			};
			lockRefusals.onRemove = async (path) => {
				if (
					cleanupTarget === "temporary"
						? path === recordTemporary
						: path.startsWith(`${file}.`) && path.endsWith(".taken")
				) {
					cleanupRefusals++;
					throw Object.assign(new Error("record cleanup refused"), { code: "EPERM" });
				}
			};
			const held = await holdRestoredWorktree(storeDir, first.path, owner);
			assert.ok(held);
			assert.ok(cleanupRefusals > 0);
			assert.equal(await confirmPooledWorktreeLease(held), true);
			lockRefusals.onRecordWrite = undefined;
			lockRefusals.onRemove = undefined;
			await discardPooledWorktree(held);
		},
	);

	test("discarding an old lease cannot delete a new admission in the same process (#5320)", async () => {
		const storeDir = sandbox.path("store-stale-discard");
		const remotes = ["https://example.com/acme/repo.git"];
		const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
		const admission = { storeDir, remotes, lastState: state, envHash: "env" };
		const first = await admitPooledWorktree(admission, { kind: "session", id: "owner-a" });
		await discardPooledWorktree(first);
		const next = await admitPooledWorktree(admission, { kind: "session", id: "owner-b" });
		assert.equal(next.slot, first.slot);
		await discardPooledWorktree(first);
		assert.equal(await confirmPooledWorktreeLease(next), true);
		const file = join(storeDir, "pool", next.repository, `${next.slot}.json`);
		assert.deepEqual((JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord).holder, next.owner);
		await discardPooledWorktree(next);
	});

	test.each(["lease acquisition", "record publication"])(
		"admission cannot replace another process's slot after takeover during %s (#5320)",
		async (pauseAt) => {
			const storeDir = sandbox.path("store-late-takeover");
			const remotes = ["https://example.com/acme/repo.git"];
			const repository = repositoryIdOf(remotes);
			const state = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
			const admission = { storeDir, remotes, lastState: state, envHash: "env" };
			const ownerA = { kind: "session" as const, id: "owner-a" };
			const ownerB = { kind: "session" as const, id: "owner-b" };
			const directory = join(storeDir, "pool", repository);
			const file = join(directory, "0.json");
			const lostPaths = new Set<string>();
			const compromised = new Promise<void>((resolve) => {
				lockRefusals.onCompromised = (path) => {
					lostPaths.add(path);
					if (lostPaths.has(directory) && lostPaths.has(file)) resolve();
				};
			});
			const realSetTimeout = globalThis.setTimeout;
			const timeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
					realSetTimeout(fn, typeof ms === "number" && ms >= 1_000 ? 40 : ms, ...args)) as typeof setTimeout);
			let child: ReturnType<typeof admissionChild> | undefined;
			let paused = false;
			const takeOver = async () => {
				if (paused) return;
				paused = true;
				await Promise.all([
					rm(`${directory}.lock`, { recursive: true, force: true }),
					rm(`${file}.lock`, { recursive: true, force: true }),
				]);
				const script = [
					`import { admitPooledWorktree, confirmPooledWorktreeLease, discardPooledWorktree } from ${JSON.stringify(POOL_MODULE_PATH)};`,
					`import { createInterface } from "node:readline";`,
					`const rl = createInterface({ input: process.stdin });`,
					`const lease = await admitPooledWorktree(${JSON.stringify(admission)}, ${JSON.stringify(ownerB)});`,
					`process.stdout.write(JSON.stringify({ slot: lease.slot }) + "\\n");`,
					`await new Promise((resolve) => rl.once("line", resolve));`,
					`process.stdout.write(JSON.stringify({ held: await confirmPooledWorktreeLease(lease) }) + "\\n");`,
					`rl.close();`,
					`await discardPooledWorktree(lease);`,
				].join("\n");
				child = admissionChild(script);
				const line = await child.nextLine();
				assert.equal((JSON.parse(line) as { slot: number }).slot, 0);
				await compromised;
			};
			try {
				if (pauseAt === "lease acquisition") {
					lockRefusals.onAttempt = async (_attempt, path) => {
						if (path.startsWith(`${file}.`) && path.endsWith(".lease.lock")) await takeOver();
						return false;
					};
				} else {
					lockRefusals.onRecordWrite = async (path, data) => {
						if (path.startsWith(`${file}.`) && path.endsWith(".tmp") && data.includes('"holder"')) {
							await takeOver();
						}
					};
				}
				await assert.rejects(admitPooledWorktree(admission, ownerA), { code: "ECOMPROMISED" });
				assert.equal(paused, true);
				const record = JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord;
				assert.deepEqual(record.holder, ownerB);
				assert.ok(child);
				child.child.stdin.end("confirm\n");
				assert.deepEqual(JSON.parse(await child.nextLine()), { held: true });
				assert.equal((await child.exited).code, 0);
				child = undefined;
			} finally {
				timeoutSpy.mockRestore();
				await child?.close();
			}
		},
	);

	test("pool and seed locks refused with EPERM for 10 seconds on end on Windows each independently report EPERM and unavailable (#5320)", async () => {
		assert.equal(POOL_LOCK_REFUSED_MS, EXPECTED_LOCK_REFUSED_MS);
		assert.equal(SEED_LOCK_REFUSED_MS, EXPECTED_LOCK_REFUSED_MS);
		const storeRepoLock = sandbox.path("store-repo-lock");
		const storeSlotAdmit = sandbox.path("store-slot-admit");
		const storeSlotHold = sandbox.path("store-slot-hold");
		const storeSeedAdopt = sandbox.path("store-seed-adopt");
		const storeSeedWait = sandbox.path("store-seed-wait");
		const { snapshot, repository } = await parkedSeed(storeSeedAdopt);
		const remotes = snapshot.remotes;
		const state = { snapshotId: null, head: snapshot.head, tree: snapshot.tree };
		const owner = { kind: "session" as const, id: "owner-1" };
		const leaseHold = await admitPooledWorktree(
			{ storeDir: storeSlotHold, remotes, lastState: state, envHash: "env" },
			owner,
		);
		await releaseRestoredWorktree(leaseHold, state);

		const repoLockTarget = join(storeRepoLock, "pool", `${repository}.lock`);
		const slotAdmitTarget = join(storeSlotAdmit, "pool", repository, "0.json.lock");
		const slotHoldTarget = join(storeSlotHold, "pool", repository, "0.json.lock");
		const seedAdoptTarget = `${seedManifestPath(storeSeedAdopt, repository)}.lock`;
		const seedWaitTarget = `${seedManifestPath(storeSeedWait, repository)}.lock`;

		setPlatform("win32");
		for (const target of [repoLockTarget, slotAdmitTarget, slotHoldTarget, seedAdoptTarget, seedWaitTarget]) {
			lockRefusals.targets.add(target);
		}
		lockRefusals.remaining = Number.POSITIVE_INFINITY;

		let seedWaitActionRan = false;
		await Promise.all([
			measureRefusedOperation(
				repoLockTarget,
				() =>
					assert.rejects(
						admitPooledWorktree({ storeDir: storeRepoLock, remotes, lastState: state, envHash: "env" }, owner),
						{ code: "EPERM" },
					),
				() => {
					assert.equal(existsSync(join(storeRepoLock, "pool", repository, "0.json")), false);
				},
			),
			measureRefusedOperation(
				slotAdmitTarget,
				() =>
					assert.rejects(
						admitPooledWorktree({ storeDir: storeSlotAdmit, remotes, lastState: state, envHash: "env" }, owner),
						{ code: "EPERM" },
					),
				() => {
					assert.equal(existsSync(join(storeSlotAdmit, "pool", repository, "0.json")), false);
				},
			),
			measureRefusedOperation(
				slotHoldTarget,
				() =>
					assert.rejects(holdRestoredWorktree(storeSlotHold, leaseHold.path, owner), {
						code: "EPERM",
					}),
				() => {},
			),
			measureRefusedOperation(
				seedAdoptTarget,
				() => adoptPrebuiltSeed(snapshot, { storeDir: storeSeedAdopt }),
				(adoption) => {
					assert.deepEqual(adoption, { adopted: false, reason: "unavailable" });
					assert.equal(existsSync(seedManifestPath(storeSeedAdopt, repository)), true);
				},
			),
			measureRefusedOperation(
				seedWaitTarget,
				() =>
					assert.rejects(
						withSeedLock(storeSeedWait, repository, true, async () => {
							seedWaitActionRan = true;
							return "unreachable";
						}),
						{ code: "EPERM" },
					),
				() => {
					assert.equal(seedWaitActionRan, false);
				},
			),
		]);
	});

	test("non-Windows EPERM and Windows non-EPERM errors on pool and seed locks fail on the first attempt (#5320)", async () => {
		const storeDir = sandbox.path("store");
		const { snapshot, repository } = await parkedSeed(storeDir);
		const remotes = snapshot.remotes;
		const state = { snapshotId: null, head: snapshot.head, tree: snapshot.tree };
		const owner = { kind: "session" as const, id: "owner-1" };
		const lease = await admitPooledWorktree({ storeDir, remotes, lastState: state, envHash: "env" }, owner);
		await releaseRestoredWorktree(lease, state);

		setPlatform("linux");
		lockRefusals.suffix = ".json.lock";
		lockRefusals.remaining = Number.POSITIVE_INFINITY;
		const startedLinux = Date.now();
		await assert.rejects(holdRestoredWorktree(storeDir, lease.path, owner), { code: "EPERM" });
		assert.equal(lockRefusals.refused, 1);
		const linuxAdoption = await adoptPrebuiltSeed(snapshot, { storeDir });
		assert.deepEqual(linuxAdoption, { adopted: false, reason: "unavailable" });
		assert.equal(lockRefusals.refused, 2);
		await assert.rejects(
			withSeedLock(storeDir, repository, true, async () => "unreachable"),
			{ code: "EPERM" },
		);
		assert.equal(lockRefusals.refused, 3);
		assert.ok(Date.now() - startedLinux < 2_000);

		setPlatform("win32");
		lockRefusals.code = "EACCES";
		lockRefusals.refused = 0;
		lockRefusals.remaining = Number.POSITIVE_INFINITY;
		const startedEacces = Date.now();
		await assert.rejects(holdRestoredWorktree(storeDir, lease.path, owner), { code: "EACCES" });
		assert.equal(lockRefusals.refused, 1);
		await assert.rejects(
			withSeedLock(storeDir, repository, true, async () => "unreachable"),
			{ code: "EACCES" },
		);
		assert.equal(lockRefusals.refused, 2);
		assert.ok(Date.now() - startedEacces < 2_000);
	});
});
