/**
 * Build locks (#4748): a process that builds the blueprints of a restored worktree records itself and the processes
 * its steps start in `<storeDir>/blueprint-builds/locks/<root key>.json`. A later build of the same worktree in another
 * process waits while that process runs, and stops the step processes a process that died without stopping them (a
 * SIGKILL) left behind, so two builds never run in one worktree at once.
 *
 * One process at a time settles and builds a worktree: it holds the lock's takeover mutex, an advisory lock the kernel
 * releases when its holder dies (#5193), from before it looks at the lock until its build settled. A process that
 * looked while another was between looking and its first step, before that one's lock was written, would otherwise
 * build beside it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { killProcessTree } from "../../../utils/shell.ts";
import { windowsPowerShellEnvironment } from "../../../utils/windows-powershell.ts";
import { type AsyncTakeoverMutex, takeTakeoverMutexAsync } from "../../lock-takeover.js";
import * as processStartToken from "../../process-start-token.js";
import { readLedger, rootKey } from "./ledger.ts";
import { stepProcessWatcher, stepStartingWatcher } from "./process.ts";

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

async function locked(pid: number, options?: { readonly fresh?: boolean }): Promise<LockedProcess> {
	const start =
		options === undefined
			? await processStartToken.processStartTokenAsync(pid)
			: await processStartToken.processStartTokenAsync(pid, options);
	return start === undefined ? { pid } : { pid, start };
}

/** Milliseconds between Windows FILETIME epoch (1601-01-01) and Unix epoch (1970-01-01). */
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000n;

function filetimeToUnixMs(created: string): number | undefined {
	if (!/^[1-9]\d*$/.test(created)) return undefined;
	const ms = BigInt(created) / 10_000n;
	if (ms < WINDOWS_EPOCH_OFFSET_MS) return undefined;
	return Number(ms - WINDOWS_EPOCH_OFFSET_MS);
}

function windowsStartToken(created: string): string {
	return (
		processStartToken.windowsStartTokenForCreationTime?.(created) ??
		createHash("sha256").update(`windows\n${created}`).digest("hex").slice(0, 12)
	);
}

interface ProvenProcess extends LockedProcess {
	/** Exact Windows FILETIME creation time verified against `start`, for atomic native termination. */
	readonly created?: string;
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

async function readLockFile(file: string): Promise<ReadLock> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
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

async function readLock(file: string): Promise<BuildLock | undefined> {
	const read = await readLockFile(file);
	return read.kind === "lock" ? read.lock : undefined;
}

/** Removes the lock at `file`; one that cannot be removed is left, since a lock never stops a build. */
async function removeLock(file: string): Promise<void> {
	try {
		await rm(file, { force: true });
	} catch {}
}

const STEP_START_MAX_ATTEMPTS = 4;
const STEP_START_RETRY_MS = 500;
const LOCK_WRITE_MAX_ATTEMPTS = 25;
const LOCK_WRITE_RETRY_MS = 20;
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const HOLDER_RETRY_KEY = -1;
const WRITE_RETRY_KEY = -2;

interface BuildLockWriter {
	readonly files: ReadonlyMap<string, string>;
	holder: LockedProcess;
	readonly steps: Map<number, LockedProcess>;
	readonly retryTimers: Map<number, ReturnType<typeof setTimeout>>;
	readonly onUnwritable?: (message: string) => void;
	started: boolean;
	settled: boolean;
	told: boolean;
}

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function clearRetryTimer(writer: BuildLockWriter, key: number): void {
	const timer = writer.retryTimers.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		writer.retryTimers.delete(key);
	}
}

function clearAllRetryTimers(writer: BuildLockWriter): void {
	for (const timer of writer.retryTimers.values()) clearTimeout(timer);
	writer.retryTimers.clear();
}

