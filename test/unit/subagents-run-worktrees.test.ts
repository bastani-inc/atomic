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
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
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
	runGitChecked,
	type WorktreeSetup,
} from "../../packages/subagents/src/runs/shared/worktree.js";

const sweepCapture = vi.hoisted((): { directory?: string; reached?: () => void; proceed?: Promise<void> } => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
			if (sweepCapture.directory !== undefined && args[0] === sweepCapture.directory) {
				sweepCapture.directory = undefined;
				sweepCapture.reached?.();
				await sweepCapture.proceed;
			}
			return actual.mkdir(...args);
		}),
	};
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A repository whose main checkout has the files Atomic's worktree setup adds to every new worktree. */
async function repositoryWithSetupSources(): Promise<string> {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-run-worktrees-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	await runGitChecked(repo, ["init", "-b", "main"]);
	await runGitChecked(repo, ["config", "user.name", "Atomic Test"]);
	await runGitChecked(repo, ["config", "user.email", "atomic@example.com"]);
	// Git for Windows defaults core.autocrlf to true, which checks the LF commits below out as CRLF.
	await runGitChecked(repo, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	await runGitChecked(repo, ["add", "seed.txt"]);
	await runGitChecked(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	mkdirSync(join(repo, "node_modules", "dependency"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "dependency", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(repo, ".atomic"), { recursive: true });
	writeFileSync(join(repo, ".atomic", "settings.local.json"), '{"local":true}\n');
	return repo;
}

async function worktreeRun(repo: string): Promise<{ runId: string; setup: WorktreeSetup }> {
	const runId = `run-${randomUUID().slice(0, 8)}`;
	const setup = await createWorktrees(repo, runId, 1);
	cleanups.push(() => cleanupWorktrees(setup));
	return { runId, setup };
}

test("capturing a worktree with a synthetic ignore file keeps the ignored deliverable (#5600)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const tree = setup.worktrees[0]!;
	tree.syntheticPaths.push(".gitignore");
	writeFileSync(join(tree.path, ".gitignore"), "report.txt\n");
	writeFileSync(join(tree.path, "report.txt"), "final report\n");
	const diffsDir = join(repo, "..", "patches");
	const run = registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] });
	await run.release();
	await runGitChecked(repo, ["apply", join(diffsDir, "task-0-worker.patch")]);
	assert.equal(readFileSync(join(repo, "report.txt"), "utf8"), "final report\n");
	assert.equal(
		existsSync(join(repo, ".gitignore")) && readFileSync(join(repo, ".gitignore"), "utf8").includes("report.txt"),
		false,
	);
});

function assertAtomicSetupPresent(worktreePath: string, why: string): void {
	assert.equal(lstatSync(join(worktreePath, "node_modules")).isSymbolicLink(), true, `${why}: node_modules link`);
	assert.equal(
		readFileSync(join(worktreePath, ".atomic", "settings.local.json"), "utf8"),
		'{"local":true}\n',
		`${why}: copied settings`,
	);
}

test("a kept checkout keeps its missing index, and its changes survive later removal (#5600)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const tree = setup.worktrees[0]!;
	const index = join((await runGitChecked(tree.path, ["rev-parse", "--absolute-git-dir"])).trimEnd(), "index");
	unlinkSync(index);
	writeFileSync(join(tree.path, "draft.txt"), "include this draft\n");
	const diffsDir = join(repo, "..", "diffs");
	const run = registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"], onCaptured() {} });
	parkRunWorktree(runId, 0);
	await run.release();
	assert.ok(existsSync(tree.path));
	assert.equal(existsSync(index), false);
	const release = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	await release();
	assert.equal(existsSync(tree.path), false);
	assert.match(readFileSync(join(diffsDir, "task-0-worker.patch"), "utf8"), /include this draft/);
});

test("resuming a paused child in its kept worktree restores missing setup without losing edits (#3784, #5600)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	assertAtomicSetupPresent(worktree.path, "a new worktree");
	const run = registerRunWorktrees(runId, setup, {
		diffsDir: join(repo, "..", "diffs"),
		agents: ["worker"],
		onCaptured() {},
	});
	const execution = holdRunWorktree(runId, 0);
	writeFileSync(join(worktree.path, "draft.md"), "unsaved work\n");
	parkRunWorktree(runId, 0);
	await execution();
	// Aggregate patch reporting must not stage files or unlink setup in a retained checkout.
	await run.release();
	assert.equal(existsSync(worktree.path), true, "the paused child's worktree with unsaved work is kept");
	assertAtomicSetupPresent(worktree.path, "patch capture keeps the checkout intact");
	// Resume also supports worktrees left by older versions, which removed setup during capture.
	unlinkSync(join(worktree.path, "node_modules"));
	unlinkSync(join(worktree.path, ".atomic", "settings.local.json"));
	assert.equal(existsSync(join(worktree.path, "node_modules")), false);

	const releaseResume = await resumeRunWorktree({ runId, index: 0, cwd: worktree.agentCwd, agent: "worker" });
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	await releaseResume();
	assert.equal(readFileSync(join(worktree.path, "draft.md"), "utf8"), "unsaved work\n", "it resumes in place");
	assertAtomicSetupPresent(worktree.path, "the resumed worktree");

	await resumedExecution();
	assert.equal(existsSync(worktree.path), false, "the worktree is removed once the resumed execution ends");
	assert.equal(
		readFileSync(join(repo, "node_modules", "dependency", "index.js"), "utf8"),
		"module.exports = 1;\n",
		"removing the worktree leaves the main checkout's node_modules behind its link",
	);
});

