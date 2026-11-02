import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { describe, test } from "vitest";
import {
	createGitWorktreeSetupCache,
	type GitRunner,
	runGitChecked,
	setupGitWorktree,
	withGitRunnerForTest,
	withWorktreeBucketIdsForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import type { GitResult } from "../../packages/workflows/src/runs/shared/worktree-types.js";

const BUCKET = /^[0-9a-f]{4}$/;

function createScratch(): string {
	return realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-any-repo-")));
}

function createGitRepo(root: string, name: string): string {
	const repo = join(root, name);
	mkdirSync(repo);
	runGitChecked(repo, ["init", "-b", "main"]);
	runGitChecked(repo, ["config", "user.email", "test@example.com"]);
	runGitChecked(repo, ["config", "user.name", "Test User"]);
	runGitChecked(repo, ["config", "commit.gpgsign", "false"]);
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	writeFileSync(join(repo, "packages", "api", "index.txt"), `${name}\n`);
	runGitChecked(repo, ["add", "."]);
	runGitChecked(repo, ["commit", "-m", "initial"]);
	runGitChecked(repo, ["checkout", "-b", "feature"]);
	writeFileSync(join(repo, "feature-only.txt"), "feature\n");
	runGitChecked(repo, ["add", "feature-only.txt"]);
	runGitChecked(repo, ["commit", "-m", "feature"]);
	runGitChecked(repo, ["checkout", "main"]);
	return repo;
}

function createNonEmptyRoot(root: string): string {
	const worktreeRoot = join(root, "worktrees");
	mkdirSync(worktreeRoot);
	writeFileSync(join(worktreeRoot, "notes.txt"), "keep me\n");
	return worktreeRoot;
}

function buckets(worktreeRoot: string): string[] {
	return readdirSync(worktreeRoot)
		.filter((entry) => BUCKET.test(entry))
		.sort();
}

function registeredWorktrees(repo: string): string[] {
	return runGitChecked(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => realpathSync.native(line.slice("worktree ".length)));
}

/** Run real Git, except for the commands `fail` selects. */
function realGitExcept(fail: (args: readonly string[]) => boolean): GitRunner {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return (cwd, args): GitResult => {
		if (fail(args)) return { stdout: "", stderr: "fatal: simulated failure", status: 128, signal: null };
		const result = spawnSync("git", [...args], { cwd, encoding: "utf-8", env });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
			signal: result.signal,
			...(result.error === undefined ? {} : { error: result.error }),
		};
	};
}

