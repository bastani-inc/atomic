import { promisify } from "node:util";
import { randomUUID } from "crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpath as realpathCallback,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { access, chmod, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, sep } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseJsonFileContent } from "../utils/json.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { normalizeAzureSettings } from "./azure-provider-compat.js";
import {
	clearLockHolder,
	clearLockHolderAsync,
	recordLockHolder,
	recordLockHolderAsync,
	takeOverDeadHolder,
	takeOverDeadHolderAsync,
} from "./lock-holder.ts";
import { releaseLock, releaseLockSync } from "./lock-release.ts";
import { inLockTurn, type LockWait, waitForLock, waitForLockSync } from "./lock-wait.ts";
import { renameReplacing, renameReplacingAsync } from "./rename-retry.ts";
import { deepMergeSettings } from "./settings-merge.js";
import type {
	AsyncSettingsStorage,
	Settings,
	SettingsFieldOrigin,
	SettingsLayer,
	SettingsScope,
	SettingsStorage,
} from "./settings-types.ts";

/**
 * How long a save waits for one other process to release a settings file's lock. Kept short: a synchronous wait blocks
 * this process, so a lock it holds asynchronously stops being refreshed and would be taken over as stale.
 */
const SETTINGS_LOCK_WAIT_MS = 200;
const SETTINGS_LOCK_POLL_MIN_MS = 10;
const SETTINGS_LOCK_POLL_MAX_MS = 50;
/** How old a settings lock must be before it is judged left by a process that cannot be proven dead. */
const SETTINGS_LOCK_STALE_MS = 10_000;

/** A rename that cannot replace the file at all: it is a mount point (EBUSY), or on another device (EXDEV). */
const UNREPLACEABLE_FILE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EXDEV"]);

/** How {@link writeSettingsFile} wrote a file: `replaced` whole, or `in-place` because the file cannot be replaced. */
export type SettingsFileWrite =
	| { readonly mode: "replaced" }
	| { readonly mode: "in-place"; readonly reason: NodeJS.ErrnoException };

const inPlaceWrites = new Map<string, NodeJS.ErrnoException>();

/** The settings files this process wrote in place, each with the rename failure that first required it. */
export function settingsFilesWrittenInPlace(): ReadonlyMap<string, NodeJS.ErrnoException> {
	return inPlaceWrites;
}

/** How many symbolic links a settings path may pass through, as the Linux kernel allows. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The file a settings path names: its real path, or, when the file does not exist yet, the end of its symbolic link
 * chain, each link resolved against its own directory. A cycle or an overlong chain throws `ELOOP`, as writing through
 * the link would.
 */
function settingsFileTarget(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	let current = path;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
		if (!lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
		const link = readlinkSync(current);
		// Joined without normalizing, so a linked directory resolves before `..` as writing through the link would.
		current = isAbsolute(link) ? link : `${dirname(current)}${sep}${link}`;
	}
	throw tooManySymlinks(path);
}

const realpathAsync = promisify(realpathCallback);

/** {@link settingsFileTarget} without blocking the event loop. */
async function settingsFileTargetAsync(path: string): Promise<string> {
	if (await pathExists(path)) return realpathAsync(path);
	let current = path;
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
		if (!(await lstatIfPresent(current))?.isSymbolicLink()) return current;
		const link = await readlink(current);
		current = isAbsolute(link) ? link : `${dirname(current)}${sep}${link}`;
	}
	throw tooManySymlinks(path);
}

function tooManySymlinks(path: string): Error {
	return Object.assign(new Error(`ELOOP: too many symbolic links encountered, write '${path}'`), {
		code: "ELOOP",
		path,
	});
}

/** Whether something is at `path`, as `existsSync` answers it. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** The `lstat` of `path`, or undefined when nothing is there, as `lstatSync` with `throwIfNoEntry: false` reports it. */
async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

/** The content of the file at `path`, or undefined when there is none, as `existsSync` and `readFileSync` read it. */
async function readIfPresent(path: string): Promise<string | undefined> {
	return (await pathExists(path)) ? readFile(path, "utf-8") : undefined;
}