function readStepStartDurably(writer: BuildLockWriter, pid: number, step: LockedProcess, attempt: number): void {
	void processStartToken.processStartTokenAsync(pid, { fresh: true }).then((start) => {
		if (writer.settled || writer.steps.get(pid) !== step) return;
		if (start !== undefined) {
			writer.steps.set(pid, { ...step, start });
			writeBuildLocksDurably(writer);
			return;
		}
		if (process.platform !== "win32" || attempt >= STEP_START_MAX_ATTEMPTS || !processAlive(pid)) return;
		clearRetryTimer(writer, pid);
		const timer = setTimeout(() => {
			writer.retryTimers.delete(pid);
			if (writer.settled || writer.steps.get(pid) !== step || !processAlive(pid)) return;
			readStepStartDurably(writer, pid, step, attempt + 1);
		}, STEP_START_RETRY_MS);
		timer.unref?.();
		writer.retryTimers.set(pid, timer);
	});
}

function backfillHolderStart(writer: BuildLockWriter, attempt: number): void {
	if (writer.settled || writer.holder.start !== undefined) return;
	if (process.platform !== "win32" || attempt >= STEP_START_MAX_ATTEMPTS) return;
	clearRetryTimer(writer, HOLDER_RETRY_KEY);
	const timer = setTimeout(() => {
		writer.retryTimers.delete(HOLDER_RETRY_KEY);
		if (writer.settled || writer.holder.start !== undefined) return;
		void processStartToken.processStartTokenAsync(process.pid, { fresh: true }).then((start) => {
			if (writer.settled || writer.holder.start !== undefined) return;
			if (start !== undefined) {
				writer.holder = { pid: process.pid, start };
				if (writer.started) writeBuildLocksDurably(writer);
				return;
			}
			backfillHolderStart(writer, attempt + 1);
		});
	}, STEP_START_RETRY_MS);
	timer.unref?.();
	writer.retryTimers.set(HOLDER_RETRY_KEY, timer);
}

function recordStepProcessDurably(writer: BuildLockWriter, pid: number, running: boolean): void {
	const { steps } = writer;
	clearRetryTimer(writer, pid);
	if (running) {
		writer.started = true;
		const step: LockedProcess = { pid, at: Date.now() };
		steps.set(pid, step);
		readStepStartDurably(writer, pid, step, 1);
	} else steps.delete(pid);
	writeBuildLocksDurably(writer);
}

function writeBuildLocksDurably(writer: BuildLockWriter, attempt = 1): void {
	if (writer.settled) return;
	clearRetryTimer(writer, WRITE_RETRY_KEY);
	const lock: BuildLock = { host: HOST, ...writer.holder, steps: [...writer.steps.values()] };
	let retryTransient = false;
	for (const [file, root] of writer.files) {
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 });
			renameSync(temporary, file);
		} catch (error) {
			try {
				rmSync(temporary, { force: true });
			} catch {}
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (process.platform === "win32" && attempt < LOCK_WRITE_MAX_ATTEMPTS && TRANSIENT_RENAME_CODES.has(code)) {
				retryTransient = true;
				continue;
			}
			if (writer.told) continue;
			writer.told = true;
			const reason = error instanceof Error ? error.message : String(error);
			writer.onUnwritable?.(
				`The blueprint build lock of ${root} could not be written (${reason.slice(0, 200)}); if Atomic is killed during this build, the next resume cannot tell, and may build the worktree again while a step of this build still runs there.`,
			);
		}
	}
	if (retryTransient && !writer.settled) {
		const timer = setTimeout(() => {
			writer.retryTimers.delete(WRITE_RETRY_KEY);
			writeBuildLocksDurably(writer, attempt + 1);
		}, LOCK_WRITE_RETRY_MS);
		timer.unref?.();
		writer.retryTimers.set(WRITE_RETRY_KEY, timer);
	}
}

type Identity = "same" | "gone" | "unknown";

/**
 * Whether `recorded` is the process that runs under its id now: proven only by the start it recorded matching the
 * running process's. `"unknown"` when either start cannot be read: a process of that id runs, but it may be a later
 * one given the same id.
 */
