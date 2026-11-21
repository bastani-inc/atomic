import { readFile, rm, stat, readdir, open, realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { type HelperLaunch, helperLaunchAsync, missingHelperOptions } from "@bastani/atomic-tui";
import { createHash, randomUUID } from "node:crypto";
import { createOwnerState } from "./owner-state.js";
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep as pathSep } from "node:path";
import {
	assertPrivateDirectoryAsync,
	containProcessTree,
	createChildProcessEnvironment,
	killChildProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "@bastani/atomic";
import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import { flattenTruncatedString } from "./flat-string.js";
import { checkGhAvailable, checkRepoSize, fetchViaApi, showGhHint } from "./github-api.js";
import { BINARY_EXTENSIONS, MAX_INLINE_FILE_CHARS, MAX_TREE_ENTRIES, NOISE_DIRS, assertValidGitHubCoordinates, chosenDefaultGitHubClonePath, loadGitHubConfig, parseGitHubUrl, resetGitHubConfig, type GitHubCloneConfig, type GitHubUrlInfo } from "./github-config.js";
import { pathExists as targetExists } from "./path-exists.js";
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
	abort: () => void;
	clonePromise: Promise<string | null>;
}

const cloneState = createOwnerState((owner) => ({
	cache: new Map<string, CachedClone>(),
	directory: owner ? randomUUID() : "",
	cleanup: Promise.resolve(),
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}


/**
 * True when `path` is strictly inside the clone root after resolving every symlink along it.
 * The walk uses lstat, so it stops at a dangling symlink, which refuses the path.
 */
async function isConfined(root: string, path: string): Promise<boolean> {
	let existing = path;
	while (!(await pathExists(existing))) existing = dirname(existing);
	if (!(await targetExists(existing))) return false;
	try {
		const realPath = join(await realpath(existing), relative(existing, path));
		return isInside(await realpath(root), realPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/** Removes a clone directory only when it is confined and carries this tool's marker. */
async function removeOwnedClone(paths: ClonePaths): Promise<boolean> {
	const { root, directory } = paths;
	if (!(await pathExists(directory))) return true;
	if (!(await isConfined(root, directory)) || !(await pathExists(join(directory, CLONE_MARKER)))) return false;
	await rm(directory, { recursive: true, force: true });
	return true;
}

/** Creates a fresh, marked clone directory inside the clone root, or refuses. */
async function prepareCloneDirectory(paths: ClonePaths): Promise<boolean> {
	const { root, directory } = paths;
	try {
		// The default cache must still be a directory only this account owns;
		// one swapped or opened up since it was chosen is refused, not used.
		const privateRoot = chosenDefaultGitHubClonePath();
		if (privateRoot && (root === privateRoot || dirname(root) === privateRoot)) {
			await assertPrivateDirectoryAsync(privateRoot);
		}
		await mkdir(root, { recursive: true });
		if (!(await isConfined(root, directory)) || !(await removeOwnedClone(paths))) return false;
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, CLONE_MARKER), "", { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

async function execClone(args: string[], paths: ClonePaths, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
	const env = createChildProcessEnvironment();
	const startedAt = performance.now();
	const expired = AbortSignal.timeout(timeoutMs);
	let launch: HelperLaunch;
	try {
		// gh and git only from PATH's absolute directories, never from the working directory. The lookup counts against
		// the clone's time limit and ends with its cancellation, which then starts nothing.
		launch = await helperLaunchAsync(args[0]!, { env, signal: signal ? AbortSignal.any([signal, expired]) : expired });
	} catch (error) {
		if (signal?.aborted || expired.aborted) return removeOwnedClone(paths).then(() => null);
		throw error;
	}
	// A cancellation or the time limit that came as the lookup finished still starts nothing.
	if (signal?.aborted || expired.aborted) return removeOwnedClone(paths).then(() => null);
	// Whole milliseconds, as spawn's `timeout` takes them, and never 0, which spawn reads as no limit.
	const remainingMs = Math.max(1, Math.ceil(timeoutMs - (performance.now() - startedAt)));
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let stopped = false;
		let treeTerminated = false;
		const finish = (failed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (!failed && !stopped) tree?.release();
			tree?.close();
			if (detachedPid !== undefined) untrackDetachedChildPid(detachedPid);
			if (failed) {
				void removeOwnedClone(paths).then(() => resolve(null), reject);
				return;
			}
			resolve(paths.checkout);
		};
		const stop = () => {
			stopped = true;
			child.stdout?.destroy();
			child.stderr?.destroy();
			// Terminating the tree ends every process in it, and closing it ends any left: it is terminated at most once.
			if (!treeTerminated) treeTerminated = tree?.terminate() === true;
			if (!treeTerminated) killChildProcessTree(child, exited);
			if (exited || child.pid === undefined) finish(true);
		};
		const onAbort = () => stop();
		const child = spawn(
			launch.file,
			args.slice(1),
			{
				timeout: remainingMs,
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env,
				...missingHelperOptions(launch),
			},
		);
		const tree = child.pid === undefined || child.pid === process.pid ? undefined : containProcessTree(child.pid);
		const detachedPid =
			process.platform !== "win32" && child.pid !== undefined && child.pid !== process.pid ? child.pid : undefined;
		if (detachedPid !== undefined) trackDetachedChildPid(detachedPid);
		const timer = setTimeout(stop, remainingMs);
		child.on("error", () => finish(true));
		child.on("exit", (code, exitSignal) => {
			exited = true;
			if (code !== 0 || exitSignal !== null || signal?.aborted) stop();
			finish(stopped || code !== 0 || exitSignal !== null || Boolean(signal?.aborted));
		});
		child.on("close", (code, exitSignal) => {
			finish(stopped || code !== 0 || exitSignal !== null || Boolean(signal?.aborted));
		});
		if (signal) {
			if (signal.aborted) stop();
			else signal.addEventListener("abort", onAbort, { once: true });
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
	if (!(await prepareCloneDirectory(paths))) return null;
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

async function isBinaryFile(filePath: string): Promise<boolean> {
	const ext = extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return true;

	let fd: Awaited<ReturnType<typeof open>>;
	try {
		fd = await open(filePath, "r");
	} catch {
		return false;
	}
	try {
		const buf = Buffer.alloc(512);
		const { bytesRead } = await fd.read(buf, 0, 512, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
	} catch {
		return false;
	} finally {
		await fd.close();
	}

	return false;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveWithinRepo(rootPath: string, relativePath: string): Promise<string | null> {
	const normalizedRoot = resolvePath(rootPath);
	const candidate = resolvePath(normalizedRoot, relativePath);
	if (candidate !== normalizedRoot) {
		const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
		if (!candidate.startsWith(rootPrefix)) return null;
	}

	if (!(await pathExists(candidate))) return (await isConfined(normalizedRoot, candidate)) ? candidate : null;

	try {
		const realRoot = await realpath(normalizedRoot);
		const realCandidate = await realpath(candidate);
		if (realCandidate === realRoot) return candidate;
		const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
		return realCandidate.startsWith(realRootPrefix) ? candidate : null;
	} catch {
		return null;
	}
}

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}

async function buildTree(rootPath: string): Promise<string> {
	const entries: string[] = [];

	async function walk(dir: string, relPath: string): Promise<void> {
		if (entries.length >= MAX_TREE_ENTRIES) return;

		let items: string[];
		try {
			items = (await readdir(dir)).sort();
		} catch {
			return;
		}

		for (const item of items) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (item === ".git") continue;

			const rel = relPath ? `${relPath}/${item}` : item;
			const safePath = await resolveWithinRepo(rootPath, rel);
			if (!safePath) {
				entries.push(`${rel}  [outside repo skipped]`);
				continue;
			}

			let entryStat;
			try {
				entryStat = await stat(safePath);
			} catch {
				continue;
			}

			if (entryStat.isDirectory()) {
				if (NOISE_DIRS.has(item)) {
					entries.push(`${rel}/  [skipped]`);
					continue;
				}
				entries.push(`${rel}/`);
				await walk(safePath, rel);
			} else {
				entries.push(rel);
			}
		}
	}

	await walk(rootPath, "");

	if (entries.length >= MAX_TREE_ENTRIES) {
		entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	}

	return entries.join("\n");
}

async function buildDirListing(rootPath: string, subPath: string): Promise<string> {
	const targetPath = await resolveWithinRepo(rootPath, subPath);
	if (!targetPath) return "(path escapes repository root)";
	const lines: string[] = [];

	let items: string[];
	try {
		items = (await readdir(targetPath)).sort();
	} catch {
		return "(directory not readable)";
	}

	for (const item of items) {
		if (item === ".git") continue;
		const rel = subPath ? `${subPath}/${item}` : item;
		const safePath = await resolveWithinRepo(rootPath, rel);
		if (!safePath) {
			lines.push(`  ${item}  (outside repo)`);
			continue;
		}
		try {
			const entryStat = await stat(safePath);
			if (entryStat.isDirectory()) {
				lines.push(`  ${item}/`);
			} else {
				lines.push(`  ${item}  (${formatFileSize(entryStat.size)})`);
			}
		} catch {
			lines.push(`  ${item}  (unreadable)`);
		}
	}

	return lines.join("\n");
}

export async function readReadme(localPath: string): Promise<string | null> {
	const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
	for (const name of candidates) {
		const readmePath = await resolveWithinRepo(localPath, name);
		if (readmePath && (await targetExists(readmePath))) {
			try {
				const content = await readFile(readmePath, "utf-8");
				return content.length > 8192 ? flattenTruncatedString(content.slice(0, 8192) + "\n\n[README truncated at 8K chars]") : content;
			} catch {
				continue;
			}
		}
	}
	return null;
}

async function generateContent(localPath: string, info: GitHubUrlInfo): Promise<string> {
	const lines: string[] = [];
	lines.push(`Repository cloned to: ${localPath}`);
	lines.push("");

	if (info.type === "root") {
		lines.push("## Structure");
		lines.push(await buildTree(localPath));
		lines.push("");

		const readme = await readReadme(localPath);
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
		const fullDirPath = await resolveWithinRepo(localPath, dirPath);

		if (!fullDirPath || !(await targetExists(fullDirPath))) {
			lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(await buildTree(localPath));
		} else {
			lines.push(`## ${dirPath || "/"}`);
			lines.push(await buildDirListing(localPath, dirPath));
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "blob") {
		const filePath = info.path || "";
		const fullFilePath = await resolveWithinRepo(localPath, filePath);

		if (!fullFilePath || !(await targetExists(fullFilePath))) {
			lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(await buildTree(localPath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		let fileStat: Awaited<ReturnType<typeof stat>>;
		try {
			fileStat = await stat(fullFilePath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			lines.push(`Could not inspect \`${filePath}\`: ${message}`);
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (fileStat.isDirectory()) {
			lines.push(`## ${filePath || "/"}`);
			lines.push(await buildDirListing(localPath, filePath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (await isBinaryFile(fullFilePath)) {
			const ext = extname(filePath).replace(".", "");
			lines.push(`## ${filePath}`);
			lines.push(`Binary file (${ext}, ${formatFileSize(fileStat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`);
			return lines.join("\n");
		}

		const content = await readTextFile(fullFilePath);
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
		const content = await generateContent(result, info);
		if (signal?.aborted) return null;
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
	const loadedConfig = await loadGitHubConfig();
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
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const clonePromise = state.cleanup
		.then(() =>
			signal?.aborted || controller.signal.aborted
				? null
				: cloneRepo(owner, repo, info.ref, paths, config, controller.signal),
		)
		.finally(() => signal?.removeEventListener("abort", onAbort));
	cloneCache.set(key, { paths, abort: () => controller.abort(), clonePromise });

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
	const content = await generateContent(result, info);
	if (signal?.aborted) return null;
	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return { url, title, content, error: null };
}

export function clearCloneCache(): Promise<void> {
	const state = cloneState();
	const entries = [...state.cache.values()];
	state.cache.clear();
	resetGitHubConfig();
	for (const entry of entries) entry.abort();
	const cleanup = state.cleanup.then(async () => {
		for (const entry of entries) {
			await entry.clonePromise.catch(() => null);
			await removeOwnedClone(entry.paths);
		}
	});
	state.cleanup = cleanup.catch(() => undefined);
	return cleanup;
}
