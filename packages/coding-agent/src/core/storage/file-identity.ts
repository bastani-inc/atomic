import { randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	opendirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR_NAME = ".atomic";
const ENV_AGENT_DIR = "ATOMIC_CODING_AGENT_DIR";
const LEGACY_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ATOMIC_STORE_FILES = [
	join("workflows", "journal.sqlite"),
	join("workflows", "journal", "catalog.sqlite"),
	join("workflows", "pool", "host-id"),
] as const;
const ADOPTION_CLAIM_FILE = ".adopted-by";
const ADOPTION_NOTICE_SUFFIX = ".notified";
const CLI_SELECTION = Symbol.for("@bastani/atomic/storage/cli-selection");
const STORAGE_ENV_NAMES = ["ATOMIC_STORAGE", "ATOMIC_SESSIONS_STORAGE", "ATOMIC_WORKFLOWS_JOURNAL"] as const;
const AGENT_DIR_STATE_ENTRIES: ReadonlySet<string> = new Set([
	"settings.json",
	"auth.json",
	"models.json",
	"trust.json",
	"oauth.json",
	"keybindings.json",
	"pool-host-id",
	"atomic-debug.log",
	"pi-debug.log",
	"sessions",
	"intercom",
	"worktree-snapshots",
	"released-history",
	"compaction-diagnostics",
	"workflow-logs",
	"blueprint-actions",
]);

export interface StorageHomeSettings {
	readonly storage?: unknown;
	readonly sessions?: { readonly storage?: unknown } | null;
	readonly workflows?: { readonly journal?: unknown } | unknown[] | null;
}

interface SettledStorageHome {
	readonly home: string;
	readonly workflowsDir: string;
	readonly journalStoreDir: string;
	readonly sessionDatabasePath: string;
	readonly sharedStoragePath: string;
	readonly adoptedClaim?: string;
	readonly provisionalWithoutSettings?: boolean;
}

const fastStorageHomes = new Map<string, SettledStorageHome>();
const settledStorageHomes = new Map<string, SettledStorageHome>();

/**
 * What a file is, whatever path names it: its device and inode (a hard link shares both, a symlink resolves to them),
 * or its real path on a file system that reports no inode. Undefined when the file does not exist.
 */
export function fileIdentity(path: string): string | undefined {
	try {
		const { dev, ino } = statSync(path, { bigint: true });
		if (ino !== 0n) return `${dev}:${ino}`;
		const real = realpathSync.native(path);
		return `path:${process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real}`;
	} catch {
		return undefined;
	}
}

/** Whether two paths name the same existing file. */
export function isSameFile(left: string, right: string): boolean {
	const identity = fileIdentity(left);
	return identity !== undefined && identity === fileIdentity(right);
}

function getHomeDir(): string {
	if (process.platform === "win32") {
		if (process.env.USERPROFILE) return process.env.USERPROFILE;
		if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
		if (process.env.HOME) return process.env.HOME;
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

function resolveConfiguredAgentDir(home: string): string {
	const envDir =
		process.env[ENV_AGENT_DIR] !== undefined ? process.env[ENV_AGENT_DIR] : process.env[LEGACY_ENV_AGENT_DIR];
	if (envDir) return expandAgentPathInput(envDir, home);
	return join(home, CONFIG_DIR_NAME, "agent");
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
		journalStoreDir: join(workflowsDir, "journal"),
		sessionDatabasePath: join(workflowsDir, "journal.sqlite"),
		sharedStoragePath: join(home, "storage.sqlite"),
		...(adoptedClaim === undefined ? {} : { adoptedClaim }),
		...(provisionalWithoutSettings ? { provisionalWithoutSettings: true } : {}),
	};
}

export function readClaimFile(file: string): string | undefined {
	try {
		const raw = readFileSync(file, "utf8");
		const line = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
		return line.length > 0 ? line : undefined;
	} catch {
		return undefined;
	}
}

function claimFileAtomically(file: string, contents: string): boolean {
	const staged = `${file}.${randomUUID()}`;
	try {
		writeFileSync(staged, contents, { flag: "wx" });
		linkSync(staged, file);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(staged, { force: true });
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
	return pathsEqual(first, second) || isSameFile(first, second);
}

function normalizeRelativeTarget(value: unknown, home: string): string | undefined {
	if (typeof value !== "string" || value === "" || value === ":memory:") return undefined;
	try {
		const expanded = expandAgentPathInput(value, home);
		return isAbsolute(expanded) ? undefined : expanded;
	} catch {
		return undefined;
	}
}

function selectsDefaultSharedStorage(selection: unknown): boolean {
	if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return false;
	const record = selection as {
		readonly path?: unknown;
		readonly dir?: unknown;
		readonly memory?: unknown;
		readonly adapter?: unknown;
		readonly database?: unknown;
	};
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

function pushSelectionTargets(targets: Set<string>, selection: unknown, home: string, isShared = false): void {
	if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return;
	if (isShared && selectsDefaultSharedStorage(selection)) {
		targets.add("storage.sqlite");
		return;
	}
	const record = selection as { readonly path?: unknown; readonly dir?: unknown };
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

function configuredRelativeTargets(agentPath: string, home: string, settings?: StorageHomeSettings): readonly string[] {
	const targets = new Set<string>();
	const cli = (globalThis as Record<symbol, { readonly value?: unknown } | undefined>)[CLI_SELECTION];
	if (cli !== undefined) pushSelectionTargets(targets, cli.value, home, true);
	for (const envName of STORAGE_ENV_NAMES) {
		const raw = process.env[envName];
		if (raw === undefined || raw === "") continue;
		try {
			pushSelectionTargets(targets, JSON.parse(raw), home, envName === "ATOMIC_STORAGE");
		} catch {}
	}
	if (settings !== undefined) {
		pushSettingsTargets(targets, settings, home);
		return [...targets];
	}
	const settingsPath = join(agentPath, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const raw = readFileSync(settingsPath, "utf8");
			const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as StorageHomeSettings | null;
			pushSettingsTargets(targets, parsed, home);
		} catch {}
	}
	return [...targets];
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function hasRelativeTargetEntries(
	baseDir: string,
	agentPath: string,
	relativeTargets: readonly string[],
	forbidSelfBase = false,
): boolean {
	for (const target of relativeTargets) {
		const candidate = resolve(baseDir, target);
		if (pathsEqual(candidate, agentPath)) continue;
		if (forbidSelfBase && pathsEqual(candidate, baseDir)) continue;
		if (existsSync(candidate)) return true;
	}
	return false;
}

function hasOwnStoreEntries(agentPath: string, relativeTargets: readonly string[]): boolean {
	for (const entry of ATOMIC_STORE_FILES) {
		if (existsSync(join(agentPath, entry))) return true;
	}
	return hasRelativeTargetEntries(agentPath, agentPath, relativeTargets);
}

function hasParentStoreEntries(
	parent: string,
	agentPath: string,
	parentWorkflows: string,
	relativeTargets: readonly string[],
): boolean {
	if (!pathsEqual(parentWorkflows, agentPath)) {
		for (const entry of ATOMIC_STORE_FILES) {
			if (existsSync(join(parent, entry))) return true;
		}
	}
	return hasRelativeTargetEntries(parent, agentPath, relativeTargets, true);
}

function agentDirectoryPriorUseTier(dirPath: string): 0 | 1 | 2 {
	if (!isDirectory(dirPath)) return 0;
	let dir: ReturnType<typeof opendirSync> | undefined;
	try {
		dir = opendirSync(dirPath);
		for (let count = 0; count < 256; count++) {
			const entry = dir.readSync();
			if (entry === null) break;
			if (AGENT_DIR_STATE_ENTRIES.has(entry.name) || entry.name.startsWith("storage-token.")) {
				return 2;
			}
		}
	} catch {
	} finally {
		try {
			dir?.closeSync();
		} catch {}
	}
	return 1;
}

function canClaimParentStore(parent: string, agentPath: string, defaultAgent: string, rawHome: string): boolean {
	const selfTier = agentDirectoryPriorUseTier(agentPath);
	if (selfTier === 2) return true;
	const parentIsDefaultAgent = sameDirectory(parent, defaultAgent);
	let dir: ReturnType<typeof opendirSync> | undefined;
	try {
		dir = opendirSync(parent);
		for (let count = 0; count < 1024; count++) {
			const entry = dir.readSync();
			if (entry === null) break;
			const name = entry.name;
			if (
				name.startsWith(".") ||
				name === "workflows" ||
				name === "repos" ||
				name === "worktrees" ||
				(parentIsDefaultAgent && AGENT_DIR_STATE_ENTRIES.has(name))
			) {
				continue;
			}
			const siblingPath = join(parent, name);
			if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(siblingPath)))) continue;
			if (sameDirectory(siblingPath, agentPath)) continue;
			const siblingTier = agentDirectoryPriorUseTier(siblingPath);
			if (
				siblingTier > selfTier &&
				!hasOwnStoreEntries(siblingPath, configuredRelativeTargets(siblingPath, rawHome))
			) {
				return false;
			}
		}
	} catch {
	} finally {
		try {
			dir?.closeSync();
		} catch {}
	}
	return true;
}

function recordSettledStorageHome(fastKey: string, cacheKey: string, settled: SettledStorageHome): SettledStorageHome {
	settledStorageHomes.set(cacheKey, settled);
	fastStorageHomes.set(fastKey, settled);
	return settled;
}

function resolveStorageHomeEntry(agentDir?: string, settings?: StorageHomeSettings): SettledStorageHome {
	const rawHome = getHomeDir();
	const rawAgentDir = agentDir ?? resolveConfiguredAgentDir(rawHome);
	const fastKey = isAbsolute(rawAgentDir)
		? `${process.platform}\0${rawHome}\0${rawAgentDir}`
		: `${process.platform}\0${rawHome}\0${process.cwd()}\0${rawAgentDir}`;
	const fastHit = fastStorageHomes.get(fastKey);
	if (fastHit !== undefined && (!fastHit.provisionalWithoutSettings || settings === undefined)) return fastHit;

	const agentPath = normalizeAgentDirPath(rawAgentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined) {
		if (!cached.provisionalWithoutSettings || settings === undefined) {
			fastStorageHomes.set(fastKey, cached);
			return cached;
		}
		const settingsTargets = new Set<string>();
		pushSettingsTargets(settingsTargets, settings, rawHome);
		if (settingsTargets.size === 0) {
			const finalized = createStorageHomeEntry(cached.home, cached.adoptedClaim, false);
			return recordSettledStorageHome(fastKey, cacheKey, finalized);
		}
		const targetList = [...settingsTargets];
		const parent = dirname(agentPath);
		if (
			hasRelativeTargetEntries(agentPath, agentPath, targetList) ||
			!hasRelativeTargetEntries(parent, agentPath, targetList, true)
		) {
			const finalized = createStorageHomeEntry(cached.home, cached.adoptedClaim, false);
			return recordSettledStorageHome(fastKey, cacheKey, finalized);
		}
	}

	if (sameDirectory(agentPath, defaultAgent)) {
		const home = pathsEqual(agentPath, defaultAgent) ? dirname(agentPath) : defaultHome;
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(home));
	}

	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || sameDirectory(parent, defaultHome)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const relativeTargets = configuredRelativeTargets(agentPath, rawHome, settings);
	if (hasOwnStoreEntries(agentPath, relativeTargets)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const parentWorkflows = join(parent, "workflows");
	const parentWorkflowsIsDir = isDirectory(parentWorkflows);
	const claim = join(parentWorkflows, ADOPTION_CLAIM_FILE);
	if (parentWorkflowsIsDir && !pathsEqual(parentWorkflows, agentPath)) {
		const existingOwner = readClaimFile(claim);
		if (existingOwner !== undefined) {
			return recordSettledStorageHome(
				fastKey,
				cacheKey,
				sameDirectory(existingOwner, agentPath)
					? createStorageHomeEntry(parent, claim)
					: createStorageHomeEntry(agentPath),
			);
		}
	}

	if (!hasParentStoreEntries(parent, agentPath, parentWorkflows, relativeTargets)) {
		return recordSettledStorageHome(
			fastKey,
			cacheKey,
			createStorageHomeEntry(agentPath, undefined, settings === undefined),
		);
	}

	const hostIdOwner = parentWorkflowsIsDir
		? readClaimFile(join(parentWorkflows, "pool", "host-id.adopted-by"))
		: undefined;
	const validHostIdOwner =
		hostIdOwner !== undefined && !hasOwnStoreEntries(hostIdOwner, configuredRelativeTargets(hostIdOwner, rawHome))
			? hostIdOwner
			: undefined;
	if (validHostIdOwner === undefined && !canClaimParentStore(parent, agentPath, defaultAgent, rawHome)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}
	const preferredOwner = validHostIdOwner ?? resolve(agentPath);

	if (!parentWorkflowsIsDir) mkdirSync(parentWorkflows, { recursive: true });
	claimFileAtomically(claim, `${preferredOwner}\n`);
	const winner = readClaimFile(claim);
	if (winner !== undefined && sameDirectory(winner, agentPath)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(parent, claim));
	}
	return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
}

export function coLocatesWorkflowStore(agentDir: string, settings?: StorageHomeSettings): boolean {
	const rawHome = getHomeDir();
	const agentPath = normalizeAgentDirPath(agentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined && !cached.provisionalWithoutSettings) {
		return pathsEqual(cached.home, agentPath);
	}
	if (sameDirectory(agentPath, defaultAgent)) return false;
	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || sameDirectory(parent, defaultHome)) return true;
	const relativeTargets = configuredRelativeTargets(agentPath, rawHome, settings);
	if (hasOwnStoreEntries(agentPath, relativeTargets)) return true;
	const parentWorkflows = join(parent, "workflows");
	const parentWorkflowsIsDir = isDirectory(parentWorkflows);
	if (parentWorkflowsIsDir && !pathsEqual(parentWorkflows, agentPath)) {
		const existingOwner = readClaimFile(join(parentWorkflows, ADOPTION_CLAIM_FILE));
		if (existingOwner !== undefined) return !sameDirectory(existingOwner, agentPath);
	}
	if (!hasParentStoreEntries(parent, agentPath, parentWorkflows, relativeTargets)) return true;
	const hostIdOwner = parentWorkflowsIsDir
		? readClaimFile(join(parentWorkflows, "pool", "host-id.adopted-by"))
		: undefined;
	if (hostIdOwner !== undefined && !hasOwnStoreEntries(hostIdOwner, configuredRelativeTargets(hostIdOwner, rawHome))) {
		return !sameDirectory(hostIdOwner, agentPath);
	}
	return !canClaimParentStore(parent, agentPath, defaultAgent, rawHome);
}

