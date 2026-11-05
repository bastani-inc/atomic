import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	assertWorkspaceGitAvailable,
	observeWorkspaceGitCommands,
	runWorkspaceGit,
	setWorkspaceGitExecutableResolver,
} from "../../packages/coding-agent/src/core/workspace/git.ts";
import {
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceBindingError,
	isWorkspaceConfigError,
	isWorkspaceTimeoutError,
	resolveWorkspace,
	restoreWorkspace,
	WorkspaceBindingError,
	workspace,
	workspaceChangeSet,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { withRepositoryLock } from "../../packages/coding-agent/src/core/workspace/lease.ts";
import { redactCredentials } from "../../packages/coding-agent/src/core/workspace/redact.ts";
import { sharedStorePath } from "../../packages/coding-agent/src/core/workspace/resolve.ts";
import { classifyRepository } from "../../packages/coding-agent/src/core/workspace/spec.ts";
import {
	commitFile,
	countGitCommands,
	createRemote,
	createRepository,
	git,
	gitTranscript,
	type WorkspaceSandboxDirs,
	withInjectedGit,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-resolve-");
});

afterEach(() => {
	dirs.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

describe("workspace resolution (#3109)", () => {
	test("binds a local repository in place on its current branch (#3109)", async () => {
		const repo = createRepository(dirs.root, "local");
		const binding = await resolveWorkspace(workspace({ repo, label: "ci" }));
		assert.equal(binding.kind, "bound-workspace");
		assert.equal(binding.worktree, realpathSync(repo));
		assert.equal(binding.repository, realpathSync(repo));
		assert.equal(binding.branch, "main");
		assert.equal(binding.base, "HEAD");
		assert.equal(binding.head, git(repo, "rev-parse", "HEAD"));
		assert.equal(binding.baseCommit, binding.head);
		assert.equal(binding.tree, git(repo, "rev-parse", "HEAD^{tree}"));
		assert.equal(binding.sandbox, "workspace-write");
		assert.equal(binding.label, "ci");
		assert.match(binding.envHash, /^[0-9a-f]{64}$/);
		assert.deepEqual(binding.remotes, []);
	});

	test("creates a missing branch from base in an auto worktree under the Atomic home (#3109)", async () => {
		const repo = createRepository(dirs.root, "creates");
		const baseCommit = git(repo, "rev-parse", "HEAD");
		commitFile(repo, "later.txt", "after base\n");
		const binding = await resolveWorkspace(workspace({ repo, base: baseCommit, branch: "feat/ticket-1" }));
		assert.equal(binding.branch, "feat/ticket-1");
		assert.ok(binding.worktree.startsWith(join(dirs.home, "worktrees", "local")));
		assert.ok(binding.worktree.endsWith(join("feat", "ticket-1")));
		assert.equal(git(binding.worktree, "symbolic-ref", "--short", "HEAD"), "feat/ticket-1");
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), baseCommit);
		assert.equal(binding.baseCommit, baseCommit);
		assert.equal(existsSync(join(binding.worktree, "later.txt")), false);
	});

	test("records the snapshot tree of a dirty worktree and its credential-free remotes (#3109)", async () => {
		const repo = createRepository(dirs.root, "dirty");
		git(repo, "remote", "add", "origin", "https://user:secret-token@example.com/acme/dirty.git");
		git(repo, "remote", "add", "ssh", "ssh://git:hunter2@example.com/acme/dirty.git");
		git(repo, "remote", "add", "scp", "git@example.com:acme/dirty.git");
		writeFileSync(join(repo, "untracked.txt"), "work in progress\n");
		writeFileSync(join(repo, "package-lock.json"), "{}\n");
		const binding = await resolveWorkspace(workspace({ repo }));
		assert.notEqual(binding.tree, git(repo, "rev-parse", "HEAD^{tree}"));
		assert.equal(git(repo, "cat-file", "-p", `${binding.tree}:untracked.txt`), "work in progress");
		assert.deepEqual(binding.remotes, [
			"git@example.com:acme/dirty.git",
			"https://example.com/acme/dirty.git",
			"ssh://git@example.com/acme/dirty.git",
		]);
		assert.deepEqual(
			git(repo, "status", "--porcelain").split("\n"),
			["?? package-lock.json", "?? untracked.txt"],
			"the snapshot never touches the real index",
		);
		const lockDigest = createHash("sha256").update("{}\n").digest("hex");
		assert.equal(binding.envHash, createHash("sha256").update(`package-lock.json\0${lockDigest}\n`).digest("hex"));
		const clean = await resolveWorkspace(workspace({ repo: createRepository(dirs.root, "clean") }));
		assert.notEqual(binding.envHash, clean.envHash);
	});

	test("reuses the worktree already on the branch, outside the repository root (#3109)", async () => {
		const repo = createRepository(dirs.root, "reuse");
		const outside = join(dirs.root, "elsewhere", "feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", outside);
		const binding = await resolveWorkspace(workspace({ repo, branch: "feature" }));
		assert.equal(binding.worktree, realpathSync(outside));
	});

	test("rejects a path that is not a repository, and a repository subdirectory (#3109)", async () => {
		const plain = join(dirs.root, "plain");
		mkdirSync(plain);
		const missing = await rejection(resolveWorkspace(workspace({ repo: plain })));
		assert.ok(isWorkspaceBindingError(missing));
		assert.equal(missing.code, "invalid-repository");
		assert.equal(missing.reason, "not-a-repository");
		assert.equal(missing.fields.repo, plain);

		const repo = createRepository(dirs.root, "rooted");
		mkdirSync(join(repo, "sub"));
		const nested = await rejection(resolveWorkspace(workspace({ repo: join(repo, "sub") })));
		assert.ok(nested instanceof WorkspaceBindingError);
		assert.equal(nested.code, "invalid-repository");
		assert.equal(nested.reason, "not-a-repository-root");
		assert.equal(nested.fields.actual, realpathSync(repo));
	});

	test("rejects a worktree of another repository with wrong-repository (#3109)", async () => {
		const repo = createRepository(dirs.root, "expected");
		const other = createRepository(dirs.root, "other");
		const otherWorktree = join(dirs.root, "other-wt");
		git(other, "worktree", "add", "-q", "-b", "feature", otherWorktree);
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feature", worktree: otherWorktree })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-repository");
		assert.equal(error.reason, "different-repository");
		assert.equal(error.fields.expected, realpathSync(join(repo, ".git")));
		assert.equal(error.fields.actual, realpathSync(join(other, ".git")));
		assert.equal(error.retryable, false);
	});

	test("rejects a directory that is not a worktree, or a worktree subdirectory (#3109)", async () => {
		const repo = createRepository(dirs.root, "roots");
		const notGit = join(dirs.root, "not-git");
		mkdirSync(notGit);
		const plain = await rejection(resolveWorkspace(workspace({ repo, branch: "main", worktree: notGit })));
		assert.ok(isWorkspaceBindingError(plain));
		assert.equal(plain.code, "wrong-repository");
		assert.equal(plain.reason, "not-a-worktree");
		mkdirSync(join(repo, "nested"));
		const nested = await rejection(
			resolveWorkspace(workspace({ repo, branch: "main", worktree: join(repo, "nested") })),
		);
		assert.ok(isWorkspaceBindingError(nested));
		assert.equal(nested.code, "wrong-repository");
		assert.equal(nested.reason, "not-a-worktree-root");
	});

	test("rejects a worktree on another branch, and a detached one, with wrong-branch (#3109)", async () => {
		const repo = createRepository(dirs.root, "branches");
		const worktree = join(dirs.root, "branches-wt");
		git(repo, "worktree", "add", "-q", "-b", "other", worktree);
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "wanted", worktree })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-branch");
		assert.equal(error.reason, "different-branch");
		assert.equal(error.fields.expected, "wanted");
		assert.equal(error.fields.actual, "other");

		git(worktree, "checkout", "-q", "--detach");
		const detached = await rejection(resolveWorkspace(workspace({ repo, branch: "other", worktree })));
		assert.ok(isWorkspaceBindingError(detached));
		assert.equal(detached.code, "wrong-branch");
		assert.equal(detached.reason, "detached-head");
		assert.equal(detached.fields.actual, "detached HEAD");

		git(repo, "checkout", "-q", "--detach");
		const inPlace = await rejection(resolveWorkspace(workspace({ repo })));
		assert.ok(isWorkspaceBindingError(inPlace));
		assert.equal(inPlace.code, "wrong-branch");
		assert.equal(inPlace.reason, "detached-head");
	});

	test("rejects a base that does not resolve before creating anything (#3109)", async () => {
		const repo = createRepository(dirs.root, "unknown-base");
		const error = await rejection(resolveWorkspace(workspace({ repo, base: "origin/nowhere", branch: "x" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "unknown-base");
		assert.equal(error.fields.base, "origin/nowhere");
		assert.equal(existsSync(join(dirs.home, "worktrees")), false);
	});

	test("clones a remote once into the shared store and adds one worktree per branch (#3109)", async () => {
		const remote = createRemote(dirs.root, "product-service");
		const branches = ["feat/a", "feat/b", "feat/c", "feat/d"];
		const { result, commands } = await countGitCommands(() =>
			Promise.all(
				branches.map((branch) => resolveWorkspace(workspace({ repo: remote.url, base: "origin/main", branch }))),
			),
		);
		const clones = commands.filter((args) => args[0] === "init" && args[1] === "--bare");
		assert.equal(
			commands.filter((args) => args[0] === "fetch").length,
			1,
			"only the new store's own fetch: a store created by this resolution is fresh",
		);
		const adds = commands.filter((args) => args[0] === "worktree" && args[1] === "add");
		assert.equal(clones.length, 1, "one clone for every concurrent binding of the repository");
		assert.equal(adds.length, branches.length, "one worktree per branch");
		const stores = new Set(result.map((binding) => binding.repository));
		assert.equal(stores.size, 1);
		const [store] = stores;
		assert.ok(store?.startsWith(join(dirs.home, "repos")));
		assert.match(basename(store ?? ""), /^product-service-[0-9a-f]{12}\.git$/);
		for (const [index, binding] of result.entries()) {
			assert.equal(binding.branch, branches[index]);
			assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
			assert.deepEqual(binding.remotes, [remote.url]);
		}

		const again = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo: remote.url, base: "origin/main", branch: "feat/e" })),
		);
		assert.equal(again.commands.filter((args) => args[0] === "init").length, 0, "the store is reused");
		assert.equal(again.commands.filter((args) => args[0] === "fetch").length, 1, "a new branch fetches once");
	});

	test("checks out a branch that exists only on the remote instead of recreating it from base (#3109)", async () => {
		const remote = createRemote(dirs.root, "remote-branch");
		git(remote.seed, "checkout", "-q", "-b", "published");
		const published = commitFile(remote.seed, "published.txt", "pushed\n");
		git(remote.seed, "push", "-q", remote.url.replace(/^file:\/\//, ""), "published");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "published" }));
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), published);
		assert.equal(binding.base, "origin/main");
	});

	test("resolves the same workspace value once and re-verifies its worktree afterwards (#3109)", async () => {
		const repo = createRepository(dirs.root, "memo");
		const api = workspace({ repo, branch: "memo-branch" });
		const first = await resolveWorkspace(api);
		const { result, commands } = await countGitCommands(() => resolveWorkspace(api));
		assert.equal(result, first);
		assert.equal(commands.filter((args) => args[0] === "worktree").length, 0);
		git(first.worktree, "checkout", "-q", "-b", "moved");
		const moved = await rejection(resolveWorkspace(api));
		assert.ok(isWorkspaceBindingError(moved));
		assert.equal(moved.code, "wrong-branch");
		assert.equal(api.readOnly(), api.readOnly(), "one read-only value per workspace");
		assert.equal(api.readOnly().readOnly(), api.readOnly());
	});

	test("recognizes resolved bindings by shape (#3109)", async () => {
		const { isBoundWorkspace } = await import("../../packages/coding-agent/src/core/workspace/resolve.ts");
		assert.equal(
			isBoundWorkspace(await resolveWorkspace(workspace({ repo: createRepository(dirs.root, "shape") }))),
			true,
		);
		for (const value of [
			null,
			undefined,
			"bound-workspace",
			{ kind: "bound-workspace" },
			{ kind: "workspace", worktree: "/w" },
		])
			assert.equal(isBoundWorkspace(value), false);
	});

	test("returns an already resolved binding without running git (#3109)", async () => {
		const repo = createRepository(dirs.root, "resolved");
		const binding = await resolveWorkspace(workspace({ repo }));
		const { result, commands } = await countGitCommands(() => resolveWorkspace(binding));
		assert.equal(result, binding);
		assert.equal(commands.length, 0);
	});

	test("rejects a value that is not a workspace before any git work (#3109)", async () => {
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace({ repo: "/tmp/x" } as unknown as ReturnType<typeof workspace>)),
		);
		assert.ok(isWorkspaceConfigError(result));
		assert.equal(result.field, "workspace");
		assert.equal(result.source, "sdk");
		assert.equal(result.fields.expected, "a value returned by workspace({ … })");
		assert.equal(commands.length, 0);
	});
});

