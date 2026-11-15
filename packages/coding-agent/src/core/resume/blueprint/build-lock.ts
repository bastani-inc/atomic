/**
 * Build locks (#4748): a process that builds the blueprints of a restored worktree records itself and the processes
 * its steps start in `<storeDir>/blueprint-builds/locks/<root key>.json`. A later build of the same worktree in another
 * process waits while that process runs, and stops the step processes a process that died without stopping them (a
 * SIGKILL) left behind, so two builds never run in one worktree at once.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { killProcessTree } from "../../../utils/shell.ts";
import { processStartToken } from "../../worktree-snapshot/pool.ts";
import { rootKey } from "./ledger.ts";
import { stepProcessWatcher } from "./process.ts";

interface LockedProcess {
	readonly pid: number;
	/** When it started, where that can be read, so a later process given the same id is told apart. */
	readonly start?: string;
}

interface BuildLock extends LockedProcess {
	readonly host: string;
	readonly steps: readonly LockedProcess[];
}

/** How often a build waiting for another process's build of the same worktree looks again. */
export const BUILD_LOCK_POLL_MS = 200;

const HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

function locked(pid: number): LockedProcess {
	const start = processStartToken(pid);
	return start === undefined ? { pid } : { pid, start };
}

export function buildLockPath(storeDir: string, root: string): string {
	return join(storeDir, "blueprint-builds", "locks", `${rootKey(root)}.json`);
}

function readLock(file: string): BuildLock | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as BuildLock;
	} catch {
		return undefined;
	}
}

function writeLock(file: string, lock: BuildLock): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 });
	renameSync(temporary, file);
}

/** Whether `process` still runs: the same process, where its start can be read, not a later one given its id. */
function runs(process_: LockedProcess): boolean {
	const start = processStartToken(process_.pid);
	if (process_.start !== undefined && start !== undefined) return start === process_.start;
	try {
		process.kill(process_.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Waits until no other process of this host builds the worktree at `root`. A process that still runs is waited for;
 * the step processes of one that died are stopped, with their process trees, and its lock is removed.
 */
async function settleOtherBuild(file: string, signal: AbortSignal | undefined): Promise<void> {
	for (;;) {
		const lock = readLock(file);
		if (lock === undefined || lock.host !== HOST || lock.pid === process.pid) return;
		if (runs(lock)) {
			await delay(BUILD_LOCK_POLL_MS, signal);
			continue;
		}
		const orphans = (lock.steps ?? []).filter(runs);
		for (const step of orphans) killProcessTree(step.pid);
		for (let waited = 0; waited < 25 && orphans.some(runs); waited++) await delay(BUILD_LOCK_POLL_MS / 2, signal);
		rmSync(file, { force: true });
		return;
	}
}

/**
 * Waits until no other process of this host builds any of the worktrees at `roots`, stopping what the builds of
 * processes that died left running. Only `signal` aborting rejects.
 */
export async function settleOtherBuilds(
	storeDir: string,
	roots: readonly string[],
	signal: AbortSignal | undefined,
): Promise<void> {
	for (const file of new Set(roots.map((root) => buildLockPath(storeDir, root)))) {
		await settleOtherBuild(file, signal);
	}
}

/**
 * Runs `build` of the worktrees at `roots` under their build locks: first waits out, or cleans up after, another
 * process's build of any of them, then, from the first step process `build` starts until it settles, records this
 * process and the step processes that run.
 * A lock that cannot be written never stops the build.
 */
export async function withBuildLocks<T>(
	storeDir: string,
	roots: readonly string[],
	signal: AbortSignal | undefined,
	build: () => Promise<T>,
): Promise<T> {
	const files = [...new Set(roots.map((root) => buildLockPath(storeDir, root)))];
	await settleOtherBuilds(storeDir, roots, signal);
	const steps = new Map<number, LockedProcess>();
	const write = () => {
		const lock: BuildLock = { host: HOST, ...locked(process.pid), steps: [...steps.values()] };
		for (const file of files) {
			try {
				writeLock(file, lock);
			} catch {}
		}
	};
	// Written once a step starts a process, so a build that runs nothing, as for an untrusted worktree, writes nothing.
	const watch = (pid: number, running: boolean) => {
		if (running) steps.set(pid, locked(pid));
		else steps.delete(pid);
		write();
	};
	try {
		return await stepProcessWatcher.run(watch, build);
	} finally {
		for (const file of files) if (readLock(file)?.pid === process.pid) rmSync(file, { force: true });
	}
}
