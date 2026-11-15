import { existsSync, readFileSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync, realpathSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createOwnerState } from "./owner-state.js";
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep as pathSep } from "node:path";
import { assertPrivateDirectory, createChildProcessEnvironment } from "@bastani/atomic";
import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import { flattenTruncatedString } from "./flat-string.js";
import { checkGhAvailable, checkRepoSize, fetchViaApi, showGhHint } from "./github-api.js";
import { BINARY_EXTENSIONS, MAX_INLINE_FILE_CHARS, MAX_TREE_ENTRIES, NOISE_DIRS, assertValidGitHubCoordinates, chosenDefaultGitHubClonePath, loadGitHubConfig, parseGitHubUrl, resetGitHubConfig, type GitHubCloneConfig, type GitHubUrlInfo } from "./github-config.js";
export { parseGitHubUrl, type GitHubUrlInfo } from "./github-config.js";

/** Written into every clone directory this tool creates; nothing without it is ever removed. */
const CLONE_MARKER = ".atomic-web-access-clone";

interface ClonePaths {
	/** The configured clone directory every clone must stay inside. */
	root: string;
	/** The directory this tool creates and marks; removing a clone removes this. */
	directory: string;
	/** Where the repository is checked out, inside `directory`. */
	checkout: string;
}

interface CachedClone {
	paths: ClonePaths;
	clonePromise: Promise<string | null>;
}

const cloneState = createOwnerState((owner) => ({
	cache: new Map<string, CachedClone>(),
	directory: owner ? randomUUID() : "",
}));

