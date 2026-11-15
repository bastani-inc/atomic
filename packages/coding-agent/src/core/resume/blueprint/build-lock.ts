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

/** A lock file as read: absent, unreadable or not a lock this version writes, or a lock. */
type ReadLock =
	| { readonly kind: "none" }
	| { readonly kind: "corrupt" }
	| { readonly kind: "lock"; readonly lock: BuildLock };

function isLockedProcess(value: unknown): value is LockedProcess {
	const candidate = value as Partial<LockedProcess> | null;
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		Number.isInteger(candidate.pid) &&
		(candidate.start === undefined || typeof candidate.start === "string")
	);
}

function readLockFile(file: string): ReadLock {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "corrupt" };
	}
	try {
		const lock = JSON.parse(text) as Partial<BuildLock> | null;
		const steps = lock?.steps;
		const host = lock?.host;
		if (isLockedProcess(lock) && typeof host === "string" && Array.isArray(steps) && steps.every(isLockedProcess)) {
			return { kind: "lock", lock: lock as BuildLock };
		}
	} catch {}
	return { kind: "corrupt" };
}

function readLock(file: string): BuildLock | undefined {
	const read = readLockFile(file);
	return read.kind === "lock" ? read.lock : undefined;
}

function writeLock(file: string, lock: BuildLock): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 });
	renameSync(temporary, file);
}

/**
 * Whether `recorded` is the process that runs under its id now: proven only by the start it recorded matching the
 * running process's. `"unknown"` when either start cannot be read: a process of that id runs, but it may be a later
 * one given the same id.
 */
function identity(recorded: LockedProcess): "same" | "gone" | "unknown" {
	const start = processStartToken(recorded.pid);
	if (recorded.start !== undefined && start !== undefined) return start === recorded.start ? "same" : "gone";
	try {
		process.kill(recorded.pid, 0);
		return "unknown";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? "unknown" : "gone";
	}
}

/**
 * On Windows, the processes left behind by `steps` whose step process itself has ended: Git for Windows' `bash.exe`
 * starts the shell as a child and may end without it, and nothing then ties that shell to a process tree. They are
 * found as processes whose parent has a step's id, started after the step and before any later process given that id,
 * and their own children. Only steps whose start was recorded are followed, so a step's identity was established.
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
	type Parent = { readonly pid: number; readonly after: number; readonly before: number };
	const window = (pid: number, after: number): Parent => ({
		pid,
		after,
		// A process that holds the id now and started after `after` is a later one: only children older than it count.
		before: processes.find((candidate) => candidate.pid === pid && candidate.created > after)?.created ?? Infinity,
	});
	let parents = steps
		.filter((step) => step.start !== undefined && step.at !== undefined)
		.map((step) => window(step.pid, step.at! - 1_000));
	while (parents.length > 0) {
		const children = processes.filter((candidate) =>
			parents.some(
				(parent) =>
					candidate.parent === parent.pid &&
					candidate.created >= parent.after &&
					candidate.created < parent.before &&
					!found.some((known) => known.pid === candidate.pid),
			),
		);
		found.push(...children.map((child) => ({ pid: child.pid })));
		parents = children.map((child) => window(child.pid, child.created));
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

/** Stops each of `steps` proven to be the step its lock recorded, and `extra`, and waits briefly until they ended. */
async function stopProven(
	steps: readonly LockedProcess[],
	signal: AbortSignal | undefined,
	extra: readonly LockedProcess[] = [],
): Promise<void> {
	const proven = steps.filter((step) => identity(step) === "same");
	for (const step of [...proven, ...extra]) killProcessTree(step.pid);
	for (let waited = 0; waited < 25 && proven.some((step) => identity(step) === "same"); waited++) {
		await delay(BUILD_LOCK_POLL_MS / 2, signal);
	}
}

/** How long a build waits for another process's build of the same worktree before it builds anyway, with a warning. */
export const BUILD_LOCK_WAIT_MS = 5 * 60_000;

export interface SettleOtherBuildsOptions {
	readonly signal?: AbortSignal;
	/** How long to wait for another process's build. Default {@link BUILD_LOCK_WAIT_MS}. */
	readonly waitMs?: number;
	/** Told once per worktree, with that worktree, when it starts waiting for another process's build. */
	readonly onWait?: (root: string, message: string) => void;
}

