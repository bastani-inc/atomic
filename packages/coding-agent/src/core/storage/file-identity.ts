import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	access,
	link,
	lstat,
	mkdir,
	opendir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./database.js";
import type { StorageInputSelection, StorageSettingsSelection } from "./selection.js";

const CONFIG_DIR_NAME = ".atomic";
const ENV_AGENT_DIR = "ATOMIC_CODING_AGENT_DIR";
const LEGACY_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ATOMIC_STORE_FILES = [
	join("workflows", "journal.sqlite"),
	join("workflows", "journal", "catalog.sqlite"),
	join("workflows", "pool", "host-id"),
] as const;
const ADOPTION_CLAIM_FILE = ".adopted-by";
const PARENT_CLAIM_FILE = ".atomic-storage-parent-owner";
const HOME_DECISION_FILE = ".atomic-storage-home";
const ADOPTION_NOTICE_SUFFIX = ".notified";
const CLI_SELECTION = Symbol.for("@bastani/atomic/storage/cli-selection");
const STORAGE_ENV_NAMES = ["ATOMIC_STORAGE", "ATOMIC_SESSIONS_STORAGE", "ATOMIC_WORKFLOWS_JOURNAL"] as const;
const ATOMIC_SETTING_KEYS: ReadonlySet<string> = new Set([
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"enabledModels",
	"thinkingBudgets",
	"branchSummary",
	"sessionSummary",
	"modelRouting",
	"enableSkillCommands",
	"showHardwareCursor",
	"doubleEscapeAction",
	"storage",
	"sessions",
	"workflows",
]);
const AGENT_DIR_STATE_ENTRIES: ReadonlySet<string> = new Set([
	HOME_DECISION_FILE,
	"open-sessions",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"agents",
	"trust.json",
	"pool-host-id",
	"atomic-debug.log",
	"pi-debug.log",
	"intercom",
	"worktree-snapshots",
	"released-history",
	"compaction-diagnostics",
	"workflow-logs",
	"blueprint-actions",
]);

interface StorageHomeSelection extends StorageSettingsSelection {
	readonly dir?: string;
	readonly database?: SqliteDatabase;
}

export interface StorageHomeSettings {
	readonly storage?: StorageInputSelection | { readonly dir: string };
	readonly sessions?: { readonly storage?: StorageInputSelection | { readonly dir: string } } | null;
	readonly workflows?: { readonly journal?: StorageInputSelection } | string[] | null;
}

interface SettledStorageHome {
	readonly home: string;
	readonly defaultHome?: boolean;
	readonly workflowsDir: string;
	readonly sessionDatabasePath: string;
	readonly sharedStoragePath: string;
	readonly adoptedClaim?: string;
	readonly provisionalWithoutSettings?: boolean;
	readonly rejectedParentAdoption?: { readonly legacyTargets: readonly string[] };
}

interface StorageHomeCacheKey {
	readonly platform: NodeJS.Platform;
	readonly rawHome: string;
	readonly rawAgentDir: string;
	readonly cwd: string | undefined;
}

interface CachedStorageHome extends StorageHomeCacheKey {
	readonly entry: SettledStorageHome;
}

const fastStorageHomes = new Map<string, CachedStorageHome>();
const settledStorageHomes = new Map<string, SettledStorageHome>();
let lastStorageHome: CachedStorageHome | undefined;

interface StorageFileStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeNs: bigint;
	readonly symbolicLink: boolean;
}

interface StorageDirectoryEntry {
	readonly name: string;
	readonly directory: boolean;
	readonly symbolicLink: boolean;
}

interface StorageIo {
	stat(path: string): StorageFileStat;
	lstat(path: string): StorageFileStat | undefined;
	realpath(path: string): string;
	exists(path: string): boolean;
	isDirectory(path: string): boolean;
	readFile(path: string): string;
	readdir(path: string): string[];
	listDirectory(path: string): StorageDirectoryEntry[];
	writeNewFile(path: string, contents: string, mode: number | undefined): void;
	link(from: string, to: string): void;
	renameNoReplace(from: string, to: string): boolean | undefined;
	rename(from: string, to: string): void;
	remove(path: string): void;
	mkdir(path: string): void;
	sleep(ms: number): void;
}

type StorageIoOp = keyof StorageIo;
type StorageIoRequest = {
	[Op in StorageIoOp]: { readonly op: Op; readonly args: Parameters<StorageIo[Op]> };
}[StorageIoOp];
type StorageIoResult = ReturnType<StorageIo[StorageIoOp]>;
type StorageSettingsRequest = { readonly op: "settings"; readonly args: readonly [] };
type StorageRequest = StorageIoRequest | StorageSettingsRequest;
type AsyncStorageIo = {
	readonly [Op in StorageIoOp]: (...args: Parameters<StorageIo[Op]>) => Promise<ReturnType<StorageIo[Op]>>;
};

export type StorageSteps<T> = Generator<StorageRequest, T, unknown>;

interface ClaimRenamer {
	readonly renameNoReplace: (from: string, to: string) => boolean;
	readonly renameNoReplaceAsync?: (from: string, to: string) => Promise<boolean>;
}

let claimRenamer: ClaimRenamer | null | undefined;

function nativeClaimRenamer(): ClaimRenamer | null {
	if (claimRenamer === undefined) {
		claimRenamer = null;
		for (const anchor of [import.meta.url, process.execPath]) {
			try {
				const binding = createRequire(anchor)("@bastani/atomic-natives") as Partial<ClaimRenamer>;
				if (typeof binding.renameNoReplace === "function") {
					claimRenamer = {
						renameNoReplace: binding.renameNoReplace,
						...(typeof binding.renameNoReplaceAsync === "function"
							? { renameNoReplaceAsync: binding.renameNoReplaceAsync }
							: {}),
					};
					break;
				}
			} catch {}
		}
	}
	return claimRenamer;
}

/** Windows system error numbers a native call reports, as the errno codes Node reports for them. */
const WINDOWS_ERROR_CODES: Readonly<Record<number, string>> = {
	2: "ENOENT",
	3: "ENOENT",
	5: "EPERM",
	19: "EROFS",
	32: "EBUSY",
	33: "EBUSY",
	80: "EEXIST",
	183: "EEXIST",
};

/**
 * Native calls fail with a generic status whose message ends with the OS error number (`... (os error 32)`). Gives the
 * error the errno code Node would report for that number, so callers can tell a busy file from a read-only one.
 */
function withNativeErrorCode(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	const code = (error as NodeJS.ErrnoException).code;
	if (typeof code === "string" && code.startsWith("E")) return error;
	const match = /\(os error (\d+)\)/.exec(error.message);
	if (match === null) return error;
	const number = Number(match[1]);
	const mapped =
		process.platform === "win32"
			? WINDOWS_ERROR_CODES[number]
			: Object.entries(osConstants.errno).find(([, value]) => value === number)?.[0];
	return mapped === undefined ? error : Object.assign(error, { code: mapped, errno: number });
}

function fileStat(stats: BigIntStats): StorageFileStat {
	return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs, symbolicLink: stats.isSymbolicLink() };
}

