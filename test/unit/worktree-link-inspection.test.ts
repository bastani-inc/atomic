import { test, vi } from "vitest";

const lstatFailure = vi.hoisted(() => ({ path: "", code: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	const lstat = ((...args: Parameters<typeof fs.lstat>) => {
		if (lstatFailure.path && String(args[0]) === lstatFailure.path) {
			return Promise.reject(
				Object.assign(new Error(`${lstatFailure.code}: lstat '${lstatFailure.path}'`), {
					code: lstatFailure.code,
				}),
			);
		}
		return fs.lstat(...args);
	}) as typeof fs.lstat;
	return { ...fs, lstat, default: { ...fs, lstat } };
});
vi.mock("../../packages/workflows/src/runs/shared/worktree-git.js", { spy: true });

import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { cleanupWorktrees, createWorktrees } from "../../packages/workflows/src/runs/shared/worktree-setup.js";

async function createRepository(): Promise<{ root: string; repo: string }> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-link-inspection-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	await runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	writeFileSync(join(repo, ".gitignore"), "deps/\n");
	writeFileSync(join(repo, "tracked.txt"), "tracked\n");
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	mkdirSync(join(repo, "deps"));
	writeFileSync(join(repo, "deps", "module.txt"), "dependency\n");
	return { root, repo };
}

for (const code of ["EACCES", "EIO"]) {
	test(`cleanup leaves the worktree in place when a linked directory cannot be inspected (${code})`, async () => {
		const { root, repo } = await createRepository();
		try {
			const setup = await createWorktrees(repo, `inspect/${code}`, 1, {
				baseBranch: "main",
				symlinkDirectories: ["deps"],
			});
			const worktree = setup.worktrees[0]!;
			const link = join(worktree.path, "deps");
			assert.equal(lstatSync(link).isSymbolicLink(), true);
			vi.mocked(runGitChecked).mockClear();
			lstatFailure.path = link;
			lstatFailure.code = code;
			try {
				await cleanupWorktrees(setup);
			} finally {
				lstatFailure.path = "";
			}
			const gitCommands = vi.mocked(runGitChecked).mock.calls.map(([, args]) => args.join(" "));
			assert.deepEqual(
				gitCommands.filter((command) => command.startsWith("worktree remove")),
				[],
			);
			assert.deepEqual(
				gitCommands.filter((command) => command.startsWith("branch -D")),
				[],
			);
			assert.equal(existsSync(worktree.path), true, "the worktree must be left for recovery");
			assert.equal(lstatSync(link).isSymbolicLink(), true, "the link must be left intact");
			assert.equal(readFileSync(join(repo, "deps", "module.txt"), "utf8"), "dependency\n");
			assert.notEqual((await runGitChecked(repo, ["branch", "--list", worktree.branch])).trim(), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
