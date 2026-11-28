import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	clearLockHolderAsync,
	lockNamesLocalHolder,
	recordLockHolderAsync,
	takeOverDeadHolderAsync,
} from "../../lock-holder.js";
import { releaseLock } from "../../lock-release.ts";
import { lockHolderAsync, takeTakeoverMutexAsync } from "../../lock-takeover.js";

/** What the last build on this machine left for one workspace: a rebuild is needed unless it succeeded unchanged. */
export interface WorkspaceLedgerEntry {
	/** Digest of the workspace's blueprint inputs when it was built. */
	readonly digest: string;
	readonly status: "success" | "failed";
	readonly builtAt: string;
	/** The failing step, for a failed build. */
	readonly failedStep?: string;
	readonly logPath?: string;
}

/** What the last build on this machine left for the global blueprint. */
export interface GlobalLedgerEntry {
	/** Digest of the global blueprint and the deprecated `resume.setupCommand` alias. */
	readonly digest: string;
	readonly status: "success" | "failed";
	readonly builtAt: string;
	/** When a full build last succeeded for the global blueprint. */
	readonly lastFullBuildAt?: string;
}

/** The last build of one restored worktree: `running` is a build that never finished. */
export interface RootLedgerEntry {
	readonly state: "running" | "success" | "failed";
	readonly at: string;
	readonly build?: string;
}

export interface BlueprintLedger {
	readonly version: 1;
	readonly global?: GlobalLedgerEntry;
	readonly workspaces: Readonly<Record<string, WorkspaceLedgerEntry>>;
	readonly roots: Readonly<Record<string, RootLedgerEntry>>;
}

const DIGEST_VERSION = "atomic-blueprint-v1";

function sha256(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(`${part.length}:`).update(part);
	return hash.digest("hex");
}

/** The digest of a blueprint file's inputs: the file's text and, for a workspace, where it sits. */
export function blueprintDigest(directory: string, source: string, extra = ""): string {
	return sha256([DIGEST_VERSION, directory, source, extra]);
}

/** The ledger key of the workspace at `directory` (`.` for the root) of the repository `identity`. */
export function workspaceKey(identity: string, directory: string): string {
	return `${repositoryKey(identity)}:${directory === "" ? "." : directory}`;
}

/** The prefix of the ledger keys of every workspace of the repository `identity`. */
export function repositoryKey(identity: string): string {
	return sha256([identity]).slice(0, 16);
}

/** The ledger key of the restored worktree at `root`. */
export function rootKey(root: string): string {
	return sha256([resolve(root)]).slice(0, 16);
}

export function ledgerPath(storeDir: string): string {
	return join(storeDir, "blueprint-builds", "ledger.json");
}

const EMPTY_LEDGER: BlueprintLedger = { version: 1, workspaces: {}, roots: {} };

function isLedger(value: unknown): value is BlueprintLedger {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Record<keyof BlueprintLedger, unknown>>;
	return (
		candidate.version === 1 &&
		typeof candidate.workspaces === "object" &&
		candidate.workspaces !== null &&
		typeof candidate.roots === "object" &&
		candidate.roots !== null
	);
}

/**
 * The ledger of the builds on this machine. A missing ledger, and one that is not a ledger this version wrote, is an
 * empty one: the next build then has no parent and runs in full, and its write replaces the file.
 */