describe("workspace resolution details (#3109)", () => {
	test("places auto worktrees and shared stores at deterministic paths (#3109)", async () => {
		const repo = createRepository(dirs.root, "paths");
		const local = await resolveWorkspace(workspace({ repo, branch: "feat/x" }));
		const digest = createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 12);
		assert.equal(local.worktree, join(dirs.home, "worktrees", "local", `paths-${digest}`, "feat", "x"));
		const remote = createRemote(dirs.root, "paths-remote");
		const bound = await resolveWorkspace(workspace({ repo: remote.url }));
		const segments = classifyRepository(remote.url)!;
		assert.ok(segments.kind === "remote");
		assert.equal(bound.repository, sharedStorePath(segments));
		const fileKey = `paths-remote-${createHash("sha256").update(segments.segments.join("/")).digest("hex").slice(0, 12)}`;
		assert.equal(bound.repository, join(dirs.home, "repos", "file", `${fileKey}.git`));
		assert.equal(bound.worktree, join(dirs.home, "worktrees", "file", fileKey, "main"));
		assert.equal(bound.branch, "main", "a remote without a branch binds the branch of its default base");
		assert.equal(bound.base, "origin/main");
		const short = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 12);
		assert.equal(
			sharedStorePath({ kind: "remote", url: "x", host: "git.example.com:8443", segments: ["team a", "svc"] }),
			join(
				dirs.home,
				"repos",
				`git.example.com_8443-${short("git.example.com:8443")}`,
				`team_a-${short("team a")}`,
				"svc.git",
			),
			"safe names stay readable; unsafe ones keep a digest of the original",
		);
	});

	test("rejects a repository path that does not exist (#3109)", async () => {
		const error = await rejection(resolveWorkspace(workspace({ repo: join(dirs.root, "missing") })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "invalid-repository");
		assert.equal(error.reason, "not-a-repository");
	});

	test("reports precise fields for worktree identity failures (#3109)", async () => {
		const repo = createRepository(dirs.root, "fields");
		const plain = join(dirs.root, "fields-plain");
		mkdirSync(plain);
		const notWorktree = await rejection(resolveWorkspace(workspace({ repo, branch: "main", worktree: plain })));
		assert.ok(isWorkspaceBindingError(notWorktree));
		assert.deepEqual(notWorktree.fields, {
			repo,
			worktree: plain,
			expected: realpathSync(join(repo, ".git")),
			actual: "not a git worktree",
		});
		mkdirSync(join(repo, "inner"));
		const inner = await rejection(
			resolveWorkspace(workspace({ repo, branch: "main", worktree: join(repo, "inner") })),
		);
		assert.ok(isWorkspaceBindingError(inner));
		assert.deepEqual(inner.fields, {
			repo,
			worktree: join(repo, "inner"),
			expected: realpathSync(join(repo, "inner")),
			actual: realpathSync(repo),
		});
		git(repo, "checkout", "-q", "--detach");
		const detached = await rejection(resolveWorkspace(workspace({ repo })));
		assert.ok(isWorkspaceBindingError(detached));
		assert.deepEqual(detached.fields, {
			repo,
			worktree: realpathSync(repo),
			expected: "a branch",
			actual: "detached HEAD",
		});
	});

	test("records where the branch forked from base, not base's current tip (#3109)", async () => {
		const repo = createRepository(dirs.root, "forked");
		const fork = git(repo, "rev-parse", "HEAD");
		git(repo, "branch", "feature");
		commitFile(repo, "main-only.txt", "advanced\n");
		const binding = await resolveWorkspace(workspace({ repo, base: "main", branch: "feature" }));
		assert.equal(binding.baseCommit, fork);
		assert.notEqual(git(repo, "rev-parse", "main"), fork);
	});

	test("falls back to the base commit when the branch shares no history with it (#3109)", async () => {
		const repo = createRepository(dirs.root, "orphan");
		git(repo, "checkout", "-q", "--orphan", "unrelated");
		writeFileSync(join(repo, "other.txt"), "other\n");
		git(repo, "add", "other.txt");
		git(repo, "commit", "-q", "-m", "unrelated root");
		git(repo, "checkout", "-q", "main");
		const binding = await resolveWorkspace(workspace({ repo, base: "main", branch: "unrelated" }));
		assert.equal(binding.baseCommit, git(repo, "rev-parse", "main"));
		assert.equal(binding.head, git(repo, "rev-parse", "unrelated"));
	});

	test("waits for the repository lock instead of racing another adder (#3109)", async () => {
		const repo = createRepository(dirs.root, "locked");
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const holder = withRepositoryLock(realpathSync(join(repo, ".git")), async () => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await inside;
		let settled = false;
		const binding = resolveWorkspace(workspace({ repo, branch: "after-the-lock" })).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(settled, false, "the binding waits while another holder adds worktrees");
		assert.equal(existsSync(join(dirs.home, "worktrees")), false);
		release();
		await holder;
		assert.equal((await binding).branch, "after-the-lock");
	});

	test("redacts credentials after any run of scheme characters (#3109)", () => {
		const prefix = "x".repeat(60);
		assert.equal(redactCredentials(`${prefix}https://user:secret@host/r.git`), `${prefix}https://host/r.git`);
		assert.equal(redactCredentials("1ssh://git:pw@host/r"), "1ssh://git@host/r");
		assert.equal(redactCredentials(`'${"a".repeat(40)}ssh://git:pw@host/r`), `'${"a".repeat(40)}ssh://host/r`);
		const letters = "a".repeat(50_000);
		assert.equal(redactCredentials(letters), letters);
	});

	test("records every remote URL once, sorted (#3109)", async () => {
		const repo = createRepository(dirs.root, "remotes");
		git(repo, "remote", "add", "upstream", "https://example.com/b.git");
		git(repo, "remote", "add", "origin", "https://example.com/a.git");
		git(repo, "remote", "add", "mirror", "https://example.com/a.git");
		const binding = await resolveWorkspace(workspace({ repo }));
		assert.deepEqual(binding.remotes, ["https://example.com/a.git", "https://example.com/b.git"]);
	});

	test("starts a missing local branch from the remote's copy of it when one exists (#3109)", async () => {
		const remote = createRemote(dirs.root, "tracking");
		git(remote.seed, "checkout", "-q", "-b", "shared-topic");
		const pushed = commitFile(remote.seed, "topic.txt", "topic\n");
		git(remote.seed, "push", "-q", remote.url.replace(/^file:\/\//, ""), "shared-topic");
		const clone = join(dirs.root, "tracking-clone");
		git(dirs.root, "clone", "-q", remote.url.replace(/^file:\/\//, ""), clone);
		const binding = await resolveWorkspace(workspace({ repo: clone, branch: "shared-topic" }));
		assert.equal(binding.head, pushed);
	});

	test("leaves no temporary index behind when it snapshots the working tree (#3109)", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "atomic-workspace-tmp-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			await resolveWorkspace(workspace({ repo: createRepository(dirs.root, "index") }));
			assert.deepEqual(readdirSync(scratch), []);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test("retries a failed resolution, and resolves again when its worktree is gone (#3109)", async () => {
		const repo = createRepository(dirs.root, "retry");
		const api = workspace({ repo, base: "later", branch: "retry-branch" });
		const missingBase = await rejection(resolveWorkspace(api));
		assert.ok(isWorkspaceBindingError(missingBase));
		assert.equal(missingBase.code, "unknown-base");
		git(repo, "branch", "later");
		const binding = await resolveWorkspace(api);
		rmSync(binding.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const again = await resolveWorkspace(api);
		assert.notEqual(again, binding);
		assert.equal(existsSync(again.worktree), true);
		assert.equal(again.worktree, binding.worktree);
	});

	test("two workspace values for one branch share one worktree (#3109)", async () => {
		const repo = createRepository(dirs.root, "shared-branch");
		const { result, commands } = await countGitCommands(() =>
			Promise.all([
				resolveWorkspace(workspace({ repo, branch: "same" })),
				resolveWorkspace(workspace({ repo, branch: "same", sandbox: "read-only" })),
			]),
		);
		assert.equal(result[0].worktree, result[1].worktree);
		assert.equal(commands.filter((args) => args[0] === "worktree" && args[1] === "add").length, 1);
		assert.deepEqual(
			result.map((binding) => binding.sandbox),
			["workspace-write", "read-only"],
		);
	});

	test("a store that already has the branch is not fetched again (#3109)", async () => {
		const remote = createRemote(dirs.root, "no-fetch");
		await resolveWorkspace(workspace({ repo: remote.url, branch: "kept" }));
		const { commands } = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo: remote.url, branch: "kept" })),
		);
		assert.equal(commands.filter((args) => args[0] === "fetch").length, 0);
	});

	test("a failed clone leaves no store behind and is retryable (#3109)", async () => {
		const url = `file://${join(dirs.root, "nowhere.git")
			.replaceAll("\\", "/")
			.replace(/^(?=[A-Za-z]:)/, "/")}`;
		const error = await rejection(resolveWorkspace(workspace({ repo: url, branch: "x" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "git-failed");
		assert.equal(error.fields.phase, "fetch", "the new store's first fetch reaches the remote");
		assert.equal(error.retryable, true);
		assert.equal(error.cleanupCause, undefined, "removing the staging clone succeeded");
		const remote = classifyRepository(url);
		assert.ok(remote?.kind === "remote");
		assert.deepEqual(readdirSync(dirname(sharedStorePath(remote))), [], "the staging clone was removed");
	});

	test("a cancelled waiter stops waiting while the shared clone finishes for the others (#3109)", async () => {
		const remote = createRemote(dirs.root, "shared-clone");
		const controller = new AbortController();
		const reason = new Error("caller went away");
		const cloning = new Promise<void>((resolve) => {
			const stop = observeWorkspaceGitCommands((command) => {
				if (command.args[0] === "init") {
					stop();
					resolve();
				}
			});
		});
		const kept = resolveWorkspace(workspace({ repo: remote.url, branch: "two" }));
		await cloning;
		const one = workspace({ repo: remote.url, branch: "one" });
		const cancelled = resolveWorkspace(one, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(reason);
		assert.equal(await rejection(cancelled), reason);
		const binding = await kept;
		assert.equal(binding.branch, "two");
		assert.equal(existsSync(join(binding.repository, "HEAD")), true);
		assert.equal((await resolveWorkspace(one)).branch, "one", "the abandoned resolution finished and is reused");
	});
});

describe("workspace git runner (#3109)", () => {
	test("reports a missing git as git-unavailable caused by GitUnavailableError, after one attempt and no writes (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({
			path: join(dirs.root, "no-such-git"),
			env: {},
		}));
		try {
			const remote = createRemote(dirs.root, "needs-git");
			const { result, commands } = await countGitCommands(() =>
				rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
			);
			assert.ok(isWorkspaceBindingError(result));
			assert.equal(result.code, "git-unavailable");
			assert.ok(isGitUnavailableError(result.cause));
			assert.ok(result.cause instanceof GitUnavailableError);
			assert.equal(result.cause.code, "not-installed");
			assert.equal(result.cause.platform, process.platform);
			assert.equal((result.cause.cause as { code?: string }).code, "ENOENT");
			assert.equal(result.fields.gitPath, join(dirs.root, "no-such-git"));
			assert.match(String(result.fields.installCommand), /git/i);
			assert.ok(result.hint.includes(String(result.fields.installCommand)));
			assert.equal(commands.length, 1, "one --version probe, nothing else");
			assert.deepEqual(readdirSync(dirs.home), ["agent"], "no store or worktree directories were created");
		} finally {
			restore();
		}
	});

	test("wraps a resolver's GitUnavailableError without losing it (#3109)", async () => {
		const unavailable = new GitUnavailableError({ gitPath: "provisioned-git" });
		const restore = setWorkspaceGitExecutableResolver(async () => {
			throw unavailable;
		});
		try {
			const error = await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" }));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "git-unavailable");
			assert.equal(error.cause, unavailable);
			assert.equal(error.fields.gitPath, "provisioned-git");
		} finally {
			restore();
		}
	});

	test("passes the injected executable environment to every command (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({
			path: "git",
			env: { GIT_CONFIG_NOSYSTEM: "1", ATOMIC_WORKSPACE_TEST_MARKER: "injected" },
		}));
		try {
			const result = await runWorkspaceGit({
				cwd: dirs.root,
				args: ["-c", "alias.marker=!echo $ATOMIC_WORKSPACE_TEST_MARKER", "marker"],
				phase: "probe",
			});
			assert.equal(result.stdout.trim(), "injected");
		} finally {
			restore();
		}
	});

	test("rejects a failing command with git-failed, credentials redacted (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: dirs.root,
				args: ["ls-remote", "https://user:secret-token@127.0.0.1:9/none.git"],
				phase: "fetch",
				timeoutMs: 20_000,
			}),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "git-failed");
		assert.equal(error.fields.phase, "fetch");
		assert.equal(error.retryable, true, "network phases may be retried");
		assert.equal(JSON.stringify(error.fields).includes("secret-token"), false);
		assert.equal(error.message.includes("secret-token"), false);
		const local = await rejection(
			runWorkspaceGit({ cwd: dirs.root, args: ["rev-parse", "HEAD"], phase: "validate" }),
		);
		assert.ok(isWorkspaceBindingError(local));
		assert.equal(local.retryable, false);
		assert.equal(typeof local.fields.status, "number");
	});

	test("times out a slow command with WorkspaceTimeoutError carrying phase and timings (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: tmpdir(),
				args: ["-c", "alias.slow=!sleep 5", "slow"],
				phase: "clone",
				timeoutMs: 100,
			}),
		);
		assert.ok(isWorkspaceTimeoutError(error));
		assert.equal(error.code, "timeout");
		assert.equal(error.phase, "clone");
		assert.equal(error.timeoutMs, 100);
		assert.ok(error.elapsedMs >= 100);
		assert.equal(error.retryable, true);
	});

	test("propagates cancellation as signal.reason, never as a workspace error (#3109)", async () => {
		const controller = new AbortController();
		const reason = new Error("stop requested");
		const pending = runWorkspaceGit({
			cwd: tmpdir(),
			args: ["-c", "alias.slow=!sleep 5", "slow"],
			phase: "clone",
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(reason), 50);
		assert.equal(await rejection(pending), reason);
		const already = await rejection(
			runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe", signal: controller.signal }),
		);
		assert.equal(already, reason);
		const resolving = await rejection(
			resolveWorkspace(workspace({ repo: createRepository(dirs.root, "cancelled") }), { signal: controller.signal }),
		);
		assert.equal(resolving, reason);
	});

	test("restores the previous executable and stops observing when asked (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({ path: join(dirs.root, "absent-git"), env: {} }));
		restore();
		const seen: string[][] = [];
		const stop = observeWorkspaceGitCommands((command) => seen.push([...command.args]));
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" });
		stop();
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" });
		assert.deepEqual(seen, [["--version"]]);
	});

	test("passes a resolver failure that is not about git through unchanged (#3109)", async () => {
		const failure = new Error("resolver bug");
		const restore = setWorkspaceGitExecutableResolver(async () => {
			throw failure;
		});
		try {
			assert.equal(
				await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" })),
				failure,
			);
		} finally {
			restore();
		}
	});

	test("never lets git prompt (#3109)", async () => {
		const result = await runWorkspaceGit({
			cwd: dirs.root,
			args: ["-c", "alias.env=!echo $GIT_TERMINAL_PROMPT $GCM_INTERACTIVE", "env"],
			phase: "probe",
		});
		assert.equal(result.stdout.trim(), "0 never");
	});

	// POSIX: the alias kills git's own process from its shell.
	test.skipIf(process.platform === "win32")(
		"describes failures from git's own output and command (#3109)",
		async () => {
			const outside = await rejection(
				runWorkspaceGit({ cwd: dirs.root, args: ["rev-parse", "HEAD"], phase: "validate" }),
			);
			assert.ok(isWorkspaceBindingError(outside));
			assert.equal(outside.fields.command, "git rev-parse HEAD");
			assert.equal(outside.fields.cwd, dirs.root);
			assert.equal(outside.fields.status, 128);
			assert.match(String(outside.fields.detail), /not a git repository/);
			const stdoutOnly = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!echo only-stdout; exit 3", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(stdoutOnly));
			assert.equal(stdoutOnly.fields.detail, "only-stdout");
			assert.equal(stdoutOnly.fields.status, 3);
			const stderrFirst = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!echo ignored-stdout; echo '  from-stderr  ' >&2; exit 4", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(stderrFirst));
			assert.equal(stderrFirst.fields.detail, "from-stderr");
			const long = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!printf '%0900d' 0 >&2; exit 5", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(long));
			assert.equal(long.fields.detail, "0".repeat(400), "git's output is cut to 400 characters");
			const killed = await rejection(
				runWorkspaceGit({ cwd: dirs.root, args: ["-c", "alias.die=!kill -KILL $PPID", "die"], phase: "probe" }),
			);
			assert.ok(isWorkspaceBindingError(killed));
			assert.equal(killed.fields.status, -1);
		},
	);

	test("tells a missing working directory apart from a missing git (#3109)", async () => {
		const missingCwd = await rejection(
			runWorkspaceGit({ cwd: join(dirs.root, "gone"), args: ["--version"], phase: "probe" }),
		);
		assert.ok(isWorkspaceBindingError(missingCwd));
		assert.equal(missingCwd.code, "git-failed");
		assert.equal(missingCwd.fields.status, null);
		const longPath = join(dirs.root, "g".repeat(200), "i".repeat(200), "git");
		const undo = setWorkspaceGitExecutableResolver(async () => ({ path: longPath, env: {} }));
		try {
			const long = await rejection(
				runWorkspaceGit({ cwd: join(dirs.root, "gone"), args: ["--version"], phase: "probe" }),
			);
			assert.ok(isWorkspaceBindingError(long));
			assert.equal(long.code, "git-failed");
			assert.equal(long.fields.detail, `spawn ${longPath} ENOENT`.slice(-400), "git's last words are kept");
		} finally {
			undo();
		}
	});

	// POSIX: spawning a directory fails with EACCES there; Windows reports ENOENT, which reads as a missing git.
	test.skipIf(process.platform === "win32")(
		"tells an executable that cannot run apart from a missing git (#3109)",
		async () => {
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: dirs.root, env: {} }));
			try {
				const directory = await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" }));
				assert.ok(isWorkspaceBindingError(directory));
				assert.equal(directory.code, "git-failed");
				assert.match(String(directory.fields.detail), /EACCES/);
			} finally {
				restore();
			}
		},
	);

	test("reports elapsed time of a timeout within its bound and leaves no abort listener behind (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: tmpdir(),
				args: ["-c", "alias.slow=!sleep 5", "slow"],
				phase: "fetch",
				timeoutMs: 50,
			}),
		);
		assert.ok(isWorkspaceTimeoutError(error));
		assert.ok(error.elapsedMs < 5_000);
		assert.equal(error.fields.command, "git -c alias.slow=!sleep 5 slow");
		const controller = new AbortController();
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe", signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	// POSIX: the executable appears later as a symbolic link to git.
	test.skipIf(process.platform === "win32")(
		"checks git once per executable and does not remember a failed check (#3109)",
		async () => {
			const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
			const link = join(dirs.root, "late-git");
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: link, env: {} }));
			try {
				const missing = await rejection(assertWorkspaceGitAvailable());
				assert.ok(isWorkspaceBindingError(missing));
				assert.equal(missing.code, "git-unavailable");
				symlinkSync(gitPath, link);
				const { transcript } = await gitTranscript(async () => {
					await assertWorkspaceGitAvailable();
					await assertWorkspaceGitAvailable();
				});
				assert.deepEqual(transcript, ["probe: --version"]);
			} finally {
				restore();
			}
		},
	);
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SHA = /\b[0-9a-f]{40}\b/g;