/**
 * Replace a settings file so readers and a killed or out-of-space writer only ever leave the old or the new content:
 * write a sibling temporary file with the same mode, then rename it over the file. A symbolic link stays a link; its
 * target is replaced, or created when it does not exist yet. A file that cannot be replaced, such as a single file
 * mounted into a container, is written in place instead, under the caller's lock; that fallback is returned and
 * recorded in {@link settingsFilesWrittenInPlace}.
 */
export function writeSettingsFile(path: string, content: string): SettingsFileWrite {
	const target = settingsFileTarget(path);
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf-8", ...(mode === undefined ? {} : { mode }) });
		if (mode !== undefined) chmodSync(temporary, mode);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	try {
		renameReplacing(temporary, target);
		return { mode: "replaced" };
	} catch (error) {
		rmSync(temporary, { force: true });
		const reason = error as NodeJS.ErrnoException;
		if (!UNREPLACEABLE_FILE_CODES.has(reason.code ?? "")) throw error;
		writeFileSync(target, content, "utf-8");
		if (!inPlaceWrites.has(target)) inPlaceWrites.set(target, reason);
		return { mode: "in-place", reason };
	}
}

/** {@link writeSettingsFile} without blocking the event loop. */
export async function writeSettingsFileAsync(path: string, content: string): Promise<SettingsFileWrite> {
	const target = await settingsFileTargetAsync(path);
	const mode = (await pathExists(target)) ? (await stat(target)).mode & 0o777 : undefined;
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf-8", ...(mode === undefined ? {} : { mode }) });
		if (mode !== undefined) await chmod(temporary, mode);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
	try {
		await renameReplacingAsync(temporary, target);
		return { mode: "replaced" };
	} catch (error) {
		await rm(temporary, { force: true });
		const reason = error as NodeJS.ErrnoException;
		if (!UNREPLACEABLE_FILE_CODES.has(reason.code ?? "")) throw error;
		await writeFile(target, content, "utf-8");
		if (!inPlaceWrites.has(target)) inPlaceWrites.set(target, reason);
		return { mode: "in-place", reason };
	}
}

/** The settings files whose lock an asynchronous save of this process holds now. */
const locksHeldAsynchronously = new Set<string>();

function parsesAsJson(content: string): boolean {
	try {
		parseJsonFileContent(content);
		return true;
	} catch {
		return false;
	}
}

