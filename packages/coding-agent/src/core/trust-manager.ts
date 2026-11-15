import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAMES } from "../config.js";
import { parseJsonFileContent } from "../utils/json.ts";
import { canonicalizePath, getHomeDir, pathsEqual, resolvePath } from "../utils/paths.ts";
import { releaseLockSync } from "./lock-release.ts";
import { waitForLockSync } from "./lock-wait.ts";
import { renameReplacing } from "./rename-retry.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;
export const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"workflows",
	"agents",
	"mcp.json",
	"blueprint.yaml",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

/** Trust file keys naming `path`. Usually one; several on Windows when saved with different casing. */
function findTrustFileKeys(data: TrustFile, path: string): string[] {
	return Object.keys(data).filter((key) => pathsEqual(key, path));
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		for (const key of findTrustFileKeys(data, currentDir)) {
			const value = data[key];
			if (value === true || value === false) {
				return { path: key, decision: value };
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function getProjectTrustPath(cwd: string): string {
	return normalizeCwd(cwd);
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = getProjectTrustPath(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = getProjectTrustPath(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

/** How long a save waits for one other process to release the trust store lock. */
export const TRUST_LOCK_WAIT_MS = 5_000;
const TRUST_LOCK_POLL_MIN_MS = 10;
const TRUST_LOCK_POLL_MAX_MS = 50;

/** A trust.json that exists but is not a valid trust store. */
class CorruptTrustFileError extends Error {}

/** The trust store files whose corruption this process has already reported, so each is reported once. */
const reportedCorruptTrustFiles = new Set<string>();

function reportCorruptTrustFile(path: string, error: Error): void {
	if (reportedCorruptTrustFiles.has(path)) return;
	reportedCorruptTrustFiles.add(path);
	process.emitWarning(`${error.message}; it is treated as empty until a trust decision is saved`, {
		code: "ATOMIC_TRUST_STORE_CORRUPT",
	});
}

/**
 * Reads trust.json without a lock: writers replace it whole with a rename, so a read sees the last complete file. A
 * missing file is empty. A file that is not a valid trust store throws {@link CorruptTrustFileError}.
 */
function readTrustFileStrict(path: string): TrustFile {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = parseJsonFileContent(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CorruptTrustFileError(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CorruptTrustFileError(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new CorruptTrustFileError(
				`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`,
			);
		}
		data[key] = value;
	}
	reportedCorruptTrustFiles.delete(path);
	return data;
}

/** Reads trust.json for a caller that only reads: any failure is reported once and read as an empty store. */
function readTrustFileForRead(path: string): TrustFile {
	try {
		return readTrustFileStrict(path);
	} catch (error) {
		reportCorruptTrustFile(path, error instanceof Error ? error : new Error(String(error)));
		return {};
	}
}

/**
 * Reads trust.json under the writer lock before a save. A corrupt store is reported and replaced; a file that cannot
 * be read at all fails the save rather than overwriting decisions that may still be there.
 */
function readTrustFileForWrite(path: string): TrustFile {
	try {
		return readTrustFileStrict(path);
	} catch (error) {
		if (!(error instanceof CorruptTrustFileError)) throw error;
		reportCorruptTrustFile(path, error);
		return {};
	}
}

/** Replaces trust.json whole: a sibling temporary file renamed over it, so a crash leaves the old or the new file. */
function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	// Replace the file a symbolic link names, not the link.
	const target = existsSync(path) ? realpathSync(path) : path;
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
		renameReplacing(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * Takes the trust store writer lock, waiting while other processes hold it. Contention never fails a save: it fails
 * only when one process keeps the lock for {@link TRUST_LOCK_WAIT_MS}, or after two minutes of
 * saves by others. A lock its holder stopped refreshing is stale and taken over, as for auth.json.
 */
function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const lockPath = `${path}.lock`;
	return waitForLockSync(() => lockfile.lockSync(trustDir, { realpath: false, lockfilePath: lockPath }), {
		lockPath,
		holderWaitMs: TRUST_LOCK_WAIT_MS,
		pollMinMs: TRUST_LOCK_POLL_MIN_MS,
		pollMaxMs: TRUST_LOCK_POLL_MAX_MS,
		retryable: (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			// Windows reports a lock directory another process is creating or removing as EPERM, as for auth.json.
			return code === "ELOCKED" || (code === "EPERM" && process.platform === "win32");
		},
		stuck: (error) =>
			new Error(
				`Could not save the trust decision: ${path} is locked by another process (waited ${TRUST_LOCK_WAIT_MS / 1000} s)`,
				{ cause: error },
			),
		contended: (error, waitedMs) =>
			new Error(
				`Could not save the trust decision: other processes kept saving to ${path} for ${Math.round(waitedMs / 1000)} s`,
				{ cause: error },
			),
	});
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		releaseLockSync(release, `${path}.lock`);
	}
}

export function hasProjectConfigDir(cwd: string): boolean {
	const projectCwd = canonicalizePath(resolvePath(cwd));
	return CONFIG_DIR_NAMES.some((configDirName) => existsSync(join(projectCwd, configDirName)));
}
function hasTrustRequiringConfigResources(cwd: string): boolean {
	const projectCwd = canonicalizePath(resolvePath(cwd));
	return CONFIG_DIR_NAMES.some((configDirName) => {
		const configDir = join(projectCwd, configDirName);
		return TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)));
	});
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Subagent definitions and their settings overrides are read from the nearest
 * ancestor of cwd that has a project config dir or a `.agents` dir, not only
 * from cwd. Returns true when that project root has agent definitions or a
 * settings file. The home directory holds the user's own config dirs, so it is
 * never treated as a project root.
 */
function hasNearestProjectRootAgentResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(getHomeDir()));
	let currentDir = canonicalizePath(resolvePath(cwd));
	while (true) {
		const configDirs = CONFIG_DIR_NAMES.map((configDirName) => join(currentDir, configDirName));
		const legacyAgentsDir = join(currentDir, ".agents");
		if (configDirs.some(isDirectory) || isDirectory(legacyAgentsDir)) {
			if (pathsEqual(currentDir, homeDir)) return false;
			return (
				isDirectory(legacyAgentsDir) ||
				configDirs.some(
					(configDir) => existsSync(join(configDir, "agents")) || existsSync(join(configDir, "settings.json")),
				)
			);
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return false;
		currentDir = parentDir;
	}
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under cwd/.atomic or cwd/.pi, or
 * .agents/skills in cwd or one of its ancestors. Returns false for inert
 * state-only config directories. The user-global ~/.agents/skills directory is
 * always treated as a trusted user resource and ignored, even when cwd is $HOME.
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	if (hasTrustRequiringConfigResources(cwd) || hasNearestProjectRootAgentResources(cwd)) {
		return true;
	}

	const userGlobalSkillsDir = canonicalizePath(resolvePath(join(getHomeDir(), ".agents", "skills")));
	let currentDir = canonicalizePath(resolvePath(cwd));
	while (true) {
		const skillsDir = canonicalizePath(resolvePath(join(currentDir, ".agents", "skills")));
		if (!pathsEqual(skillsDir, userGlobalSkillsDir) && existsSync(skillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export function hasProjectTrustInputs(cwd: string): boolean {
	let currentDir = canonicalizePath(resolvePath(cwd));
	if (hasTrustRequiringConfigResources(currentDir) || hasNearestProjectRootAgentResources(currentDir)) {
		return true;
	}
	const userGlobalSkillsDir = canonicalizePath(resolvePath(join(getHomeDir(), ".agents", "skills")));
	const contextFileNames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

	while (true) {
		for (const contextFileName of contextFileNames) {
			if (existsSync(join(currentDir, contextFileName))) {
				return true;
			}
		}

		const skillsDir = canonicalizePath(resolvePath(join(currentDir, ".agents", "skills")));
		if (!pathsEqual(skillsDir, userGlobalSkillsDir) && existsSync(skillsDir)) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

export class ProjectTrustStore {
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return findNearestTrustEntry(readTrustFileForRead(this.trustPath), cwd);
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFileForWrite(this.trustPath);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				for (const existingKey of findTrustFileKeys(data, key)) {
					delete data[existingKey];
				}
				if (decision !== null) {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
