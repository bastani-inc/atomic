/**
 * Build locks (#4748): a process that builds the blueprints of a restored worktree records itself and the processes
 * its steps start in `<storeDir>/blueprint-builds/locks/<root key>.json`. A later build of the same worktree in another
 * process waits while that process runs, and stops the step processes a process that died without stopping them (a
 * SIGKILL) left behind, so two builds never run in one worktree at once.
 */

import { spawnSync } from "node:child_process";
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
	/** When this process saw it start, in milliseconds since the epoch. */
	readonly at?: number;
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

/**
 * On Windows, the processes left behind by `steps` whose step process itself has ended: Git for Windows' `bash.exe`
 * starts the shell as a child and may end without it, and nothing then ties that shell to a process tree. They are
 * found as processes of a step's id, started after it, and their own children.
 */
function orphanedChildren(steps: readonly LockedProcess[]): LockedProcess[] {
	const script =
		"Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
	const shell = join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const listed = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
	const processes = listed.stdout
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter((fields) => fields.length === 3 && fields.every(Number.isFinite))
		.map(([pid, parent, created]) => ({ pid: pid!, parent: parent!, created: created! }));
	const found: LockedProcess[] = [];
	let parents = steps.map((step) => ({ pid: step.pid, at: step.at ?? 0 }));
	while (parents.length > 0) {
		const children = processes.filter((candidate) =>
			parents.some(
				(parent) =>
					candidate.parent === parent.pid &&
					candidate.created >= parent.at - 1_000 &&
					!found.some((known) => known.pid === candidate.pid),
			),
		);
		found.push(...children.map((child) => ({ pid: child.pid })));
		parents = children.map((child) => ({ pid: child.pid, at: child.created }));
	}
	return found;
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
		const steps = lock.steps ?? [];
		const orphans = [...steps.filter(runs), ...(process.platform === "win32" ? orphanedChildren(steps) : [])];
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
		if (running) steps.set(pid, { ...locked(pid), at: Date.now() });
		else steps.delete(pid);
		write();
	};
	try {
		return await stepProcessWatcher.run(watch, build);
	} finally {
		for (const file of files) if (readLock(file)?.pid === process.pid) rmSync(file, { force: true });
	}
}
