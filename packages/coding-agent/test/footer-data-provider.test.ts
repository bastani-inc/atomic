import { execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockedFunction<T> = T & {
	mock: { calls: unknown[][] };
	mockClear(): void;
};

function mocked<T>(fn: T): MockedFunction<T> {
	return fn as MockedFunction<T>;
}
let gitBranch = "main";

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[0] === "--version") {
				setTimeout(() => callback(null, "git version 2.45.0\n", ""), 0);
				return;
			}
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() => callback(gitBranch ? null : new Error("detached"), gitBranch ? `${gitBranch}\n` : "", ""),
					0,
				);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[0] === "--version") return { status: 0, stdout: "git version 2.45.0\n", stderr: "" };
		if (args[1] === "symbolic-ref") {
			return { status: gitBranch ? 0 : 1, stdout: gitBranch ? `${gitBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

type ReftableWatcherTestAccess = {
	reftableWatcher: FSWatcher | null;
	reftableTablesListWatcher: FSWatcher | null;
	reftableTablesListCheck: Promise<void>;
	handleReftableDirectoryEvent: (filename: string | Buffer | null) => void;
};

/** Start the watchers and wait until the reftable ones are installed; call before faking timers. */
async function startReftableWatchers(provider: FooterDataProvider): Promise<ReftableWatcherTestAccess> {
	provider.startGitWatcher();
	const access = provider as unknown as ReftableWatcherTestAccess;
	await vi.waitFor(() => expect(access.reftableTablesListWatcher).not.toBeNull());
	expect(access.reftableWatcher).not.toBeNull();
	// Keep watcher installation under test while making event delivery deterministic.
	access.reftableWatcher?.removeAllListeners("change");
	access.reftableTablesListWatcher?.removeAllListeners("change");
	return access;
}

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function advanceTimersByTime(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await Promise.resolve();
}

/** The branch once its first read finished. */
async function resolvedBranch(provider: FooterDataProvider): Promise<string | null> {
	provider.getGitBranch();
	const internals = provider as unknown as { cachedBranch: string | null | undefined };
	await vi.waitFor(() => expect(internals.cachedBranch).not.toBeUndefined());
	return provider.getGitBranch();
}

/** Wait for a branch refresh to finish reading HEAD and asking git. */
async function settledRefresh(provider: FooterDataProvider): Promise<void> {
	const internals = provider as unknown as { refreshInFlight: boolean };
	await vi.waitFor(() => expect(internals.refreshInFlight).toBe(false));
}

/** Let reftable events finish comparing tables.list, which reads the file. */
async function settleReftableChecks(access: ReftableWatcherTestAccess): Promise<void> {
	await access.reftableTablesListCheck;
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		gitBranch = "main";
		mocked(spawnSync).mockClear();
		mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", async () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			expect(mocked(execFile)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("reads the branch in the background and asks listeners to repaint once it is known", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const repaint = vi.fn();
			provider.onBranchChange(repaint);
			// A render must not wait for the disk: the first lookup has nothing to show yet.
			expect(provider.getGitBranch()).toBeNull();
			await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(1));
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("does not start git watchers until requested", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const providerWithInternals = provider as unknown as { headWatcher: FSWatcher | null };
			expect(providerWithInternals.headWatcher).toBeNull();
			expect(await resolvedBranch(provider)).toBe("main");
			expect(providerWithInternals.headWatcher).toBeNull();

			provider.startGitWatcher();
			await vi.waitFor(() => expect(providerWithInternals.headWatcher).not.toBeNull());
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", async () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			expect(mocked(execFile)).toHaveBeenCalledWith(
				expect.stringMatching(/[\\/]git(\.exe)?$/),
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
				}),
				expect.any(Function),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", async () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", async () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		gitBranch = "";

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(await resolvedBranch(provider)).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	// Upstream 082f7577c2: control debounce time without racing native fs.watch delivery.
	it("does not notify listeners when reftable updates keep the same branch", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			mocked(spawnSync).mockClear();
			mocked(execFile).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);
			const watcherAccess = await startReftableWatchers(provider);
			vi.useFakeTimers();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await settleReftableChecks(watcherAccess);
			await vi.advanceTimersByTimeAsync(501);
			await vi.waitFor(() => expect(mocked(execFile)).toHaveBeenCalledTimes(1));
			await settledRefresh(provider);

			expect(mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("debounces rapid reftable updates into a single async refresh", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			mocked(execFile).mockClear();
			const watcherAccess = await startReftableWatchers(provider);
			vi.useFakeTimers();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			writeFileSync(join(reftableDir, "tables.list"), "2\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			writeFileSync(join(reftableDir, "tables.list"), "3\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await settleReftableChecks(watcherAccess);
			await vi.advanceTimersByTimeAsync(499);
			expect(mocked(execFile)).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2);
			await vi.waitFor(() => expect(mocked(execFile)).toHaveBeenCalledTimes(1));
			await settledRefresh(provider);
			await vi.advanceTimersByTimeAsync(650);
			await settledRefresh(provider);

			expect(mocked(execFile)).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("ignores duplicate reftable watcher events for an unchanged tables.list state", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			mocked(execFile).mockClear();
			const watcherAccess = await startReftableWatchers(provider);
			vi.useFakeTimers();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await settleReftableChecks(watcherAccess);
			await vi.advanceTimersByTimeAsync(500);
			await vi.waitFor(() => expect(mocked(execFile)).toHaveBeenCalledTimes(1));
			await settledRefresh(provider);

			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await settleReftableChecks(watcherAccess);
			await vi.advanceTimersByTimeAsync(650);
			await settledRefresh(provider);
			expect(mocked(execFile)).toHaveBeenCalledTimes(1);

			writeFileSync(join(reftableDir, "tables.list"), "2\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await settleReftableChecks(watcherAccess);
			await vi.advanceTimersByTimeAsync(500);

			await vi.waitFor(() => expect(mocked(execFile)).toHaveBeenCalledTimes(2));
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("refreshes on unnamed reftable directory watcher events", async () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			mocked(execFile).mockClear();
			const watcherAccess = await startReftableWatchers(provider);
			vi.useFakeTimers();

			watcherAccess.handleReftableDirectoryEvent(null);
			await vi.advanceTimersByTimeAsync(500);

			await vi.waitFor(() => expect(mocked(execFile)).toHaveBeenCalledTimes(1));
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(await resolvedBranch(provider)).toBe("main");
			mocked(execFile).mockClear();
			gitBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);
			const watcherAccess = await startReftableWatchers(provider);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			watcherAccess.handleReftableDirectoryEvent("tables.list");
			await waitFor(() => mocked(execFile).mock.calls.length === 1);
			await waitFor(() => provider.getGitBranch() === "foo");

			expect(mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("retries git watchers 5 seconds after an async fs.watch error", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			provider.startGitWatcher();
			const providerWithInternals = provider as unknown as {
				headWatcher: FSWatcher | null;
			};
			await vi.waitFor(() => expect(providerWithInternals.headWatcher).not.toBeNull());
			vi.useFakeTimers();
			const originalWatcher = providerWithInternals.headWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(providerWithInternals.headWatcher).toBeNull();

			await advanceTimersByTime(4999);
			expect(providerWithInternals.headWatcher).toBeNull();

			await advanceTimersByTime(1);
			await vi.waitFor(() => expect(providerWithInternals.headWatcher).not.toBeNull());
			expect(providerWithInternals.headWatcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});
