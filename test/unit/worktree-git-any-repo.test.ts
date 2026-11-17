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
	setupGitWorktreeCached,
	withGitRunnerForTest,
	withWorktreeBucketIdsForTest,
} from "../../packages/workflows/src/runs/shared/worktree-git.js";
import type {
	GitResult,
	GitWorktreeSetupOptions,
	GitWorktreeSetupResult,
} from "../../packages/workflows/src/runs/shared/worktree-types.js";

/** The SDK's synchronous setup and the engine's non-blocking one run the same steps; each scenario runs on both. */
const SETUP_DRIVERS: ReadonlyArray<
	readonly [string, (options: GitWorktreeSetupOptions) => Promise<GitWorktreeSetupResult>]
> = [
	["the synchronous SDK setup", async (options) => setupGitWorktree(options)],
	["the engine's non-blocking setup", (options) => setupGitWorktreeCached(options)],
];

const BUCKET = /^[0-9a-f]{4}$/;

function createScratch(): string {
	return realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-worktree-any-repo-")));
}

async function createGitRepo(root: string, name: string): Promise<string> {
	const repo = join(root, name);
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.email", "test@example.com"]);
	await runGitChecked(repo, ["config", "user.name", "Test User"]);
	await runGitChecked(repo, ["config", "commit.gpgsign", "false"]);
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	writeFileSync(join(repo, "packages", "api", "index.txt"), `${name}\n`);
	await runGitChecked(repo, ["add", "."]);
	await runGitChecked(repo, ["commit", "-m", "initial"]);
	await runGitChecked(repo, ["checkout", "-b", "feature"]);
	writeFileSync(join(repo, "feature-only.txt"), "feature\n");
	await runGitChecked(repo, ["add", "feature-only.txt"]);
	await runGitChecked(repo, ["commit", "-m", "feature"]);
	await runGitChecked(repo, ["checkout", "main"]);
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

async function registeredWorktrees(repo: string): Promise<string[]> {
	return (await runGitChecked(repo, ["worktree", "list", "--porcelain"]))
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
	test("reuses another repository's linked worktree from a different repository's cwd", async () => {
		const root = createScratch();
		try {
			const invoking = await createGitRepo(root, "invoking");
			const other = await createGitRepo(root, "other");
			const otherWorktree = join(root, "other-wt");
			await runGitChecked(other, ["worktree", "add", "--detach", otherWorktree]);
			const cache = createGitWorktreeSetupCache("run-cross-repo");
			try {
				const options = { cwd: join(invoking, "packages", "api"), gitWorktreeDir: otherWorktree };
				const setup = await cache.get(options);
				assert.deepEqual(setup, {
					worktreeRoot: otherWorktree,
					cwd: otherWorktree,
					repositoryRoot: otherWorktree,
					created: false,
				});
				assert.equal(await cache.get(options), setup);
			} finally {
				await cache.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reuses linked and main checkouts from a cwd outside any Git repository", async () => {
		const root = createScratch();
		try {
			const other = await createGitRepo(root, "other");
			const otherWorktree = join(root, "other-wt");
			await runGitChecked(other, ["worktree", "add", "--detach", otherWorktree]);
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

	test("still rejects subdirectories of an existing worktree from a non-Git cwd", async () => {
		const root = createScratch();
		try {
			const other = await createGitRepo(root, "other");
			const plainCwd = join(root, "plain");
			mkdirSync(plainCwd);
			assert.throws(
				() => setupGitWorktree({ cwd: plainCwd, gitWorktreeDir: join(other, "packages") }),
				/gitWorktreeDir must not be inside another Git working tree/,
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

describe.each(SETUP_DRIVERS)(
	"gitWorktreeDir creates worktrees in empty and non-empty directories through %s",
	(_driver, setup) => {
		test("creates the worktree directly in an existing empty directory", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const empty = join(root, "empty-wt");
				mkdirSync(empty);
				const created = await setup({
					cwd: join(repo, "packages", "api"),
					gitWorktreeDir: empty,
					baseBranch: "feature",
				});
				assert.equal(created.created, true);
				assert.equal(created.worktreeRoot, empty);
				assert.equal(created.cwd, join(empty, "packages", "api"));
				assert.equal(existsSync(join(empty, "feature-only.txt")), true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test("allocates a bucketed checkout from base_branch inside a non-empty non-Git directory", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const worktreeRoot = createNonEmptyRoot(root);
				const created = await setup({
					cwd: join(repo, "packages", "api"),
					gitWorktreeDir: worktreeRoot,
					baseBranch: "feature",
				});
				const [bucket] = buckets(worktreeRoot);
				assert.ok(bucket, "expected one allocated bucket");
				const checkout = join(worktreeRoot, bucket, "repo");
				assert.deepEqual(created, {
					worktreeRoot: checkout,
					cwd: join(checkout, "packages", "api"),
					repositoryRoot: repo,
					created: true,
				});
				assert.equal(existsSync(join(checkout, "feature-only.txt")), true);
				assert.equal((await runGitChecked(checkout, ["status", "--porcelain"])).trim(), "");
				assert.equal(
					(await runGitChecked(checkout, ["rev-parse", "HEAD"])).trim(),
					(await runGitChecked(repo, ["rev-parse", "feature"])).trim(),
				);
				assert.equal(readFileSync(join(worktreeRoot, "notes.txt"), "utf8"), "keep me\n");
				assert.ok((await registeredWorktrees(repo)).includes(checkout));
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test("retries bucket allocation when a bucket already exists", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const worktreeRoot = createNonEmptyRoot(root);
				mkdirSync(join(worktreeRoot, "aaaa"));
				writeFileSync(join(worktreeRoot, "aaaa", "other.txt"), "someone else\n");
				const ids = ["aaaa", "bbbb"];
				const created = await withWorktreeBucketIdsForTest(
					() => ids.shift() ?? "cccc",
					() => setup({ cwd: repo, gitWorktreeDir: worktreeRoot }),
				);
				assert.equal(created.worktreeRoot, join(worktreeRoot, "bbbb", "repo"));
				assert.deepEqual(readdirSync(join(worktreeRoot, "aaaa")), ["other.txt"]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test("rolls back the bucket when git worktree add fails", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const worktreeRoot = createNonEmptyRoot(root);
				const before = await registeredWorktrees(repo);
				await assert.rejects(
					() =>
						withGitRunnerForTest(
							realGitExcept((args) => args[0] === "worktree" && args[1] === "add"),
							() => setup({ cwd: repo, gitWorktreeDir: worktreeRoot }),
						),
					/Failed to create git worktree at .* under gitWorktreeDir .*simulated failure/,
				);
				assert.deepEqual(readdirSync(worktreeRoot), ["notes.txt"]);
				assert.deepEqual(await registeredWorktrees(repo), before);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test("a run started in a subdirectory named '..sub' works in that subdirectory of the worktree (#4836)", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const dotted = join(repo, "..sub");
				mkdirSync(dotted);
				writeFileSync(join(dotted, "file.txt"), "dotted\n");
				await runGitChecked(repo, ["add", "."]);
				await runGitChecked(repo, ["commit", "-m", "dotted subdirectory"]);
				const worktreeRoot = createNonEmptyRoot(root);
				const created = await setup({ cwd: dotted, gitWorktreeDir: worktreeRoot });
				assert.equal(created.cwd, join(created.worktreeRoot, "..sub"));
				assert.equal(readFileSync(join(created.cwd, "file.txt"), "utf8").replaceAll("\r\n", "\n"), "dotted\n");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test("rolls back the checkout when the base lacks the invoking subdirectory", async () => {
			const root = createScratch();
			try {
				const repo = await createGitRepo(root, "repo");
				const untracked = join(repo, "untracked-only");
				mkdirSync(untracked);
				const worktreeRoot = createNonEmptyRoot(root);
				const before = await registeredWorktrees(repo);
				await assert.rejects(
					() => setup({ cwd: untracked, gitWorktreeDir: worktreeRoot }),
					/does not contain a working directory untracked-only/,
				);
				assert.deepEqual(readdirSync(worktreeRoot), ["notes.txt"]);
				assert.deepEqual(await registeredWorktrees(repo), before);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	},
);

describe("gitWorktreeDir allocations under a non-empty directory belong to their run", () => {
	test("one run reuses its allocated checkout across caches while other runs get their own", async () => {
		const root = createScratch();
		try {
			const repo = await createGitRepo(root, "repo");
			const worktreeRoot = createNonEmptyRoot(root);
			const options = { cwd: join(repo, "packages", "api"), gitWorktreeDir: worktreeRoot };
			const first = createGitWorktreeSetupCache("run-a");
			const resumed = createGitWorktreeSetupCache("run-a");
			const other = createGitWorktreeSetupCache("run-b");
			try {
				const original = await first.get(options);
				assert.equal(original.created, true);
				assert.equal(await first.get(options), original, "later stages of the run share one checkout");

				const afterResume = await resumed.get(options);
				assert.equal(afterResume.created, false);
				assert.equal(afterResume.worktreeRoot, original.worktreeRoot);
				assert.equal(afterResume.cwd, original.cwd);

				const separate = await other.get(options);
				assert.equal(separate.created, true);
				assert.notEqual(separate.worktreeRoot, original.worktreeRoot);
				assert.equal(buckets(worktreeRoot).length, 2);
				assert.equal(basename(separate.worktreeRoot), "repo");
				assert.ok(BUCKET.test(basename(dirname(separate.worktreeRoot))));
				assert.equal(relative(worktreeRoot, dirname(dirname(separate.worktreeRoot))), "");
			} finally {
				await first.dispose();
				await resumed.dispose();
				await other.dispose();
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

	async function createMetadataFixture(): Promise<MetadataFixture> {
		const root = createScratch();
		const invoking = await createGitRepo(root, "invoking");
		const other = await createGitRepo(root, "other");
		await runGitChecked(other, ["worktree", "add", "--detach", join(root, "other-linked")]);
		const adminDir = (await runGitChecked(join(root, "other-linked"), ["rev-parse", "--absolute-git-dir"])).trim();
		const bare = join(root, "bare.git");
		await runGitChecked(root, ["clone", "--bare", "--quiet", other, bare]);
		return { root, invoking, otherGitDir: join(other, ".git"), adminDir: realpathSync.native(adminDir), bare };
	}

	/** Snapshot every path below `directory`, so a rejected setup can be shown to have written nothing. */
	function tree(directory: string): string[] {
		return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
	}

	async function assertRejectedWithoutWrites(
		fixture: MetadataFixture,
		gitWorktreeDir: string,
		watched: string,
	): Promise<void> {
		const before = tree(watched);
		const worktreesBefore = await registeredWorktrees(fixture.invoking);
		assert.throws(
			() => setupGitWorktree({ cwd: join(fixture.invoking, "packages", "api"), gitWorktreeDir }),
			/gitWorktreeDir must not be inside Git metadata/,
		);
		assert.deepEqual(tree(watched), before);
		assert.deepEqual(await registeredWorktrees(fixture.invoking), worktreesBefore);
	}

	function emptyDirectory(parent: string, name: string): string {
		const directory = join(parent, name);
		mkdirSync(directory, { recursive: true });
		assert.deepEqual(readdirSync(directory), []);
		return directory;
	}

	test("rejects an empty directory under another repository's .git/objects/info", async () => {
		const fixture = await createMetadataFixture();
		try {
			const target = join(fixture.otherGitDir, "objects", "info");
			assert.deepEqual(readdirSync(target), []);
			await assertRejectedWithoutWrites(fixture, target, fixture.otherGitDir);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects an empty directory under a linked worktree's admin directory", async () => {
		const fixture = await createMetadataFixture();
		try {
			const target = emptyDirectory(fixture.adminDir, "empty");
			await assertRejectedWithoutWrites(fixture, target, fixture.adminDir);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects an empty directory inside a bare repository", async () => {
		const fixture = await createMetadataFixture();
		try {
			const target = emptyDirectory(fixture.bare, "empty");
			await assertRejectedWithoutWrites(fixture, target, fixture.bare);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects allocating a checkout inside non-empty Git metadata directories", async () => {
		const fixture = await createMetadataFixture();
		try {
			await assertRejectedWithoutWrites(fixture, join(fixture.otherGitDir, "objects"), fixture.otherGitDir);
			await assertRejectedWithoutWrites(fixture, fixture.adminDir, fixture.adminDir);
			await assertRejectedWithoutWrites(fixture, fixture.bare, fixture.bare);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects creating a missing path inside Git metadata directories", async () => {
		const fixture = await createMetadataFixture();
		try {
			const cases = [
				[join(fixture.otherGitDir, "objects", "info", "new-wt"), fixture.otherGitDir],
				[join(fixture.adminDir, "new-wt"), fixture.adminDir],
				[join(fixture.bare, "new-wt"), fixture.bare],
			] as const;
			for (const [target, watched] of cases) {
				await assertRejectedWithoutWrites(fixture, target, watched);
				assert.equal(existsSync(target), false);
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects Git metadata from a cwd outside any Git repository", async () => {
		const fixture = await createMetadataFixture();
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

describe("gitWorktreeDir never nests a checkout inside another Git working tree", () => {
	async function assertRejectedWithoutWrites(
		invoking: string,
		gitWorktreeDir: string,
		watched: string,
	): Promise<void> {
		const before = readdirSync(watched, { recursive: true, encoding: "utf8" }).sort();
		const invokingBefore = await registeredWorktrees(invoking);
		const watchedBefore = await registeredWorktrees(watched);
		assert.throws(
			() => setupGitWorktree({ cwd: join(invoking, "packages", "api"), gitWorktreeDir }),
			/gitWorktreeDir must not be inside another Git working tree/,
		);
		assert.deepEqual(readdirSync(watched, { recursive: true, encoding: "utf8" }).sort(), before);
		assert.deepEqual(await registeredWorktrees(invoking), invokingBefore);
		assert.deepEqual(await registeredWorktrees(watched), watchedBefore);
	}

	test("rejects an empty subdirectory of another repository's checkout", async () => {
		const root = createScratch();
		try {
			const invoking = await createGitRepo(root, "invoking");
			const other = await createGitRepo(root, "other");
			const target = join(other, "empty-subdir");
			mkdirSync(target);
			await assertRejectedWithoutWrites(invoking, target, other);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a missing path under another repository's checkout", async () => {
		const root = createScratch();
		try {
			const invoking = await createGitRepo(root, "invoking");
			const other = await createGitRepo(root, "other");
			for (const target of [join(other, "new-wt"), join(other, "packages", "api", "deeper", "new-wt")]) {
				await assertRejectedWithoutWrites(invoking, target, other);
				assert.equal(existsSync(target), false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects allocating inside a non-empty subdirectory of another repository's checkout", async () => {
		const root = createScratch();
		try {
			const invoking = await createGitRepo(root, "invoking");
			const other = await createGitRepo(root, "other");
			const target = join(other, "notes");
			mkdirSync(target);
			writeFileSync(join(target, "untracked.txt"), "untracked\n");
			await assertRejectedWithoutWrites(invoking, target, other);
			await assertRejectedWithoutWrites(invoking, join(other, "packages"), other);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("still creates worktrees in containers outside every Git working tree", async () => {
		const root = createScratch();
		try {
			const repo = await createGitRepo(root, "repo");
			const missing = join(root, "containers", "missing", "repo-wt");
			const created = setupGitWorktree({ cwd: repo, gitWorktreeDir: missing });
			assert.equal(created.created, true);
			assert.equal(created.worktreeRoot, missing);

			const container = createNonEmptyRoot(root);
			const allocated = setupGitWorktree({ cwd: repo, gitWorktreeDir: container });
			assert.equal(allocated.created, true);
			assert.equal(dirname(dirname(allocated.worktreeRoot)), container);

			const otherRoot = await createGitRepo(root, "other");
			const reused = setupGitWorktree({ cwd: repo, gitWorktreeDir: otherRoot });
			assert.equal(reused.created, false);
			assert.equal(reused.worktreeRoot, otherRoot);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
