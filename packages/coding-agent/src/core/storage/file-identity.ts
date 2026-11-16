import { createHash, randomUUID } from "node:crypto";
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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, win32 } from "node:path";
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
const PARENT_CLAIM_FILE = ".atomic-storage-parent-owner";
const HOME_DECISION_FILE = ".atomic-storage-home";
let renameClaimWithoutReplacing: ((from: string, to: string) => boolean) | null | undefined;
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
let lastStorageHome:
	| {
			readonly platform: NodeJS.Platform;
			readonly rawHome: string;
			readonly rawAgentDir: string;
			readonly cwd: string | undefined;
			readonly entry: SettledStorageHome;
	  }
	| undefined;

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

function getHomeDir(platform = process.platform): string {
	if (platform === "win32") {
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
		let raw = readFileSync(file, "utf8");
		for (let attempt = 0; raw.length === 0 && attempt < 100; attempt++) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			raw = readFileSync(file, "utf8");
		}
		const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
		return line.length > 0 ? line : undefined;
	} catch {
		return undefined;
	}
}

export function claimFileAtomically(file: string, contents: string): boolean {
	const staged = `${file}.${randomUUID()}`;
	try {
		writeFileSync(staged, contents, { flag: "wx" });
		try {
			linkSync(staged, file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		}
		if (renameClaimWithoutReplacing === undefined) {
			renameClaimWithoutReplacing = null;
			for (const anchor of [import.meta.url, process.execPath]) {
				try {
					const binding = createRequire(anchor)("@bastani/atomic-natives") as {
						renameNoReplace?: (from: string, to: string) => boolean;
					};
					if (typeof binding.renameNoReplace === "function") {
						renameClaimWithoutReplacing = binding.renameNoReplace;
						break;
					}
				} catch {}
			}
		}
		if (renameClaimWithoutReplacing !== null) return renameClaimWithoutReplacing(staged, file);
		writeFileSync(file, contents, { flag: "wx" });
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

function configuredRelativeTargets(
	agentPath: string,
	home: string,
	settings?: StorageHomeSettings,
	includeProcessSelections = true,
): readonly string[] {
	const targets = new Set<string>();
	const cli = includeProcessSelections
		? (globalThis as Record<symbol, { readonly value?: unknown } | undefined>)[CLI_SELECTION]
		: undefined;
	const environment: Partial<Record<(typeof STORAGE_ENV_NAMES)[number], object>> = {};
	for (const envName of includeProcessSelections ? STORAGE_ENV_NAMES : []) {
		const raw = process.env[envName];
		if (raw === undefined || raw === "") continue;
		try {
			environment[envName] = JSON.parse(raw) as object;
		} catch {}
	}
	let fileSettings: StorageHomeSettings | undefined;
	const settingsPath = join(agentPath, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const raw = readFileSync(settingsPath, "utf8");
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

function hasOwnTargetEntries(agentPath: string, parent: string, relativeTargets: readonly string[]): boolean {
	for (const target of relativeTargets) {
		const own = resolve(agentPath, target);
		if (pathsEqual(own, agentPath) || !existsSync(own)) continue;
		const legacy = resolve(parent, target);
		if (!pathsEqual(legacy, agentPath) && !pathsEqual(legacy, parent) && existsSync(legacy)) {
			continue;
		}
		return true;
	}
	return false;
}

function hasOwnStoreEntries(agentPath: string, parent: string, relativeTargets: readonly string[]): boolean {
	for (const entry of ATOMIC_STORE_FILES) {
		if (existsSync(join(agentPath, entry))) return true;
	}
	return hasOwnTargetEntries(agentPath, parent, relativeTargets);
}

function hasParentStoreEntries(parent: string, agentPath: string, relativeTargets: readonly string[]): boolean {
	for (const entry of ATOMIC_STORE_FILES) {
		if (existsSync(join(parent, entry))) return true;
	}
	return hasRelativeTargetEntries(parent, agentPath, relativeTargets, true);
}

function readConfigurationObject(path: string): object | undefined {
	try {
		const raw = readFileSync(path, "utf8");
		const value: object | null = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function hasAtomicConfiguration(path: string, name: string): boolean {
	const value = readConfigurationObject(path);
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

function agentDirectoryPriorUseTier(dirPath: string): 0 | 1 | 2 {
	if (!isDirectory(dirPath)) return 0;
	let dir: ReturnType<typeof opendirSync> | undefined;
	try {
		dir = opendirSync(dirPath);
		for (let count = 0; count < 256; count++) {
			const entry = dir.readSync();
			if (entry === null) break;
			if (
				AGENT_DIR_STATE_ENTRIES.has(entry.name) ||
				entry.name.startsWith("storage-token.") ||
				(["settings.json", "auth.json", "models.json"].includes(entry.name) &&
					hasAtomicConfiguration(join(dirPath, entry.name), entry.name))
			) {
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
			if (name === "repos" || name === "worktrees" || (parentIsDefaultAgent && AGENT_DIR_STATE_ENTRIES.has(name))) {
				continue;
			}
			const siblingPath = join(parent, name);
			if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(siblingPath)))) continue;
			if (sameDirectory(siblingPath, agentPath)) continue;
			const siblingDecision = readStorageHomeDecision(storageHomeDecisionFile(siblingPath));
			if (siblingDecision !== undefined && siblingDecision.parentOwner === undefined) continue;
			const siblingTier = agentDirectoryPriorUseTier(siblingPath);
			if (name === "workflows" && siblingTier < 2) continue;
			if (
				siblingTier === 2 &&
				!hasOwnStoreEntries(siblingPath, parent, configuredRelativeTargets(siblingPath, rawHome, undefined, false))
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
	lastStorageHome = undefined;
	if (!settled.provisionalWithoutSettings) {
		for (const [key, entry] of settledStorageHomes) {
			if (entry.provisionalWithoutSettings) settledStorageHomes.delete(key);
		}
		for (const [key, entry] of fastStorageHomes) {
			if (entry.provisionalWithoutSettings) fastStorageHomes.delete(key);
		}
	}
	settledStorageHomes.set(cacheKey, settled);
	fastStorageHomes.set(fastKey, settled);
	return settled;
}

interface StorageHomeDecision {
	readonly home: string;
	readonly defaultHome?: boolean;
	readonly parentOwner?: string;
	readonly targets?: readonly string[];
}

function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(canonicalPath(parent), relative(parent, path));
	}
}

function storageHomeDecisionFile(agentPath: string): string {
	return join(agentPath, HOME_DECISION_FILE);
}

function isDefaultStorageHome(home: string, configuredHome: string): boolean {
	if (sameDirectory(home, configuredHome)) return true;
	const agent = join(home, "agent");
	if (basename(canonicalPath(home)) !== CONFIG_DIR_NAME || !isDirectory(agent)) return false;
	const decision = readStorageHomeDecision(storageHomeDecisionFile(agent));
	if (decision !== undefined) return decision.defaultHome === true || decision.parentOwner !== undefined;
	return hasParentStoreEntries(home, agent, configuredRelativeTargets(agent, getHomeDir(), undefined, false));
}

function defaultHomeForAgent(agentPath: string, configuredHome: string): string | undefined {
	if (sameDirectory(agentPath, join(configuredHome, "agent"))) return configuredHome;
	const physical = canonicalPath(agentPath);
	const parent = dirname(physical);
	return basename(physical) === "agent" && isDefaultStorageHome(parent, configuredHome) ? parent : undefined;
}

function readStorageHomeDecision(file: string): StorageHomeDecision | undefined {
	const raw = readClaimFile(file);
	if (raw === undefined) {
		if (existsSync(file)) throw new Error(`Cannot read storage home decision at ${file}`);
		return undefined;
	}
	const decision = JSON.parse(raw) as StorageHomeDecision;
	if (
		decision === null ||
		typeof decision !== "object" ||
		typeof decision.home !== "string" ||
		!isAbsolute(decision.home) ||
		(decision.defaultHome !== undefined && typeof decision.defaultHome !== "boolean") ||
		(decision.parentOwner !== undefined &&
			(typeof decision.parentOwner !== "string" || !isAbsolute(decision.parentOwner))) ||
		(decision.targets !== undefined &&
			(!Array.isArray(decision.targets) || decision.targets.some((target) => typeof target !== "string")))
	) {
		throw new Error(`Invalid storage home decision at ${file}`);
	}
	return decision;
}

function settleStorageDecision(file: string, decision: StorageHomeDecision): StorageHomeDecision {
	const canonical = {
		...decision,
		home: canonicalPath(decision.home),
		...(decision.parentOwner === undefined ? {} : { parentOwner: canonicalPath(decision.parentOwner) }),
	};
	mkdirSync(dirname(file), { recursive: true });
	claimFileAtomically(file, `${JSON.stringify(canonical)}\n`);
	const winner = readStorageHomeDecision(file);
	if (winner === undefined) throw new Error(`Cannot settle storage decision at ${file}`);
	return winner;
}

function eligibleLegacyHostOwner(parentWorkflows: string, rawHome: string): string | undefined {
	const owner = readClaimFile(join(parentWorkflows, "pool", "host-id.adopted-by"));
	if (owner === undefined || !isDirectory(owner)) return undefined;
	const decision = readStorageHomeDecision(storageHomeDecisionFile(owner));
	if (decision !== undefined && decision.parentOwner === undefined) return undefined;
	return hasOwnStoreEntries(owner, dirname(owner), configuredRelativeTargets(owner, rawHome, undefined, false))
		? undefined
		: owner;
}

interface StorageOwner {
	readonly path: string;
	readonly identity?: string;
	readonly homeIdentity?: boolean;
}

function storageOwner(path: string): StorageOwner {
	const homeIdentity = fileIdentity(storageHomeDecisionFile(path));
	return {
		path: canonicalPath(path),
		identity: homeIdentity ?? fileIdentity(path),
		homeIdentity: homeIdentity !== undefined,
	};
}

function readStorageOwner(file: string): StorageOwner | undefined {
	const raw = readClaimFile(file);
	if (raw === undefined) {
		if (existsSync(file)) throw new Error(`Cannot read storage owner at ${file}`);
		return undefined;
	}
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
		(owner.identity !== undefined && typeof owner.identity !== "string") ||
		(owner.homeIdentity !== undefined && typeof owner.homeIdentity !== "boolean")
	) {
		throw new Error(`Invalid storage owner at ${file}`);
	}
	return owner;
}

function currentStorageOwnerPath(owner: StorageOwner): string {
	if (
		owner.identity === undefined ||
		fileIdentity(owner.homeIdentity ? storageHomeDecisionFile(owner.path) : owner.path) === owner.identity
	)
		return owner.path;
	let directory: ReturnType<typeof opendirSync> | undefined;
	let found: string | undefined;
	try {
		directory = opendirSync(dirname(owner.path));
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
			const candidate = join(dirname(owner.path), entry.name);
			if (!isDirectory(candidate)) continue;
			const identity = fileIdentity(owner.homeIdentity ? storageHomeDecisionFile(candidate) : candidate);
			if (identity !== owner.identity) continue;
			if (found !== undefined && !sameDirectory(found, candidate))
				throw new Error("Ambiguous storage owner identity");
			found = candidate;
		}
	} finally {
		directory?.closeSync();
	}
	return found ?? owner.path;
}

function parentStorageOwner(parent: string): string | undefined {
	const owner = readStorageOwner(join(parent, PARENT_CLAIM_FILE));
	return owner === undefined
		? readClaimFile(join(parent, "workflows", ADOPTION_CLAIM_FILE))
		: currentStorageOwnerPath(owner);
}

function applyStorageHomeDecision(decision: StorageHomeDecision, agentPath: string): SettledStorageHome {
	if (decision.defaultHome) return createStorageHomeEntry(decision.home);
	if (decision.parentOwner === undefined) return createStorageHomeEntry(agentPath);
	const workflows = join(decision.home, "workflows");
	const claim = join(decision.home, PARENT_CLAIM_FILE);
	const preferred = canonicalPath(parentStorageOwner(decision.home) ?? decision.parentOwner);
	claimFileAtomically(claim, `${JSON.stringify(storageOwner(preferred))}\n`);
	const winner = readStorageOwner(claim);
	if (winner === undefined) throw new Error(`Cannot claim storage home at ${claim}`);
	const winnerPath = currentStorageOwnerPath(winner);
	if (isDirectory(workflows) || !pathsEqual(canonicalPath(workflows), canonicalPath(agentPath))) {
		mkdirSync(workflows, { recursive: true });
		const legacyClaim = join(workflows, ADOPTION_CLAIM_FILE);
		claimFileAtomically(legacyClaim, `${winner.path}\n`);
		const legacyOwner = readClaimFile(legacyClaim);
		if (
			legacyOwner === undefined ||
			(!sameDirectory(legacyOwner, winner.path) && !sameDirectory(legacyOwner, winnerPath))
		) {
			throw new Error(`Conflicting storage home ownership at ${legacyClaim}`);
		}
	}
	return sameDirectory(winnerPath, agentPath)
		? createStorageHomeEntry(decision.home, claim)
		: createStorageHomeEntry(agentPath);
}

function resolveStorageHomeEntry(agentDir?: string, settings?: StorageHomeSettings): SettledStorageHome {
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
	const fastKey =
		cwd === undefined ? `${platform}\0${rawHome}\0${rawAgentDir}` : `${platform}\0${rawHome}\0${cwd}\0${rawAgentDir}`;
	const fastHit = fastStorageHomes.get(fastKey);
	if (fastHit !== undefined && (!fastHit.provisionalWithoutSettings || settings === undefined)) {
		lastStorageHome = { platform, rawHome, rawAgentDir, cwd, entry: fastHit };
		return fastHit;
	}

	const agentPath = normalizeAgentDirPath(rawAgentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined && (!cached.provisionalWithoutSettings || settings === undefined)) {
		fastStorageHomes.set(fastKey, cached);
		return cached;
	}

	const matchedDefaultHome = defaultHomeForAgent(agentPath, defaultHome);
	if (matchedDefaultHome !== undefined) {
		const file = storageHomeDecisionFile(agentPath);
		const existing = readStorageHomeDecision(file);
		if (existing !== undefined) {
			return recordSettledStorageHome(fastKey, cacheKey, applyStorageHomeDecision(existing, agentPath));
		}
		const aliasParent = dirname(agentPath);
		const targets = configuredRelativeTargets(agentPath, rawHome, settings);
		const aliasHasHistory =
			!sameDirectory(aliasParent, matchedDefaultHome) &&
			hasParentStoreEntries(aliasParent, agentPath, targets) &&
			!hasParentStoreEntries(matchedDefaultHome, agentPath, targets);
		if (!aliasHasHistory) {
			const entry =
				settings === undefined || !isDirectory(agentPath)
					? createStorageHomeEntry(matchedDefaultHome, undefined, true)
					: applyStorageHomeDecision(
							settleStorageDecision(file, { home: matchedDefaultHome, defaultHome: true }),
							agentPath,
						);
			return recordSettledStorageHome(fastKey, cacheKey, entry);
		}
	}

	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || isDefaultStorageHome(parent, defaultHome)) {
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(agentPath));
	}

	const decisionFile = storageHomeDecisionFile(agentPath);
	const existingDecision = readStorageHomeDecision(decisionFile);
	if (existingDecision !== undefined) {
		return recordSettledStorageHome(fastKey, cacheKey, applyStorageHomeDecision(existingDecision, agentPath));
	}
	const relativeTargets = configuredRelativeTargets(agentPath, rawHome, settings);
	const parentWorkflows = join(parent, "workflows");
	const existingOwner = parentStorageOwner(parent);
	let decision: StorageHomeDecision = { home: agentPath };
	if (!hasOwnStoreEntries(agentPath, parent, relativeTargets)) {
		if (existingOwner !== undefined) {
			if (sameDirectory(existingOwner, agentPath)) decision = { home: parent, parentOwner: existingOwner };
		} else if (hasParentStoreEntries(parent, agentPath, relativeTargets)) {
			const validHostIdOwner = eligibleLegacyHostOwner(parentWorkflows, rawHome);
			if (validHostIdOwner !== undefined || canClaimParentStore(parent, agentPath, defaultAgent, rawHome)) {
				decision = { home: parent, parentOwner: validHostIdOwner ?? resolve(agentPath) };
			}
		}
	}
	if (settings === undefined || !isDirectory(agentPath)) {
		const provisionalHome =
			decision.parentOwner === undefined || sameDirectory(decision.parentOwner, agentPath)
				? decision.home
				: agentPath;
		return recordSettledStorageHome(fastKey, cacheKey, createStorageHomeEntry(provisionalHome, undefined, true));
	}
	const winner = settleStorageDecision(decisionFile, { ...decision, targets: relativeTargets });
	return recordSettledStorageHome(fastKey, cacheKey, applyStorageHomeDecision(winner, agentPath));
}

export function coLocatesWorkflowStore(agentDir: string, settings?: StorageHomeSettings): boolean {
	const rawHome = getHomeDir();
	const agentPath = normalizeAgentDirPath(agentDir);
	const defaultHome = normalizeAgentDirPath(join(rawHome, CONFIG_DIR_NAME));
	const defaultAgent = join(defaultHome, "agent");
	const cacheKey = `${getPathComparisonKey(defaultHome)}\0${getPathComparisonKey(agentPath)}`;
	const cached = settledStorageHomes.get(cacheKey);
	if (cached !== undefined && !cached.provisionalWithoutSettings) {
		return sameDirectory(cached.home, agentPath);
	}
	if (defaultHomeForAgent(agentPath, defaultHome) !== undefined) return false;
	const decision = readStorageHomeDecision(storageHomeDecisionFile(agentPath));
	if (decision !== undefined) {
		if (decision.defaultHome) return false;
		if (decision.parentOwner === undefined) return true;
		const owner = parentStorageOwner(decision.home);
		return !sameDirectory(owner ?? decision.parentOwner, agentPath);
	}
	const parent = dirname(agentPath);
	if (pathsEqual(parent, agentPath) || isDefaultStorageHome(parent, defaultHome)) return true;
	const relativeTargets = configuredRelativeTargets(agentPath, rawHome, settings);
	if (hasOwnStoreEntries(agentPath, parent, relativeTargets)) return true;
	const parentWorkflows = join(parent, "workflows");
	const existingOwner = parentStorageOwner(parent);
	if (existingOwner !== undefined) return !sameDirectory(existingOwner, agentPath);
	if (!hasParentStoreEntries(parent, agentPath, relativeTargets)) return true;
	const hostIdOwner = eligibleLegacyHostOwner(parentWorkflows, rawHome);
	if (hostIdOwner !== undefined) {
		return !sameDirectory(hostIdOwner, agentPath);
	}
	return !canClaimParentStore(parent, agentPath, defaultAgent, rawHome);
}

export function storageHomeDir(agentDir?: string, settings?: StorageHomeSettings): string {
	return resolveStorageHomeEntry(agentDir, settings).home;
}

function containsPath(directory: string, target: string): boolean {
	const inside = relative(directory, target);
	return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function targetClaimFiles(agentPath: string, target: string): readonly string[] {
	const identities = [getPathComparisonKey(canonicalPath(target))];
	try {
		const stat = statSync(target, { bigint: true });
		if (stat.ino !== 0n) identities.push(`file:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
	} catch {}
	return identities.map((identity) => {
		const key = createHash("sha256").update(identity).digest("hex");
		return join(canonicalPath(dirname(agentPath)), `.atomic-storage-target-${key}`);
	});
}

function preferredTargetOwner(agentPath: string, target: string): string {
	const parent = dirname(agentPath);
	const physical = canonicalPath(target);
	const defaultHome = join(getHomeDir(), CONFIG_DIR_NAME);
	const parentOwner =
		parentStorageOwner(parent) ?? (isDefaultStorageHome(parent, defaultHome) ? join(parent, "agent") : undefined);
	if (parentOwner !== undefined && !sameDirectory(parentOwner, agentPath)) {
		if (containsPath(canonicalPath(parentOwner), physical)) return parentOwner;
		const decision = readStorageHomeDecision(storageHomeDecisionFile(parentOwner));
		const ownerHome = decision?.home ?? parent;
		if (
			containsPath(canonicalPath(join(ownerHome, "workflows")), physical) ||
			pathsEqual(canonicalPath(join(ownerHome, "storage.sqlite")), physical)
		)
			return parentOwner;
		const targets = decision?.targets ?? configuredRelativeTargets(parentOwner, getHomeDir(), undefined, false);
		if (targets.some((entry) => pathsEqual(canonicalPath(resolve(ownerHome, entry)), physical))) return parentOwner;
	}
	const physicalParent = canonicalPath(parent);
	const segment = relative(physicalParent, physical).split(sep)[0];
	if (segment !== undefined && segment !== "" && segment !== "..") {
		const sibling = join(physicalParent, segment);
		if (!sameDirectory(sibling, agentPath) && agentDirectoryPriorUseTier(sibling) === 2) return sibling;
	}
	return canonicalPath(agentPath);
}

export function storagePathBaseDir(path: string, agentDir: string, settings?: StorageHomeSettings): string {
	const home = storageHomeDir(agentDir, settings);
	const target = normalizeRelativeTarget(path, getHomeDir());
	if (target === undefined) return home;
	const agentPath = normalizeAgentDirPath(agentDir);
	const parent = dirname(agentPath);
	const key = createHash("sha256")
		.update(getPathComparisonKey(resolve(canonicalPath(agentPath), target)))
		.digest("hex");
	const decisionFile = `${storageHomeDecisionFile(agentPath)}.target-${key}`;
	let decision = readStorageHomeDecision(decisionFile);
	if (decision === undefined) {
		const base = pathsEqual(home, parent) || !existsSync(resolve(parent, target)) ? home : parent;
		const selected = resolve(base, target);
		decision = containsPath(canonicalPath(agentPath), canonicalPath(selected))
			? { home: base }
			: { home: base, parentOwner: preferredTargetOwner(agentPath, selected) };
		if (settings !== undefined && isDirectory(agentPath)) {
			decision = settleStorageDecision(decisionFile, decision);
		}
	}
	if (decision.parentOwner === undefined) return decision.home;
	const selected = resolve(decision.home, target);
	for (const claim of targetClaimFiles(agentPath, selected)) {
		if (settings !== undefined && isDirectory(agentPath)) {
			mkdirSync(dirname(claim), { recursive: true });
			claimFileAtomically(claim, `${JSON.stringify(storageOwner(decision.parentOwner))}\n`);
		}
		const owner =
			readStorageOwner(claim) ??
			(settings === undefined || !isDirectory(agentPath) ? storageOwner(decision.parentOwner) : undefined);
		if (owner === undefined) throw new Error(`Cannot claim storage target at ${claim}`);
		if (sameDirectory(currentStorageOwnerPath(owner), agentPath)) continue;
		const fallback = resolve(agentPath, target);
		if (
			!containsPath(canonicalPath(agentPath), canonicalPath(fallback)) ||
			pathsEqual(canonicalPath(fallback), canonicalPath(selected)) ||
			isSameFile(fallback, selected)
		) {
			throw new Error(`Relative storage target ${path} is owned by another agent directory`);
		}
		return agentPath;
	}
	return decision.home;
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
	if (
		existsSync(noticeFile) ||
		existsSync(join(entry.workflowsDir, `${ADOPTION_CLAIM_FILE}${ADOPTION_NOTICE_SUFFIX}`))
	)
		return undefined;
	if (!claimFileAtomically(noticeFile, `${resolve(targetAgentDir)}\n`)) return undefined;
	return `Adopted existing storage at ${entry.workflowsDir} for agent directory ${resolve(targetAgentDir)}. Sibling agent directories use their own <agentDir>/workflows store.`;
}

export function resetStorageHomeCacheForTests(): void {
	fastStorageHomes.clear();
	settledStorageHomes.clear();
	lastStorageHome = undefined;
}
