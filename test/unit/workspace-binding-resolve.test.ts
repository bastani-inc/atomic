import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
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
	WorkspaceBindingError,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { sharedStorePath } from "../../packages/coding-agent/src/core/workspace/resolve.ts";
import { classifyRepository } from "../../packages/coding-agent/src/core/workspace/spec.ts";
import {
	commitFile,
	countGitCommands,
	createRemote,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
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
		writeFileSync(join(repo, "untracked.txt"), "work in progress\n");
		writeFileSync(join(repo, "package-lock.json"), "{}\n");
		const binding = await resolveWorkspace(workspace({ repo }));
		assert.notEqual(binding.tree, git(repo, "rev-parse", "HEAD^{tree}"));
		assert.equal(git(repo, "cat-file", "-p", `${binding.tree}:untracked.txt`), "work in progress");
		assert.deepEqual(binding.remotes, ["https://example.com/acme/dirty.git"]);
		assert.equal(git(repo, "status", "--porcelain").includes("untracked.txt"), true);
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
		const clones = commands.filter((args) => args.includes("clone"));
		const adds = commands.filter((args) => args[0] === "worktree" && args[1] === "add");
		assert.equal(clones.length, 1, "one clone for every concurrent binding of the repository");
		assert.equal(adds.length, branches.length, "one worktree per branch");
		const stores = new Set(result.map((binding) => binding.repository));
		assert.equal(stores.size, 1);
		const [store] = stores;
		assert.ok(store?.startsWith(join(dirs.home, "repos")));
		assert.ok(store?.endsWith("product-service.git"));
		for (const [index, binding] of result.entries()) {
			assert.equal(binding.branch, branches[index]);
			assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
			assert.deepEqual(binding.remotes, [remote.url]);
		}

		const again = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo: remote.url, base: "origin/main", branch: "feat/e" })),
		);
		assert.equal(again.commands.filter((args) => args.includes("clone")).length, 0, "the store is reused");
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
		assert.equal(bound.worktree, join(dirs.home, "worktrees", "file", ...segments.segments, "main"));
		assert.equal(bound.branch, "main", "a remote without a branch binds the branch of its default base");
		assert.equal(bound.base, "origin/main");
		assert.equal(
			sharedStorePath({ kind: "remote", url: "x", host: "git.example.com:8443", segments: ["team a", "svc"] }),
			join(dirs.home, "repos", "git.example.com_8443", "team_a", "svc.git"),
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
			rmSync(scratch, { recursive: true, force: true });
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
		rmSync(binding.worktree, { recursive: true, force: true });
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
		assert.equal(error.fields.phase, "clone");
		assert.equal(error.retryable, true);
		const remote = classifyRepository(url);
		assert.ok(remote?.kind === "remote");
		assert.deepEqual(readdirSync(dirname(sharedStorePath(remote))), [], "the staging clone was removed");
	});

	test("a cancelled waiter stops waiting while the shared clone finishes for the others (#3109)", async () => {
		const remote = createRemote(dirs.root, "shared-clone");
		const controller = new AbortController();
		const reason = new Error("caller went away");
		const cancelled = resolveWorkspace(workspace({ repo: remote.url, branch: "one" }), { signal: controller.signal });
		const kept = resolveWorkspace(workspace({ repo: remote.url, branch: "two" }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort(reason);
		assert.equal(await rejection(cancelled), reason);
		const binding = await kept;
		assert.equal(binding.branch, "two");
		assert.equal(existsSync(join(binding.repository, "HEAD")), true);
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
			assert.match(String(result.fields.installCommand), /git/);
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
				cwd: dirs.root,
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
			cwd: dirs.root,
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
});
