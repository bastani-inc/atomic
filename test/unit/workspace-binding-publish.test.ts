import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { setWorkspaceGhCommand } from "../../packages/coding-agent/src/core/workspace/change-set.ts";
import {
	isWorkspacePublicationError,
	publishPullRequest,
	resolveWorkspace,
	type WorkspaceChangeSet,
	workspace,
	workspaceChangeSet,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { classifyRepository } from "../../packages/coding-agent/src/core/workspace/spec.ts";
import { moduleDir } from "../helpers/runtime.js";
import {
	commitFile,
	createRemote,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

const GH_STUB = join(moduleDir(import.meta.url), "..", "fixtures", "gh-stub.mjs");

let dirs: WorkspaceSandboxDirs;
let restoreGh: () => void;
let log: string;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-publish-");
	log = join(dirs.root, "gh.log");
	writeFileSync(log, "");
	process.env.GH_STUB_LOG = log;
	delete process.env.GH_STUB_MODE;
	restoreGh = setWorkspaceGhCommand({ path: process.execPath, args: [GH_STUB] });
});

afterEach(() => {
	restoreGh();
	delete process.env.GH_STUB_LOG;
	delete process.env.GH_STUB_MODE;
	dirs.cleanup();
});

function ghLog(): { args: string[]; prompt: string | null }[] {
	return readFileSync(log, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { args: string[]; prompt: string | null });
}

function ghCalls(): string[][] {
	return ghLog().map((entry) => entry.args);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

async function committedChangeSet(name: string): Promise<{ changeSet: WorkspaceChangeSet; bare: string }> {
	const remote = createRemote(dirs.root, name);
	const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "feat/publish" }));
	commitFile(binding.worktree, "change.txt", "one\ntwo\n");
	return { changeSet: await workspaceChangeSet(binding), bare: join(dirs.root, `${name}.git`) };
}

