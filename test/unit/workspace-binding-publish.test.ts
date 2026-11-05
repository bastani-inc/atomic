import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { setWorkspaceGhCommand } from "../../packages/coding-agent/src/core/workspace/change-set.ts";
import {
	isWorkspaceBindingError,
	isWorkspacePublicationError,
	publishPullRequest,
	resolveWorkspace,
	type WorkspaceChangeSet,
	workspace,
	workspaceChangeSet,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
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

function ghCalls(): string[][] {
	return readFileSync(log, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as string[]);
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
		const calls = ghCalls();
		assert.deepEqual(
			calls.map((call) => call.slice(0, 2)),
			[
				["auth", "status"],
				["pr", "list"],
				["pr", "create"],
			],
		);
		assert.ok(calls[2]?.includes("--draft"));
		assert.ok(calls[2]?.includes("--fill"));
		assert.deepEqual(calls[2]?.slice(calls[2].indexOf("--head"), calls[2].indexOf("--head") + 2), [
			"--head",
			"feat/publish",
		]);
	});

	test("returns the open pull request for the branch instead of opening another (#3109)", async () => {
		const { changeSet } = await committedChangeSet("existing");
		process.env.GH_STUB_MODE = "existing";
		assert.deepEqual(await publishPullRequest(changeSet), {
			url: "https://example.test/pr/7",
			draft: false,
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
		assert.throws(() => git(bare, "rev-parse", "--verify", "refs/heads/feat/publish"));
	});

	test("reports a rejected push as push-failed with the git failure as cause (#3109)", async () => {
		const { changeSet, bare } = await committedChangeSet("rejected");
		const other = createRepository(dirs.root, "rejected-other");
		git(other, "push", "-q", bare, "main:refs/heads/feat/publish", "--force");
		const error = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(error));
		assert.equal(error.reason, "push-failed");
		assert.equal(error.retryable, true);
		assert.ok(isWorkspaceBindingError(error.cause));
		assert.equal(error.cause.code, "git-failed");
		assert.equal(error.cause.fields.phase, "push");
	});

	test("reports gh failures and a repository without origin (#3109)", async () => {
		const { changeSet } = await committedChangeSet("gh-fails");
		process.env.GH_STUB_MODE = "create-fails";
		const failed = await rejection(publishPullRequest(changeSet));
		assert.ok(isWorkspacePublicationError(failed));
		assert.equal(failed.reason, "gh-failed");
		assert.match(String(failed.fields.detail), /GraphQL/);

		const local = createRepository(dirs.root, "no-origin");
		const binding = await resolveWorkspace(workspace({ repo: local }));
		const noRemote = await rejection(publishPullRequest(await workspaceChangeSet(binding)));
		assert.ok(isWorkspacePublicationError(noRemote));
		assert.equal(noRemote.reason, "no-remote");
		assert.equal(ghCalls().length, 3, "no gh call for a repository without origin");
	});
});