describe("gitWorktreeDir reuses existing worktrees of any repository", () => {
	test("reuses another repository's linked worktree from a different repository's cwd", () => {
		const root = createScratch();
		try {
			const invoking = createGitRepo(root, "invoking");
			const other = createGitRepo(root, "other");
			const otherWorktree = join(root, "other-wt");
			runGitChecked(other, ["worktree", "add", "--detach", otherWorktree]);
			const cache = createGitWorktreeSetupCache("run-cross-repo");
			try {
				const options = { cwd: join(invoking, "packages", "api"), gitWorktreeDir: otherWorktree };
				const setup = cache.get(options);
				assert.deepEqual(setup, {
					worktreeRoot: otherWorktree,
					cwd: otherWorktree,
					repositoryRoot: otherWorktree,
					created: false,
				});
				assert.equal(cache.get(options), setup);
			} finally {
				cache.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reuses linked and main checkouts from a cwd outside any Git repository", () => {
		const root = createScratch();
		try {
			const other = createGitRepo(root, "other");
			const otherWorktree = join(root, "other-wt");
			runGitChecked(other, ["worktree", "add", "--detach", otherWorktree]);
			const plainCwd = join(root, "plain");
			mkdirSync(plainCwd);

			const linked = setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: "../other-wt" });
			assert.equal(linked.created, false);
			assert.equal(linked.worktreeRoot, otherWorktree);
			assert.equal(linked.cwd, otherWorktree);
			assert.equal(linked.repositoryRoot, otherWorktree);

			const main = setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: other });
			assert.equal(main.worktreeRoot, other);
			assert.equal(main.cwd, other);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("still rejects subdirectories of an existing worktree from a non-Git cwd", () => {
		const root = createScratch();
		try {
			const other = createGitRepo(root, "other");
			const plainCwd = join(root, "plain");
			mkdirSync(plainCwd);
			assert.throws(
				() => setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: join(other, "packages") }),
				/already exists but is not a Git worktree root/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("explains that creating a worktree needs a Git cwd and suggests an existing worktree", () => {
		const root = createScratch();
		try {
			const plainCwd = join(root, "plain");
			mkdirSync(plainCwd);
			assert.throws(
				() => setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: join(root, "missing-wt") }),
				/requires the workflow to be invoked from inside a Git repository to create a new worktree at .*existing Git worktree/,
			);
			assert.throws(
				() => setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: createNonEmptyRoot(root) }),
				/requires the workflow to be invoked from inside a Git repository to create a new worktree under .*existing Git worktree/,
			);
			assert.equal(existsSync(join(root, "missing-wt")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("gitWorktreeDir creates worktrees in empty and non-empty directories", () => {
	test("creates the worktree directly in an existing empty directory", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const empty = join(root, "empty-wt");
			mkdirSync(empty);
			const setup = setupGitWorktree({
				cwd: join(repo, "packages", "api"),
				gitWorktreeDir: empty,
				baseBranch: "feature",
			});
			assert.equal(setup.created, true);
			assert.equal(setup.worktreeRoot, empty);
			assert.equal(setup.cwd, join(empty, "packages", "api"));
			assert.equal(existsSync(join(empty, "feature-only.txt")), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("allocates a bucketed checkout from base_branch inside a non-empty non-Git directory", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const worktreeRoot = createNonEmptyRoot(root);
			const setup = setupGitWorktree({
				cwd: join(repo, "packages", "api"),
				gitWorktreeDir: worktreeRoot,
				baseBranch: "feature",
			});
			const [bucket] = buckets(worktreeRoot);
			assert.ok(bucket, "expected one allocated bucket");
			const checkout = join(worktreeRoot, bucket, "repo");
			assert.deepEqual(setup, {
				worktreeRoot: checkout,
				cwd: join(checkout, "packages", "api"),
				repositoryRoot: repo,
				created: true,
			});
			assert.equal(existsSync(join(checkout, "feature-only.txt")), true);
			assert.equal(runGitChecked(checkout, ["status", "--porcelain"]).trim(), "");
			assert.equal(
				runGitChecked(checkout, ["rev-parse", "HEAD"]).trim(),
				runGitChecked(repo, ["rev-parse", "feature"]).trim(),
			);
			assert.equal(readFileSync(join(worktreeRoot, "notes.txt"), "utf8"), "keep me\n");
			assert.ok(registeredWorktrees(repo).includes(checkout));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("retries bucket allocation when a bucket already exists", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const worktreeRoot = createNonEmptyRoot(root);
			mkdirSync(join(worktreeRoot, "aaaa"));
			writeFileSync(join(worktreeRoot, "aaaa", "other.txt"), "someone else\n");
			const ids = ["aaaa", "bbbb"];
			const setup = withWorktreeBucketIdsForTest(
				() => ids.shift() ?? "cccc",
				() => setupGitWorktree({ cwd: repo, gitWorktreeDir: worktreeRoot }),
			);
			assert.equal(setup.worktreeRoot, join(worktreeRoot, "bbbb", "repo"));
			assert.deepEqual(readdirSync(join(worktreeRoot, "aaaa")), ["other.txt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rolls back the bucket when git worktree add fails", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const worktreeRoot = createNonEmptyRoot(root);
			const before = registeredWorktrees(repo);
			assert.throws(
				() =>
					withGitRunnerForTest(
						realGitExcept((args) => args[0] === "worktree" && args[1] === "add"),
						() => setupGitWorktree({ cwd: repo, gitWorktreeDir: worktreeRoot }),
					),
				/Failed to create git worktree at .* under gitWorktreeDir .*simulated failure/,
			);
			assert.deepEqual(readdirSync(worktreeRoot), ["notes.txt"]);
			assert.deepEqual(registeredWorktrees(repo), before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rolls back the checkout when the base lacks the invoking subdirectory", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const untracked = join(repo, "untracked-only");
			mkdirSync(untracked);
			const worktreeRoot = createNonEmptyRoot(root);
			const before = registeredWorktrees(repo);
			assert.throws(
				() => setupGitWorktree({ cwd: untracked, gitWorktreeDir: worktreeRoot }),
				/does not contain a working directory untracked-only/,
			);
			assert.deepEqual(readdirSync(worktreeRoot), ["notes.txt"]);
			assert.deepEqual(registeredWorktrees(repo), before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("one run reuses its allocated checkout across caches while other runs get their own", () => {
		const root = createScratch();
		try {
			const repo = createGitRepo(root, "repo");
			const worktreeRoot = createNonEmptyRoot(root);
			const options = { cwd: join(repo, "packages", "api"), gitWorktreeDir: worktreeRoot };
			const first = createGitWorktreeSetupCache("run-a");
			const resumed = createGitWorktreeSetupCache("run-a");
			const other = createGitWorktreeSetupCache("run-b");
			try {
				const original = first.get(options);
				assert.equal(original.created, true);
				assert.equal(first.get(options), original, "later stages of the run share one checkout");

				const afterResume = resumed.get(options);
				assert.equal(afterResume.created, false);
				assert.equal(afterResume.worktreeRoot, original.worktreeRoot);
				assert.equal(afterResume.cwd, original.cwd);

				const separate = other.get(options);
				assert.equal(separate.created, true);
				assert.notEqual(separate.worktreeRoot, original.worktreeRoot);
				assert.equal(buckets(worktreeRoot).length, 2);
				assert.equal(basename(separate.worktreeRoot), "repo");
				assert.ok(BUCKET.test(basename(dirname(separate.worktreeRoot))));
				assert.equal(relative(worktreeRoot, dirname(dirname(separate.worktreeRoot))), "");
			} finally {
				first.dispose();
				resumed.dispose();
				other.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("gitWorktreeDir never creates or reuses a checkout inside Git metadata", () => {
	interface MetadataFixture {
		readonly root: string;
		readonly invoking: string;
		/** Main-checkout `.git` of another repository. */
		readonly otherGitDir: string;
		/** Linked-worktree admin directory of another repository. */
		readonly adminDir: string;
		/** Bare repository. */
		readonly bare: string;
	}

	function createMetadataFixture(): MetadataFixture {
		const root = createScratch();
		const invoking = createGitRepo(root, "invoking");
		const other = createGitRepo(root, "other");
		runGitChecked(other, ["worktree", "add", "--detach", join(root, "other-linked")]);
		const adminDir = runGitChecked(join(root, "other-linked"), ["rev-parse", "--absolute-git-dir"]).trim();
		const bare = join(root, "bare.git");
		runGitChecked(root, ["clone", "--bare", "--quiet", other, bare]);
		return { root, invoking, otherGitDir: join(other, ".git"), adminDir: realpathSync.native(adminDir), bare };
	}

	/** Snapshot every path below `directory`, so a rejected setup can be shown to have written nothing. */
	function tree(directory: string): string[] {
		return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
	}

	function assertRejectedWithoutWrites(fixture: MetadataFixture, gitWorktreeDir: string, watched: string): void {
		const before = tree(watched);
		const worktreesBefore = registeredWorktrees(fixture.invoking);
		assert.throws(
			() => setupGitWorktree({ cwd: join(fixture.invoking, "packages", "api"), gitWorktreeDir }),
			/gitWorktreeDir must not be inside Git metadata/,
		);
		assert.deepEqual(tree(watched), before);
		assert.deepEqual(registeredWorktrees(fixture.invoking), worktreesBefore);
	}

	function emptyDirectory(parent: string, name: string): string {
		const directory = join(parent, name);
		mkdirSync(directory, { recursive: true });
		assert.deepEqual(readdirSync(directory), []);
		return directory;
	}

	test("rejects an empty directory under another repository's .git/objects/info", () => {
		const fixture = createMetadataFixture();
		try {
			const target = join(fixture.otherGitDir, "objects", "info");
			assert.deepEqual(readdirSync(target), []);
			assertRejectedWithoutWrites(fixture, target, fixture.otherGitDir);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects an empty directory under a linked worktree's admin directory", () => {
		const fixture = createMetadataFixture();
		try {
			const target = emptyDirectory(fixture.adminDir, "empty");
			assertRejectedWithoutWrites(fixture, target, fixture.adminDir);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects an empty directory inside a bare repository", () => {
		const fixture = createMetadataFixture();
		try {
			const target = emptyDirectory(fixture.bare, "empty");
			assertRejectedWithoutWrites(fixture, target, fixture.bare);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects allocating a checkout inside non-empty Git metadata directories", () => {
		const fixture = createMetadataFixture();
		try {
			assertRejectedWithoutWrites(fixture, join(fixture.otherGitDir, "objects"), fixture.otherGitDir);
			assertRejectedWithoutWrites(fixture, fixture.adminDir, fixture.adminDir);
			assertRejectedWithoutWrites(fixture, fixture.bare, fixture.bare);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects creating a missing path inside Git metadata directories", () => {
		const fixture = createMetadataFixture();
		try {
			const cases = [
				[join(fixture.otherGitDir, "objects", "info", "new-wt"), fixture.otherGitDir],
				[join(fixture.adminDir, "new-wt"), fixture.adminDir],
				[join(fixture.bare, "new-wt"), fixture.bare],
			] as const;
			for (const [target, watched] of cases) {
				assertRejectedWithoutWrites(fixture, target, watched);
				assert.equal(existsSync(target), false);
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects Git metadata from a cwd outside any Git repository", () => {
		const fixture = createMetadataFixture();
		try {
			const plainCwd = emptyDirectory(fixture.root, "plain");
			for (const target of [join(fixture.otherGitDir, "objects", "info"), fixture.adminDir, fixture.bare]) {
				assert.throws(
					() => setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: target }),
					/gitWorktreeDir must not be inside Git metadata/,
				);
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