async function identity(recorded: LockedProcess, options?: { readonly fresh?: boolean }): Promise<Identity> {
	if (!processAlive(recorded.pid)) return "gone";
	if (recorded.start === undefined) return "unknown";
	const start =
		options === undefined
			? await processStartToken.processStartTokenAsync(recorded.pid)
			: await processStartToken.processStartTokenAsync(recorded.pid, options);
	if (start !== undefined) return start === recorded.start ? "same" : "gone";
	return processAlive(recorded.pid) ? "unknown" : "gone";
}

/**
 * On Windows, the processes left behind by `steps` whose step process itself has ended: Git for Windows' `bash.exe`
 * starts the shell as a child and may end without it, and nothing then ties that shell to a process tree. They are
 * found as processes whose parent has a step's id, started after the step and before any later process given that id;
 * stopping each stops its own children. Only steps whose start was recorded are followed, and without one the host's
 * processes are not listed. Each is returned with its verified creation time and start token, so stopping checks the
 * exact creation time atomically and the wait follows that process, not a later one given its id.
 */
async function orphanedChildren(steps: readonly LockedProcess[]): Promise<ProvenProcess[]> {
	if (!steps.some((step) => step.start !== undefined && step.at !== undefined)) return [];
	const script =
		"Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
	const listed = await powershellOutput(script);
	if (listed === undefined) return [];
	const processes = listed
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter((fields) => fields.length === 3 && fields.every(Number.isFinite))
		.map(([pid, parent, created]) => ({ pid: pid!, parent: parent!, created: created! }));
	const found: ProvenProcess[] = [];
	// Only a step's direct children: stopping one stops its tree, and a descendant stopped on its own could already
	// have ended, its id given to a process of the build that follows, before its separate stop ran.
	for (const step of steps) {
		if (step.start === undefined || step.at === undefined) continue;
		const after = step.at - 1_000;
		// A process that holds the id now and started after the step is a later one: only children older than it count.
		const before = processes.find((candidate) => candidate.pid === step.pid && candidate.created > after)?.created;
		for (const candidate of processes) {
			if (candidate.parent !== step.pid || candidate.created < after) continue;
			if (before !== undefined && candidate.created >= before) continue;
			if (found.some((known) => known.pid === candidate.pid)) continue;
			const created = await processStartToken.readProcessCreationTime(candidate.pid);
			if (created === undefined) continue;
			const createdMs = filetimeToUnixMs(created);
			if (createdMs === undefined || createdMs < after || (before !== undefined && createdMs >= before)) continue;
			found.push({ pid: candidate.pid, start: windowsStartToken(created), created });
		}
	}
	return found;
}

function powershellOutput(script: string): Promise<string | undefined> {
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return new Promise((resolve) => {
		execFile(
			shell,
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ cwd: systemRoot, encoding: "utf8", env: windowsPowerShellEnvironment(), timeout: 30_000, windowsHide: true },
			(error, stdout) => resolve(error === null ? stdout : undefined),
		);
	});
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

async function stepsWhose(
	steps: readonly LockedProcess[],
	wanted: Identity,
	options?: { readonly fresh?: boolean },
): Promise<LockedProcess[]> {
	const identities = await Promise.all(steps.map((step) => identity(step, options)));
	return steps.filter((_, index) => identities[index] === wanted);
}

async function provenForStop(steps: readonly LockedProcess[]): Promise<ProvenProcess[]> {
	if (process.platform !== "win32") return stepsWhose(steps, "same", { fresh: true });
	const checked = await Promise.all(
		steps.map(async (step): Promise<ProvenProcess | undefined> => {
			if (!processAlive(step.pid) || step.start === undefined) return undefined;
			const created = await processStartToken.readProcessCreationTime(step.pid);
			if (created === undefined || windowsStartToken(created) !== step.start) return undefined;
			return { ...step, created };
		}),
	);
	return checked.filter((step): step is ProvenProcess => step !== undefined);
}

