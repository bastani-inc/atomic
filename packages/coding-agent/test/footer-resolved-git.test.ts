import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { GitUnavailableError } from "../src/utils/git-errors.js";

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

vi.mock("../src/utils/tools-manager.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tools-manager.js")>()),
	resolveGitSync: git.resolve,
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.js";

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
			assert.equal(provider.getGitBranch(), "feature");
			const [command, args, options] = git.spawnSync.mock.calls[0]!;
			assert.equal(command, provisioned.path);
			assert.deepEqual(args, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
			assert.equal(options.env.GIT_EXEC_PATH, provisioned.env.GIT_EXEC_PATH);
			assert.equal(options.env.AI_AGENT, "atomic");
			assert.equal(options.env.GIT_DIR, undefined);
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
			assert.equal(provider.getGitBranch(), "main");
			await (provider as unknown as { refreshGitBranchAsync(): Promise<void> }).refreshGitBranchAsync();
			assert.equal(provider.getGitBranch(), "renamed");
			const [command, , options] = git.execFile.mock.calls[0]!;
			assert.equal(command, provisioned.path);
			assert.equal(options.env.GIT_EXEC_PATH, provisioned.env.GIT_EXEC_PATH);
			assert.equal(options.env.GIT_DIR, undefined);
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
			assert.equal(provider.getGitBranch(), "detached");
			await (provider as unknown as { refreshGitBranchAsync(): Promise<void> }).refreshGitBranchAsync();
			assert.equal(provider.getGitBranch(), "detached");
			assert.equal(git.spawnSync.mock.calls.length, 0);
			assert.equal(git.execFile.mock.calls.length, 0);
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
			assert.equal(provider.getGitBranch(), null);
		} finally {
			provider.dispose();
		}
	});
});