/**
 * Waits until no other process of this host builds the worktree whose lock is `file`, for at most `options.waitMs`.
 * A process proven to be the build's holder is waited for. The step processes of a holder that died are stopped, with
 * their process trees, only when each is proven to be the step the lock recorded (its recorded start matches);
 * a process whose identity cannot be proven is never stopped, and while one may still run the wait goes on. Returns
 * the warnings for the user: the wait timed out, a step may still run, or the lock could not be read.
 */
async function settleOtherBuild(file: string, root: string, options: SettleOtherBuildsOptions): Promise<string[]> {
	const deadline = Date.now() + (options.waitMs ?? BUILD_LOCK_WAIT_MS);
	let told = false;
	let stopped = false;
	const wait = async (why: string): Promise<boolean> => {
		if (!told) options.onWait?.(root, `Waiting for ${why} of ${root} to end`);
		told = true;
		if (Date.now() >= deadline) return false;
		await delay(BUILD_LOCK_POLL_MS, options.signal);
		return true;
	};
	for (;;) {
		const read = readLockFile(file);
		if (read.kind === "none") return [];
		if (read.kind === "corrupt") {
			rmSync(file, { force: true });
			return [
				`The build lock of ${root} could not be read; building it anyway. An earlier build may still be running there.`,
			];
		}
		const { lock } = read;
		if (lock.host !== HOST || lock.pid === process.pid) return [];
		const steps = lock.steps ?? [];
		const holder = identity(lock);
		if (holder !== "gone") {
			if (await wait("another Atomic process's blueprint build")) continue;
			// Building anyway: the steps proven to be that build's stop first, so two builds never run in the worktree.
			await stopProven(steps, options.signal);
			return [
				`Another process (pid ${lock.pid}) still seemed to build ${root} after ${Math.round((options.waitMs ?? BUILD_LOCK_WAIT_MS) / 1000)} s; building it anyway.`,
			];
		}
		if (!stopped) {
			stopped = true;
			// Stopped once: the Windows scan lists every process, and a later look only waits on what could not be proven.
			await stopProven(steps, options.signal, process.platform === "win32" ? orphanedChildren(steps) : []);
		}
		const unproven = steps.filter((step) => identity(step) === "unknown");
		if (unproven.length > 0) {
			if (await wait("an earlier blueprint build")) continue;
			rmSync(file, { force: true });
			const pids = unproven.map((step) => step.pid).join(", ");
			return [
				`An earlier blueprint build of ${root} may still be running (process ${pids}), but it could not be confirmed as that build, so it was not stopped; building the worktree anyway.`,
			];
		}
		rmSync(file, { force: true });
		// A step recorded without its start cannot be told from what it left running (on Windows, Git's bash.exe ends
		// before the shell it started), so the user hears that the earlier build may still run.
		const unidentified = steps.filter((step) => step.start === undefined);
		if (unidentified.length > 0) {
			return [
				`An earlier blueprint build of ${root} was interrupted, and processes it started could not be identified to stop them; they may still be running while the worktree is built again.`,
			];
		}
		return [];
	}
}

/**
 * Waits until no other process of this host builds any of the worktrees at `roots`, stopping what the builds of
 * processes that died left running where that is proven to be theirs. Resolves the warnings for the user; only
 * `options.signal` aborting rejects.
 */
export async function settleOtherBuilds(
	storeDir: string,
	roots: readonly string[],
	options: SettleOtherBuildsOptions = {},
): Promise<string[]> {
	const warnings: string[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		const file = buildLockPath(storeDir, root);
		if (seen.has(file)) continue;
		seen.add(file);
		warnings.push(...(await settleOtherBuild(file, root, options)));
	}
	return warnings;
}

/**
 * Runs `build` of the worktrees at `roots` under their build locks: from the first step process `build` starts until it
 * settles, records this process and the step processes that run. Callers settle other processes' builds of them first
 * ({@link settleOtherBuilds}).
 * A lock that cannot be written never stops the build.
 */
export async function withBuildLocks<T>(
	storeDir: string,
	roots: readonly string[],
	build: () => Promise<T>,
): Promise<T> {
	const files = [...new Set(roots.map((root) => buildLockPath(storeDir, root)))];
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
