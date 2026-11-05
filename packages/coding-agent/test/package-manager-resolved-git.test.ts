import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { runCommand } from "../src/core/package-manager-command.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { GitUnavailableError } from "../src/utils/git-errors.ts";

const resolved = vi.hoisted(() => ({
	path: "/opt/atomic/bin/git/bin/git",
	env: { GIT_EXEC_PATH: "/opt/atomic/bin/git/libexec/git-core" } as Record<string, string>,
	failure: undefined as Error | undefined,
}));

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.ts")>();
	const getToolPath = ((tool: "fd" | "rg" | "git") =>
		tool === "git"
			? resolved.failure
				? Promise.reject(resolved.failure)
				: Promise.resolve(resolved.path)
			: actual.getToolPath(tool)) as typeof actual.getToolPath;
	const getToolEnv = async (tool: "fd" | "rg" | "git") => (tool === "git" ? resolved.env : {});
	return { ...actual, getToolPath, getToolEnv };
});

interface CommandInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<void>;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
	): Promise<string>;
}

describe("package manager git commands (#4322)", () => {
	let tempDir: string;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-pm-resolved-git-"));
		vi.stubEnv("ATOMIC_OFFLINE", "");
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resolved.env = { GIT_EXEC_PATH: "/opt/atomic/bin/git/libexec/git-core" };
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("clones with the resolved git and its portable environment", async () => {
		const targetDir = join(tempDir, "agent", "git", "github.com", "user", "repo");
		const internals = packageManager as unknown as CommandInternals;
		const runCommand = vi.spyOn(internals, "runCommand").mockImplementation(async (_command, args) => {
			if (args[0] === "clone") {
				mkdirSync(targetDir, { recursive: true });
				writeFileSync(join(targetDir, "README.md"), "x");
			}
		});

		await packageManager.install("git:github.com/user/repo");

		assert.deepEqual(runCommand.mock.calls[0], [
			resolved.path,
			["clone", "--", "https://github.com/user/repo", targetDir],
			{ env: resolved.env },
		]);
	});

	it("keeps caller variables over the portable environment when capturing output", async () => {
		const internals = packageManager as unknown as CommandInternals;
		const capture = vi
			.spyOn(internals, "runCommandCapture")
			.mockImplementation(async (_command, args) =>
				args[0] === "ls-remote" ? `${"b".repeat(40)}\tHEAD` : "origin/main",
			);
		const installed = join(tempDir, "installed");
		mkdirSync(installed);

		await (
			packageManager as unknown as { gitHasAvailableUpdate(path: string): Promise<boolean> }
		).gitHasAvailableUpdate(installed);

		assert.deepEqual(
			capture.mock.calls.map(([, args]) => args),
			[
				["rev-parse", "HEAD"],
				["rev-parse", "--abbrev-ref", "@{upstream}"],
				["ls-remote", "origin", "refs/heads/main"],
			],
		);
		const remoteCall = capture.mock.calls.find(([, args]) => args[0] === "ls-remote");
		assert.ok(remoteCall);
		assert.equal(remoteCall[0], resolved.path);
		assert.deepEqual(remoteCall[2]?.env, { ...resolved.env, GIT_TERMINAL_PROMPT: "0" });
	});

	it("leaves the environment untouched for a system git", async () => {
		resolved.env = {};
		const internals = packageManager as unknown as CommandInternals;
		const capture = vi.spyOn(internals, "runCommandCapture").mockResolvedValue("abc");
		await (
			packageManager as unknown as { getLocalGitUpdateTarget(path: string): Promise<object> }
		).getLocalGitUpdateTarget(tempDir);
		assert.deepEqual(capture.mock.calls[0], [
			resolved.path,
			["rev-parse", "--abbrev-ref", "@{upstream}"],
			{ cwd: tempDir, timeoutMs: 10_000 },
		]);
		for (const [command, , options] of capture.mock.calls) {
			assert.equal(command, resolved.path);
			assert.equal(options?.env?.GIT_EXEC_PATH, undefined);
		}
	});
});

