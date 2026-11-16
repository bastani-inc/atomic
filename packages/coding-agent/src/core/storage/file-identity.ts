import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR_NAME = ".atomic";
const ENV_AGENT_DIR = "ATOMIC_CODING_AGENT_DIR";
const LEGACY_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const WORKFLOW_STORE_ENTRIES = ["journal.sqlite", "journal", "pool", "runs"] as const;
const HOME_STORE_ENTRIES = ["storage.sqlite", "repos", "worktrees"] as const;
const ADOPTION_CLAIM_FILE = ".adopted-by";
const ADOPTION_NOTICE_SUFFIX = ".notified";
const CLI_SELECTION = Symbol.for("@bastani/atomic/storage/cli-selection");
const STORAGE_ENV_NAMES = ["ATOMIC_STORAGE", "ATOMIC_SESSIONS_STORAGE", "ATOMIC_WORKFLOWS_JOURNAL"] as const;

interface SettledStorageHome {
	readonly home: string;
	readonly workflowsDir: string;
	readonly sessionDatabasePath: string;
	readonly sharedStoragePath: string;
	readonly adoptedClaim?: string;
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

function createStorageHomeEntry(home: string, adoptedClaim?: string): SettledStorageHome {
	const workflowsDir = join(home, "workflows");
	return {
		home,
		workflowsDir,
		sessionDatabasePath: join(workflowsDir, "journal.sqlite"),
		sharedStoragePath: join(home, "storage.sqlite"),
		...(adoptedClaim === undefined ? {} : { adoptedClaim }),
	};
}

function readClaimFile(file: string): string | undefined {
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
	return normalized.length > root.length && (normalized.endsWith("/") || normalized.endsWith("\\"))
		? normalized.slice(0, -1)
		: normalized;
}

function sameDirectory(first: string, second: string): boolean {
	return pathsEqual(first, second) || isSameFile(first, second);
}

function normalizeRelativeTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (
		trimmed === "" ||
		trimmed === ":memory:" ||
		trimmed === "~" ||
		trimmed.startsWith("~/") ||
		trimmed.startsWith("~\\") ||
		trimmed.startsWith("file://") ||
		isAbsolute(trimmed)
	) {
		return undefined;
	}
	return value;
}

function pushSelectionTargets(targets: Set<string>, selection: unknown): void {
	if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return;
	const record = selection as { readonly path?: unknown; readonly dir?: unknown };
	const pathTarget = normalizeRelativeTarget(record.path);
	if (pathTarget !== undefined) targets.add(pathTarget);
	const dirTarget = normalizeRelativeTarget(record.dir);
	if (dirTarget !== undefined) targets.add(dirTarget);
}

function configuredRelativeTargets(agentPath: string): readonly string[] {
	const targets = new Set<string>();
	const cli = (globalThis as Record<symbol, { readonly value?: unknown } | undefined>)[CLI_SELECTION];
	if (cli !== undefined) pushSelectionTargets(targets, cli.value);
	for (const envName of STORAGE_ENV_NAMES) {
		const raw = process.env[envName];
		if (raw === undefined || raw === "") continue;
		try {
			pushSelectionTargets(targets, JSON.parse(raw));
		} catch {}
	}
	const settingsPath = join(agentPath, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const raw = readFileSync(settingsPath, "utf8");
			const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as {
				readonly storage?: unknown;
				readonly sessions?: { readonly storage?: unknown } | null;
				readonly workflows?: { readonly journal?: unknown } | unknown[] | null;
			} | null;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				pushSelectionTargets(targets, parsed.storage);
				if (parsed.sessions !== null && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)) {
					pushSelectionTargets(targets, parsed.sessions.storage);
				}
				if (parsed.workflows !== null && typeof parsed.workflows === "object" && !Array.isArray(parsed.workflows)) {
					pushSelectionTargets(targets, parsed.workflows.journal);
				}
			}
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

function hasWorkflowStoreEntries(workflowsDir: string): boolean {
	for (const entry of WORKFLOW_STORE_ENTRIES) {
		if (existsSync(join(workflowsDir, entry))) return true;
	}
	return false;
}

function hasOwnStoreEntries(agentPath: string, relativeTargets: readonly string[]): boolean {
	const workflowsDir = join(agentPath, "workflows");
	if (isDirectory(workflowsDir) && hasWorkflowStoreEntries(workflowsDir)) return true;
	for (const entry of HOME_STORE_ENTRIES) {
		if (existsSync(join(agentPath, entry))) return true;
	}
	for (const target of relativeTargets) {
		const candidate = resolve(agentPath, target);
		if (!pathsEqual(candidate, agentPath) && existsSync(candidate)) return true;
	}
	return false;
}