export function storageHomeDir(agentDir?: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).home;
}

export function workflowsStorageDir(agentDir?: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).workflowsDir;
}

export function defaultJournalStoreDirectory(agentDir: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).journalStoreDir;
}

export function defaultSessionDatabasePath(agentDir?: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).sessionDatabasePath;
}

export function defaultSharedStoragePath(agentDir?: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).sharedStoragePath;
}

export function takeStorageAdoptionNotice(agentDir?: string, settings?: StorageHomeSettings): string | undefined {
	const rawHome = getHomeDir();
	const targetAgentDir = normalizeAgentDirPath(agentDir ?? resolveConfiguredAgentDir(rawHome));
	const entry = resolveStorageHomeEntry(targetAgentDir, settings);
	if (entry.adoptedClaim === undefined) return undefined;
	const noticeFile = `${entry.adoptedClaim}${ADOPTION_NOTICE_SUFFIX}`;
	if (existsSync(noticeFile)) return undefined;
	if (!claimFileAtomically(noticeFile, `${resolve(targetAgentDir)}\n`)) return undefined;
	return `Adopted existing storage at ${entry.workflowsDir} for agent directory ${resolve(targetAgentDir)}. Sibling agent directories use their own <agentDir>/workflows store.`;
}

export function resetStorageHomeCacheForTests(): void {
	fastStorageHomes.clear();
	settledStorageHomes.clear();
}