function isMissingEntry(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

const syncIo: StorageIo = {
	stat: (path) => fileStat(statSync(path, { bigint: true })),
	lstat: (path) => {
		const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		return stats === undefined ? undefined : fileStat(stats);
	},
	realpath: (path) => realpathSync.native(path),
	exists: (path) => existsSync(path),
	isDirectory: (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	readFile: (path) => readFileSync(path, "utf8"),
	readdir: (path) => readdirSync(path),
	listDirectory: (path) => {
		const directory = opendirSync(path);
		try {
			const entries: StorageDirectoryEntry[] = [];
			for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
				entries.push({ name: entry.name, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() });
			}
			return entries;
		} finally {
			try {
				directory.closeSync();
			} catch {}
		}
	},
	writeNewFile: (path, contents, mode) => {
		writeFileSync(path, contents, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
	},
	link: (from, to) => linkSync(from, to),
	renameNoReplace: (from, to) => {
		try {
			return nativeClaimRenamer()?.renameNoReplace(from, to);
		} catch (error) {
			throw withNativeErrorCode(error);
		}
	},
	rename: (from, to) => renameSync(from, to),
	remove: (path) => rmSync(path, { force: true }),
	mkdir: (path) => {
		mkdirSync(path, { recursive: true });
	},
	sleep: (ms) => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	},
};

const asyncIo: AsyncStorageIo = {
	stat: async (path) => fileStat(await stat(path, { bigint: true })),
	lstat: async (path) => {
		try {
			return fileStat(await lstat(path, { bigint: true }));
		} catch (error) {
			if (isMissingEntry(error)) return undefined;
			throw error;
		}
	},
	realpath: (path) => realpath(path),
	exists: (path) =>
		access(path).then(
			() => true,
			() => false,
		),
	isDirectory: (path) =>
		stat(path).then(
			(stats) => stats.isDirectory(),
			() => false,
		),
	readFile: (path) => readFile(path, "utf8"),
	readdir: (path) => readdir(path),
	listDirectory: async (path) => {
		const entries: StorageDirectoryEntry[] = [];
		for await (const entry of await opendir(path)) {
			entries.push({ name: entry.name, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() });
		}
		return entries;
	},
	writeNewFile: (path, contents, mode) =>
		writeFile(path, contents, mode === undefined ? { flag: "wx" } : { flag: "wx", mode }),
	link: (from, to) => link(from, to),
	renameNoReplace: async (from, to) => {
		const renamer = nativeClaimRenamer();
		if (renamer === null) return undefined;
		try {
			return renamer.renameNoReplaceAsync === undefined
				? renamer.renameNoReplace(from, to)
				: await renamer.renameNoReplaceAsync(from, to);
		} catch (error) {
			throw withNativeErrorCode(error);
		}
	},
	rename: (from, to) => rename(from, to),
	remove: (path) => rm(path, { force: true }),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	sleep: (ms) => sleep(ms),
};

function* io<Op extends StorageIoOp>(
	op: Op,
	...args: Parameters<StorageIo[Op]>
): StorageSteps<ReturnType<StorageIo[Op]>> {
	return (yield { op, args } as StorageIoRequest) as ReturnType<StorageIo[Op]>;
}

export function* storageSettingsSteps<S>(): StorageSteps<S> {
	return (yield { op: "settings", args: [] }) as S;
}

export function runStorageStepsSync<T>(steps: StorageSteps<T>, loadSettings?: () => unknown): T {
	let settings: { readonly value: unknown } | undefined;
	let next = steps.next();
	while (!next.done) {
		const request = next.value;
		let result: unknown;
		try {
			if (request.op === "settings") {
				settings ??= { value: loadSettings?.() };
				result = settings.value;
			} else {
				const operation = syncIo[request.op] as (...args: StorageIoRequest["args"]) => StorageIoResult;
				result = operation(...request.args);
			}
		} catch (error) {
			next = steps.throw(error);
			continue;
		}
		next = steps.next(result);
	}
	return next.value;
}

export async function runStorageSteps<T>(steps: StorageSteps<T>, loadSettings?: () => Promise<unknown>): Promise<T> {
	let settings: Promise<unknown> | undefined;
	let next = steps.next();
	while (!next.done) {
		const request = next.value;
		let result: unknown;
		try {
			if (request.op === "settings") {
				settings ??= Promise.resolve(loadSettings?.());
				result = await settings;
			} else {
				const operation = asyncIo[request.op] as (...args: StorageIoRequest["args"]) => Promise<StorageIoResult>;
				result = await operation(...request.args);
			}
		} catch (error) {
			next = steps.throw(error);
			continue;
		}
		next = steps.next(result);
	}
	return next.value;
}

/**
 * What a file is, whatever path names it: its device and inode (a hard link shares both, a symlink resolves to them),
 * or its real path on a file system that reports no inode. Undefined when the file does not exist.
 */
export function fileIdentity(path: string): string | undefined {
	try {
		const { dev, ino } = statSync(path, { bigint: true });
		if (ino !== 0n) return `${dev}:${ino}`;
		const real = realpathSync.native(path);
		return realPathIdentity(real);
	} catch {
		return undefined;
	}
}

export async function fileIdentityAsync(path: string): Promise<string | undefined> {
	try {
		const { dev, ino } = await stat(path, { bigint: true });
		if (ino !== 0n) return `${dev}:${ino}`;
		return realPathIdentity(await realpath(path));
	} catch {
		return undefined;
	}
}

function* fileIdentitySteps(path: string): StorageSteps<string | undefined> {
	try {
		const { dev, ino } = yield* io("stat", path);
		if (ino !== 0n) return `${dev}:${ino}`;
		return realPathIdentity(yield* io("realpath", path));
	} catch {
		return undefined;
	}
}

function realPathIdentity(real: string): string {
	return `path:${process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real}`;
}

/** Whether two paths name the same existing file. */
export function isSameFile(left: string, right: string): boolean {
	const identity = fileIdentity(left);
	return identity !== undefined && identity === fileIdentity(right);
}

function* isSameFileSteps(left: string, right: string): StorageSteps<boolean> {
	const identity = yield* fileIdentitySteps(left);
	return identity !== undefined && identity === (yield* fileIdentitySteps(right));
}

function getHomeDir(platform = process.platform): string {
	if (platform === "win32") {
		const profile = process.env.USERPROFILE;
		if (profile) return profile;
		const drive = process.env.HOMEDRIVE;
		const path = process.env.HOMEPATH;
		if (drive && path) return `${drive}${path}`;
		const home = process.env.HOME;
		if (home) return home;
		return homedir();
	}
	return process.env.HOME || process.env.USERPROFILE || homedir();
}

function expandAgentPathInput(input: string, home: string): string {
	let normalized = input;
	if (
		process.platform === "win32" &&
		normalized.startsWith("/") &&
		!normalized.startsWith("//") &&
		!normalized.includes("\\")
	) {
		const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (match) {
			const suffix = match[2]?.replaceAll("/", "\\");
			normalized = `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
		}
	}
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(home, normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		decodeURI(normalized);
		return fileURLToPath(normalized);
	}
	return normalized;
}

let configuredDefaultAgentDir: { readonly home: string; readonly path: string } | undefined;

function resolveConfiguredAgentDir(home: string): string {
	const envDir = process.env[ENV_AGENT_DIR] ?? process.env[LEGACY_ENV_AGENT_DIR];
	if (envDir) return expandAgentPathInput(envDir, home);
	if (configuredDefaultAgentDir?.home !== home) {
		configuredDefaultAgentDir = { home, path: join(home, CONFIG_DIR_NAME, "agent") };
	}
	return configuredDefaultAgentDir.path;
}

function getPathComparisonKey(path: string): string {
	const pathApi = process.platform === "win32" ? win32 : posix;
	const resolvedPath = pathApi.resolve(path);
	return pathApi === win32 ? resolvedPath.toLowerCase() : resolvedPath;
}

function pathsEqual(left: string, right: string): boolean {
	return getPathComparisonKey(left) === getPathComparisonKey(right);
}

function createStorageHomeEntry(
	home: string,
	adoptedClaim?: string,
	provisionalWithoutSettings?: boolean,
): SettledStorageHome {
	const workflowsDir = join(home, "workflows");
	return {
		home,
		workflowsDir,
		sessionDatabasePath: join(workflowsDir, "journal.sqlite"),
		sharedStoragePath: join(home, "storage.sqlite"),
		...(adoptedClaim === undefined ? {} : { adoptedClaim }),
		...(provisionalWithoutSettings ? { provisionalWithoutSettings: true } : {}),
	};
}

function createDefaultStorageHomeEntry(home: string, provisionalWithoutSettings?: boolean): SettledStorageHome {
	return { ...createStorageHomeEntry(home, undefined, provisionalWithoutSettings), defaultHome: true };
}

export function readClaimFile(file: string): string | undefined {
	return runStorageStepsSync(readClaimFileSteps(file));
}

export function readClaimFileAsync(file: string): Promise<string | undefined> {
	return runStorageSteps(readClaimFileSteps(file));
}

function* readClaimFileSteps(file: string): StorageSteps<string | undefined> {
	const claim = yield* readPublishedClaimSteps(file);
	return claim.state === "published" ? claim.contents : undefined;
}

/** How long a reader waits for a claim another process is still publishing before it reports the claim unreadable. */
const CLAIM_PUBLICATION_WAIT_MS = 1_000;
const CLAIM_PUBLICATION_POLL_MS = 10;

type ClaimRead =
	| { readonly state: "absent" }
	| { readonly state: "published"; readonly contents: string }
	| { readonly state: "unreadable" };

/**
 * Errors a reader can see while another process is creating or holding a claim file it will release shortly: a
 * sharing violation, and on Windows the access errors reported for a file another process has open in a conflicting
 * way.
 */
function isTransientClaimError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code === "EBUSY" || code === "EAGAIN" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"))
	);
}

/**
 * Reads a claim another process may be publishing at this moment. A claim that does not exist when the reader looks is
 * absent, even if it is published a moment later: the caller then publishes its own claim and reads whichever won.
 * Publishers end every record with a newline. A file that is empty or holds a record without its newline that is not a
 * whole JSON value (the exclusive-create fallback creates the file before writing it), or that is transiently busy, is a
 * publication in progress: the reader polls for up to `CLAIM_PUBLICATION_WAIT_MS` before reporting it unreadable (or,
 * for a record that never gained its newline, returning it for its reader to validate). Any other read error is
 * reported at once.
 */
function* readPublishedClaimSteps(file: string): StorageSteps<ClaimRead> {
	if (!(yield* io("exists", file))) return { state: "absent" };
	let partial: string | undefined;
	for (let waitedMs = 0; ; ) {
		try {
			const raw = yield* io("readFile", file);
			const contents = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
			if (contents.length > 0 && (contents !== raw || isJsonRecord(contents)))
				return { state: "published", contents };
			partial = contents.length > 0 ? contents : undefined;
		} catch (error) {
			if (!(yield* io("exists", file))) return { state: "absent" };
			// A file missing at the read that exists again now is being replaced: read it again.
			if (!isMissingEntry(error) && !isTransientClaimError(error)) return { state: "unreadable" };
		}
		if (waitedMs >= CLAIM_PUBLICATION_WAIT_MS) {
			// Still no terminating newline: a record written without one, which its reader validates as it is.
			return partial === undefined ? { state: "unreadable" } : { state: "published", contents: partial };
		}
		yield* io("sleep", CLAIM_PUBLICATION_POLL_MS);
		waitedMs += CLAIM_PUBLICATION_POLL_MS;
	}
}

function isJsonRecord(contents: string): boolean {
	try {
		JSON.parse(contents);
		return true;
	} catch {
		return false;
	}
}

type ClaimPublication = "claimed" | "exists" | "read-only" | "failed";

function isReadOnlyStorageError(error: NodeJS.ErrnoException): boolean {
	return error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS";
}

export function claimFileAtomically(file: string, contents: string): boolean {
	return runStorageStepsSync(claimFileAtomicallySteps(file, contents));
}

export function claimFileAtomicallyAsync(file: string, contents: string): Promise<boolean> {
	return runStorageSteps(claimFileAtomicallySteps(file, contents));
}

function* claimFileAtomicallySteps(file: string, contents: string): StorageSteps<boolean> {
	return (yield* publishClaimFileSteps(file, contents)) === "claimed";
}

/**
 * Publishes a claim unless one exists, by hard-linking a fully written staged copy into place, else by a native
 * no-replace rename, else (neither available) by exclusive create, whose record readers recognise as complete only once
 * it is fully written. Writing the staged copy is the write probe: when it fails with a permission or read-only error the
 * store is read-only. Once it succeeded the directory is writable, so a placement that keeps failing is a failure, never
 * a read-only store. A placement another process holds busy (a sharing violation) is retried, for up to
 * `CLAIM_PUBLICATION_WAIT_MS` in all, before the next way is tried.
 */
function* publishClaimFileSteps(file: string, contents: string): StorageSteps<ClaimPublication> {
	const staged = `${file}.${randomUUID()}`;
	let waitedMs = 0;
	function* waitWhileBusy(error: unknown): StorageSteps<boolean> {
		if (!isTransientClaimError(error) || waitedMs >= CLAIM_PUBLICATION_WAIT_MS) return false;
		yield* io("sleep", CLAIM_PUBLICATION_POLL_MS);
		waitedMs += CLAIM_PUBLICATION_POLL_MS;
		return true;
	}
	try {
		try {
			yield* io("writeNewFile", staged, contents, undefined);
		} catch (error) {
			return isReadOnlyStorageError(error as NodeJS.ErrnoException) ? "read-only" : "failed";
		}
		for (;;) {
			try {
				yield* io("link", staged, file);
				return "claimed";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
				if (!(yield* waitWhileBusy(error))) break;
			}
		}
		for (;;) {
			try {
				const renamed = yield* io("renameNoReplace", staged, file);
				if (renamed !== undefined) return renamed ? "claimed" : "exists";
				yield* io("writeNewFile", file, contents, undefined);
				return "claimed";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
				if (!(yield* waitWhileBusy(error))) return "failed";
			}
		}
	} finally {
		// The claim is settled either way; a staged copy that cannot be removed yet must not undo the publication.
		try {
			yield* io("remove", staged);
		} catch {}
	}
}

function normalizeAgentDirPath(rawAgentDir: string): string {
	if (!isAbsolute(rawAgentDir)) return resolve(rawAgentDir);
	const normalized = normalize(rawAgentDir);
	const root = parse(normalized).root;
	const hasTrailingSeparator = normalized.endsWith("/") || (process.platform === "win32" && normalized.endsWith("\\"));
	return normalized.length > root.length && hasTrailingSeparator ? normalized.slice(0, -1) : normalized;
}

export function sameDirectory(first: string, second: string): boolean {
	return runStorageStepsSync(sameDirectorySteps(first, second));
}

export function sameDirectoryAsync(first: string, second: string): Promise<boolean> {
	return runStorageSteps(sameDirectorySteps(first, second));
}

function* sameDirectorySteps(first: string, second: string): StorageSteps<boolean> {
	return pathsEqual(first, second) || (yield* isSameFileSteps(first, second));
}

function normalizeRelativeTarget(value: string | undefined, home: string): string | undefined {
	if (typeof value !== "string" || value === "" || value === ":memory:") return undefined;
	try {
		const expanded = expandAgentPathInput(value, home);
		return isAbsolute(expanded) ? undefined : expanded;
	} catch {
		return undefined;
	}
}

function selectsDefaultSharedStorage(selection: StorageHomeSelection): boolean {
	if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return false;
	const record = selection;
	if (
		record.dir !== undefined ||
		record.memory === true ||
		record.adapter !== undefined ||
		record.database !== undefined
	) {
		return false;
	}
	return record.path === undefined || record.path === "";
}

function pushSelectionTargets(
	targets: Set<string>,
	selection: StorageHomeSelection | undefined,
	home: string,
	isShared = false,
): void {
	if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return;
	if (isShared && selectsDefaultSharedStorage(selection)) {
		targets.add("storage.sqlite");
		return;
	}
	const record = selection;
	const pathTarget = normalizeRelativeTarget(record.path, home);
	if (pathTarget !== undefined) targets.add(pathTarget);
	const dirTarget = normalizeRelativeTarget(record.dir, home);
	if (dirTarget !== undefined) targets.add(dirTarget);
}

function pushSettingsTargets(
	targets: Set<string>,
	settings: StorageHomeSettings | null | undefined,
	home: string,
): void {
	if (settings === undefined || settings === null || typeof settings !== "object" || Array.isArray(settings)) return;
	pushSelectionTargets(targets, settings.storage, home, true);
	if (settings.sessions !== null && typeof settings.sessions === "object" && !Array.isArray(settings.sessions)) {
		pushSelectionTargets(targets, settings.sessions.storage, home);
	}
	if (settings.workflows !== null && typeof settings.workflows === "object" && !Array.isArray(settings.workflows)) {
		pushSelectionTargets(targets, settings.workflows.journal, home);
	}
}

function* configuredRelativeTargetsSteps(
	agentPath: string,
	home: string,
	settings?: StorageHomeSettings,
	includeProcessSelections = true,
): StorageSteps<readonly string[]> {
	const targets = new Set<string>();
	const cli = includeProcessSelections
		? (globalThis as Record<symbol, { readonly value?: StorageInputSelection } | undefined>)[CLI_SELECTION]
		: undefined;
	const environment: Partial<Record<(typeof STORAGE_ENV_NAMES)[number], StorageHomeSelection>> = {};
	for (const envName of includeProcessSelections ? STORAGE_ENV_NAMES : []) {
		const raw = process.env[envName];
		if (raw === undefined || raw === "") continue;
		try {
			environment[envName] = JSON.parse(raw) as StorageHomeSelection;
		} catch {}
	}
	let fileSettings: StorageHomeSettings | undefined;
	const settingsPath = join(agentPath, "settings.json");
	if (yield* io("exists", settingsPath)) {
		try {
			const raw = yield* io("readFile", settingsPath);
			const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as StorageHomeSettings | null;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) fileSettings = parsed;
		} catch {}
	}
	const effective = {
		storage: settings?.storage === undefined ? fileSettings?.storage : settings.storage,
		sessions: settings?.sessions === undefined ? fileSettings?.sessions : settings.sessions,
		workflows: settings?.workflows === undefined ? fileSettings?.workflows : settings.workflows,
	};
	const shared = cli?.value ?? environment.ATOMIC_STORAGE ?? effective.storage;
	pushSelectionTargets(targets, shared, home, true);
	const sessions = cli?.value ?? environment.ATOMIC_SESSIONS_STORAGE ?? environment.ATOMIC_STORAGE;
	if (sessions !== undefined) {
		pushSelectionTargets(targets, sessions, home, sessions === shared);
	} else if (!includeProcessSelections || !process.env.ATOMIC_CODING_AGENT_SESSION_DIR) {
		pushSettingsTargets(
			targets,
			{
				sessions: effective.sessions,
				storage: effective.sessions?.storage === undefined ? effective.storage : undefined,
			},
			home,
		);
	}
	// The workflow journal selections of earlier releases select nothing now, but a store they pointed at still marks
	// where this agent directory's earlier stores are.
	const workflows = cli?.value ?? environment.ATOMIC_WORKFLOWS_JOURNAL ?? environment.ATOMIC_STORAGE;
	if (workflows !== undefined) {
		pushSelectionTargets(targets, workflows, home, workflows === shared);
	} else if (!includeProcessSelections || !process.env.ATOMIC_WORKFLOW_JOURNAL_PATH) {
		const journal = Array.isArray(effective.workflows) ? undefined : effective.workflows?.journal;
		pushSettingsTargets(
			targets,
			{ workflows: effective.workflows, storage: journal === undefined ? effective.storage : undefined },
			home,
		);
	}
	return [...targets];
}

function* hasRelativeTargetEntriesSteps(
	baseDir: string,
	agentPath: string,
	relativeTargets: readonly string[],
	forbidSelfBase = false,
): StorageSteps<boolean> {
	for (const target of relativeTargets) {
		const candidate = resolve(baseDir, target);
		if (pathsEqual(candidate, agentPath)) continue;
		if (forbidSelfBase && pathsEqual(candidate, baseDir)) continue;
		if (yield* io("exists", candidate)) return true;
	}
	return false;
}

function* hasOwnTargetEntriesSteps(
	agentPath: string,
	parent: string,
	relativeTargets: readonly string[],
): StorageSteps<boolean> {
	for (const target of relativeTargets) {
		const own = resolve(agentPath, target);
		if (pathsEqual(own, agentPath) || !(yield* io("exists", own))) continue;
		const legacy = resolve(parent, target);
		if (!pathsEqual(legacy, agentPath) && !pathsEqual(legacy, parent) && (yield* io("exists", legacy))) {
			continue;
		}
		return true;
	}
	return false;
}

function* hasOwnStoreEntriesSteps(
	agentPath: string,
	parent: string,
	relativeTargets: readonly string[],
): StorageSteps<boolean> {
	for (const entry of ATOMIC_STORE_FILES) {
		if (yield* io("exists", join(agentPath, entry))) return true;
	}
	return yield* hasOwnTargetEntriesSteps(agentPath, parent, relativeTargets);
}

function* hasParentStoreEntriesSteps(
	parent: string,
	agentPath: string,
	relativeTargets: readonly string[],
): StorageSteps<boolean> {
	for (const entry of ATOMIC_STORE_FILES) {
		if (yield* io("exists", join(parent, entry))) return true;
	}
	return yield* hasRelativeTargetEntriesSteps(parent, agentPath, relativeTargets, true);
}

function parseConfigurationObject(contents: string): object | undefined {
	try {
		const value: object | null = JSON.parse(contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function hasAtomicConfiguration(contents: string, name: string): boolean {
	const value = parseConfigurationObject(contents);
	if (value === undefined) return false;
	if (name === "settings.json") return Object.keys(value).some((key) => ATOMIC_SETTING_KEYS.has(key));
	if (name === "models.json") {
		return (
			"providers" in value &&
			value.providers !== null &&
			typeof value.providers === "object" &&
			!Array.isArray(value.providers)
		);
	}
	const credentials = value as Readonly<Record<string, object | null>>;
	return Object.keys(credentials).some((provider) => {
		const credential = credentials[provider];
		if (credential === null || typeof credential !== "object" || Array.isArray(credential)) return false;
		if (!("type" in credential)) return false;
		if (credential.type === "api_key") return true;
		return (
			credential.type === "oauth" &&
			"access" in credential &&
			typeof credential.access === "string" &&
			"refresh" in credential &&
			typeof credential.refresh === "string" &&
			"expires" in credential &&
			typeof credential.expires === "number"
		);
	});
}

interface PriorUseSnapshot {
	readonly directoryVersion: string;
	readonly configurationVersions: readonly string[];
	readonly tier: 1 | 2;
}

const priorUseSnapshots = new Map<string, PriorUseSnapshot>();

function* agentDirectoryPriorUseTierSteps(dirPath: string): StorageSteps<0 | 1 | 2> {
	let names: string[];
	try {
		names = (yield* io("readdir", dirPath)).sort();
	} catch {
		return 0;
	}
	if (names.some((name) => AGENT_DIR_STATE_ENTRIES.has(name) || name.startsWith("storage-token."))) return 2;
	const directoryVersion = names.join("\0");
	const configurations: { name: string; contents: string; version: string }[] = [];
	let cacheable = true;
	for (const name of names) {
		if (!["settings.json", "auth.json", "models.json"].includes(name)) continue;
		try {
			const contents = yield* io("readFile", join(dirPath, name));
			configurations.push({ name, contents, version: createHash("sha256").update(contents).digest("hex") });
		} catch {
			cacheable = false;
		}
	}
	const cached = priorUseSnapshots.get(dirPath);
	if (
		cacheable &&
		cached?.directoryVersion === directoryVersion &&
		cached.configurationVersions.length === configurations.length &&
		cached.configurationVersions.every((version, index) => version === configurations[index]!.version)
	)
		return cached.tier;
	const tier = configurations.some(({ name, contents }) => hasAtomicConfiguration(contents, name)) ? 2 : 1;
	if (cacheable) {
		priorUseSnapshots.set(dirPath, {
			directoryVersion,
			configurationVersions: configurations.map(({ version }) => version),
			tier,
		});
	}
	return tier;
}

function* canClaimParentStoreSteps(
	parent: string,
	agentPath: string,
	defaultAgent: string,
	rawHome: string,
): StorageSteps<boolean> {
	const selfTier = yield* agentDirectoryPriorUseTierSteps(agentPath);
	if (selfTier === 2) return true;
	const parentIsDefaultAgent = yield* sameDirectorySteps(parent, defaultAgent);
	try {
		for (const entry of yield* io("listDirectory", parent)) {
			const name = entry.name;
			if (name === "repos" || name === "worktrees" || (parentIsDefaultAgent && AGENT_DIR_STATE_ENTRIES.has(name))) {
				continue;
			}
			const siblingPath = join(parent, name);
			if (!(entry.directory || (entry.symbolicLink && (yield* io("isDirectory", siblingPath))))) continue;
			if (yield* sameDirectorySteps(siblingPath, agentPath)) continue;
			const siblingDecision = yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(siblingPath));
			if (siblingDecision !== undefined && siblingDecision.parentOwner === undefined) continue;
			const siblingTier = yield* agentDirectoryPriorUseTierSteps(siblingPath);
			if (name === "workflows" && siblingTier < 2) continue;
			if (
				siblingTier === 2 &&
				!(yield* hasOwnStoreEntriesSteps(
					siblingPath,
					parent,
					yield* configuredRelativeTargetsSteps(siblingPath, rawHome, undefined, false),
				))
			) {
				return false;
			}
		}
	} catch {}
	return true;
}

function recordSettledStorageHome(
	fastKey: StorageHomeCacheKey,
	cacheKey: string,
	settled: SettledStorageHome,
): SettledStorageHome {
	const recorded = settledStorageHomes.get(cacheKey);
	if (settled.provisionalWithoutSettings && recorded !== undefined && !recorded.provisionalWithoutSettings) {
		return recorded;
	}
	lastStorageHome = undefined;
	if (!settled.provisionalWithoutSettings) {
		for (const [key, entry] of settledStorageHomes) {
			if (entry.provisionalWithoutSettings) settledStorageHomes.delete(key);
		}
		for (const [key, cached] of fastStorageHomes) {
			if (cached.entry.provisionalWithoutSettings) fastStorageHomes.delete(key);
		}
	}
	settledStorageHomes.set(cacheKey, settled);
	fastStorageHomes.set(fastKey.rawAgentDir, { ...fastKey, entry: settled });
	return settled;
}

interface StorageHomeDecision {
	readonly id?: string;
	readonly relativePaths?: boolean;
	readonly home: string;
	readonly defaultHome?: boolean;
	readonly parentOwner?: string;
	readonly targets?: readonly string[];
}

interface StorageTargetDecision {
	readonly agentPath: string;
	readonly target: string;
	readonly decision: StorageHomeDecision;
}

let storageTargetDecisions = new WeakMap<SettledStorageHome, Map<string, StorageTargetDecision>>();
let defaultTargetClaims = new WeakMap<StorageTargetDecision, { version: string; claims: readonly string[] }>();

function* canonicalPathSteps(path: string): StorageSteps<string> {
	try {
		return yield* io("realpath", path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(yield* canonicalPathSteps(parent), relative(parent, path));
	}
}

function storageHomeDecisionFile(agentPath: string): string {
	return join(agentPath, HOME_DECISION_FILE);
}

function* storageTargetDecisionFileSteps(agentPath: string, target: string): StorageSteps<string> {
	const key = createHash("sha256")
		.update(getPathComparisonKey(resolve(yield* canonicalPathSteps(agentPath), target)))
		.digest("hex");
	return `${storageHomeDecisionFile(agentPath)}.target-${key}`;
}

/**
 * Marks that this directory uses its own copy of `target` because another directory owns the parent one. The marker
 * lives in the directory and is keyed by the target relative to it, so it moves and is copied with the data it marks.
 */
function* localTargetMarkerFileSteps(agentPath: string, target: string): StorageSteps<string> {
	const base = yield* canonicalPathSteps(agentPath);
	const local = relative(base, resolve(base, target));
	const key = createHash("sha256")
		.update(process.platform === "win32" ? local.toLowerCase() : local)
		.digest("hex");
	return `${storageHomeDecisionFile(agentPath)}.local-${key}`;
}

function* isDefaultStorageHomeSteps(home: string, configuredHome: string): StorageSteps<boolean> {
	if (yield* sameDirectorySteps(home, configuredHome)) return true;
	const agent = join(home, "agent");
	if (basename(yield* canonicalPathSteps(home)) !== CONFIG_DIR_NAME || !(yield* io("isDirectory", agent)))
		return false;
	const decision = yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(agent));
	if (decision !== undefined) return decision.defaultHome === true || decision.parentOwner !== undefined;
	return yield* hasParentStoreEntriesSteps(
		home,
		agent,
		yield* configuredRelativeTargetsSteps(agent, getHomeDir(), undefined, false),
	);
}

function* defaultHomeForAgentSteps(agentPath: string, configuredHome: string): StorageSteps<string | undefined> {
	if (yield* sameDirectorySteps(agentPath, join(configuredHome, "agent"))) return configuredHome;
	const physical = yield* canonicalPathSteps(agentPath);
	const parent = dirname(physical);
	return basename(physical) === "agent" && (yield* isDefaultStorageHomeSteps(parent, configuredHome))
		? parent
		: undefined;
}

function* readStorageHomeDecisionSteps(file: string): StorageSteps<StorageHomeDecision | undefined> {
	const claim = yield* readPublishedClaimSteps(file);
	if (claim.state === "absent") return undefined;
	if (claim.state === "unreadable") throw new Error(`Cannot read storage home decision at ${file}`);
	let decision = JSON.parse(claim.contents) as StorageHomeDecision;
	if (
		decision === null ||
		typeof decision !== "object" ||
		typeof decision.home !== "string" ||
		(decision.id !== undefined && typeof decision.id !== "string") ||
		(decision.relativePaths !== undefined && typeof decision.relativePaths !== "boolean") ||
		(!decision.relativePaths && !isAbsolute(decision.home)) ||
		(decision.defaultHome !== undefined && typeof decision.defaultHome !== "boolean") ||
		(decision.parentOwner !== undefined &&
			(typeof decision.parentOwner !== "string" ||
				(!decision.relativePaths && !isAbsolute(decision.parentOwner)))) ||
		(decision.targets !== undefined &&
			(!Array.isArray(decision.targets) || decision.targets.some((target) => typeof target !== "string")))
	) {
		throw new Error(`Invalid storage home decision at ${file}`);
	}
	const agentPath = yield* canonicalPathSteps(dirname(file));
	const parent = yield* canonicalPathSteps(dirname(dirname(file)));
	if (decision.relativePaths) {
		decision = {
			...decision,
			home: resolve(agentPath, decision.home),
			...(decision.parentOwner === undefined ? {} : { parentOwner: resolve(agentPath, decision.parentOwner) }),
		};
	}
	if (decision.parentOwner === undefined) return decision;
	if (basename(file) === HOME_DECISION_FILE) {
		const owner = yield* readStorageOwnerSteps(join(parent, PARENT_CLAIM_FILE));
		if (owner !== undefined) {
			const currentOwner = yield* currentStorageOwnerPathSteps(owner, parent);
			if (
				pathsEqual(decision.parentOwner, owner.path) ||
				(currentOwner !== undefined && (yield* sameDirectorySteps(decision.parentOwner, currentOwner)))
			) {
				return { ...decision, home: parent, parentOwner: currentOwner ?? owner.path };
			}
		}
	} else {
		const homeFile = storageHomeDecisionFile(dirname(file));
		const recorded = yield* readClaimFileSteps(homeFile);
		if (recorded !== undefined) {
			const original = JSON.parse(recorded) as StorageHomeDecision;
			const recordedHome = original.relativePaths ? resolve(agentPath, original.home) : original.home;
			if (pathsEqual(decision.home, recordedHome)) {
				const current = yield* readStorageHomeDecisionSteps(homeFile);
				if (current !== undefined && !pathsEqual(current.home, recordedHome)) {
					const originalOwner = original.parentOwner;
					const owner =
						originalOwner === undefined
							? undefined
							: original.relativePaths
								? resolve(agentPath, originalOwner)
								: originalOwner;
					return {
						...decision,
						home: current.home,
						...(owner !== undefined && pathsEqual(decision.parentOwner, owner)
							? { parentOwner: current.parentOwner }
							: {}),
					};
				}
			}
		}
	}
	return decision;
}

function* settleStorageDecisionSteps(file: string, decision: StorageHomeDecision): StorageSteps<StorageHomeDecision> {
	const agentPath = yield* canonicalPathSteps(dirname(file));
	const canonical = {
		...decision,
		id: decision.id ?? randomUUID(),
		relativePaths: true,
		home: relative(agentPath, yield* canonicalPathSteps(decision.home)) || ".",
		...(decision.parentOwner === undefined
			? {}
			: { parentOwner: relative(agentPath, yield* canonicalPathSteps(decision.parentOwner)) || "." }),
	};
	try {
		yield* io("mkdir", dirname(file));
	} catch (error) {
		if (isReadOnlyStorageError(error as NodeJS.ErrnoException)) {
			return (yield* readStorageHomeDecisionSteps(file)) ?? decision;
		}
		throw error;
	}
	const publication = yield* publishClaimFileSteps(file, `${JSON.stringify(canonical)}\n`);
	const winner = yield* readStorageHomeDecisionSteps(file);
	if (winner === undefined) {
		if (publication === "read-only") return decision;
		throw new Error(`Cannot settle storage decision at ${file}`);
	}
	return winner;
}

function* eligibleLegacyHostOwnerSteps(parentWorkflows: string, rawHome: string): StorageSteps<string | undefined> {
	const owner = yield* readClaimFileSteps(join(parentWorkflows, "pool", "host-id.adopted-by"));
	if (owner === undefined || !(yield* io("isDirectory", owner))) return undefined;
	const decision = yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(owner));
	if (decision !== undefined && decision.parentOwner === undefined) return undefined;
	return (yield* hasOwnStoreEntriesSteps(
		owner,
		dirname(owner),
		yield* configuredRelativeTargetsSteps(owner, rawHome, undefined, false),
	))
		? undefined
		: owner;
}

interface StorageOwner {
	readonly path: string;
	readonly relativePath?: string;
	readonly identity?: string;
	readonly directoryIdentity?: string;
	readonly decisionId?: string;
	readonly homeIdentity?: boolean;
	readonly legacyTargets?: readonly string[];
}

function* storageDecisionMetadataSteps(
	path: string,
): StorageSteps<Pick<StorageHomeDecision, "id" | "targets"> | undefined> {
	const contents = yield* readClaimFileSteps(storageHomeDecisionFile(path));
	if (contents === undefined) return undefined;
	try {
		const decision = JSON.parse(contents) as Pick<StorageHomeDecision, "id" | "targets"> | null;
		if (
			decision === null ||
			typeof decision !== "object" ||
			(decision.id !== undefined && typeof decision.id !== "string") ||
			(decision.targets !== undefined &&
				(!Array.isArray(decision.targets) || decision.targets.some((target) => typeof target !== "string")))
		)
			return undefined;
		return decision;
	} catch {
		return undefined;
	}
}

function* storageOwnerSteps(path: string, claimDirectory?: string): StorageSteps<StorageOwner> {
	const physical = yield* canonicalPathSteps(path);
	const homeIdentity = yield* fileIdentitySteps(storageHomeDecisionFile(path));
	const relativePath =
		claimDirectory === undefined ? undefined : relative(yield* canonicalPathSteps(claimDirectory), physical);
	const identity = homeIdentity ?? (yield* fileIdentitySteps(path));
	const decisionId = (yield* storageDecisionMetadataSteps(path))?.id;
	const directoryIdentity = yield* fileIdentitySteps(path);
	return {
		path: physical,
		...(relativePath === undefined || isAbsolute(relativePath) ? {} : { relativePath: relativePath || "." }),
		identity,
		decisionId,
		directoryIdentity,
		homeIdentity: homeIdentity !== undefined,
	};
}

function* readStorageOwnerSteps(file: string): StorageSteps<StorageOwner | undefined> {
	const claim = yield* readPublishedClaimSteps(file);
	if (claim.state === "absent") return undefined;
	if (claim.state === "unreadable") throw new Error(`Cannot read storage owner at ${file}`);
	const raw = claim.contents;
	if (!raw.startsWith("{")) {
		if (!isAbsolute(raw)) throw new Error(`Invalid storage owner at ${file}`);
		return { path: raw };
	}
	const owner = JSON.parse(raw) as StorageOwner;
	if (
		owner === null ||
		typeof owner !== "object" ||
		typeof owner.path !== "string" ||
		!isAbsolute(owner.path) ||
		(owner.relativePath !== undefined &&
			(typeof owner.relativePath !== "string" || isAbsolute(owner.relativePath))) ||
		(owner.identity !== undefined && typeof owner.identity !== "string") ||
		(owner.directoryIdentity !== undefined && typeof owner.directoryIdentity !== "string") ||
		(owner.decisionId !== undefined && typeof owner.decisionId !== "string") ||
		(owner.homeIdentity !== undefined && typeof owner.homeIdentity !== "boolean") ||
		(owner.legacyTargets !== undefined &&
			(!Array.isArray(owner.legacyTargets) || owner.legacyTargets.some((target) => typeof target !== "string")))
	) {
		throw new Error(`Invalid storage owner at ${file}`);
	}
	return owner;
}

function* currentStorageOwnerPathSteps(
	owner: StorageOwner,
	claimDirectory = dirname(owner.path),
	claimedTarget?: string,
): StorageSteps<string | undefined> {
	const path = owner.relativePath === undefined ? owner.path : resolve(claimDirectory, owner.relativePath);
	if (
		owner.identity === undefined ||
		(yield* fileIdentitySteps(owner.homeIdentity ? storageHomeDecisionFile(path) : path)) === owner.identity
	)
		return path;
	const exact: string[] = [];
	const recorded: string[] = [];
	const fallback: string[] = [];
	function* consider(candidate: string): StorageSteps<void> {
		if (!(yield* io("isDirectory", candidate))) return;
		const identity = yield* fileIdentitySteps(owner.homeIdentity ? storageHomeDecisionFile(candidate) : candidate);
		let matches: string[];
		if (identity === owner.identity) {
			matches = exact;
		} else {
			const metadata = yield* storageDecisionMetadataSteps(candidate);
			if (
				(owner.decisionId === undefined || metadata?.id !== owner.decisionId) &&
				(owner.directoryIdentity === undefined || (yield* fileIdentitySteps(candidate)) !== owner.directoryIdentity)
			)
				return;
			const atRecordedPath = yield* sameDirectorySteps(candidate, path);
			const targets = [
				...(metadata?.targets ?? []),
				...(yield* configuredRelativeTargetsSteps(candidate, getHomeDir(), undefined, false)),
			];
			const physicalCandidate = yield* canonicalPathSteps(candidate);
			const ownTargets: string[] = [];
			for (const target of targets) {
				if (
					containsPath(physicalCandidate, yield* canonicalPathSteps(resolve(candidate, target))) &&
					(claimedTarget === undefined ||
						!pathsEqual(resolve(candidate, target), resolve(candidate, claimedTarget)) ||
						(yield* io("exists", yield* localTargetMarkerFileSteps(candidate, claimedTarget))))
				)
					ownTargets.push(target);
			}
			const legacyTargets = owner.legacyTargets;
			let unownedTargets = ownTargets;
			if (legacyTargets !== undefined) {
				unownedTargets = [];
				for (const target of ownTargets) {
					if (
						!legacyTargets.some((legacy) => pathsEqual(resolve(candidate, legacy), resolve(candidate, target))) ||
						!(yield* hasRelativeTargetEntriesSteps(claimDirectory, candidate, [target], true))
					)
						unownedTargets.push(target);
				}
			}
			if (
				(yield* hasOwnStoreEntriesSteps(candidate, claimDirectory, [])) ||
				(owner.legacyTargets === undefined && atRecordedPath
					? yield* hasOwnTargetEntriesSteps(candidate, claimDirectory, ownTargets)
					: yield* hasRelativeTargetEntriesSteps(candidate, candidate, unownedTargets, true))
			)
				return;
			matches = atRecordedPath ? recorded : fallback;
		}
		for (const match of matches) {
			if (yield* sameDirectorySteps(match, candidate)) return;
		}
		matches.push(candidate);
	}
	try {
		yield* consider(path);
		for (const entry of yield* io("listDirectory", claimDirectory)) {
			yield* consider(join(claimDirectory, entry.name));
		}
	} catch {
		return undefined;
	}
	const matches = exact.length > 0 ? exact : recorded.length > 0 ? recorded : fallback;
	return matches.length === 1 ? matches[0] : undefined;
}

function* refreshStorageOwnerSteps(
	file: string,
	owner: StorageOwner,
	agentPath: string,
	claimDirectory: string,
): StorageSteps<void> {
	const current = {
		...(yield* storageOwnerSteps(agentPath, claimDirectory)),
		path: owner.path,
		legacyTargets: owner.legacyTargets,
	};
	if (
		current.identity === owner.identity &&
		current.directoryIdentity === owner.directoryIdentity &&
		current.decisionId === owner.decisionId &&
		current.relativePath === owner.relativePath &&
		current.homeIdentity === owner.homeIdentity
	)
		return;
	const staged = `${file}.${randomUUID()}.tmp`;
	try {
		yield* io("writeNewFile", staged, `${JSON.stringify(current)}\n`, 0o600);
		yield* io("rename", staged, file);
	} catch {
	} finally {
		try {
			yield* io("remove", staged);
		} catch {}
	}
}

function* parentStorageOwnerSteps(parent: string): StorageSteps<string | undefined> {
	const owner = yield* readStorageOwnerSteps(join(parent, PARENT_CLAIM_FILE));
	return owner === undefined
		? yield* readClaimFileSteps(join(parent, "workflows", ADOPTION_CLAIM_FILE))
		: ((yield* currentStorageOwnerPathSteps(owner, parent)) ?? join(parent, PARENT_CLAIM_FILE));
}

function* applyStorageHomeDecisionSteps(
	decision: StorageHomeDecision,
	agentPath: string,
): StorageSteps<SettledStorageHome> {
	if (decision.defaultHome) {
		const home = yield* defaultHomeForAgentSteps(agentPath, join(getHomeDir(), CONFIG_DIR_NAME));
		return home === undefined ? createStorageHomeEntry(agentPath) : createDefaultStorageHomeEntry(home);
	}
	if (decision.parentOwner === undefined) return createStorageHomeEntry(agentPath);
	const workflows = join(decision.home, "workflows");
	const claim = join(decision.home, PARENT_CLAIM_FILE);
	const preferred = yield* canonicalPathSteps((yield* parentStorageOwnerSteps(decision.home)) ?? decision.parentOwner);
	const ownerTargets = new Set([
		...((yield* storageDecisionMetadataSteps(preferred))?.targets ?? []),
		...(yield* configuredRelativeTargetsSteps(preferred, getHomeDir(), undefined, false)),
	]);
	const legacyTargets: string[] = [];
	for (const target of ownerTargets) {
		if (
			containsPath(yield* canonicalPathSteps(preferred), yield* canonicalPathSteps(resolve(preferred, target))) &&
			(yield* io("exists", resolve(preferred, target))) &&
			(yield* hasRelativeTargetEntriesSteps(decision.home, preferred, [target], true))
		)
			legacyTargets.push(target);
	}
	yield* claimFileAtomicallySteps(
		claim,
		`${JSON.stringify({ ...(yield* storageOwnerSteps(preferred, decision.home)), legacyTargets })}\n`,
	);
	const winner = yield* readStorageOwnerSteps(claim);
	if (winner === undefined) throw new Error(`Cannot claim storage home at ${claim}`);
	const winnerPath = yield* currentStorageOwnerPathSteps(winner, decision.home);
	if (winnerPath !== undefined && (yield* sameDirectorySteps(winnerPath, agentPath))) {
		yield* refreshStorageOwnerSteps(claim, winner, agentPath, decision.home);
	}
	if (
		(yield* io("isDirectory", workflows)) ||
		!pathsEqual(yield* canonicalPathSteps(workflows), yield* canonicalPathSteps(agentPath))
	) {
		yield* io("mkdir", workflows);
		const legacyClaim = join(workflows, ADOPTION_CLAIM_FILE);
		yield* claimFileAtomicallySteps(legacyClaim, `${winner.path}\n`);
		const legacyOwner = yield* readClaimFileSteps(legacyClaim);
		if (
			legacyOwner === undefined ||
			(!(yield* sameDirectorySteps(legacyOwner, winner.path)) &&
				(winnerPath === undefined || !(yield* sameDirectorySteps(legacyOwner, winnerPath))))
		) {
			throw new Error(`Conflicting storage home ownership at ${legacyClaim}`);
		}
	}
	if (winnerPath !== undefined && (yield* sameDirectorySteps(winnerPath, agentPath)))
		return createStorageHomeEntry(decision.home, claim);
	const weakCandidate =
		(winner.decisionId !== undefined && (yield* storageDecisionMetadataSteps(agentPath))?.id === winner.decisionId) ||
		(winner.directoryIdentity !== undefined && (yield* fileIdentitySteps(agentPath)) === winner.directoryIdentity);
	return weakCandidate && winner.legacyTargets !== undefined
		? { ...createStorageHomeEntry(agentPath), rejectedParentAdoption: { legacyTargets: winner.legacyTargets } }
		: createStorageHomeEntry(agentPath);
}

function* resolveStorageHomeEntrySteps(
	agentDir?: string,
	settings?: StorageHomeSettings,
): StorageSteps<SettledStorageHome> {
	const platform = process.platform;
	const rawHome = getHomeDir(platform);
	const rawAgentDir = agentDir ?? resolveConfiguredAgentDir(rawHome);
	const cwd = isAbsolute(rawAgentDir) ? undefined : process.cwd();
	const last = lastStorageHome;
	if (
		last !== undefined &&
		last.platform === platform &&
		last.rawHome === rawHome &&
		last.rawAgentDir === rawAgentDir &&
		last.cwd === cwd &&
		(!last.entry.provisionalWithoutSettings || settings === undefined)
	) {
		return last.entry;
	}
	const fastHit = fastStorageHomes.get(rawAgentDir);
	if (
		fastHit !== undefined &&
		fastHit.platform === platform &&
		fastHit.rawHome === rawHome &&
		fastHit.cwd === cwd &&
		(!fastHit.entry.provisionalWithoutSettings || settings === undefined)
	) {
		lastStorageHome = fastHit;
		return fastHit.entry;
	}
	const fastKey = { platform, rawHome, rawAgentDir, cwd };

	const agentPath = normalizeAgentDirPath(rawAgentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined && (!cached.provisionalWithoutSettings || settings === undefined)) {
		fastStorageHomes.set(rawAgentDir, { ...fastKey, entry: cached });
		return cached;
	}

	const matchedDefaultHome = yield* defaultHomeForAgentSteps(agentPath, defaultHome);
	if (matchedDefaultHome !== undefined) {
		const file = storageHomeDecisionFile(agentPath);
		const existing = yield* readStorageHomeDecisionSteps(file);
		if (existing !== undefined) {
			return recordSettledStorageHome(fastKey, cacheKey, yield* applyStorageHomeDecisionSteps(existing, agentPath));
		}
		const aliasParent = dirname(agentPath);
		const targets = yield* configuredRelativeTargetsSteps(agentPath, rawHome, settings);
		const aliasHasHistory =
			!(yield* sameDirectorySteps(aliasParent, matchedDefaultHome)) &&
			(yield* hasParentStoreEntriesSteps(aliasParent, agentPath, targets)) &&
			!(yield* hasParentStoreEntriesSteps(matchedDefaultHome, agentPath, targets));
		if (!aliasHasHistory) {
			const entry =
				settings === undefined || !(yield* io("isDirectory", agentPath))
					? createDefaultStorageHomeEntry(matchedDefaultHome, true)
					: yield* applyStorageHomeDecisionSteps(
							yield* settleStorageDecisionSteps(file, { home: matchedDefaultHome, defaultHome: true }),
							agentPath,
						);
			return recordSettledStorageHome(fastKey, cacheKey, entry);
		}
	}

	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || (yield* isDefaultStorageHomeSteps(parent, defaultHome))) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const decisionFile = storageHomeDecisionFile(agentPath);
	const existingDecision = yield* readStorageHomeDecisionSteps(decisionFile);
	if (existingDecision !== undefined) {
		return recordSettledStorageHome(
			fastKey,
			cacheKey,
			yield* applyStorageHomeDecisionSteps(existingDecision, agentPath),
		);
	}
	const relativeTargets = yield* configuredRelativeTargetsSteps(agentPath, rawHome, settings);
	const parentWorkflows = join(parent, "workflows");
	const existingOwner = yield* parentStorageOwnerSteps(parent);
	let decision: StorageHomeDecision = { home: agentPath };
	if (!(yield* hasOwnStoreEntriesSteps(agentPath, parent, relativeTargets))) {
		if (existingOwner !== undefined) {
			if (yield* sameDirectorySteps(existingOwner, agentPath))
				decision = { home: parent, parentOwner: existingOwner };
		} else if (yield* hasParentStoreEntriesSteps(parent, agentPath, relativeTargets)) {
			const validHostIdOwner = yield* eligibleLegacyHostOwnerSteps(parentWorkflows, rawHome);
			if (
				validHostIdOwner !== undefined ||
				(yield* canClaimParentStoreSteps(parent, agentPath, defaultAgent, rawHome))
			) {
				decision = { home: parent, parentOwner: validHostIdOwner ?? resolve(agentPath) };
			}
		}
	}
	if (settings === undefined || !(yield* io("isDirectory", agentPath))) {
		const provisionalHome =
			decision.parentOwner === undefined || (yield* sameDirectorySteps(decision.parentOwner, agentPath))
				? decision.home
				: agentPath;
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(provisionalHome, undefined, true));
	}
	const winner = yield* settleStorageDecisionSteps(decisionFile, { ...decision, targets: relativeTargets });
	return recordSettledStorageHome(fastKey, cacheKey, yield* applyStorageHomeDecisionSteps(winner, agentPath));
}

export function coLocatesWorkflowStore(agentDir: string, settings?: StorageHomeSettings): boolean {
	return runStorageStepsSync(coLocatesWorkflowStoreSteps(agentDir, settings));
}

export function coLocatesWorkflowStoreAsync(agentDir: string, settings?: StorageHomeSettings): Promise<boolean> {
	return runStorageSteps(coLocatesWorkflowStoreSteps(agentDir, settings));
}

function* coLocatesWorkflowStoreSteps(agentDir: string, settings?: StorageHomeSettings): StorageSteps<boolean> {
	const rawHome = getHomeDir();
	const agentPath = normalizeAgentDirPath(agentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined && !cached.provisionalWithoutSettings) {
		return yield* sameDirectorySteps(cached.home, agentPath);
	}
	if ((yield* defaultHomeForAgentSteps(agentPath, defaultHome)) !== undefined) return false;
	const decision = yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(agentPath));
	if (decision !== undefined) {
		if (decision.defaultHome || decision.parentOwner === undefined) return true;
		const owner = yield* parentStorageOwnerSteps(decision.home);
		return !(yield* sameDirectorySteps(owner ?? decision.parentOwner, agentPath));
	}
	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || (yield* isDefaultStorageHomeSteps(parent, defaultHome))) return true;
	const relativeTargets = yield* configuredRelativeTargetsSteps(agentPath, rawHome, settings);
	if (yield* hasOwnStoreEntriesSteps(agentPath, parent, relativeTargets)) return true;
	const parentWorkflows = join(parent, "workflows");
	const existingOwner = yield* parentStorageOwnerSteps(parent);
	if (existingOwner !== undefined) return !(yield* sameDirectorySteps(existingOwner, agentPath));
	if (!(yield* hasParentStoreEntriesSteps(parent, agentPath, relativeTargets))) return true;
	const hostIdOwner = yield* eligibleLegacyHostOwnerSteps(parentWorkflows, rawHome);
	if (hostIdOwner !== undefined) {
		return !(yield* sameDirectorySteps(hostIdOwner, agentPath));
	}
	return !(yield* canClaimParentStoreSteps(parent, agentPath, defaultAgent, rawHome));
}

const pendingStorageHomes = new Map<string, Promise<SettledStorageHome>>();

function resolveStorageHomeEntryAsync(agentDir?: string, settings?: StorageHomeSettings): Promise<SettledStorageHome> {
	const rawHome = getHomeDir();
	const rawAgentDir = agentDir ?? resolveConfiguredAgentDir(rawHome);
	const key = [
		process.platform,
		rawHome,
		rawAgentDir,
		isAbsolute(rawAgentDir) ? "" : process.cwd(),
		settings === undefined ? "provisional" : "settled",
	].join("\0");
	let pending = pendingStorageHomes.get(key);
	if (pending === undefined) {
		pending = runStorageSteps(resolveStorageHomeEntrySteps(agentDir, settings)).finally(() => {
			pendingStorageHomes.delete(key);
		});
		pendingStorageHomes.set(key, pending);
	}
	return pending;
}

export function storageHomeDir(agentDir?: string, settings?: StorageHomeSettings): string {
	return runStorageStepsSync(resolveStorageHomeEntrySteps(agentDir, settings)).home;
}

export async function storageHomeDirAsync(agentDir?: string, settings?: StorageHomeSettings): Promise<string> {
	return (await resolveStorageHomeEntryAsync(agentDir, settings)).home;
}

function containsPath(directory: string, target: string): boolean {
	const inside = relative(directory, target);
	return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function* targetClaimFilesSteps(agentPath: string, home: string, target: string): StorageSteps<readonly string[]> {
	const containers = [dirname(yield* canonicalPathSteps(agentPath))];
	const decisionHome = yield* canonicalPathSteps(home);
	if (!pathsEqual(containers[0]!, decisionHome)) containers.push(decisionHome);
	const identities = [getPathComparisonKey(yield* canonicalPathSteps(target))];
	try {
		const stats = yield* io("stat", target);
		if (stats.ino !== 0n) identities.push(`file:${stats.dev}:${stats.ino}:${stats.birthtimeNs}`);
	} catch {}
	return containers.flatMap((container) =>
		identities.map((identity) => {
			const key = createHash("sha256").update(identity).digest("hex");
			return join(container, `.atomic-storage-target-${key}`);
		}),
	);
}

function* preferredTargetOwnerSteps(agentPath: string, parent: string, target: string): StorageSteps<string> {
	const physical = yield* canonicalPathSteps(target);
	const defaultHome = join(getHomeDir(), CONFIG_DIR_NAME);
	const parentOwner =
		(yield* parentStorageOwnerSteps(parent)) ??
		((yield* isDefaultStorageHomeSteps(parent, defaultHome)) ? join(parent, "agent") : undefined);
	if (parentOwner !== undefined && !(yield* sameDirectorySteps(parentOwner, agentPath))) {
		if (containsPath(yield* canonicalPathSteps(parentOwner), physical)) return parentOwner;
		const decision = yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(parentOwner));
		const ownerHome = decision?.defaultHome ? parent : (decision?.home ?? parent);
		if (
			containsPath(yield* canonicalPathSteps(join(ownerHome, "workflows")), physical) ||
			pathsEqual(yield* canonicalPathSteps(join(ownerHome, "storage.sqlite")), physical)
		)
			return parentOwner;
		const targets =
			decision?.targets ?? (yield* configuredRelativeTargetsSteps(parentOwner, getHomeDir(), undefined, false));
		for (const entry of targets) {
			if (pathsEqual(yield* canonicalPathSteps(resolve(ownerHome, entry)), physical)) return parentOwner;
		}
	}
	const physicalParent = yield* canonicalPathSteps(parent);
	const segment = relative(physicalParent, physical).split(sep)[0];
	if (segment !== undefined && segment !== "" && segment !== "..") {
		const sibling = join(physicalParent, segment);
		if (!(yield* sameDirectorySteps(sibling, agentPath)) && (yield* agentDirectoryPriorUseTierSteps(sibling)) === 2)
			return sibling;
	}
	return yield* canonicalPathSteps(agentPath);
}

export function storagePathBaseDir(path: string, agentDir: string, settings?: StorageHomeSettings): string {
	return runStorageStepsSync(storagePathBaseDirSteps(path, agentDir, settings));
}

export async function storagePathBaseDirAsync(
	path: string,
	agentDir: string,
	settings?: StorageHomeSettings,
): Promise<string> {
	await resolveStorageHomeEntryAsync(agentDir, settings);
	return runStorageSteps(storagePathBaseDirSteps(path, agentDir, settings));
}

export function* storagePathBaseDirSteps(
	path: string,
	agentDir: string,
	settings?: StorageHomeSettings,
): StorageSteps<string> {
	const entry = yield* resolveStorageHomeEntrySteps(agentDir, settings);
	const targetCacheKey = `${agentDir}\0${path}`;
	const cached = storageTargetDecisions.get(entry)?.get(targetCacheKey);
	if (cached !== undefined) return yield* applyStorageTargetDecisionSteps(cached, settings);
	const home = entry.home;
	const target = normalizeRelativeTarget(path, getHomeDir());
	if (target === undefined) return home;
	const agentPath = normalizeAgentDirPath(agentDir);
	const ownTarget = resolve(agentPath, target);
	const rejected = entry.rejectedParentAdoption;
	if (rejected !== undefined) {
		let rejectedTarget = false;
		for (const legacy of rejected.legacyTargets) {
			if (
				pathsEqual(resolve(agentPath, legacy), ownTarget) &&
				(yield* io("exists", resolve(dirname(yield* canonicalPathSteps(agentPath)), target)))
			) {
				rejectedTarget = true;
				break;
			}
		}
		if (
			!rejectedTarget &&
			!pathsEqual(ownTarget, agentPath) &&
			containsPath(yield* canonicalPathSteps(agentPath), yield* canonicalPathSteps(ownTarget)) &&
			(yield* io("exists", ownTarget))
		)
			return yield* applyStorageTargetDecisionSteps({
				agentPath,
				target,
				decision: { home: agentPath, parentOwner: agentPath },
			});
	}
	const parent = dirname(agentPath);
	const claimDir = (yield* sameDirectorySteps(home, agentPath))
		? dirname(yield* canonicalPathSteps(agentPath))
		: yield* canonicalPathSteps(home);
	const decisionFile = yield* storageTargetDecisionFileSteps(agentPath, target);
	let decision = yield* readStorageHomeDecisionSteps(decisionFile);
	if (decision === undefined) {
		const parentCandidates = (yield* sameDirectorySteps(home, agentPath)) ? [claimDir, parent] : [home, parent];
		let base = home;
		for (const candidate of parentCandidates) {
			if (yield* io("exists", resolve(candidate, target))) {
				base = candidate;
				break;
			}
		}
		const selected = resolve(base, target);
		if (containsPath(yield* canonicalPathSteps(agentPath), yield* canonicalPathSteps(selected))) {
			decision = { home: base };
		} else {
			const reservedOwner = yield* preferredTargetOwnerSteps(agentPath, claimDir, selected);
			const parentOwner =
				(yield* sameDirectorySteps(base, claimDir)) || !(yield* sameDirectorySteps(reservedOwner, agentPath))
					? reservedOwner
					: yield* preferredTargetOwnerSteps(agentPath, base, selected);
			decision = { home: base, parentOwner };
		}
		if (entry.defaultHome && (yield* sameDirectorySteps(base, home))) decision = { ...decision, defaultHome: true };
		if (settings !== undefined && (yield* io("isDirectory", agentPath))) {
			decision = yield* settleStorageDecisionSteps(decisionFile, decision);
		}
	}
	if (entry.defaultHome) {
		const recorded = decision.defaultHome
			? undefined
			: yield* readStorageHomeDecisionSteps(storageHomeDecisionFile(agentPath));
		if (decision.defaultHome || (recorded?.defaultHome && pathsEqual(decision.home, recorded.home))) {
			const selected = resolve(home, target);
			decision = containsPath(yield* canonicalPathSteps(agentPath), yield* canonicalPathSteps(selected))
				? { home, defaultHome: true }
				: {
						home,
						defaultHome: true,
						parentOwner: yield* preferredTargetOwnerSteps(agentPath, claimDir, selected),
					};
		}
	}
	const resolved = { agentPath, target, decision };
	if (!entry.provisionalWithoutSettings && settings !== undefined && (yield* io("isDirectory", agentPath))) {
		let targets = storageTargetDecisions.get(entry);
		if (targets === undefined) {
			targets = new Map();
			storageTargetDecisions.set(entry, targets);
		}
		targets.set(targetCacheKey, resolved);
	}
	return yield* applyStorageTargetDecisionSteps(resolved, settings);
}

function* defaultTargetVersionSteps({
	agentPath,
	target,
	decision,
}: StorageTargetDecision): StorageSteps<string | undefined> {
	if (!decision.defaultHome) return undefined;
	const selected = resolve(decision.home, target);
	if (!pathsEqual(dirname(selected), decision.home)) return undefined;
	try {
		const home = yield* io("stat", decision.home);
		const agent = yield* io("stat", agentPath);
		if (home.ino === 0n || agent.ino === 0n) return undefined;
		const file = yield* io("lstat", selected);
		if (file !== undefined && (file.symbolicLink || file.ino === 0n)) return undefined;
		const homeVersion = `${home.dev}:${home.ino}:${home.birthtimeNs}:${agent.dev}:${agent.ino}:${agent.birthtimeNs}`;
		return file === undefined
			? `${homeVersion}:missing`
			: `${homeVersion}:${file.dev}:${file.ino}:${file.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

function* applyStorageTargetDecisionSteps(
	targetDecision: StorageTargetDecision,
	settings?: StorageHomeSettings,
): StorageSteps<string> {
	const { agentPath, target, decision } = targetDecision;
	if (decision.parentOwner === undefined) return decision.home;
	const version = yield* defaultTargetVersionSteps(targetDecision);
	const cached = defaultTargetClaims.get(targetDecision);
	const selected = resolve(decision.home, target);
	const claims =
		version !== undefined && cached?.version === version
			? cached.claims
			: yield* targetClaimFilesSteps(agentPath, decision.home, selected);
	for (const claim of claims) {
		let owner = yield* readStorageOwnerSteps(claim);
		if (owner === undefined && settings !== undefined && (yield* io("isDirectory", agentPath))) {
			yield* io("mkdir", dirname(claim));
			yield* claimFileAtomicallySteps(
				claim,
				`${JSON.stringify(yield* storageOwnerSteps(decision.parentOwner, dirname(claim)))}\n`,
			);
			owner = yield* readStorageOwnerSteps(claim);
		}
		if (owner === undefined && (settings === undefined || !(yield* io("isDirectory", agentPath)))) {
			owner = yield* storageOwnerSteps(decision.parentOwner);
		}
		if (owner === undefined) throw new Error(`Cannot claim storage target at ${claim}`);
		const ownerPath = yield* currentStorageOwnerPathSteps(owner, dirname(claim), target);
		if (ownerPath !== undefined && (yield* sameDirectorySteps(ownerPath, agentPath))) continue;
		const fallback = resolve(agentPath, target);
		if (
			!containsPath(yield* canonicalPathSteps(agentPath), yield* canonicalPathSteps(fallback)) ||
			pathsEqual(yield* canonicalPathSteps(fallback), yield* canonicalPathSteps(selected)) ||
			(yield* isSameFileSteps(fallback, selected))
		) {
			throw new Error(`Relative storage target ${target} is owned by another agent directory`);
		}
		const marker = yield* localTargetMarkerFileSteps(agentPath, target);
		if (settings !== undefined && (yield* io("isDirectory", agentPath)) && !(yield* io("exists", marker))) {
			yield* claimFileAtomicallySteps(marker, `${JSON.stringify({ target })}\n`);
		}
		return agentPath;
	}
	if (version !== undefined && (yield* defaultTargetVersionSteps(targetDecision)) === version) {
		defaultTargetClaims.set(targetDecision, { version, claims });
	}
	return decision.home;
}

export function workflowsStorageDir(agentDir?: string, settings?: StorageHomeSettings): string {
	return runStorageStepsSync(resolveStorageHomeEntrySteps(agentDir, settings)).workflowsDir;
}

export async function workflowsStorageDirAsync(agentDir?: string, settings?: StorageHomeSettings): Promise<string> {
	return (await resolveStorageHomeEntryAsync(agentDir, settings)).workflowsDir;
}

export function defaultSessionDatabasePath(agentDir?: string, settings?: StorageHomeSettings): string {
	return runStorageStepsSync(resolveStorageHomeEntrySteps(agentDir, settings)).sessionDatabasePath;
}

export async function defaultSessionDatabasePathAsync(
	agentDir?: string,
	settings?: StorageHomeSettings,
): Promise<string> {
	return (await resolveStorageHomeEntryAsync(agentDir, settings)).sessionDatabasePath;
}

export function* defaultSessionDatabasePathSteps(
	agentDir?: string,
	settings?: StorageHomeSettings,
): StorageSteps<string> {
	return (yield* resolveStorageHomeEntrySteps(agentDir, settings)).sessionDatabasePath;
}

export function defaultSharedStoragePath(agentDir?: string, settings?: StorageHomeSettings): string {
	return runStorageStepsSync(resolveStorageHomeEntrySteps(agentDir, settings)).sharedStoragePath;
}

export async function defaultSharedStoragePathAsync(
	agentDir?: string,
	settings?: StorageHomeSettings,
): Promise<string> {
	return (await resolveStorageHomeEntryAsync(agentDir, settings)).sharedStoragePath;
}

export function* defaultSharedStoragePathSteps(
	agentDir?: string,
	settings?: StorageHomeSettings,
): StorageSteps<string> {
	return (yield* resolveStorageHomeEntrySteps(agentDir, settings)).sharedStoragePath;
}

export function takeStorageAdoptionNotice(agentDir?: string, settings?: StorageHomeSettings): string | undefined {
	return runStorageStepsSync(takeStorageAdoptionNoticeSteps(agentDir, settings));
}

export function takeStorageAdoptionNoticeAsync(
	agentDir?: string,
	settings?: StorageHomeSettings,
): Promise<string | undefined> {
	return runStorageSteps(takeStorageAdoptionNoticeSteps(agentDir, settings));
}

function* takeStorageAdoptionNoticeSteps(
	agentDir?: string,
	settings?: StorageHomeSettings,
): StorageSteps<string | undefined> {
	const rawHome = getHomeDir();
	const targetAgentDir = normalizeAgentDirPath(agentDir ?? resolveConfiguredAgentDir(rawHome));
	const entry = yield* resolveStorageHomeEntrySteps(targetAgentDir, settings);
	if (entry.adoptedClaim === undefined) return undefined;
	const noticeFile = `${entry.adoptedClaim}${ADOPTION_NOTICE_SUFFIX}`;
	if (
		(yield* io("exists", noticeFile)) ||
		(yield* io("exists", join(entry.workflowsDir, `${ADOPTION_CLAIM_FILE}${ADOPTION_NOTICE_SUFFIX}`)))
	)
		return undefined;
	if (!(yield* claimFileAtomicallySteps(noticeFile, `${resolve(targetAgentDir)}\n`))) return undefined;
	return `Adopted existing storage at ${entry.workflowsDir} for agent directory ${resolve(targetAgentDir)}. Sibling agent directories use their own <agentDir>/workflows store.`;
}

export function resetStorageHomeCacheForTests(): void {
	fastStorageHomes.clear();
	settledStorageHomes.clear();
	storageTargetDecisions = new WeakMap();
	defaultTargetClaims = new WeakMap();
	priorUseSnapshots.clear();
	lastStorageHome = undefined;
}