/** Record git commands with `paths` replaced by their names, longest first, so expectations hold on every platform. */
function transcriptOf(paths: Readonly<Record<string, string>>) {
	const named = Object.entries(paths)
		.sort(([, a], [, b]) => b.length - a.length)
		.map(([name, path]): [string, string] => [path, `<${name}>`]);
	return <T>(body: () => Promise<T>) =>
		gitTranscript(body, [...named, [UUID, "<uuid>"], [SHA, "<sha>"]]).then(({ result, transcript }) => ({
			result,
			transcript: transcript.filter((line) => line !== "probe: --version"),
		}));
}

/** Push a commit that adds `file` to `branch` of the remote, as another machine would. */
function pushFromElsewhere(remote: { readonly url: string }, root: string, branch: string, file: string): string {
	const clone = join(root, `elsewhere-${file}`);
	git(root, "clone", "-q", remote.url.replace(/^file:\/\//, ""), clone);
	git(clone, "config", "user.email", "test@example.com");
	git(clone, "config", "user.name", "Test User");
	if (git(clone, "branch", "-r", "--list", `origin/${branch}`) !== "") git(clone, "checkout", "-q", branch);
	else git(clone, "checkout", "-q", "-b", branch);
	const head = commitFile(clone, file, `${file}\n`);
	git(clone, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
	return head;
}

describe("shared stores follow the remote (#3109)", () => {
	test("binds the default branch and an existing remote branch at the remote's current tip (#3109)", async () => {
		const remote = createRemote(dirs.root, "advancing");
		await resolveWorkspace(workspace({ repo: remote.url, branch: "warm-up" }));
		const mainTip = pushFromElsewhere(remote, dirs.root, "main", "later-main.txt");
		const featureTip = pushFromElsewhere(remote, dirs.root, "feat/existing", "later-feature.txt");
		const main = await resolveWorkspace(workspace({ repo: remote.url }));
		assert.equal(main.branch, "main");
		assert.equal(main.head, mainTip);
		assert.equal(main.baseCommit, mainTip, "the base is the remote's main as it is now");
		const feature = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/existing" }));
		assert.equal(feature.head, featureTip);
		assert.equal(existsSync(join(feature.worktree, "later-feature.txt")), true);
	});

	test("fast-forwards a store branch the remote moved ahead of before adding its worktree again (#3109)", async () => {
		const remote = createRemote(dirs.root, "fast-forward");
		const first = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/ff" }));
		commitFile(first.worktree, "mine.txt", "mine\n");
		git(first.worktree, "push", "-q", "origin", "HEAD:refs/heads/feat/ff");
		const theirs = pushFromElsewhere(remote, dirs.root, "feat/ff", "theirs.txt");
		rmSync(first.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const { result: again, transcript } = await gitTranscript(
			() => resolveWorkspace(workspace({ repo: remote.url, branch: "feat/ff" })),
			[[SHA, "<sha>"]],
		);
		assert.ok(transcript.includes("worktree-add: branch --force feat/ff <sha>"), transcript.join("\n"));
		assert.equal(again.worktree, first.worktree);
		assert.equal(again.head, theirs);
		assert.equal(existsSync(join(again.worktree, "mine.txt")), true);
		assert.equal(existsSync(join(again.worktree, "theirs.txt")), true);
	});

	test("keeps a store branch that holds commits the remote does not have yet (#3109)", async () => {
		const remote = createRemote(dirs.root, "unpushed");
		const first = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/local" }));
		git(first.worktree, "push", "-q", "origin", "HEAD:refs/heads/feat/local");
		const local = commitFile(first.worktree, "unpushed.txt", "unpushed\n");
		rmSync(first.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const again = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/local" }));
		assert.equal(again.head, local, "the unpushed commit survives");
	});

	test("fails closed with drift when a store branch and the remote diverged, adding nothing (#3109)", async () => {
		const remote = createRemote(dirs.root, "diverged");
		const first = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/split" }));
		git(first.worktree, "push", "-q", "origin", "HEAD:refs/heads/feat/split");
		const local = commitFile(first.worktree, "here.txt", "here\n");
		const theirs = pushFromElsewhere(remote, dirs.root, "feat/split", "there.txt");
		rmSync(first.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "feat/split" }))),
		);
		assert.ok(isWorkspaceBindingError(result));
		assert.equal(result.code, "drift");
		assert.equal(result.reason, "branch-diverged");
		assert.equal(result.fields.branch, "feat/split");
		assert.equal(result.fields.expected, theirs);
		assert.equal(result.fields.actual, local);
		assert.equal(result.fields.repository, first.repository);
		assert.equal(result.retryable, false);
		assert.equal(
			result.hint,
			`Push or rebase the local commits onto origin/feat/split, or take the remote's history with git -C ${first.repository} branch --force feat/split origin/feat/split, then retry.`,
		);
		assert.equal(
			commands.some((args) => args[0] === "worktree" && args[1] === "add"),
			false,
		);
		assert.equal(existsSync(first.worktree), false);
	});

	test("a local repository's own branches are used as they are, ahead of its remote-tracking copies (#3109)", async () => {
		const remote = createRemote(dirs.root, "local-clone-origin");
		const clone = join(dirs.root, "local-clone");
		git(dirs.root, "clone", "-q", remote.url.replace(/^file:\/\//, ""), clone);
		git(clone, "config", "user.email", "test@example.com");
		git(clone, "config", "user.name", "Test User");
		git(clone, "branch", "behind");
		const behind = git(clone, "rev-parse", "behind");
		pushFromElsewhere(remote, dirs.root, "behind", "remote-only.txt");
		pushFromElsewhere(remote, dirs.root, "main", "remote-main.txt");
		git(clone, "fetch", "-q", "origin");
		const binding = await resolveWorkspace(workspace({ repo: clone, base: "main", branch: "behind" }));
		assert.equal(binding.head, behind, "the local branch is not moved to its remote copy");
		git(clone, "branch", "on-remote-main", "origin/main");
		const onRemote = await resolveWorkspace(workspace({ repo: clone, base: "main", branch: "on-remote-main" }));
		assert.equal(onRemote.baseCommit, git(clone, "rev-parse", "main"), "base main is the repository's own main");
		assert.notEqual(onRemote.baseCommit, git(clone, "rev-parse", "origin/main"));
	});

	test("remotes whose names differ only in unsafe characters get separate stores (#3109)", async () => {
		const plus = createRemote(dirs.root, "foo+bar");
		const underscore = createRemote(dirs.root, "foo_bar");
		const a = await resolveWorkspace(workspace({ repo: plus.url, branch: "x" }));
		const b = await resolveWorkspace(workspace({ repo: underscore.url, branch: "x" }));
		assert.notEqual(a.repository, b.repository);
		assert.deepEqual(a.remotes, [plus.url]);
		assert.deepEqual(b.remotes, [underscore.url]);
		const scp = sharedStorePath({ kind: "remote", url: "x", host: "host", segments: ["..", "..", "escape"] });
		assert.ok(scp.startsWith(join(dirs.home, "repos", "host")), "dot segments never climb out of the store root");
	});

	test("a remote whose HEAD names no branch still binds explicit refs and names the missing default (#3109)", async () => {
		const remote = createRemote(dirs.root, "dangling-head");
		git(join(dirs.root, "dangling-head.git"), "symbolic-ref", "HEAD", "refs/heads/master");
		const explicit = await resolveWorkspace(workspace({ repo: remote.url, base: "origin/main", branch: "explicit" }));
		assert.equal(explicit.baseCommit, git(remote.seed, "rev-parse", "HEAD"));
		const missing = await rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "needs-default" })));
		assert.ok(isWorkspaceBindingError(missing));
		assert.equal(missing.code, "unknown-base");
		assert.equal(missing.fields.base, "origin/HEAD");
	});

	test("a base naming a remote branch means that branch as the remote has it (#3109)", async () => {
		const remote = createRemote(dirs.root, "base-name");
		await resolveWorkspace(workspace({ repo: remote.url, branch: "main" }));
		const tip = pushFromElsewhere(remote, dirs.root, "main", "newer.txt");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, base: "main", branch: "from-main" }));
		assert.equal(binding.baseCommit, tip, "not the store's own main, which is behind");
	});

	test("concurrent restores of one missing worktree add it once (#3109)", async () => {
		const remote = createRemote(dirs.root, "restore-once");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "shared" }));
		rmSync(binding.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const { result, commands } = await countGitCommands(() =>
			Promise.all(Array.from({ length: 4 }, () => restoreWorkspace(binding))),
		);
		assert.deepEqual(new Set(result), new Set([binding.worktree]));
		assert.equal(commands.filter((args) => args[0] === "worktree" && args[1] === "add").length, 1);
		assert.equal(commands.filter((args) => args[0] === "fetch").length, 1);
	});
});