function cacheKey(owner: string, repo: string, ref?: string): string {
	return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function clonePaths(config: GitHubCloneConfig, owner: string, repo: string, ref?: string): ClonePaths {
	assertValidGitHubCoordinates(owner, repo, ref);
	const root = resolvePath(config.clonePath);
	// A ref may contain "/", so only its hash becomes part of the directory name.
	const refName = ref ? `@${createHash("sha256").update(ref).digest("hex").slice(0, 16)}` : "";
	const directory = join(root, owner, `${repo}${refName}`);
	return { root, directory, checkout: join(directory, repo) };
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function pathExists(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** True when `path` is strictly inside the clone root after resolving every symlink that exists along it. */
function isConfined(root: string, path: string): boolean {
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	const realPath = join(realpathSync(existing), relative(existing, path));
	return isInside(realpathSync(root), realPath);
}

/** Removes a clone directory only when it is confined and carries this tool's marker. */
function removeOwnedClone(paths: ClonePaths): boolean {
	const { root, directory } = paths;
	if (!pathExists(directory)) return true;
	if (!isConfined(root, directory) || !pathExists(join(directory, CLONE_MARKER))) return false;
	rmSync(directory, { recursive: true, force: true });
	return true;
}

/** Creates a fresh, marked clone directory inside the clone root, or refuses. */
function prepareCloneDirectory(paths: ClonePaths): boolean {
	const { root, directory } = paths;
	try {
		// The default cache must still be a directory only this account owns;
		// one swapped or opened up since it was chosen is refused, not used.
		const privateRoot = chosenDefaultGitHubClonePath();
		if (privateRoot && (root === privateRoot || dirname(root) === privateRoot)) assertPrivateDirectory(privateRoot);
		mkdirSync(root, { recursive: true });
		if (!isConfined(root, directory) || !removeOwnedClone(paths)) return false;
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, CLONE_MARKER), "", { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

function execClone(args: string[], paths: ClonePaths, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
	return new Promise((resolve) => {
		const child = execFile(args[0], args.slice(1), { timeout: timeoutMs, env: createChildProcessEnvironment() }, (err) => {
			if (err) {
				removeOwnedClone(paths);
				resolve(null);
				return;
			}
			resolve(paths.checkout);
		});

		if (signal) {
			const onAbort = () => child.kill();
			signal.addEventListener("abort", onAbort, { once: true });
			child.on("exit", () => signal.removeEventListener("abort", onAbort));
		}
	});
}

async function cloneRepo(
	owner: string,
	repo: string,
	ref: string | undefined,
	paths: ClonePaths,
	config: GitHubCloneConfig,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!prepareCloneDirectory(paths)) return null;
	const localPath = paths.checkout;

	const timeoutMs = config.cloneTimeoutSeconds * 1000;
	const hasGh = await checkGhAvailable();

	if (hasGh) {
		const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		return execClone(args, paths, timeoutMs, signal);
	}

	showGhHint();

	const gitUrl = `https://github.com/${owner}/${repo}.git`;
	const args = ["git", "clone", "--depth", "1", "--single-branch"];
	if (ref) args.push("--branch", ref);
	args.push(gitUrl, localPath);
	return execClone(args, paths, timeoutMs, signal);
}

function isBinaryFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return true;

	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		const buf = Buffer.alloc(512);
		const bytesRead = readSync(fd, buf, 0, 512, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}

	return false;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
	const normalizedRoot = resolvePath(rootPath);
	const candidate = resolvePath(normalizedRoot, relativePath);
	if (candidate !== normalizedRoot) {
		const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
		if (!candidate.startsWith(rootPrefix)) return null;
	}

	if (!existsSync(candidate)) return candidate;

	try {
		const realRoot = realpathSync(normalizedRoot);
		const realCandidate = realpathSync(candidate);
		if (realCandidate === realRoot) return candidate;
		const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
		return realCandidate.startsWith(realRootPrefix) ? candidate : null;
	} catch {
		return null;
	}
}

function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function buildTree(rootPath: string): string {
	const entries: string[] = [];

	function walk(dir: string, relPath: string): void {
		if (entries.length >= MAX_TREE_ENTRIES) return;

		let items: string[];
		try {
			items = readdirSync(dir).sort();
		} catch {
			return;
		}

		for (const item of items) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (item === ".git") continue;

			const rel = relPath ? `${relPath}/${item}` : item;
			const safePath = resolveWithinRepo(rootPath, rel);
			if (!safePath) {
				entries.push(`${rel}  [outside repo skipped]`);
				continue;
			}

			let stat;
			try {
				stat = statSync(safePath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				if (NOISE_DIRS.has(item)) {
					entries.push(`${rel}/  [skipped]`);
					continue;
				}
				entries.push(`${rel}/`);
				walk(safePath, rel);
			} else {
				entries.push(rel);
			}
		}
	}

	walk(rootPath, "");

	if (entries.length >= MAX_TREE_ENTRIES) {
		entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	}

	return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
	const targetPath = resolveWithinRepo(rootPath, subPath);
	if (!targetPath) return "(path escapes repository root)";
	const lines: string[] = [];

	let items: string[];
	try {
		items = readdirSync(targetPath).sort();
	} catch {
		return "(directory not readable)";
	}

	for (const item of items) {
		if (item === ".git") continue;
		const rel = subPath ? `${subPath}/${item}` : item;
		const safePath = resolveWithinRepo(rootPath, rel);
		if (!safePath) {
			lines.push(`  ${item}  (outside repo)`);
			continue;
		}
		try {
			const stat = statSync(safePath);
			if (stat.isDirectory()) {
				lines.push(`  ${item}/`);
			} else {
				lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
			}
		} catch {
			lines.push(`  ${item}  (unreadable)`);
		}
	}

	return lines.join("\n");
}

export function readReadme(localPath: string): string | null {
	const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
	for (const name of candidates) {
		const readmePath = join(localPath, name);
		if (existsSync(readmePath)) {
			try {
				const content = readFileSync(readmePath, "utf-8");
				return content.length > 8192 ? flattenTruncatedString(content.slice(0, 8192) + "\n\n[README truncated at 8K chars]") : content;
			} catch {
				continue;
			}
		}
	}
	return null;
}

function generateContent(localPath: string, info: GitHubUrlInfo): string {
	const lines: string[] = [];
	lines.push(`Repository cloned to: ${localPath}`);
	lines.push("");

	if (info.type === "root") {
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");

		const readme = readReadme(localPath);
		if (readme) {
			lines.push("## README.md");
			lines.push(readme);
			lines.push("");
		}

		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "tree") {
		const dirPath = info.path || "";
		const fullDirPath = resolveWithinRepo(localPath, dirPath);

		if (!fullDirPath || !existsSync(fullDirPath)) {
			lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
		} else {
			lines.push(`## ${dirPath || "/"}`);
			lines.push(buildDirListing(localPath, dirPath));
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "blob") {
		const filePath = info.path || "";
		const fullFilePath = resolveWithinRepo(localPath, filePath);

		if (!fullFilePath || !existsSync(fullFilePath)) {
			lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(fullFilePath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			lines.push(`Could not inspect \`${filePath}\`: ${message}`);
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (stat.isDirectory()) {
			lines.push(`## ${filePath || "/"}`);
			lines.push(buildDirListing(localPath, filePath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (isBinaryFile(fullFilePath)) {
			const ext = extname(filePath).replace(".", "");
			lines.push(`## ${filePath}`);
			lines.push(`Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`);
			return lines.join("\n");
		}

		const content = readTextFile(fullFilePath);
		if (content === null) {
			lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}
		lines.push(`## ${filePath}`);

		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push("");
			lines.push(`[File truncated at 100K chars. Full file: ${fullFilePath}]`);
		} else {
			lines.push(content);
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	return lines.join("\n");
}

async function awaitCachedClone(
	cached: CachedClone,
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	if (signal?.aborted) return null;
	const result = await cached.clonePromise;
	if (signal?.aborted) return null;
	if (result) {
		const content = generateContent(result, info);
		const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
		return { url, title, content, error: null };
	}
	return fetchViaApi(url, owner, repo, info);
}

export async function extractGitHub(
	url: string,
	signal?: AbortSignal,
	forceClone?: boolean,
): Promise<ExtractedContent | null> {
	let info: GitHubUrlInfo | null;
	try {
		info = parseGitHubUrl(url);
	} catch (err) {
		return { url, title: "", content: "", error: (err as Error).message };
	}
	if (!info) return null;

	if (signal?.aborted) return null;

	const state = cloneState();
	const cloneCache = state.cache;
	const loadedConfig = loadGitHubConfig();
	const config = { ...loadedConfig, clonePath: join(loadedConfig.clonePath, state.directory) };
	if (!config.enabled) return null;

	const { owner, repo } = info;
	const key = cacheKey(owner, repo, info.ref);

	const cached = cloneCache.get(key);
	if (cached) return awaitCachedClone(cached, url, owner, repo, info, signal);

	if (info.refIsFullSha) {
		if (signal?.aborted) return null;
		const sizeNote = `Note: Commit SHA URLs use the GitHub API instead of cloning.`;
		return fetchViaApi(url, owner, repo, info, sizeNote);
	}

	const activityId = activityMonitor.logStart({ type: "fetch", url: `github.com/${owner}/${repo}` });

	if (!forceClone) {
		const sizeKB = await checkRepoSize(owner, repo);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}
		if (sizeKB !== null) {
			const sizeMB = sizeKB / 1024;
			if (sizeMB > config.maxRepoSizeMB) {
				if (signal?.aborted) {
					activityMonitor.logComplete(activityId, 0);
					return null;
				}
				const sizeNote =
					`Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). ` +
					`Showing API-fetched content instead of full clone. Ask the user if they'd like to clone the full repo -- ` +
					`if yes, call fetch_content again with the same URL and add forceClone: true to the params.`;
				const apiView = await fetchViaApi(url, owner, repo, info, sizeNote);
				if (apiView) {
					activityMonitor.logComplete(activityId, 200);
					return apiView;
				}
				activityMonitor.logError(activityId, "api fallback unavailable for oversized repository");
				return null;
			}
		}
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	// Re-check: another concurrent caller may have started a clone while we awaited the size check
	const cachedAfterSizeCheck = cloneCache.get(key);
	if (cachedAfterSizeCheck) {
		const cachedResult = await awaitCachedClone(cachedAfterSizeCheck, url, owner, repo, info, signal);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
		} else if (cachedResult) {
			activityMonitor.logComplete(activityId, 200);
		} else {
			activityMonitor.logError(activityId, "clone failed");
		}
		return cachedResult;
	}

	const paths = clonePaths(config, owner, repo, info.ref);
	const clonePromise = cloneRepo(owner, repo, info.ref, paths, config, signal);
	cloneCache.set(key, { paths, clonePromise });

	const result = await clonePromise;
	if (signal?.aborted) {
		if (!result) cloneCache.delete(key);
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	if (!result) {
		cloneCache.delete(key);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}

		const apiFallback = await fetchViaApi(url, owner, repo, info);
		if (apiFallback) {
			activityMonitor.logComplete(activityId, 200);
			return apiFallback;
		}

		activityMonitor.logError(activityId, "clone and API fallback failed");
		return null;
	}

	activityMonitor.logComplete(activityId, 200);
	const content = generateContent(result, info);
	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return { url, title, content, error: null };
}

export function clearCloneCache(): void {
	const cloneCache = cloneState().cache;
	for (const entry of cloneCache.values()) removeOwnedClone(entry.paths);
	cloneCache.clear();
	resetGitHubConfig();
}