describe("package manager command environment (#4322)", () => {
	const exitUnlessSet = ["-e", "process.exit(process.env.ATOMIC_PM_TEST === 'yes' ? 0 : 3)"];

	it("runs a system git without adding an environment", async () => {
		resolved.env = {};
		const tempDir = mkdtempSync(join(tmpdir(), "atomic-pm-system-git-"));
		try {
			const packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				settingsManager: SettingsManager.inMemory(),
			});
			const internals = packageManager as unknown as CommandInternals;
			const runCommand = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);
			await packageManager.install("git:github.com/user/repo").catch(() => undefined);
			assert.deepEqual(runCommand.mock.calls[0], [
				resolved.path,
				[
					"clone",
					"--",
					"https://github.com/user/repo",
					join(tempDir, "agent", "git", "github.com", "user", "repo"),
				],
				undefined,
			]);
		} finally {
			resolved.env = { GIT_EXEC_PATH: "/opt/atomic/bin/git/libexec/git-core" };
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("passes environment overrides to the shared command runner, and runs without options", async () => {
		await runCommand(process.execPath, exitUnlessSet, { env: { ATOMIC_PM_TEST: "yes" } });
		await assert.rejects(runCommand(process.execPath, exitUnlessSet), /failed with code 3/);
	});

	it("passes environment overrides to the package manager's runner, and runs without options", async () => {
		const packageManager = new DefaultPackageManager({
			cwd: tmpdir(),
			agentDir: join(tmpdir(), "atomic-pm-env-agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		const internals = packageManager as unknown as CommandInternals;
		await internals.runCommand(process.execPath, exitUnlessSet, { env: { ATOMIC_PM_TEST: "yes" } });
		await assert.rejects(internals.runCommand(process.execPath, exitUnlessSet), /failed with code 3/);
	});
});

describe("package manager git call sites (#4322)", () => {
	let tempDir: string;
	let packageManager: DefaultPackageManager;
	let internals: CommandInternals;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-pm-call-sites-"));
		vi.stubEnv("ATOMIC_OFFLINE", "");
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		internals = packageManager as unknown as CommandInternals;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("checks out a pinned ref after cloning with the resolved git", async () => {
		const targetDir = join(tempDir, "agent", "git", "github.com", "user", "repo");
		const runCommand = vi.spyOn(internals, "runCommand").mockImplementation(async (_command, args) => {
			if (args[0] === "clone") mkdirSync(targetDir, { recursive: true });
		});
		await packageManager.install("git:github.com/user/repo@v1");
		assert.deepEqual(runCommand.mock.calls[1], [
			resolved.path,
			["checkout", "v1"],
			{ cwd: targetDir, env: resolved.env },
		]);
	});

	it("resets the remote HEAD when the checkout has no upstream", async () => {
		const runCommand = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);
		vi.spyOn(internals, "runCommandCapture").mockResolvedValue("no-upstream");
		await (
			packageManager as unknown as { getLocalGitUpdateTarget(path: string): Promise<object> }
		).getLocalGitUpdateTarget(tempDir);
		assert.deepEqual(runCommand.mock.calls[0], [
			resolved.path,
			["remote", "set-head", "origin", "-a"],
			{ cwd: tempDir, env: resolved.env },
		]);
	});

	it("skips refreshing a temporary source pinned to the commit already checked out", async () => {
		const capture = vi.spyOn(internals, "runCommandCapture").mockResolvedValue("abcdef1234567890");
		const runCommand = vi.spyOn(internals, "runCommand").mockResolvedValue(undefined);
		await (
			packageManager as unknown as {
				refreshTemporaryGitSource(source: object, sourceStr: string, installedPath: string): Promise<void>;
			}
		).refreshTemporaryGitSource(
			{
				type: "git",
				repo: "https://github.com/user/repo",
				host: "github.com",
				path: "user/repo",
				ref: "abcdef1",
				pinned: true,
			},
			"git:github.com/user/repo@abcdef1",
			tempDir,
		);
		assert.deepEqual(capture.mock.calls, [
			[resolved.path, ["rev-parse", "HEAD"], { cwd: tempDir, timeoutMs: 10_000, env: resolved.env }],
		]);
		assert.equal(runCommand.mock.calls.length, 0);
	});
});

describe("package manager without git (#4322)", () => {
	let tempDir: string;
	let packageManager: DefaultPackageManager;
	let internals: CommandInternals;
	const unavailable = new GitUnavailableError({
		code: "offline",
		offlineVariable: "ATOMIC_OFFLINE",
		platform: "linux",
		arch: "x64",
		installCommand: "apt-get install git",
	});

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-pm-no-git-"));
		vi.stubEnv("ATOMIC_OFFLINE", "");
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		internals = packageManager as unknown as CommandInternals;
		resolved.failure = unavailable;
	});

	afterEach(() => {
		resolved.failure = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const isUnavailable = (error: Error) => error === unavailable;

	it("reports git as unavailable instead of an update target it could not read", async () => {
		const run = vi.spyOn(internals, "runCommand");
		const capture = vi.spyOn(internals, "runCommandCapture");
		await assert.rejects(
			(
				packageManager as unknown as { getLocalGitUpdateTarget(path: string): Promise<object> }
			).getLocalGitUpdateTarget(tempDir),
			isUnavailable,
		);
		assert.equal(run.mock.calls.length + capture.mock.calls.length, 0);
	});

	it.each([
		[
			"gitHasAvailableUpdate",
			(pm: DefaultPackageManager, dir: string) =>
				(pm as never as { gitHasAvailableUpdate(p: string): Promise<boolean> }).gitHasAvailableUpdate(dir),
		],
		[
			"refreshTemporaryGitSource",
			(pm: DefaultPackageManager, dir: string) =>
				(
					pm as never as {
						refreshTemporaryGitSource(source: object, sourceStr: string, path: string): Promise<void>;
					}
				).refreshTemporaryGitSource(
					{
						type: "git",
						repo: "https://github.com/user/repo",
						host: "github.com",
						path: "user/repo",
						pinned: false,
					},
					"git:github.com/user/repo",
					dir,
				),
		],
	])("does not hide an unavailable git behind %s's best-effort result", async (_name, call) => {
		await assert.rejects(call(packageManager, tempDir), isUnavailable);
	});

	it("does not call a missing git a failed clean", async () => {
		const progress: string[] = [];
		packageManager.setProgressCallback((event) => progress.push(event.message ?? ""));
		const targetDir = join(tempDir, "agent", "git", "github.com", "user", "repo");
		mkdirSync(join(targetDir, ".git"), { recursive: true });
		await assert.rejects(
			(
				packageManager as never as {
					updateGit(source: object, scope: string): Promise<void>;
				}
			).updateGit(
				{ type: "git", repo: "https://github.com/user/repo", host: "github.com", path: "user/repo", pinned: false },
				"user",
			),
			isUnavailable,
		);
		assert.deepEqual(
			progress.filter((message) => message.includes("untracked")),
			[],
		);
	});

	it("reports a failing set-head once and still reads the update target", async () => {
		resolved.failure = undefined;
		const progress: string[] = [];
		packageManager.setProgressCallback((event) => progress.push(event.message ?? ""));
		vi.spyOn(internals, "runCommand").mockRejectedValue(new Error("remote refused"));
		vi.spyOn(internals, "runCommandCapture").mockImplementation(async (_command, args) => {
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") throw new Error("no upstream");
			if (args[0] === "symbolic-ref") return "refs/remotes/origin/main";
			return "abc123";
		});
		const target = await (
			packageManager as never as { getLocalGitUpdateTarget(path: string): Promise<{ ref: string; head: string }> }
		).getLocalGitUpdateTarget(tempDir);
		assert.equal(target.head, "abc123");
		assert.deepEqual(progress, [
			`Could not refresh the default branch of ${tempDir} (remote refused); using the last known one.`,
		]);
	});
});