export class FileSettingsStorage implements SettingsStorage, AsyncSettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private globalReadPaths: string[];
	private projectReadPaths: string[];
	/** The content of each read path as this storage last read or wrote it; undefined when the file was absent. */
	private knownContent = new Map<string, string | undefined>();

	constructor(cwd: string, agentDir: string, options?: { globalReadPaths?: string[]; projectReadPaths?: string[] }) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
		this.globalReadPaths = (options?.globalReadPaths ?? [this.globalSettingsPath]).map((path) => normalizePath(path));
		this.projectReadPaths = (options?.projectReadPaths ?? [this.projectSettingsPath]).map((path) =>
			normalizePath(path),
		);
	}

	getFieldOrigin(scope: SettingsScope, field: keyof Settings): SettingsFieldOrigin | undefined {
		const index = this.fieldSourceIndex(scope, field);
		if (index === undefined) return undefined;
		return index === 0 ? "primary" : "legacy";
	}

	getFieldPath(scope: SettingsScope, field: string): string | undefined {
		const index = this.fieldSourceIndex(scope, field);
		return index === undefined
			? undefined
			: (scope === "global" ? this.globalReadPaths : this.projectReadPaths)[index];
	}

	/**
	 * Index of the first read path that sets the field, which is the one whose value takes effect: as the files were
	 * when this storage last read or wrote them, which is what the settings loaded from it hold.
	 */
	private fieldSourceIndex(scope: SettingsScope, field: string): number | undefined {
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		for (const [index, readPath] of readPaths.entries()) {
			const content = this.knownContent.get(readPath);
			if (content === undefined) continue;
			try {
				const parsed = parseJsonFileContent(content) as Settings;
				if (Object.hasOwn(parsed, field)) return index;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/** Records `content` as what the file at `path` holds now; undefined when it is absent. */
	private remember(path: string, content: string | undefined): void {
		this.knownContent.set(normalizePath(path), content);
	}

	/** Records the files of `scope` as `layers`, the ones that exist, and returns them. */
	private rememberLayers(scope: SettingsScope, layers: SettingsLayer[]): SettingsLayer[] {
		for (const readPath of scope === "global" ? this.globalReadPaths : this.projectReadPaths)
			this.knownContent.set(readPath, layers.find((layer) => layer.path === readPath)?.content);
		return layers;
	}

	private lockWait(path: string): Omit<LockWait, "takeOver"> {
		return {
			lockPath: `${path}.lock`,
			staleMs: SETTINGS_LOCK_STALE_MS,
			holderWaitMs: SETTINGS_LOCK_WAIT_MS,
			pollMinMs: SETTINGS_LOCK_POLL_MIN_MS,
			pollMaxMs: SETTINGS_LOCK_POLL_MAX_MS,
			retryable: (error) => (error as NodeJS.ErrnoException).code === "ELOCKED",
			stuck: (error) => error as Error,
			contended: (error, waitedMs) =>
				Object.assign(
					new Error(`Other processes kept saving ${path} for ${Math.round(waitedMs / 1000)} s`, {
						cause: error,
					}),
					{
						code: "ELOCKED",
					},
				),
		};
	}

	/**
	 * Takes the lock of the settings file `path`, waiting while other processes save to it (see {@link waitForLockSync}).
	 * A lock whose holder is proven dead is taken over at once (#5161), and this process is named as the holder.
	 */
	private acquireLockSyncWithRetry(path: string): () => void {
		const lockPath = `${path}.lock`;
		const release = waitForLockSync(
			(fs) => lockfile.lockSync(path, { realpath: false, stale: SETTINGS_LOCK_STALE_MS, fs }),
			{ ...this.lockWait(path), takeOver: () => takeOverDeadHolder(lockPath) },
		);
		recordLockHolder(lockPath);
		return () => {
			clearLockHolder(lockPath);
			release();
		};
	}

	/** {@link acquireLockSyncWithRetry} without blocking the event loop: every wait, takeover and holder record is asynchronous. */
	private async acquireLockWithRetry(path: string): Promise<() => Promise<void>> {
		const lockPath = `${path}.lock`;
		const release = await waitForLock(
			(fs) => lockfile.lock(path, { realpath: false, stale: SETTINGS_LOCK_STALE_MS, retries: 0, fs }),
			{ ...this.lockWait(path), takeOver: () => takeOverDeadHolderAsync(lockPath) },
		);
		locksHeldAsynchronously.add(path);
		await recordLockHolderAsync(lockPath);
		return async () => {
			try {
				await clearLockHolderAsync(lockPath);
				await release();
			} finally {
				locksHeldAsynchronously.delete(path);
			}
		};
	}

	private readMergedSettings(readPaths: string[]): string | undefined {
		let merged: Settings | undefined;
		for (let i = readPaths.length - 1; i >= 0; i--) {
			const readPath = readPaths[i]!;
			merged = this.mergeFile(merged, readPath, existsSync(readPath) ? readFileSync(readPath, "utf-8") : undefined);
		}
		return merged === undefined ? undefined : JSON.stringify(merged, null, 2);
	}

	private async readMergedSettingsAsync(readPaths: string[]): Promise<string | undefined> {
		let merged: Settings | undefined;
		for (let i = readPaths.length - 1; i >= 0; i--) {
			const readPath = readPaths[i]!;
			merged = this.mergeFile(merged, readPath, await readIfPresent(readPath));
		}
		return merged === undefined ? undefined : JSON.stringify(merged, null, 2);
	}

	/** Merges the file at `path`, read as `content` (undefined when absent), over the files of lower precedence. */
	private mergeFile(merged: Settings | undefined, path: string, content: string | undefined): Settings | undefined {
		this.remember(path, content);
		if (content === undefined) return merged;
		try {
			const parsed = parseJsonFileContent(content) as Settings;
			return deepMergeSettings(merged ?? {}, normalizeAzureSettings(parsed));
		} catch (error) {
			if (error instanceof Error) (error as Error & { path?: string }).path = path;
			throw error;
		}
	}

	/**
	 * Reads each settings file of `scope` without the write lock (#5161): saves replace a file whole with a rename, so a
	 * read sees the last complete file, and a lock left by a killed process never stops a read. Only a file written in
	 * place, because it cannot be replaced, may be read halfway; a read that does not parse is repeated under the lock,
	 * and when the lock cannot be had, the file as read stands and its parse error is reported.
	 */
	readLayers(scope: SettingsScope): SettingsLayer[] {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const read = () =>
			readPaths
				.filter((readPath) => existsSync(readPath))
				.map((readPath) => ({ path: readPath, content: readFileSync(readPath, "utf-8") }));
		const layers = read();
		if (layers.every(({ content }) => parsesAsJson(content)) || !existsSync(path))
			return this.rememberLayers(scope, layers);
		let release: () => void;
		try {
			release = this.acquireLockSyncWithRetry(path);
		} catch {
			return this.rememberLayers(scope, layers);
		}
		try {
			return this.rememberLayers(scope, read());
		} finally {
			releaseLockSync(release, path);
		}
	}

	/** {@link readLayers} without blocking the event loop. */
	async readLayersAsync(scope: SettingsScope): Promise<SettingsLayer[]> {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const read = async () => {
			const layers: SettingsLayer[] = [];
			for (const readPath of readPaths) {
				const content = await readIfPresent(readPath);
				if (content !== undefined) layers.push({ path: readPath, content });
			}
			return layers;
		};
		const layers = await read();
		if (layers.every(({ content }) => parsesAsJson(content)) || !(await pathExists(path)))
			return this.rememberLayers(scope, layers);
		return inLockTurn(path, async () => {
			let release: () => Promise<void>;
			try {
				release = await this.acquireLockWithRetry(path);
			} catch {
				return this.rememberLayers(scope, layers);
			}
			try {
				return this.rememberLayers(scope, await read());
			} finally {
				await releaseLock(release, path);
			}
		});
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if the primary file exists or we need to write.
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = this.readMergedSettings(readPaths);
			const next = fn(current);

			if (next !== undefined) {
				// Only create directory when we actually need to write.
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					if (!existsSync(path)) writeFileSync(path, "{}", "utf-8");
					release = this.acquireLockSyncWithRetry(path);
				}
				writeSettingsFile(path, next);
				this.remember(path, next);
			}
		} finally {
			if (release) {
				releaseLockSync(release, path);
			}
		}
	}

	/** {@link withLock} without blocking the event loop. */
	async withLockAsync(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const readPaths = scope === "global" ? this.globalReadPaths : this.projectReadPaths;
		const dir = dirname(path);

		await inLockTurn(path, async () => {
			let release: (() => Promise<void>) | undefined;
			try {
				if (await pathExists(path)) {
					release = await this.acquireLockWithRetry(path);
				}
				const next = fn(await this.readMergedSettingsAsync(readPaths));

				if (next !== undefined) {
					if (!(await pathExists(dir))) {
						await mkdir(dir, { recursive: true });
					}
					if (!release) {
						if (!(await pathExists(path))) await writeFile(path, "{}", "utf-8");
						release = await this.acquireLockWithRetry(path);
					}
					await writeSettingsFileAsync(path, next);
					this.remember(path, next);
				}
			} finally {
				if (release) {
					await releaseLock(release, path);
				}
			}
		});
	}

	withPrimaryWriteLock(scope: SettingsScope, fn: (currentPrimary: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const release = this.acquireLockSyncWithRetry(path);
		try {
			const currentPrimary = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			const next = fn(currentPrimary);
			if (next !== undefined) {
				writeSettingsFile(path, next);
			}
			this.remember(path, next ?? currentPrimary);
		} finally {
			releaseLockSync(release, path);
		}
	}

	/**
	 * {@link withPrimaryWriteLock} as the process exits. When an asynchronous save of this process holds the file's lock,
	 * it never resumes, so the file is written under that lock rather than waiting for it.
	 */
	withPrimaryWriteLockAtExit(
		scope: SettingsScope,
		fn: (currentPrimary: string | undefined) => string | undefined,
	): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		if (!locksHeldAsynchronously.has(path)) {
			this.withPrimaryWriteLock(scope, fn);
			return;
		}
		const next = fn(existsSync(path) ? readFileSync(path, "utf-8") : undefined);
		if (next !== undefined) writeSettingsFile(path, next);
	}

	/** {@link withPrimaryWriteLock} without blocking the event loop. */
	async withPrimaryWriteLockAsync(
		scope: SettingsScope,
		fn: (currentPrimary: string | undefined) => string | undefined,
	): Promise<void> {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);
		if (!(await pathExists(dir))) {
			await mkdir(dir, { recursive: true });
		}

		await inLockTurn(path, async () => {
			const release = await this.acquireLockWithRetry(path);
			try {
				const currentPrimary = await readIfPresent(path);
				const next = fn(currentPrimary);
				if (next !== undefined) {
					await writeSettingsFileAsync(path, next);
				}
				this.remember(path, next ?? currentPrimary);
			} finally {
				await releaseLock(release, path);
			}
		});
	}
}

