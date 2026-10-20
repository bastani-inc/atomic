import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	claimRunWorktree,
	holdRunWorktree,
	parkRunWorktree,
	registerRunWorktrees,
	resumeRunWorktree,
	runWorktreeRecord,
	type SubagentChildWorktree,
} from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	type WorktreeSetup,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import { runGitChecked } from "../../packages/workflows/src/runs/shared/worktree-git.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A repository whose main checkout has the files Atomic's worktree setup adds to every new worktree. */
function repositoryWithSetupSources(): string {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-run-worktrees-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	runGitChecked(repo, ["init", "-b", "main"]);
	runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	// Git for Windows defaults core.autocrlf to true, which checks the LF commits below out as CRLF.
	runGitChecked(repo, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	runGitChecked(repo, ["add", "seed.txt"]);
	runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	mkdirSync(join(repo, "node_modules", "dependency"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "dependency", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), '{"local":true}\n');
	return repo;
}

function worktreeRun(repo: string): { runId: string; setup: WorktreeSetup } {
	const runId = `run-${randomUUID().slice(0, 8)}`;
	const setup = createWorktrees(repo, runId, 1);
	cleanups.push(() => cleanupWorktrees(setup));
	return { runId, setup };
}

function assertAtomicSetupPresent(worktreePath: string, why: string): void {
	assert.equal(lstatSync(join(worktreePath, "node_modules")).isSymbolicLink(), true, `${why}: node_modules link`);
	assert.equal(
		readFileSync(join(worktreePath, ".atomic", "settings.local.json"), "utf8"),
		'{"local":true}\n',
		`${why}: copied settings`,
	);
}

test("resuming a paused child in its kept worktree restores the node_modules link and settings its run's diff removed (#3784)", () => {
	const repo = repositoryWithSetupSources();
	const { runId, setup } = worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	assertAtomicSetupPresent(worktree.path, "a new worktree");
	const run = registerRunWorktrees(runId, setup);
	const execution = holdRunWorktree(runId, 0);
	writeFileSync(join(worktree.path, "draft.md"), "unsaved work\n");
	parkRunWorktree(runId, 0);
	execution();
	// The run returns: it reports every worktree's changes, then lets go of its worktrees.
	diffWorktrees(setup, ["worker"], join(repo, "..", "diffs"));
	run.release();
	assert.equal(existsSync(worktree.path), true, "the paused child's worktree with unsaved work is kept");
	assert.equal(existsSync(join(worktree.path, "node_modules")), false, "the diff removed the node_modules link");

	const releaseResume = resumeRunWorktree({ runId, index: 0, cwd: worktree.agentCwd, agent: "worker" });
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	releaseResume();
	assert.equal(readFileSync(join(worktree.path, "draft.md"), "utf8"), "unsaved work\n", "it resumes in place");
	assertAtomicSetupPresent(worktree.path, "the resumed worktree");

	resumedExecution();
	assert.equal(existsSync(worktree.path), false, "the worktree is removed once the resumed execution ends");
	assert.equal(
		readFileSync(join(repo, "node_modules", "dependency", "index.js"), "utf8"),
		"module.exports = 1;\n",
		"removing the worktree leaves the main checkout's node_modules behind its link",
	);
});

test("after a restart, resuming a child whose worktree was removed recreates it on its branch from the child's record (#3784)", () => {
	const repo = repositoryWithSetupSources();
	const { runId, setup } = worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	writeFileSync(join(worktree.path, "work.md"), "committed work\n");
	runGitChecked(worktree.path, ["add", "work.md"]);
	runGitChecked(worktree.path, ["commit", "--no-gpg-sign", "-m", "child work"]);
	// What the child record carries, as `runWorktreeRecord` writes it while the run is tracked.
	const record: SubagentChildWorktree = {
		repo: setup.cwd,
		path: worktree.path,
		branch: worktree.branch,
		baseCommit: setup.baseCommit,
		syntheticPaths: worktree.syntheticPaths,
	};
	// Git for Windows keeps a junction (and the worktree directory above it), so the link goes first, as on cleanup.
	unlinkSync(join(worktree.path, "node_modules"));
	runGitChecked(repo, ["worktree", "remove", "--force", worktree.path]);
	assert.equal(existsSync(worktree.path), false);
	assert.equal(runWorktreeRecord(runId, 0), undefined, "this process does not track the run, as after a restart");

	const releaseResume = resumeRunWorktree({
		runId,
		index: 0,
		cwd: worktree.agentCwd,
		agent: "worker",
		worktree: record,
	});
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	releaseResume();
	assert.equal(existsSync(worktree.path), true, "resume recreated the worktree at its recorded path");
	assert.equal(runGitChecked(worktree.path, ["branch", "--show-current"]).trim(), worktree.branch);
	assert.equal(readFileSync(join(worktree.path, "work.md"), "utf8"), "committed work\n", "its branch's commits");
	assertAtomicSetupPresent(worktree.path, "the recreated worktree");
	assert.equal(runWorktreeRecord(runId, 0)?.path, worktree.path, "the run is tracked again from the record");

	resumedExecution();
	assert.equal(existsSync(worktree.path), false, "the recreated worktree is removed once the resumed execution ends");
});

test("after a restart, a resumed child's tracked and untracked edits are saved as a patch before its worktree is removed (#3784)", () => {
	const repo = repositoryWithSetupSources();
	const { runId, setup } = worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	const diffsDir = join(repo, "..", "artifacts", "worktree-diffs");
	const run = registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] });
	// The child record, as the run wrote it while it tracked the worktree.
	const record = runWorktreeRecord(runId, 0);
	assert.ok(record, "the run records the child's worktree");
	run.release();
	assert.equal(existsSync(worktree.path), false, "the run removed the clean worktree");
	assert.equal(runWorktreeRecord(runId, 0), undefined, "this process does not track the run, as after a restart");

	const releaseResume = resumeRunWorktree({
		runId,
		index: 0,
		cwd: worktree.agentCwd,
		agent: "worker",
		worktree: record,
	});
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	releaseResume();
	writeFileSync(join(worktree.path, "seed.txt"), "seed\nresumed edit\n");
	writeFileSync(join(worktree.path, "new-file.md"), "resumed untracked\n");
	resumedExecution();

	assert.equal(existsSync(worktree.path), false, "the resumed child's worktree is removed once it ends");
	const patch = readFileSync(join(diffsDir, "task-0-worker.patch"), "utf8");
	assert.match(patch, /\+resumed edit/, "the tracked edit is in the patch");
	assert.match(patch, /new-file\.md[\s\S]*\+resumed untracked/, "the untracked file is in the patch");
});