function hasParentStoreEntries(
	parent: string,
	agentPath: string,
	parentWorkflows: string,
	parentWorkflowsIsDir: boolean,
	relativeTargets: readonly string[],
): boolean {
	if (parentWorkflowsIsDir && !pathsEqual(parentWorkflows, agentPath) && hasWorkflowStoreEntries(parentWorkflows)) {
		return true;
	}
	for (const entry of HOME_STORE_ENTRIES) {
		const candidate = join(parent, entry);
		if (!pathsEqual(candidate, agentPath) && existsSync(candidate)) return true;
	}
	for (const target of relativeTargets) {
		const candidate = resolve(parent, target);
		if (!pathsEqual(candidate, agentPath) && !pathsEqual(candidate, parent) && existsSync(candidate)) return true;
	}
	return false;
}

function recordSettledStorageHome(fastKey: string, cacheKey: string, settled: SettledStorageHome): SettledStorageHome {
	settledStorageHomes.set(cacheKey, settled);
	fastStorageHomes.set(fastKey, settled);
	return settled;
}

function resolveStorageHomeEntry(agentDir?: string): SettledStorageHome {
	const rawHome = getHomeDir();
	const rawAgentDir = agentDir ?? resolveConfiguredAgentDir(rawHome);
	const agentPath = normalizeAgentDirPath(rawAgentDir);
	const fastKey = `${process.platform}\0${rawHome}\0${agentPath}`;
	const fastHit = fastStorageHomes.get(fastKey);
	if (fastHit !== undefined) return fastHit;

	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined) {
		fastStorageHomes.set(fastKey, cached);
		return cached;
	}

	if (sameDirectory(agentPath, defaultAgent)) {
		const home = pathsEqual(agentPath, defaultAgent) ? dirname(agentPath) : defaultHome;
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(home));
	}

	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || sameDirectory(parent, defaultHome)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const relativeTargets = configuredRelativeTargets(agentPath);
	if (hasOwnStoreEntries(agentPath, relativeTargets)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const parentWorkflows = join(parent, "workflows");
	const parentWorkflowsIsDir = isDirectory(parentWorkflows);
	const claim = join(parentWorkflows, ADOPTION_CLAIM_FILE);
	if (parentWorkflowsIsDir) {
		const existingOwner = readClaimFile(claim);
		if (existingOwner !== undefined) {
			return recordSettledStorageHome(
				fastKey,
				cacheKey,
				pathsEqual(existingOwner, agentPath)
					? createStorageHomeEntry(parent, claim)
					: createStorageHomeEntry(agentPath),
			);
		}
	}

	if (!hasParentStoreEntries(parent, agentPath, parentWorkflows, parentWorkflowsIsDir, relativeTargets)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const hostIdOwner = parentWorkflowsIsDir
		? readClaimFile(join(parentWorkflows, "pool", "host-id.adopted-by"))
		: undefined;
	const preferredOwner =
		hostIdOwner !== undefined && !hasOwnStoreEntries(hostIdOwner, configuredRelativeTargets(hostIdOwner))
			? hostIdOwner
			: resolve(agentPath);

	if (!parentWorkflowsIsDir) mkdirSync(parentWorkflows, { recursive: true });
	claimFileAtomically(claim, `${preferredOwner}\n`);
	const winner = readClaimFile(claim);
	if (winner !== undefined && pathsEqual(winner, agentPath)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(parent, claim));
	}
	return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
}

export function storageHomeDir(agentDir?: string): string {
	return resolveStorageHomeEntry(agentDir).home;
}

export function workflowsStorageDir(agentDir?: string): string {
	return resolveStorageHomeEntry(agentDir).workflowsDir;
}

export function defaultSessionDatabasePath(agentDir?: string): string {
	return resolveStorageHomeEntry(agentDir).sessionDatabasePath;
}

export function defaultSharedStoragePath(agentDir?: string): string {
	return resolveStorageHomeEntry(agentDir).sharedStoragePath;
}

export function takeStorageAdoptionNotice(agentDir?: string): string | undefined {
	const rawHome = getHomeDir();
	const targetAgentDir = normalizeAgentDirPath(agentDir ?? resolveConfiguredAgentDir(rawHome));
	const entry = resolveStorageHomeEntry(targetAgentDir);
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