export async function readLedger(storeDir: string): Promise<BlueprintLedger> {
	let text: string;
	try {
		text = await readFile(ledgerPath(storeDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LEDGER;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return EMPTY_LEDGER;
		throw error;
	}
	return isLedger(parsed) ? parsed : EMPTY_LEDGER;
}

const ledgerQueues = new Map<string, Promise<void>>();

/** A lock without a matching local holder record is stale after this long without a heartbeat. */
const LEDGER_LOCK_STALE_MS = 15_000;
const LEDGER_LOCK_UPDATE_MS = 5_000;
const LEDGER_LOCK_RETRIES = { retries: 40, factor: 1.2, minTimeout: 20, maxTimeout: 250 } as const;
const LEDGER_WAIT_NOTICE = "Waiting for another Atomic process to finish writing the blueprint ledger.";

function ledgerLocked(): Error {
	return Object.assign(new Error("Blueprint ledger lock is already being held"), { code: "ELOCKED" });
}

async function tryLockLedger(path: string, lockPath: string): Promise<() => Promise<void>> {
	const mutex = await takeTakeoverMutexAsync(lockPath, 0);
	if (mutex === undefined) {
		// The directory-mutex fallback can also fail in a read-only directory.
		await access(dirname(path), fs.constants.W_OK);
		throw ledgerLocked();
	}
	try {
		// New writers publish under the same mutex as both takeover paths. The library's mtime
		// rule is only for locks without a matching local holder, not live writers with late heartbeats.
		if ((await lockNamesLocalHolder(lockPath)) || !(await mutex.owned())) throw ledgerLocked();
		let acquired = false;
		let generation: string | undefined;
		// Once acquired, a late release or process exit must not remove a lock that replaced ours.
		// Older Atomic versions can still take over a stale lock without consulting the owner record.
		const rmdir = ((candidate: fs.PathLike, callback: fs.NoParamCallback) => {
			if (!acquired) return fs.rmdir(candidate, callback);
			void lockHolderAsync(lockPath).then((current) => {
				if (generation !== undefined && current === generation) fs.rmdir(candidate, callback);
				else callback(null);
			});
		}) as typeof fs.rmdir;
		const unlock = await lockfile.lock(path, {
			realpath: false,
			lockfilePath: lockPath,
			stale: LEDGER_LOCK_STALE_MS,
			update: LEDGER_LOCK_UPDATE_MS,
			fs: {
				...fs,
				rmdir,
				// proper-lockfile also tries to remove locks on exit. If normal release did not run,
				// leave the owner record for the next writer instead of unlinking without the mutex.
				rmdirSync: () => {},
			},
		});
		generation = await recordLockHolderAsync(lockPath);
		acquired = true;
		return async () => {
			const releaseMutex = await takeTakeoverMutexAsync(lockPath);
			try {
				await unlock();
				// If we could not take the mutex, leave the record: it cannot match a new lock directory.
				if (generation !== undefined && (await releaseMutex?.owned()))
					await clearLockHolderAsync(lockPath, generation);
			} finally {
				await releaseMutex?.release();
			}
		};
	} finally {
		await mutex.release();
	}
}

async function lockLedger(path: string, lockPath: string, onWait?: (message: string) => void) {
	let retries = 0;
	for (;;) {
		try {
			return await tryLockLedger(path, lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			if (await takeOverDeadHolderAsync(lockPath)) continue;
			if (retries >= LEDGER_LOCK_RETRIES.retries) throw error;
			if (retries === 0) onWait?.(LEDGER_WAIT_NOTICE);
			const delay = Math.min(
				Math.round(LEDGER_LOCK_RETRIES.minTimeout * LEDGER_LOCK_RETRIES.factor ** retries++),
				LEDGER_LOCK_RETRIES.maxTimeout,
			);
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, delay));
		}
	}
}

/** Serializes work on one ledger within this process, in the order it was asked for. */
async function inProcessTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = ledgerQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolveTurn) => {
		release = resolveTurn;
	});
	const chained = previous.then(() => current);
	ledgerQueues.set(key, chained);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (ledgerQueues.get(key) === chained) ledgerQueues.delete(key);
	}
}

/**
 * Applies `update` to the ledger as it is now and writes the result atomically. Updates are serialized, within this
 * process by a queue and across processes by a lock file, so builds that finish at about the same time keep each
 * other's entries. Reports contention through `onWait`. A lock that cannot be taken within its retries rejects with
 * the lock's error.
 */
export async function updateLedger(
	storeDir: string,
	update: (ledger: BlueprintLedger) => BlueprintLedger,
	onWait?: (message: string) => void,
): Promise<BlueprintLedger> {
	const path = resolve(ledgerPath(storeDir));
	const lockPath = `${path}.lock`;
	return inProcessTurn(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		const release = await lockLedger(path, lockPath, onWait);
		try {
			const next = update(await readLedger(storeDir));
			const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, path);
			return next;
		} finally {
			await releaseLock(release, lockPath);
		}
	});
}
