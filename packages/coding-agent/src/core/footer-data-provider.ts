import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, type Stats, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { createChildProcessEnvironment } from "../utils/child-process.ts";
import {
	closeWatcher,
	FS_WATCH_RETRY_DELAY_MS,
	isSafeFsWatchPathError,
	watchWithErrorHandler,
} from "../utils/fs-watch.ts";
import { createGitEnvironment } from "../utils/git-env.ts";
import { isGitProvisionError } from "../utils/git-errors.ts";
import { type ResolvedGit, resolveGitSync } from "../utils/tools-manager.ts";

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The resolved git, or undefined when none is available; the status surface reports the typed reason. */
function availableGit(): ResolvedGit | undefined {
	try {
		return resolveGitSync();
	} catch (error) {
		if (isGitProvisionError(error)) return undefined;
		throw error;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const git = availableGit();
	if (git === undefined) return null;
	const result = spawnSync(git.path, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		env: createGitEnvironment(undefined, createChildProcessEnvironment(undefined, git.env)),
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	const git = availableGit();
	if (git === undefined) return Promise.resolve(null);
	return new Promise((resolvePromise) => {
		execFile(
			git.path,
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: createGitEnvironment(undefined, createChildProcessEnvironment(undefined, git.env)),
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

function isWslEnvironment(): boolean {
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function isWindowsMountedRepoPath(repoDir: string): boolean {
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

function shouldPollGitHead(repoDir: string): boolean {
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Context usage is on ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), and model info on ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private headWatchFilePath: string | null = null;
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private reftableTablesListFingerprint: string | null = null;
	private reftableTablesListWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private disposed = false;
	private gitWatchersStarted = false;
	private cwdGeneration = 0;
	private watcherGeneration = 0;
	private readonly cwdBranches = new Map<string, { provider: FooterDataProvider; references: number }>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** Start post-frame git branch watching. Branch discovery remains lazy for first render. */
	startGitWatcher(): void {
		if (this.disposed || this.gitWatchersStarted) return;
		this.gitWatchersStarted = true;
		this.ensureGitPaths();
		this.setupGitWatcher();
		for (const { provider } of this.cwdBranches.values()) {
			if (provider !== this) provider.startGitWatcher();
		}
	}

	/** Current git branch for the displayed session cwd, defaulting to this provider's cwd. */
	getGitBranch(cwd = this.cwd): string | null {
		if (this.disposed) return null;
		if (cwd !== this.cwd) {
			const leased = this.cwdBranches.get(cwd);
			if (leased) return leased.provider.getGitBranch();
			// A read without a viewer must not retain watchers or cached child providers.
			const provider = new FooterDataProvider(cwd);
			try {
				return provider.getGitBranch();
			} finally {
				provider.dispose();
			}
		}
		if (this.cachedBranch === undefined) {
			this.ensureGitPaths();
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to branch changes. An explicit cwd retains its watcher until unsubscribe. */
	onBranchChange(callback: () => void, cwd?: string): () => void {
		if (this.disposed) return () => {};
		if (cwd === undefined) {
			this.branchChangeCallbacks.add(callback);
			return () => this.branchChangeCallbacks.delete(callback);
		}
		let entry = this.cwdBranches.get(cwd);
		if (!entry) {
			entry = { provider: cwd === this.cwd ? this : this.createCwdProvider(cwd), references: 0 };
			this.cwdBranches.set(cwd, entry);
		}
		entry.references++;
		const listener = () => callback();
		this.branchChangeCallbacks.add(listener);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.branchChangeCallbacks.delete(listener);
			if (--entry.references === 0 && this.cwdBranches.get(cwd) === entry) {
				this.cwdBranches.delete(cwd);
				if (entry.provider !== this) entry.provider.dispose();
			}
		};
	}

	private createCwdProvider(cwd: string): FooterDataProvider {
		const provider = new FooterDataProvider(cwd);
		provider.onBranchChange(() => this.notifyBranchChange());
		if (this.gitWatchersStarted) provider.startGitWatcher();
		return provider;
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	setCwd(cwd: string): void {
		if (this.disposed || this.cwd === cwd) {
			return;
		}

		const restartGitWatcher = this.gitWatchersStarted;
		const previous = this.cwdBranches.get(this.cwd);
		if (previous) previous.provider = this.createCwdProvider(this.cwd);
		const next = this.cwdBranches.get(cwd);
		if (next) {
			next.provider.dispose();
			next.provider = this;
		}
		this.cwd = cwd;
		this.cwdGeneration++;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.gitPaths = undefined;
		if (restartGitWatcher) {
			this.gitWatchersStarted = false;
			this.startGitWatcher();
		}
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.gitWatchersStarted = false;
		this.branchChangeCallbacks.clear();
		for (const { provider } of this.cwdBranches.values()) {
			if (provider !== this) provider.dispose();
		}
		this.cwdBranches.clear();
	}

	private ensureGitPaths(): void {
		if (this.gitPaths !== undefined) return;
		this.gitPaths = findGitPaths(this.cwd);
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		const generation = this.cwdGeneration;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed || generation !== this.cwdGeneration) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private clearGitWatchers(): void {
		this.watcherGeneration++;
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		if (this.headWatchFilePath && this.headWatchFileListener) {
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			this.headWatchFilePath = null;
			this.headWatchFileListener = null;
		}
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath && this.reftableTablesListWatchFileListener) {
			unwatchFile(this.reftableTablesListPath, this.reftableTablesListWatchFileListener);
		}
		this.reftableTablesListPath = null;
		this.reftableTablesListFingerprint = null;
		this.reftableTablesListWatchFileListener = null;
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private installHeadPollingFallback(): void {
		if (this.disposed || !this.gitPaths || this.headWatchFilePath || this.headWatchFileListener) {
			return;
		}
		this.headWatchFilePath = this.gitPaths.headPath;
		this.headWatchFileListener = (current, previous) => {
			if (
				current.mtimeMs !== previous.mtimeMs ||
				current.ctimeMs !== previous.ctimeMs ||
				current.size !== previous.size
			) {
				this.scheduleRefresh();
			}
		};
		watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
	}

	private installReftableTablesListPolling(tablesListPath: string): void {
		if (this.disposed || this.reftableTablesListWatchFileListener) {
			return;
		}
		this.reftableTablesListWatchFileListener = (current, previous) => {
			if (
				current.mtimeMs !== previous.mtimeMs ||
				current.ctimeMs !== previous.ctimeMs ||
				current.size !== previous.size
			) {
				this.scheduleReftableRefresh();
			}
		};
		watchFile(tablesListPath, { interval: 250 }, this.reftableTablesListWatchFileListener);
	}
	private scheduleGitWatcherRetry(): void {
		if (this.disposed || !this.gitWatchersStarted || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.ensureGitPaths();
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private readReftableTablesListFingerprint(): string | null {
		if (!this.reftableTablesListPath || !existsSync(this.reftableTablesListPath)) {
			return null;
		}

		try {
			const stat = statSync(this.reftableTablesListPath);
			const content = readFileSync(this.reftableTablesListPath, "utf8");
			return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${content}`;
		} catch {
			return null;
		}
	}

	private scheduleReftableRefresh(): void {
		const fingerprint = this.readReftableTablesListFingerprint();
		if (fingerprint !== null && fingerprint === this.reftableTablesListFingerprint) {
			return;
		}

		this.reftableTablesListFingerprint = fingerprint;
		this.scheduleRefresh();
	}

	private handleReftableDirectoryEvent(filename: string | Buffer | null): void {
		if (filename === "tables.list") {
			this.scheduleReftableRefresh();
			return;
		}

		this.scheduleRefresh();
	}

	private setupGitWatcher(): void {
		if (this.disposed || !this.gitWatchersStarted) return;
		this.clearGitWatchers();
		const generation = this.watcherGeneration;
		const isCurrent = () => !this.disposed && generation === this.watcherGeneration;
		this.ensureGitPaths();
		if (!this.gitPaths) return;
		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!isCurrent()) return;
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			(error) => {
				if (!isCurrent()) return;
				if (isSafeFsWatchPathError(error)) {
					this.installHeadPollingFallback();
					return;
				}
				this.handleGitWatcherError();
			},
		);
		if (pollGitHead) {
			this.installHeadPollingFallback();
		}
		if (!this.headWatcher && !this.headWatchFileListener) {
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableTablesListPath = join(reftableDir, "tables.list");
			this.reftableTablesListFingerprint = this.readReftableTablesListFingerprint();
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				(_eventType, filename) => {
					if (!isCurrent()) return;
					this.handleReftableDirectoryEvent(filename);
				},
				(error) => {
					if (!isCurrent()) return;
					if (isSafeFsWatchPathError(error)) {
						return;
					}
					this.handleGitWatcherError();
				},
			);

			const tablesListPath = this.reftableTablesListPath;
			if (tablesListPath && existsSync(tablesListPath)) {
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						if (!isCurrent()) return;
						this.scheduleReftableRefresh();
					},
					(error) => {
						if (!isCurrent()) return;
						if (isSafeFsWatchPathError(error)) {
							this.installReftableTablesListPolling(tablesListPath);
							return;
						}
						this.handleGitWatcherError();
					},
				);
				if (isCurrent()) this.installReftableTablesListPolling(tablesListPath);
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