describe("publishPullRequest (#3109)", () => {
	test("pushes the head commit to its branch and opens a draft pull request (#3109)", async () => {
		const { changeSet, bare } = await committedChangeSet("publish");
		assert.deepEqual(changeSet.diffStat, { files: 1, insertions: 2, deletions: 0 });
		const published = await publishPullRequest(changeSet, { draft: true });
		assert.deepEqual(published, { url: "https://example.test/pr/8", draft: true, created: true });
		assert.equal(git(bare, "rev-parse", "refs/heads/feat/publish"), changeSet.headCommit);
		const remote = classifyRepository(changeSet.repo);
		assert.ok(remote?.kind === "remote");
		const repo = `file/${remote.segments.slice(-2).join("/")}`;
		assert.deepEqual(ghCalls(), [
			["auth", "status", "--hostname", "file"],
			[
				"pr",
				"list",
				"--repo",
				repo,
				"--head",
				"feat/publish",
				"--state",
				"open",
				"--json",
				"url,isDraft",
				"--limit",
				"1",
			],
			["pr", "create", "--repo", repo, "--head", "feat/publish", "--fill", "--draft"],
		]);
		assert.deepEqual(
			ghLog().map((entry) => entry.prompt),
			["1", "1", "1"],
			"gh never prompts",
		);
	});

	test("a change set counts binary files and deletions (#3109)", async () => {
		const repo = createRepository(dirs.root, "binary");
		const binding = await resolveWorkspace(workspace({ repo, branch: "binary-change" }));
		writeFileSync(join(binding.worktree, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
		writeFileSync(join(binding.worktree, "README.md"), "");
		git(binding.worktree, "add", "-A");
		git(binding.worktree, "commit", "-q", "-m", "binary and deletion");
		const changeSet = await workspaceChangeSet(binding);
		assert.deepEqual(changeSet.diffStat, { files: 2, insertions: 0, deletions: 1 });
		assert.equal(changeSet.headCommit, git(binding.worktree, "rev-parse", "HEAD"));
		assert.equal(changeSet.baseCommit, git(repo, "rev-parse", "main"));
		const unchanged = await resolveWorkspace(workspace({ repo, branch: "no-change" }));
		assert.deepEqual((await workspaceChangeSet(unchanged)).diffStat, { files: 0, insertions: 0, deletions: 0 });
	});

	test("opens a ready pull request unless draft is requested (#3109)", async () => {
		const { changeSet } = await committedChangeSet("ready");
		assert.deepEqual(await publishPullRequest(changeSet), {
			url: "https://example.test/pr/8",
			draft: false,
			created: true,
		});
		assert.equal(ghCalls().at(-1)?.includes("--draft"), false);
	});

	test("returns the open pull request for the branch instead of opening another (#3109)", async () => {
		const { changeSet } = await committedChangeSet("existing");
		process.env.GH_STUB_MODE = "existing";
		assert.deepEqual(await publishPullRequest(changeSet), {
			url: "https://example.test/pr/7",
			draft: true,
			created: false,
		});
		assert.equal(
			ghCalls().some((call) => call[1] === "create"),
			false,
		);
	});

	test("checks gh before pushing: unauthenticated or missing gh fails with nothing pushed (#3109)", async () => {
		const { changeSet, bare } = await committedChangeSet("preconditions");
		process.env.GH_STUB_MODE = "unauthenticated";
		const unauthenticated = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(unauthenticated));
		assert.equal(unauthenticated.code, "publication-failed");
		assert.equal(unauthenticated.reason, "gh-unauthenticated");
		assert.match(unauthenticated.hint, /gh auth login/);
		restoreGh();
		restoreGh = setWorkspaceGhCommand({ path: join(dirs.root, "no-gh"), args: [] });
		const missing = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(missing));
		assert.equal(missing.reason, "gh-unavailable");
		assert.equal(missing.retryable, false);
		assert.ok((missing.cause as { code?: string }).code === "ENOENT");
		assert.throws(() => git(bare, "rev-parse", "--verify", "refs/heads/feat/publish"));
	});

	test("reports a rejected push as push-failed with git's reason (#3109)", async () => {
		const { changeSet, bare } = await committedChangeSet("rejected");
		const other = createRepository(dirs.root, "rejected-other");
		git(other, "push", "-q", bare, "main:refs/heads/feat/publish", "--force");
		const error = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(error));
		assert.equal(error.reason, "push-failed");
		assert.equal(error.retryable, true);
		assert.equal(error.fields.repo, changeSet.repo);
		assert.equal(error.fields.branch, "feat/publish");
		assert.match(String(error.fields.detail), /rejected/);
	});

	test("reports gh failures and a repository without a usable origin (#3109)", async () => {
		const { changeSet } = await committedChangeSet("gh-fails");
		process.env.GH_STUB_MODE = "create-fails";
		const failed = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(failed));
		assert.equal(failed.reason, "gh-failed");
		assert.equal(failed.fields.detail, "GraphQL: something went wrong");
		process.env.GH_STUB_MODE = "list-fails";
		const listFailed = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(listFailed));
		assert.equal(listFailed.fields.detail, "HTTP 502 from list", "stdout is the detail when stderr is empty");
		process.env.GH_STUB_MODE = "garbage";
		const garbage = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(garbage));
		assert.equal(garbage.reason, "gh-failed");
		assert.equal(garbage.fields.detail, "unreadable gh output");
		assert.ok(garbage.cause instanceof SyntaxError);
		process.env.GH_STUB_MODE = "killed";
		const killed = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(killed));
		assert.equal(killed.reason, "gh-failed");

		const calls = ghCalls().length;
		for (const origin of [null, "https://example.com/only-one-segment", "/srv/local/path"]) {
			const local = createRepository(dirs.root, `origin-${calls}-${String(origin).length}`);
			if (origin !== null) git(local, "remote", "add", "origin", origin);
			const binding = await resolveWorkspace(workspace({ repo: local }));
			const noRemote = await rejection(publishPullRequest(await workspaceChangeSet(binding)));
			assert.ok(isWorkspacePublicationError(noRemote), String(origin));
			assert.equal(noRemote.reason, "no-remote");
		}
		assert.equal(ghCalls().length, calls, "no gh call without a GitHub-shaped origin");
	});

	test("a gh that cannot be executed is gh-failed, and cancellation rejects with the signal's reason (#3109)", async () => {
		const { changeSet } = await committedChangeSet("spawn");
		restoreGh();
		restoreGh = setWorkspaceGhCommand({ path: dirs.root, args: [] });
		const notExecutable = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(notExecutable));
		assert.equal(notExecutable.reason, "gh-failed");
		restoreGh();
		restoreGh = setWorkspaceGhCommand({ path: process.execPath, args: [GH_STUB] });
		process.env.GH_STUB_MODE = "hang";
		const controller = new AbortController();
		const reason = new Error("stop publishing");
		const pending = publishPullRequest(changeSet, { signal: controller.signal });
		setTimeout(() => controller.abort(reason), 300);
		assert.equal(await rejection(pending), reason);
	});
});