export class InMemorySettingsStorage implements SettingsStorage, AsyncSettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}

	async withLockAsync(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		this.withLock(scope, fn);
	}

	getFieldOrigin(scope: SettingsScope, field: keyof Settings): SettingsFieldOrigin | undefined {
		const raw = scope === "global" ? this.global : this.project;
		const settings = JSON.parse(raw ?? "{}") as Settings;
		return Object.hasOwn(settings, field) ? "primary" : undefined;
	}
}

/** What a storage written before the asynchronous members has (#2299); {@link FileSettingsStorage} is never one. */
interface SynchronousSettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	withPrimaryWriteLock?(scope: SettingsScope, fn: (currentPrimary: string | undefined) => string | undefined): void;
	readLayers?(scope: SettingsScope): SettingsLayer[];
}

/** Loads and saves through the synchronous members of a storage that has no asynchronous ones. */
class SynchronousSettingsStorageAdapter implements AsyncSettingsStorage {
	readonly withPrimaryWriteLockAsync?: (
		scope: SettingsScope,
		fn: (currentPrimary: string | undefined) => string | undefined,
	) => Promise<void>;
	readonly readLayersAsync?: (scope: SettingsScope) => Promise<SettingsLayer[]>;
	private readonly storage: SynchronousSettingsStorage;

	constructor(storage: SynchronousSettingsStorage) {
		this.storage = storage;
		if (storage.withPrimaryWriteLock) {
			this.withPrimaryWriteLockAsync = async (scope, fn) => {
				storage.withPrimaryWriteLock?.(scope, fn);
			};
		}
		if (storage.readLayers) this.readLayersAsync = async (scope) => storage.readLayers?.(scope) ?? [];
	}

	async withLockAsync(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): Promise<void> {
		this.storage.withLock(scope, fn);
	}
}

/** The asynchronous members of `storage`, or its synchronous ones behind them when it has none. */
export function asyncSettingsStorage(storage: SettingsStorage): AsyncSettingsStorage {
	return hasAsyncMembers(storage) ? storage : new SynchronousSettingsStorageAdapter(storage);
}

function hasAsyncMembers(storage: SettingsStorage): storage is SettingsStorage & AsyncSettingsStorage {
	return typeof storage.withLockAsync === "function";
}