describe("workspace git phases (#3109)", () => {
	test("runs every git command of a binding in its phase, network ones as clone or fetch (#3109)", async () => {
		const remote = createRemote(dirs.root, "phases");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		const worktrees = join(dirs.home, "worktrees", "file", basename(store, ".git"));
		const record = transcriptOf({
			url: remote.url,
			store,
			"feat/x": join(worktrees, "feat", "x"),
			main: join(worktrees, "main"),
		});
		const fresh = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "feat/x" })));
		const snapshot = [
			"probe: rev-parse --show-toplevel --git-common-dir",
			"probe: symbolic-ref --short HEAD",
			"snapshot: rev-parse HEAD",
			"snapshot: read-tree HEAD",
			"snapshot: add --all",
			"snapshot: write-tree",
			"probe: config --get-regexp ^remote\\..*\\.url$",
			"probe: merge-base <sha> HEAD",
		];
		assert.deepEqual(fresh.transcript, [
			"clone: init --bare <store>.tmp-<uuid>",
			"clone: remote add origin <url>",
			"fetch: fetch origin",
			"fetch: remote set-head origin --auto",
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"probe: rev-parse --verify origin/main^{commit}",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/feat/x^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/feat/x^{commit}",
			"worktree-add: worktree add -b feat/x <feat/x> <sha>",
			...snapshot,
		]);
		const existing = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "main" })));
		assert.deepEqual(existing.transcript, [
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"fetch: fetch origin",
			"probe: rev-parse --verify origin/main^{commit}",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/main^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/main^{commit}",
			"worktree-add: worktree add -b main <main> <sha>",
			...snapshot,
		]);
		const fetched = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "feat/y" })));
		assert.deepEqual(fetched.transcript.slice(0, 3), [
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"fetch: fetch origin",
		]);
		commitFile(existing.result.worktree, "change.txt", "change\n");
		const changes = await record(() => workspaceChangeSet(existing.result));
		assert.deepEqual(changes.transcript, [
			"change-set: rev-parse HEAD",
			"change-set: diff --numstat --no-renames <sha> <sha>",
		]);
	});

	test("restores a deleted worktree with a network fetch and local worktree commands (#3109)", async () => {
		const remote = createRemote(dirs.root, "restore-phases");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "main" }));
		rmSync(binding.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const record = transcriptOf({ worktree: binding.worktree });
		const { transcript } = await record(() => restoreWorkspace(binding));
		assert.deepEqual(transcript, [
			"fetch: fetch origin",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/main^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/main^{commit}",
			"worktree-add: worktree add <worktree> main",
			"probe: rev-parse --show-toplevel --git-common-dir",
			"probe: symbolic-ref --short HEAD",
			"validate: merge-base --is-ancestor <sha> HEAD",
			"probe: config --get-regexp ^remote\\..*\\.url$",
		]);
		git(binding.worktree, "reset", "-q", "--hard", "HEAD");
		git(binding.worktree, "commit", "-q", "--amend", "-m", "rewritten");
		const drift = await record(() => rejection(restoreWorkspace(binding)));
		assert.ok(isWorkspaceBindingError(drift.result));
		assert.equal(drift.result.code, "drift");
		assert.deepEqual(drift.transcript.slice(-2), [
			"validate: merge-base --is-ancestor <sha> HEAD",
			"validate: rev-parse HEAD",
		]);
	});

	test("fails fast on a missing repository path without running git in it (#3109)", async () => {
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo: join(dirs.root, "absent") }))),
		);
		assert.ok(isWorkspaceBindingError(result));
		assert.equal(result.reason, "not-a-repository");
		assert.deepEqual(
			commands.filter((args) => args[0] !== "--version"),
			[],
		);
	});

	test("reports a store directory it cannot create as a typed filesystem failure before cloning (#3109)", async () => {
		const remote = createRemote(dirs.root, "unwritable-home");
		writeFileSync(join(dirs.home, "repos"), "a file where the store directory belongs\n");
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(result));
		assert.equal(result.code, "filesystem-failed");
		assert.equal(result.fields.operation, "create directory");
		assert.equal(result.fields.errno, "ENOTDIR");
		assert.equal(result.fields.path, dirname(sharedStorePath(classifyRepository(remote.url) as never)));
		assert.equal(result.retryable, false);
		assert.equal((result.cause as NodeJS.ErrnoException).code, "ENOTDIR");
		assert.deepEqual(
			commands.filter((args) => args[0] !== "--version"),
			[],
			"nothing was cloned",
		);
	});

	test("reports a leftover store directory with content as in the way instead of overwriting it (#3109)", async () => {
		const remote = createRemote(dirs.root, "occupied-store");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "unrelated.txt"), "not a git store\n");
		const error = await rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "filesystem-failed");
		assert.equal(error.fields.operation, "move clone to");
		assert.equal(error.fields.path, store);
		assert.deepEqual(readdirSync(store), ["unrelated.txt"], "the leftover content is untouched");
		if (process.platform !== "win32") assert.equal(error.hint, `Remove ${store}, which is in the way, then retry.`);
	});

	test("derives the branch from a remote base by dropping only a leading origin/ (#3109)", async () => {
		const remote = createRemote(dirs.root, "base-branches");
		const bare = remote.url.replace(/^file:\/\//, "");
		git(remote.seed, "push", "-q", bare, "HEAD:refs/heads/release");
		git(remote.seed, "push", "-q", bare, "HEAD:refs/heads/upstream/origin/x");
		const release = await resolveWorkspace(workspace({ repo: remote.url, base: "origin/release" }));
		assert.equal(release.branch, "release");
		const nested = await resolveWorkspace(workspace({ repo: remote.url, base: "upstream/origin/x" }));
		assert.equal(nested.branch, "upstream/origin/x");
	});

	test("a waiter's abort listener is removed when the shared clone settles either way (#3109)", async () => {
		const remote = createRemote(dirs.root, "listeners");
		const controller = new AbortController();
		await resolveWorkspace(workspace({ repo: remote.url, branch: "one" }), { signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const url = `file://${join(dirs.root, "missing-remote.git")
			.replaceAll("\\", "/")
			.replace(/^(?=[A-Za-z]:)/, "/")}`;
		const failed = await rejection(
			resolveWorkspace(workspace({ repo: url, branch: "x" }), { signal: controller.signal }),
		);
		assert.ok(isWorkspaceBindingError(failed));
		assert.equal(failed.fields.phase, "fetch");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
});

// POSIX: the fake git is a shell script.
describe.skipIf(process.platform === "win32")("workspace resolution under injected git failures (#3109)", () => {
	function withFakeGit<T>(mode: string, body: () => Promise<T>): Promise<T> {
		return withInjectedGit(dirs.root, { FAKE_GIT_MODE: mode }, body);
	}

	function storeParent(url: string): string {
		const remote = classifyRepository(url);
		assert.ok(remote?.kind === "remote");
		return dirname(sharedStorePath(remote));
	}

	test("removes a staging clone whose fetch failed and reports the fetch (#3109)", async () => {
		const remote = createRemote(dirs.root, "staging-fetch");
		const error = await withFakeGit("staging-fetch", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "fetch");
		assert.equal(error.fields.detail, "injected fetch failure");
		assert.equal(error.cleanupCause, undefined);
		assert.deepEqual(readdirSync(storeParent(remote.url)), []);
	});

	test("keeps the fetch failure primary when the staging clone cannot be removed (#3109)", async () => {
		const remote = createRemote(dirs.root, "unremovable-staging");
		const error = await withFakeGit("unremovable-staging", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.detail, "injected fetch failure");
		assert.equal((error.cleanupCause as NodeJS.ErrnoException | undefined)?.code, "ENOTDIR");
	});

	test("uses the store a concurrent clone completed when its own clone failed (#3109)", async () => {
		const remote = createRemote(dirs.root, "winner-store");
		const binding = await withFakeGit("winner-store", () =>
			resolveWorkspace(workspace({ repo: remote.url, branch: "x" })),
		);
		assert.equal(binding.repository, realpathSync(sharedStorePath(classifyRepository(remote.url) as never)));
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
	});

	test("does not mistake a store directory without HEAD for a completed clone (#3109)", async () => {
		const remote = createRemote(dirs.root, "empty-store");
		const error = await withFakeGit("empty-store", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.detail, "injected fetch failure");
	});

	test("replaces an empty leftover store directory with a fresh clone (#3109)", async () => {
		const remote = createRemote(dirs.root, "leftover-store");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		mkdirSync(store, { recursive: true });
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "x" }));
		assert.equal(existsSync(join(store, "HEAD")), true);
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
	});

	test("a store whose creation fails before it exists leaves nothing to clean up (#3109)", async () => {
		const remote = createRemote(dirs.root, "init-fails");
		const error = await withFakeGit("init-fails", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "clone");
		assert.equal(error.fields.detail, "injected init failure");
		assert.equal(error.cleanupCause, undefined);
	});

	test("a snapshot that fails before its index exists reports the git failure, not the index cleanup (#3109)", async () => {
		const repo = createRepository(dirs.root, "read-tree");
		const error = await withFakeGit("read-tree", () => rejection(resolveWorkspace(workspace({ repo }))));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "snapshot");
		assert.equal(error.fields.detail, "injected read-tree failure");
	});

	test("a second resolution waits for a worktree another one is still adding (#3109)", async () => {
		const remote = createRemote(dirs.root, "slow-add");
		await resolveWorkspace(workspace({ repo: remote.url, branch: "main" }));
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		const target = join(dirs.home, "worktrees", "file", basename(store, ".git"), "race");
		await withFakeGit("slow-worktree-add", async () => {
			const first = resolveWorkspace(workspace({ repo: remote.url, branch: "race" }));
			while (!existsSync(target)) await new Promise((resolve) => setTimeout(resolve, 10));
			const second = resolveWorkspace(workspace({ repo: remote.url, branch: "race" }));
			const [a, b] = await Promise.all([first, second]);
			assert.equal(a.worktree, realpathSync(target));
			assert.equal(b.worktree, a.worktree);
		});
	});
});