/** Stops each of `steps` proven to be the step its lock recorded, and `extra`, and waits briefly until they ended. */
async function stopProven(
	steps: readonly LockedProcess[],
	signal: AbortSignal | undefined,
	extra: readonly ProvenProcess[] = [],
): Promise<void> {
	const proven = [...(await provenForStop(steps)), ...extra];
	for (const step of proven) {
		if (process.platform === "win32") {
			if (step.created === undefined) continue;
			// Atomic native termination verifies the creation time on the opened handle before terminating the root and
			// its sequence-number-verified descendants. `null` means already gone or reused (never fall back to taskkill).
			const terminated = processStartToken.nativeTerminateProcess?.(step.pid, step.created, true);
			if (terminated === undefined) killProcessTree(step.pid);
		} else {
			killProcessTree(step.pid);
		}
	}
	// Stopping is asynchronous on Windows: the next build starts only once they have ended, or after a bounded wait.
	for (let waited = 0; waited < 50 && (await stepsWhose(proven, "same")).length > 0; waited++) {
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
	readonly keepCancelledLocks?: boolean;
}

/**
 * Waits until no other process of this host builds the worktree whose lock is `file`, for at most `options.waitMs`.
 * A process proven to be the build's holder is waited for. The step processes of a holder that died are stopped, with
 * their process trees, only when each is proven to be the step the lock recorded (its recorded start matches);
 * a process whose identity cannot be proven is never stopped, and while one may still run the wait goes on. First the
 * worktree's build mutex is taken ({@link takeBuildMutex}), waited for while another process holds it. Returns the
 * warnings for the user: the wait timed out, a step may still run, or the lock could not be read; and the mutex, which
 * the caller holds until its build settled.
 */
async function settleOtherBuild(file: string, root: string, options: SettleOtherBuildsOptions): Promise<SettledBuild> {
	const deadline = Date.now() + (options.waitMs ?? BUILD_LOCK_WAIT_MS);
	let told = false;
	const wait = async (why: string): Promise<boolean> => {
		if (!told) options.onWait?.(root, `Waiting for ${why} of ${root} to end`);
		told = true;
		if (Date.now() >= deadline) return false;
		await delay(BUILD_LOCK_POLL_MS, options.signal);
		return true;
	};
	let mutex = await takeBuildMutex(file);
	while (mutex === undefined && (await wait("another Atomic process's blueprint build")))
		mutex = await takeBuildMutex(file);
	try {
		const { warnings, cancelled } = await settleLock(file, root, options, wait);
		// Without the mutex, the process that holds it builds, though it may not have written its lock yet.
		if (mutex !== undefined || warnings.length > 0) return { warnings, mutex, cancelled };
		const waited = Math.round((options.waitMs ?? BUILD_LOCK_WAIT_MS) / 1000);
		return {
			warnings: [`Another process still seemed to build ${root} after ${waited} s; building it anyway.`],
			mutex,
			cancelled: true,
		};
	} catch (error) {
		await mutex?.release();
		throw error;
	}
}

/** {@link settleOtherBuild} of the lock at `file`, waiting with `wait`: the warnings for the user. */
async function settleLock(
	file: string,
	root: string,
	options: SettleOtherBuildsOptions,
	wait: (why: string) => Promise<boolean>,
): Promise<{ warnings: string[]; cancelled: boolean }> {
	const settled = (warnings: string[]) => ({ warnings, cancelled: true });
	const remove = async () => {
		if (!options.keepCancelledLocks) await removeLock(file);
	};
	let stopped = false;
	for (;;) {
		const read = await readLockFile(file);
		if (read.kind === "none") return { warnings: [], cancelled: false };
		if (read.kind === "corrupt") {
			await remove();
			return settled([
				`The build lock of ${root} could not be read; building it anyway. An earlier build may still be running there.`,
			]);
		}
		const { lock } = read;
		if (lock.host !== HOST || lock.pid === process.pid) return { warnings: [], cancelled: false };
		const steps = lock.steps ?? [];
		const holder = await identity(lock);
		if (holder !== "gone") {
			if (await wait("another Atomic process's blueprint build")) continue;
			// Building anyway: the steps proven to be that build's stop first, so two builds never run in the worktree.
			await stopProven(steps, options.signal);
			return settled([
				`Another process (pid ${lock.pid}) still seemed to build ${root} after ${Math.round((options.waitMs ?? BUILD_LOCK_WAIT_MS) / 1000)} s; building it anyway.`,
			]);
		}
		if (!stopped) {
			stopped = true;
			// Stopped once: the Windows scan lists every process, and a later look only waits on what could not be proven.
			await stopProven(steps, options.signal, process.platform === "win32" ? await orphanedChildren(steps) : []);
		}
		const unproven = await stepsWhose(steps, "unknown");
		if (unproven.length > 0) {
			if (await wait("an earlier blueprint build")) continue;
			await remove();
			const pids = unproven.map((step) => step.pid).join(", ");
			return settled([
				`An earlier blueprint build of ${root} may still be running (process ${pids}), but it could not be confirmed as that build, so it was not stopped; building the worktree anyway.`,
			]);
		}
		await remove();
		// A step recorded without its start cannot be told from what it left running (on Windows, Git's bash.exe ends
		// before the shell it started), so the user hears that the earlier build may still run.
		const unidentified = steps.filter((step) => step.start === undefined);
		if (unidentified.length > 0) {
			return settled([
				`An earlier blueprint build of ${root} was interrupted, and processes it started could not be identified to stop them; they may still be running while the worktree is built again.`,
			]);
		}
		return settled([]);
	}
}

/** What settling another process's build of one worktree left: the warnings, and the mutex held for this build. */
interface SettledBuild {
	readonly warnings: string[];
	readonly cancelled: boolean;
	/** Undefined when another process kept it past the wait, and this one builds anyway. */
	readonly mutex: AsyncTakeoverMutex | undefined;
}

/** Holds nothing: where the lock's directory cannot be made or written to, there is nothing to lock either. */
const UNLOCKABLE: AsyncTakeoverMutex = { owned: async () => true, release: async () => {} };

/**
 * Takes the takeover mutex of the build lock at `file` without waiting (#5193), held from before another process's
 * build is settled until this process's build settled: undefined while another process holds it. A lock whose
 * directory cannot be made or written to could not be written either, and a lock that cannot be written never stops a
 * build.
 */
async function takeBuildMutex(file: string): Promise<AsyncTakeoverMutex | undefined> {
	try {
		await mkdir(dirname(file), { recursive: true });
		await access(dirname(file), constants.W_OK);
	} catch {
		return UNLOCKABLE;
	}
	return takeTakeoverMutexAsync(file, 0);
}

/** Other processes' builds of a set of worktrees, settled ({@link settleOtherBuilds}). */
export interface SettledBuilds {
	/** The warnings for the user: a wait timed out, a step may still run, or a lock could not be read. */
	readonly warnings: string[];
	readonly cancelled: ReadonlySet<string>;
	/** Lets other processes build the worktrees again: called once this process's build of them settled. */
	release(): Promise<void>;
}

/**
 * Waits until no other process of this host builds any of the worktrees at `roots`, stopping what the builds of
 * processes that died left running where that is proven to be theirs, and keeps other processes from building them
 * until {@link SettledBuilds.release}: the caller builds them, under {@link withBuildLocks}, and then releases them.
 * The kernel releases them too if this process dies. Resolves the warnings for the user; only `options.signal`
 * aborting rejects.
 */
export async function settleOtherBuilds(
	storeDir: string,
	roots: readonly string[],
	options: SettleOtherBuildsOptions = {},
): Promise<SettledBuilds> {
	const warnings: string[] = [];
	const cancelled = new Set<string>();
	const held: AsyncTakeoverMutex[] = [];
	const release = async () => {
		for (const mutex of held.splice(0)) await mutex.release().catch(() => {});
	};
	const files = new Map<string, string>();
	for (const root of roots) {
		const file = buildLockPath(storeDir, root);
		if (!files.has(file)) files.set(file, root);
	}
	try {
		// In one order in every process, so two processes building overlapping worktrees never wait on each other.
		for (const file of [...files.keys()].sort()) {
			const settled = await settleOtherBuild(file, files.get(file)!, options);
			if (settled.mutex !== undefined) held.push(settled.mutex);
			if (settled.cancelled) cancelled.add(files.get(file)!);
			warnings.push(...settled.warnings);
		}
	} catch (error) {
		await release();
		throw error;
	}
	return { warnings, cancelled, release };
}

export interface CancelledBuild {
	readonly root: string;
	readonly startedAt: string;
	readonly logs: string;
}

export async function cancelledBuilds(
	storeDir: string,
	roots: readonly string[],
	options: SettleOtherBuildsOptions,
	setAside: (build: CancelledBuild) => Promise<boolean>,
): Promise<string[]> {
	const unfinished = async () => {
		const ledger = await readLedger(storeDir).catch(() => undefined);
		return roots.flatMap((root) => {
			const entry = ledger?.roots[rootKey(root)];
			if (entry?.state !== "running") return [];
			const logs = join(storeDir, "blueprint-logs");
			return [
				{ root, startedAt: entry.at, logs: entry.build === undefined ? logs : join(logs, `${entry.build}-*.log`) },
			];
		});
	};
	const candidates = await unfinished();
	if (candidates.length === 0) return [];
	const settled = await settleOtherBuilds(
		storeDir,
		candidates.map((candidate) => candidate.root),
		{ ...options, keepCancelledLocks: true },
	);
	try {
		for (const build of await unfinished()) {
			if (!settled.cancelled.has(build.root)) continue;
			if (await setAside(build)) await removeLock(buildLockPath(storeDir, build.root));
		}
		return settled.warnings;
	} finally {
		await settled.release();
	}
}

/**
 * Runs `build` of the worktrees at `roots` under their build locks: from the first step process `build` starts until it
 * settles, records this process and the step processes that run. Callers settle other processes' builds of them first
 * ({@link settleOtherBuilds}), and release them once this resolves.
 * A lock that cannot be written never stops the build.
 */
export async function withBuildLocks<T>(
	storeDir: string,
	roots: readonly string[],
	build: () => Promise<T>,
	onUnwritable?: (message: string) => void,
): Promise<T> {
	const files = new Map(roots.map((root) => [buildLockPath(storeDir, root), root]));
	const steps = new Map<number, LockedProcess>();
	const writer: BuildLockWriter = {
		files,
		holder: await locked(process.pid, { fresh: true }),
		steps,
		retryTimers: new Map(),
		...(onUnwritable === undefined ? {} : { onUnwritable }),
		started: false,
		settled: false,
		told: false,
	};
	if (writer.holder.start === undefined) backfillHolderStart(writer, 1);
	// Written once a step starts a process, so a build that runs nothing, as for an untrusted worktree, writes nothing.
	const starting = () => {
		if (writer.started) return;
		writer.started = true;
		writeBuildLocksDurably(writer);
	};
	const watch = (pid: number, running: boolean) => recordStepProcessDurably(writer, pid, running);
	try {
		return await stepStartingWatcher.run(starting, () => stepProcessWatcher.run(watch, build));
	} finally {
		writer.settled = true;
		clearAllRetryTimers(writer);
		steps.clear();
		for (const file of files.keys()) if ((await readLock(file))?.pid === process.pid) await removeLock(file);
	}
}
