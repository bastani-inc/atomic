import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { runGitChecked } from "../../packages/subagents/src/runs/shared/worktree.js";
import {
	findCanonicalGitRoot as findSubagentCanonicalGitRoot,
	findGitRoot as findSubagentGitRoot,
	resolveMainRepoRoot as resolveSubagentMainRepoRoot,
} from "../../packages/subagents/src/runs/shared/worktree-root.js";

async function createGitRepository(): Promise<{
	readonly root: string;
	readonly repo: string;
	readonly worktree: string;
}> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-generation-test-")));
	const repo = join(root, "repo");
	const worktree = join(root, "worktree");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	writeFileSync(join(repo, "tracked.txt"), "primary\n");
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, [
		"-c",
		"user.name=Atomic Test",
		"-c",
		"user.email=atomic-test@example.com",
		"commit",
		"--no-gpg-sign",
		"-m",
		"initial",
	]);
	return { root, repo, worktree };
}

describe("canonical main Git root parser", () => {
	test("subagent parser mirrors canonical-root edge cases", async () => {
		const { root, repo, worktree } = await createGitRepository();
		const malformed = join(root, "malformed");
		const foreign = await createGitRepository();
		mkdirSync(malformed);
		try {
			assert.equal(await findSubagentGitRoot(join(repo, "tracked.txt")), repo);
			assert.equal(await resolveSubagentMainRepoRoot(repo), repo);
			await runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
			const nested = join(worktree, "nested", "deeper");
			mkdirSync(nested, { recursive: true });
			assert.equal(await findSubagentCanonicalGitRoot(nested), repo);

			writeFileSync(join(malformed, ".git"), "missing-prefix: ../foreign\n");
			assert.equal(await resolveSubagentMainRepoRoot(malformed), undefined);
			writeFileSync(join(malformed, ".git"), "gitdir:   \n");
			assert.equal(await resolveSubagentMainRepoRoot(malformed), undefined);
			writeFileSync(join(malformed, ".git"), "gitdir: ../foreign/admin\n");
			assert.equal(await resolveSubagentMainRepoRoot(malformed), undefined);

			await runGitChecked(foreign.repo, ["worktree", "add", "--detach", foreign.worktree]);
			writeFileSync(join(malformed, ".git"), readFileSync(join(foreign.worktree, ".git")));
			assert.equal(await resolveSubagentMainRepoRoot(malformed), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(foreign.root, { recursive: true, force: true });
		}
	});
});
