import { existsSync, readFileSync } from "node:fs";
import { ensurePrivateTempDirAsync } from "@bastani/atomic";
import { findReadableConfigPath } from "./config-paths.ts";
import { createOwnerState } from "./owner-state.js";

const CONFIG_PATH = findReadableConfigPath();

export const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff", ".tif",
	".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav", ".ogg", ".webm", ".flac", ".aac",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
	".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	".sqlite", ".db", ".sqlite3",
	".pyc", ".pyo", ".class", ".jar", ".war",
	".iso", ".img", ".dmg",
]);

export const NOISE_DIRS = new Set([
	"node_modules", "vendor", ".next", "dist", "build", "__pycache__",
	".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
	"target", ".gradle", ".idea", ".vscode",
]);

export const MAX_INLINE_FILE_CHARS = 100_000;
export const MAX_TREE_ENTRIES = 200;

export interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

/** Directory name of the default clone cache below a directory only this account owns. */
export const DEFAULT_GITHUB_CLONE_DIR = "github-repos";

export interface GitHubCloneConfig {
	enabled: boolean;
	maxRepoSizeMB: number;
	cloneTimeoutSeconds: number;
	clonePath: string;
}

const configState = createOwnerState(() => ({
	generation: 0,
	cachedConfig: null as GitHubCloneConfig | null,
	defaultClonePath: null as string | null,
}));

/**
 * The default clone cache: a directory only the current account owns (see
 * `ensurePrivateTempDirAsync`), never a fixed name in the shared temp directory.
 * Created on first use and kept for the life of the owner.
 */
export async function defaultGitHubClonePath(): Promise<string> {
	const state = configState();
	if (state.defaultClonePath !== null) return state.defaultClonePath;
	const generation = state.generation;
	const clonePath = await ensurePrivateTempDirAsync(DEFAULT_GITHUB_CLONE_DIR);
	if (state.generation !== generation) return clonePath;
	return state.defaultClonePath ??= clonePath;
}

/** The default clone cache if one was chosen, else `null`. */
export function chosenDefaultGitHubClonePath(): string | null {
	return configState().defaultClonePath;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

async function normalizeClonePath(value: unknown, fallback: () => Promise<string>): Promise<string> {
	if (typeof value !== "string") return fallback();
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback();
}

export async function loadGitHubConfig(): Promise<GitHubCloneConfig> {
	const state = configState();
	if (state.cachedConfig) return state.cachedConfig;
	const generation = state.generation;

	const defaults = {
		enabled: true,
		maxRepoSizeMB: 350,
		cloneTimeoutSeconds: 30,
	};

	if (!existsSync(CONFIG_PATH)) {
		const config = { ...defaults, clonePath: await defaultGitHubClonePath() };
		if (state.generation === generation) state.cachedConfig = config;
		return config;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { githubClone?: { enabled?: unknown; maxRepoSizeMB?: unknown; cloneTimeoutSeconds?: unknown; clonePath?: unknown } };
	try {
		raw = JSON.parse(rawText) as { githubClone?: { enabled?: unknown; maxRepoSizeMB?: unknown; cloneTimeoutSeconds?: unknown; clonePath?: unknown } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const gc = raw.githubClone ?? {};
	const clonePath = await normalizeClonePath(gc.clonePath, defaultGitHubClonePath);
	const config = {
		enabled: normalizeEnabled(gc.enabled, defaults.enabled),
		maxRepoSizeMB: normalizePositiveNumber(gc.maxRepoSizeMB, defaults.maxRepoSizeMB),
		cloneTimeoutSeconds: normalizePositiveNumber(gc.cloneTimeoutSeconds, defaults.cloneTimeoutSeconds),
		clonePath,
	};
	if (state.generation === generation) state.cachedConfig = config;
	return config;
}

const NON_CODE_SEGMENTS = new Set([
	"issues", "pull", "pulls", "discussions", "releases", "wiki",
	"actions", "settings", "security", "projects", "graphs",
	"compare", "commits", "tags", "branches", "stargazers",
	"watchers", "network", "forks", "milestone", "labels",
	"packages", "codespaces", "contribute", "community",
	"sponsors", "invitations", "notifications", "insights",
]);

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_REF_LENGTH = 255;
// git check-ref-format: no control characters, space, ~ ^ : ? * [ or backslash anywhere in a ref.
const REF_FORBIDDEN_CHARACTERS = /[\x00-\x20\x7f~^:?*[\\]/;

function invalidGitHubUrl(reason: string): Error {
	return new Error(`Invalid GitHub URL: ${reason}`);
}

export function isValidGitHubOwner(owner: string): boolean {
	return OWNER_PATTERN.test(owner);
}

export function isValidGitHubRepo(repo: string): boolean {
	return REPO_PATTERN.test(repo) && repo !== "." && repo !== "..";
}

export function isValidGitRef(ref: string): boolean {
	if (ref.length > MAX_REF_LENGTH || ref === "@") return false;
	if (REF_FORBIDDEN_CHARACTERS.test(ref) || ref.includes("..") || ref.includes("@{")) return false;
	if (ref.startsWith("-") || ref.endsWith(".")) return false;
	return ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isValidRepoPath(path: string): boolean {
	return path.split("/").every((part) => part !== "." && part !== "..");
}

/** Throws an "Invalid GitHub URL" error unless owner, repo and ref are names GitHub and git allow. */
export function assertValidGitHubCoordinates(owner: string, repo: string, ref?: string): void {
	if (!isValidGitHubOwner(owner)) throw invalidGitHubUrl(`unsupported owner ${JSON.stringify(owner)}`);
	if (!isValidGitHubRepo(repo)) throw invalidGitHubUrl(`unsupported repository ${JSON.stringify(repo)}`);
	if (ref !== undefined && !isValidGitRef(ref)) throw invalidGitHubUrl(`unsupported ref ${JSON.stringify(ref)}`);
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;

	const segments = parsed.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");

	if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

	if (segments.length === 2) {
		assertValidGitHubCoordinates(owner, repo);
		return { owner, repo, refIsFullSha: false, type: "root" };
	}

	const action = segments[2];
	if (action !== "blob" && action !== "tree") return null;
	if (segments.length < 4) return null;

	const ref = segments[3];
	const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
	const pathParts = segments.slice(4);
	const path = pathParts.length > 0 ? pathParts.join("/") : "";
	assertValidGitHubCoordinates(owner, repo, ref);
	if (!isValidRepoPath(path)) throw invalidGitHubUrl(`unsupported path ${JSON.stringify(path)}`);

	return {
		owner,
		repo,
		ref,
		refIsFullSha,
		path,
		type: action as "blob" | "tree",
	};
}

export function resetGitHubConfig(): void {
	const state = configState();
	state.generation += 1;
	state.cachedConfig = null;
	state.defaultClonePath = null;
}