test("after a restart, resuming a child whose worktree was removed recreates it on its branch from the child's record (#3784)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	writeFileSync(join(worktree.path, "work.md"), "committed work\n");
	await runGitChecked(worktree.path, ["add", "work.md"]);
	await runGitChecked(worktree.path, ["commit", "--no-gpg-sign", "-m", "child work"]);
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
	await runGitChecked(repo, ["worktree", "remove", "--force", worktree.path]);
	assert.equal(existsSync(worktree.path), false);
	assert.equal(runWorktreeRecord(runId, 0), undefined, "this process does not track the run, as after a restart");

	const releaseResume = await resumeRunWorktree({
		runId,
		index: 0,
		cwd: worktree.agentCwd,
		agent: "worker",
		worktree: record,
	});
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	await releaseResume();
	assert.equal(existsSync(worktree.path), true, "resume recreated the worktree at its recorded path");
	assert.equal((await runGitChecked(worktree.path, ["branch", "--show-current"])).trim(), worktree.branch);
	assert.equal(readFileSync(join(worktree.path, "work.md"), "utf8"), "committed work\n", "its branch's commits");
	assertAtomicSetupPresent(worktree.path, "the recreated worktree");
	assert.equal(runWorktreeRecord(runId, 0)?.path, worktree.path, "the run is tracked again from the record");

	await resumedExecution();
	assert.equal(existsSync(worktree.path), false, "the recreated worktree is removed once the resumed execution ends");
});

test("after a restart, a resumed child's tracked and untracked edits are saved as a patch before its worktree is removed (#3784)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	const diffsDir = join(repo, "..", "artifacts", "worktree-diffs");
	const run = registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] });
	// The child record, as the run wrote it while it tracked the worktree.
	const record = runWorktreeRecord(runId, 0);
	assert.ok(record, "the run records the child's worktree");
	await run.release();
	assert.equal(existsSync(worktree.path), false, "the run removed the clean worktree");
	assert.equal(runWorktreeRecord(runId, 0), undefined, "this process does not track the run, as after a restart");

	const releaseResume = await resumeRunWorktree({
		runId,
		index: 0,
		cwd: worktree.agentCwd,
		agent: "worker",
		worktree: record,
	});
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	await releaseResume();
	writeFileSync(join(worktree.path, "seed.txt"), "seed\nresumed edit\n");
	writeFileSync(join(worktree.path, "new-file.md"), "resumed untracked\n");
	await resumedExecution();

	assert.equal(existsSync(worktree.path), false, "the resumed child's worktree is removed once it ends");
	assert.equal(readFileSync(join(diffsDir, "task-0-worker.patch"), "utf8"), "", "the first execution's patch is kept");
	const patch = readFileSync(join(diffsDir, "task-0-worker.2.patch"), "utf8");
	assert.match(patch, /\+resumed edit/, "the tracked edit is in the resumed execution's patch");
	assert.match(patch, /new-file\.md[\s\S]*\+resumed untracked/, "the untracked file is in the patch");
});

test("cleanup unlinks a synthetic link named '..cache' before git removes the worktree (#4836)", async () => {
	const repo = await repositoryWithSetupSources();
	const { setup } = await worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	const shared = join(repo, "shared-cache");
	mkdirSync(shared);
	writeFileSync(join(shared, "entry.txt"), "main checkout data\n");
	const link = join(worktree.path, "..cache");
	symlinkSync(shared, link, process.platform === "win32" ? "junction" : "dir");
	// A locked worktree survives `git worktree remove --force`, so the links cleanup removed stay observable.
	await runGitChecked(repo, ["worktree", "lock", worktree.path]);
	cleanups.push(async () => {
		await runGitChecked(repo, ["worktree", "remove", "--force", "--force", worktree.path]);
	});

	await cleanupWorktrees({ ...setup, worktrees: [{ ...worktree, syntheticPaths: ["..cache"] }] });

	assert.equal(existsSync(worktree.path), true, "the locked worktree is still present");
	assert.throws(() => lstatSync(link), { code: "ENOENT" }, "cleanup unlinked the '..cache' link");
	assert.equal(readFileSync(join(shared, "entry.txt"), "utf8"), "main checkout data\n");
});

test("resuming while an async release sweep is in flight serializes behind the sweep and preserves edits (#3784)", async () => {
	const repo = await repositoryWithSetupSources();
	const { runId, setup } = await worktreeRun(repo);
	const worktree = setup.worktrees[0]!;
	const diffsDir = join(repo, "..", "artifacts", "worktree-diffs-concurrent");
	const run = registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] });
	const record = runWorktreeRecord(runId, 0);
	assert.ok(record);
	writeFileSync(join(worktree.path, "seed.txt"), "seed\nin-flight edit\n");

	const reached = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	Object.assign(sweepCapture, { directory: diffsDir, reached: reached.resolve, proceed: proceed.promise });
	cleanups.push(() => proceed.resolve());
	const releaseSweep = run.release();
	await reached.promise;
	const resuming = resumeRunWorktree({
		runId,
		index: 0,
		cwd: worktree.agentCwd,
		agent: "worker",
		worktree: record,
	});
	proceed.resolve();
	await releaseSweep;
	const releaseResume = await resuming;
	const resumedExecution = holdRunWorktree(runId, 0);
	claimRunWorktree(runId, 0);
	await releaseResume();

	assert.equal(existsSync(worktree.path), true, "the worktree is present for the resumed child");
	assert.equal(readFileSync(join(worktree.path, "seed.txt"), "utf8"), "seed\nin-flight edit\n");
	assertAtomicSetupPresent(worktree.path, "the worktree after concurrent sweep and resume");

	await resumedExecution();
	assert.equal(existsSync(worktree.path), false, "the worktree is removed once the resumed execution ends");
});
