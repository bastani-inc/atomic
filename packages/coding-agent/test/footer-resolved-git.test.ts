import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitUnavailableError } from "../src/utils/git-errors.ts";

const git = vi.hoisted(() => ({
	resolve: vi.fn(),
	spawnSync: vi.fn(),
	execFile: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawnSync: git.spawnSync,
	execFile: git.execFile,
}));

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tools-manager.ts")>()),
	resolveGitSync: git.resolve,
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

const provisioned = {
	path: "/agent/bin/git/bin/git",
	source: "provisioned",
	version: "2.56.0",
	env: { PATH: "/usr/bin", GIT_EXEC_PATH: "/agent/bin/git/libexec/git-core", GIT_DIR: "/elsewhere.git" },
};

describe("footer branch through the resolved git (#4322)", () => {
	let tempDir: string;
	let repoDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "footer-resolved-git-"));
		repoDir = join(tempDir, "repo");
		mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
		writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
		git.resolve.mockReset();
		git.spawnSync.mockReset();
		git.execFile.mockReset();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs the resolved executable with its portable environment and without repository bindings", () => {
		git.resolve.mockReturnValue(provisioned);
		git.spawnSync.mockReturnValue({ status: 0, stdout: "feature\n", stderr: "" });
		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("feature");
			const [command, args, options] = git.spawnSync.mock.calls[0]!;
			expect(command).toBe(provisioned.path);
			expect(args).toEqual(["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
			expect(options.env.GIT_EXEC_PATH).toBe(provisioned.env.GIT_EXEC_PATH);
			expect(options.env.AI_AGENT).toBe("atomic");
			expect(options.env.GIT_DIR).toBeUndefined();
		} finally {
			provider.dispose();
		}
	});

	it("refreshes asynchronously through the resolved executable and environment", async () => {
		git.resolve.mockReturnValue(provisioned);
		git.spawnSync.mockReturnValue({ status: 0, stdout: "main\n", stderr: "" });
		git.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, "renamed\n", ""));
		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			await (provider as unknown as { refreshGitBranchAsync(): Promise<void> }).refreshGitBranchAsync();
			expect(provider.getGitBranch()).toBe("renamed");
			const [command, , options] = git.execFile.mock.calls[0]!;
			expect(command).toBe(provisioned.path);
			expect(options.env.GIT_EXEC_PATH).toBe(provisioned.env.GIT_EXEC_PATH);
			expect(options.env.GIT_DIR).toBeUndefined();
		} finally {
			provider.dispose();
		}
	});

	it("shows a detached branch without spawning when git is unavailable", async () => {
		git.resolve.mockImplementation(() => {
			throw new GitUnavailableError({
				code: "offline",
				offlineVariable: "ATOMIC_OFFLINE",
				platform: "linux",
				arch: "x64",
			});
		});
		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("detached");
			await (provider as unknown as { refreshGitBranchAsync(): Promise<void> }).refreshGitBranchAsync();
			expect(provider.getGitBranch()).toBe("detached");
			expect(git.spawnSync).not.toHaveBeenCalled();
			expect(git.execFile).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("does not treat an unexpected resolution failure as an unavailable git", () => {
		git.resolve.mockImplementation(() => {
			throw new TypeError("resolver bug");
		});
		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBeNull();
		} finally {
			provider.dispose();
		}
	});
});
