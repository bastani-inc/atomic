import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
	findCanonicalGitRoot as findSubagentCanonicalGitRoot,
	findGitRoot as findSubagentGitRoot,
	resolveMainRepoRoot as resolveSubagentMainRepoRoot,
} from "../../packages/subagents/src/runs/shared/worktree-root.js";
import { createGitWorktreeSetupCacheOwner } from "../../packages/workflows/src/runs/shared/worktree-cache-lifecycle.js";
import {
	resolveWorktreeStageCwd,
	resolveWorktreeStageCwdAsync,
} from "../../packages/workflows/src/runs/shared/worktree-cwd.js";
import {
	createGitWorktreeSetupCache,
	type GitRunner,
	gitFailureMessage,
	runGitChecked,
	setupGitWorktree,
	withGitRunnerForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import {
	findCanonicalGitRoot,
	findGitRoot,
	resolveMainRepoRoot,
} from "../../packages/workflows/src/runs/shared/worktree-root.js";
import type { GitResult } from "../../packages/workflows/src/runs/shared/worktree-types.js";

function successfulGit(stdout = ""): GitResult {
	return { stdout, stderr: "", status: 0, signal: null, elapsedMs: 1 };
}

function timedOutGit(): GitResult {
	const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
	return { stdout: "", stderr: "", status: null, signal: null, elapsedMs: 60_001, error };
}

function notARepositoryGit(): GitResult {
	return { stdout: "", stderr: "fatal: not a git repository", status: 128, signal: null, elapsedMs: 1 };
}

function failingGit(args: readonly string[]): GitResult {
	return { stdout: "", stderr: `unexpected fake git call: ${args.join(" ")}`, status: 1, signal: null, elapsedMs: 1 };
}

function createRepoShape(): { readonly root: string; readonly repo: string; readonly sourceCwd: string } {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-git-test-")));
	const repo = join(root, "repo");
	const sourceCwd = join(repo, "packages", "api");
	mkdirSync(sourceCwd, { recursive: true });
	mkdirSync(join(repo, ".git"));
	return { root, repo, sourceCwd };
}

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

function isArgs(args: readonly string[], expected: readonly string[]): boolean {
	return args.length === expected.length && args.every((value, index) => value === expected[index]);
}
describe("canonical main Git root parser", () => {
	test("finds a main checkout and handles cwd-is-a-file", async () => {
		const { root, repo } = await createGitRepository();
		const file = join(repo, "tracked.txt");
		try {
			assert.equal(await findGitRoot(file), repo);
			assert.equal(await resolveMainRepoRoot(repo), repo);
			assert.equal(await findCanonicalGitRoot(file), repo);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("resolves a linked pointer and nested cwd without invoking Git", async () => {
		const { root, repo, worktree } = await createGitRepository();
		try {
			await runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
			const nested = join(worktree, "nested", "deeper");
			mkdirSync(nested, { recursive: true });
			assert.equal(await findGitRoot(nested), worktree);
			assert.equal(await resolveMainRepoRoot(worktree), repo);
			assert.equal(await findCanonicalGitRoot(nested), repo);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects missing-prefix, empty, and non-worktrees pointers", async () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-pointer-test-")));
		const checkout = join(root, "checkout");
		mkdirSync(checkout);
		try {
			writeFileSync(join(checkout, ".git"), "not-gitdir: ../foreign\n");
			assert.equal(await resolveMainRepoRoot(checkout), undefined);
			writeFileSync(join(checkout, ".git"), "gitdir:   \n");
			assert.equal(await resolveMainRepoRoot(checkout), undefined);
			writeFileSync(join(checkout, ".git"), "gitdir: ../foreign/admin\n");
			assert.equal(await resolveMainRepoRoot(checkout), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a pointer escaping to a foreign repository worktree", async () => {
		const first = await createGitRepository();
		const foreign = await createGitRepository();
		const fake = join(first.root, "fake-linked");
		mkdirSync(fake);
		try {
			await runGitChecked(foreign.repo, ["worktree", "add", "--detach", foreign.worktree]);
			writeFileSync(join(fake, ".git"), readFileSync(join(foreign.worktree, ".git")));
			assert.equal(await resolveMainRepoRoot(fake), undefined);
		} finally {
			rmSync(first.root, { recursive: true, force: true });
			rmSync(foreign.root, { recursive: true, force: true });
		}
	});

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

describe("workflow reusable git worktree git runner", () => {
	test("formats timeout diagnostics with command cwd timeout elapsed status and signal", () => {
		const message = gitFailureMessage({
			...timedOutGit(),
			argv: ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
			cwd: "/repo with spaces",
			timeoutMs: 60_000,
			elapsedMs: 60_123,
		});

		assert.match(message, /git command timed out after 60000ms \(ETIMEDOUT\)/);
		assert.match(
			message,
			/command: git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false rev-parse --show-toplevel/,
		);
		assert.match(message, /cwd: \/repo with spaces/);
		assert.match(message, /timeout: 60000ms/);
		assert.match(message, /elapsed: 60123ms/);
		assert.match(message, /status: null/);
		assert.match(message, /signal: null/);
	});

	test("retries transient rev-parse timeouts before creating a missing worktree", () => {
		const { root, repo, sourceCwd } = createRepoShape();
		const worktree = join(root, "transient-wt");
		const commonDir = join(root, "common.git");
		mkdirSync(commonDir);
		let sourceTopLevelCalls = 0;
		const runner: GitRunner = (cwd, args) => {
			if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
				if (cwd === sourceCwd) {
					sourceTopLevelCalls += 1;
					return sourceTopLevelCalls === 1 ? timedOutGit() : successfulGit(`${repo}\n`);
				}
				return cwd === worktree ? successfulGit(`${worktree}\n`) : notARepositoryGit();
			}
			if (isArgs(args, ["rev-parse", "--git-common-dir"])) return successfulGit(`${commonDir}\n`);
			if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) {
				mkdirSync(worktree);
				return successfulGit();
			}
			return failingGit(args);
		};

		try {
			const setup = withGitRunnerForTest(runner, () =>
				setupGitWorktree({
					cwd: sourceCwd,
					gitWorktreeDir: "../transient-wt",
					baseBranch: "main",
				}),
			);

			assert.equal(setup.created, true);
			assert.equal(setup.repositoryRoot, repo);
			assert.equal(setup.worktreeRoot, join(root, "transient-wt"));
			assert.equal(setup.cwd, join(root, "transient-wt", "packages", "api"));
			assert.equal(sourceTopLevelCalls, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("caches setup and revalidates checkout identity within a run", async () => {
		const { root, repo, sourceCwd } = createRepoShape();
		const worktree = join(root, "cached-wt");
		const commonDir = join(root, "common.git");
		const worktreeGitDir = join(root, "cached-wt.git");
		mkdirSync(commonDir);
		mkdirSync(worktreeGitDir);
		let worktreeAddCalls = 0;
		let identityProbeCalls = 0;
		const runner: GitRunner = (cwd, args) => {
			if (isArgs(args, ["rev-parse", "--show-toplevel"])) {
				if (cwd === sourceCwd) return successfulGit(`${repo}\n`);
				return cwd === worktree ? successfulGit(`${worktree}\n`) : notARepositoryGit();
			}
			if (isArgs(args, ["rev-parse", "--git-common-dir"])) {
				identityProbeCalls += 1;
				return successfulGit(`${commonDir}\n`);
			}
			if (isArgs(args, ["rev-parse", "--absolute-git-dir"])) {
				identityProbeCalls += 1;
				return successfulGit(`${worktreeGitDir}\n`);
			}
			if (isArgs(args.slice(0, 3), ["worktree", "add", "--detach"])) {
				worktreeAddCalls += 1;
				mkdirSync(worktree);
				writeFileSync(join(worktree, ".git"), "gitdir: ../cached-wt.git\n");
				return successfulGit();
			}
			return failingGit(args);
		};

		const cache = createGitWorktreeSetupCache();
		try {
			await withGitRunnerForTest(runner, async () => {
				const options = { cwd: sourceCwd, gitWorktreeDir: "../cached-wt", baseBranch: "main" };
				const setup = await cache.get(options);
				assert.equal(setup.cwd, join(root, "cached-wt", "packages", "api"));
				assert.equal(await cache.get(options), setup);
			});
			assert.equal(worktreeAddCalls, 1);
			assert.ok(identityProbeCalls > 0, "cache reuse should probe the selected checkout identity");
		} finally {
			await cache.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects cache reuse when a byte-identical .git file replaces the cached checkout generation", async () => {
		const { root, repo, worktree } = await createGitRepository();
		const cache = createGitWorktreeSetupCache();
		try {
			await cache.get({ cwd: repo, gitWorktreeDir: worktree });
			const before = statSync(worktree);
			const gitFile = join(worktree, ".git");
			const gitFileContents = readFileSync(gitFile);

			renameSync(gitFile, `${gitFile}.replaced`);
			writeFileSync(gitFile, gitFileContents);

			const after = statSync(worktree);
			assert.equal(after.dev, before.dev, "replacement should retain the cached root device");
			assert.equal(after.ino, before.ino, "replacement should retain the cached root inode");
			await assert.rejects(
				async () => await cache.get({ cwd: repo, gitWorktreeDir: worktree }),
				/Cached gitWorktreeDir changed before reuse:/,
			);
		} finally {
			await cache.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("disposes cached checkout anchors idempotently before worktree cleanup", async () => {
		const { root, repo, worktree } = await createGitRepository();
		const cache = createGitWorktreeSetupCache();
		try {
			await cache.get({ cwd: repo, gitWorktreeDir: worktree });
			await cache.dispose();
			await assert.doesNotReject(async () => await cache.dispose());
			await assert.rejects(
				async () => await cache.get({ cwd: repo, gitWorktreeDir: worktree }),
				/cache is already disposed/,
			);
			await runGitChecked(repo, ["worktree", "remove", "--force", worktree]);
		} finally {
			await cache.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("leaves a supplied setup cache open when its engine owner is released", async () => {
		const { root, repo, worktree } = await createGitRepository();
		const cache = createGitWorktreeSetupCache();
		const owner = createGitWorktreeSetupCacheOwner(cache);
		let finalized = false;
		try {
			await owner.release(() => {
				finalized = true;
			});
			assert.equal(finalized, true);
			assert.equal((await cache.get({ cwd: repo, gitWorktreeDir: worktree })).worktreeRoot, worktree);
		} finally {
			await cache.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("supports the main checkout as a reusable target from a linked invocation", async () => {
		const { root, repo } = await createGitRepository();
		const linkedSource = join(root, "linked-source");
		const cache = createGitWorktreeSetupCache();
		try {
			await runGitChecked(repo, ["worktree", "add", "--detach", linkedSource]);
			const options = { cwd: linkedSource, gitWorktreeDir: repo };
			const setup = await cache.get(options);
			assert.equal(setup.created, false);
			assert.equal(setup.worktreeRoot, repo);
			assert.equal(await cache.get(options), setup);
		} finally {
			await cache.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("creates a missing reusable target from the main root when invoked inside a linked worktree", async () => {
		const { root, repo } = await createGitRepository();
		const linkedSource = join(root, "linked-source");
		const reusable = join(root, "reusable-from-linked");
		try {
			await runGitChecked(repo, ["worktree", "add", "--detach", linkedSource]);
			const nested = join(linkedSource, "packages", "api");
			mkdirSync(nested, { recursive: true });
			const setup = setupGitWorktree({ cwd: nested, gitWorktreeDir: reusable, baseBranch: "main" });
			assert.equal(setup.created, true);
			assert.equal(setup.repositoryRoot, linkedSource);
			assert.equal(setup.worktreeRoot, reusable);
			assert.equal(setup.cwd, join(reusable, "packages", "api"));
			assert.equal(await findCanonicalGitRoot(reusable), repo);
			await runGitChecked(repo, ["worktree", "remove", "--force", reusable]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("resolves worktree stage cwd asynchronously with the same containment checks as the sync helper", async () => {
		const { root, repo, worktree } = await createGitRepository();
		try {
			await runGitChecked(repo, ["worktree", "add", "--detach", worktree]);
			mkdirSync(join(repo, "packages", "api"), { recursive: true });
			mkdirSync(join(worktree, "packages", "api"), { recursive: true });
			const setup = {
				created: false,
				repositoryRoot: repo,
				worktreeRoot: worktree,
				cwd: worktree,
			};
			assert.equal(await resolveWorktreeStageCwdAsync(undefined, setup), resolveWorktreeStageCwd(undefined, setup));
			assert.equal(
				await resolveWorktreeStageCwdAsync("packages/api", setup),
				resolveWorktreeStageCwd("packages/api", setup),
			);
			assert.equal(
				await resolveWorktreeStageCwdAsync(join(repo, "packages", "api"), setup),
				resolveWorktreeStageCwd(join(repo, "packages", "api"), setup),
			);
			await assert.rejects(() => resolveWorktreeStageCwdAsync("../outside", setup), /escapes gitWorktreeDir/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
