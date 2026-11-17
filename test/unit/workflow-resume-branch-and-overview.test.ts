import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createWorkflowResumeProvider } from "../../packages/workflows/src/extension/workflow-resume-provider.js";
import { run as executeWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { resolveInvocationGitBranch } from "../../packages/workflows/src/runs/shared/worktree-git.js";
import { resolveGitHeadBranch } from "../../packages/workflows/src/runs/shared/worktree-root.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { workflowResumeSelectorItems } from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";

const opened: JournalDurableBackend[] = [];
const dirs: string[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	for (const backend of opened.splice(0)) await backend.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

const branchWorkflow = workflow({
	name: "branchy",
	description: "Fix the shipping benchmark",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const stage = await ctx.stage("implement");
		await stage.prompt("ship it");
		return {};
	},
});

const sessionOpts = {
	adapters: {
		prompt: {
			prompt: async () => "ok",
		},
	},
};

function initGitRepo(dir: string, branch = "feat/ship"): (...args: string[]) => string {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q", "-b", branch);
	git(
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	writeFileSync(join(dir, "README.md"), "hello\n");
	mkdirSync(join(dir, ".atomic"), { recursive: true });
	return git;
}

describe("workflow resume branch persistence and live row age (#5256)", () => {
	test("records the invocation branch at launch and shows age and branch on both live and cold durable rows", async () => {
		const repoDir = makeTempDirectory("resume-branch-repo-");
		dirs.push(repoDir);
		const git = initGitRepo(repoDir, "feat/ship");

		const journalDir = makeTempDirectory("resume-branch-journal-");
		dirs.push(journalDir);
		const journalPath = join(journalDir, "journal.sqlite");

		const writer = await JournalDurableBackend.open(await openSqlRunJournal(journalPath));
		opened.push(writer);
		setDurableBackend(writer);
		const completedRunId = testRunId("completed-branch-run");
		await executeWorkflow(
			branchWorkflow,
			{},
			{ runId: completedRunId, cwd: repoDir, store, durableBackend: writer, ...sessionOpts },
		);

		const runId = testRunId("branch-run");
		await executeWorkflow(branchWorkflow, {}, { runId, cwd: repoDir, store, durableBackend: writer, ...sessionOpts });
		await writer.commitWorkflowStatus(runId, "paused", 0, true);

		const recordedSnapshot = store.run(runId);
		assert.equal(recordedSnapshot?.branch, "feat/ship");
		assert.equal(writer.getWorkflow(runId)?.branch, "feat/ship");

		git("checkout", "-q", "-b", "chore/later-checkout");
		await executeWorkflow(
			branchWorkflow,
			{},
			{
				runId,
				cwd: repoDir,
				store,
				durableBackend: writer,
				...sessionOpts,
				continuation: {
					source: recordedSnapshot!,
					resumeFromStageId: recordedSnapshot!.stages[0]?.id,
				},
			},
		);
		await writer.commitWorkflowStatus(runId, "paused", 0, true);
		assert.equal(store.run(runId)?.branch, "feat/ship");
		assert.equal(writer.getWorkflow(runId)?.branch, "feat/ship");

		const liveSnapshot = {
			...recordedSnapshot!,
			status: "paused" as const,
			endedAt: undefined,
			pausedAt: recordedSnapshot!.startedAt,
			resumable: true,
		};
		const now = (liveSnapshot.stages[0]?.endedAt ?? liveSnapshot.startedAt) + 7 * 60_000;
		const [liveItem] = workflowResumeSelectorItems([liveSnapshot], [], [], [liveSnapshot], writer, now);
		assert.ok(liveItem, "expected a live row");
		assert.match(liveItem.session.detail ?? "", /paused · stage 1\/1 implement · 7m ago · \d+s · feat\/ship/);

		await writer.close();
		store.clear();

		const coldBackend = await JournalDurableBackend.open(await openSqlRunJournal(journalPath), { runs: [] });
		opened.push(coldBackend);
		setDurableBackend(coldBackend);
		const runtime = createExtensionRuntime({ definitions: [branchWorkflow], store, cwd: repoDir });
		const provider = createWorkflowResumeProvider({
			pi: {},
			overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			context: () => ({ hasUI: true, cwd: repoDir, ui: { notify: () => undefined } }),
		});

		const rows = await provider.listResumeEntries();
		const coldRow = rows.find((row) => row.id === runId);
		assert.ok(coldRow, "expected the cold durable row");
		assert.match(coldRow.detail ?? "", /paused · stage 1\/1 implement · just now · \d+s · feat\/ship/);

		const completedRows = await provider.listResumeEntries(completedRunId);
		const coldCompletedRow = completedRows.find((row) => row.id === completedRunId);
		assert.ok(coldCompletedRow, "expected the cold completed row");
		assert.match(coldCompletedRow.detail ?? "", /✓ completed · stage 1\/1 implement · just now · \d+s · feat\/ship/);
	});

	test("resolves the branch of a linked git worktree and omits the branch for detached HEAD or non-git directories", async () => {
		const repoDir = makeTempDirectory("resume-wt-main-");
		dirs.push(repoDir);
		const git = initGitRepo(repoDir, "main");

		const worktreeParent = makeTempDirectory("resume-wt-linked-");
		dirs.push(worktreeParent);
		const worktreeDir = join(worktreeParent, "wt");
		git("worktree", "add", "-q", "-b", "feat/worktree-slice", worktreeDir, "HEAD");

		const detachedDir = makeTempDirectory("resume-detached-");
		dirs.push(detachedDir);
		const detachedGit = initGitRepo(detachedDir, "main");
		detachedGit("checkout", "-q", "--detach", "HEAD");

		const nonGitDir = makeTempDirectory("resume-nongit-");
		dirs.push(nonGitDir);

		const journalDir = makeTempDirectory("resume-wt-journal-");
		dirs.push(journalDir);
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(journalDir, "journal.sqlite")));
		opened.push(backend);
		setDurableBackend(backend);

		const wtRunId = testRunId("wt-run");
		await executeWorkflow(
			branchWorkflow,
			{},
			{ runId: wtRunId, cwd: worktreeDir, store, durableBackend: backend, ...sessionOpts },
		);
		assert.equal(backend.getWorkflow(wtRunId)?.branch, "feat/worktree-slice");

		const detachedRunId = testRunId("detached-run");
		await executeWorkflow(
			branchWorkflow,
			{},
			{ runId: detachedRunId, cwd: detachedDir, store, durableBackend: backend, ...sessionOpts },
		);
		assert.equal(backend.getWorkflow(detachedRunId)?.branch, undefined);

		const detachedSnapshot = store.run(detachedRunId);
		await backend.commitWorkflowStatus(detachedRunId, "paused", 0, true);
		detachedGit("checkout", "-q", "-b", "chore/later-branch");
		await executeWorkflow(
			branchWorkflow,
			{},
			{
				runId: detachedRunId,
				cwd: detachedDir,
				store,
				durableBackend: backend,
				...sessionOpts,
				continuation: {
					source: detachedSnapshot!,
					resumeFromStageId: detachedSnapshot!.stages[0]?.id,
				},
			},
		);
		assert.equal(store.run(detachedRunId)?.branch, undefined);
		assert.equal(backend.getWorkflow(detachedRunId)?.branch, undefined);

		const nonGitRunId = testRunId("nongit-run");
		await executeWorkflow(
			branchWorkflow,
			{},
			{ runId: nonGitRunId, cwd: nonGitDir, store, durableBackend: backend, ...sessionOpts },
		);
		assert.equal(backend.getWorkflow(nonGitRunId)?.branch, undefined);

		writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
		assert.equal(
			resolveGitHeadBranch(repoDir, () => "feat/reftable"),
			"feat/reftable",
		);
		assert.equal(
			resolveGitHeadBranch(repoDir, () => undefined),
			undefined,
		);
	});

	test("a fork keeps its source's branch in the source checkout and records the branch of any other destination", async () => {
		const sourceDir = makeTempDirectory("resume-fork-source-");
		dirs.push(sourceDir);
		const sourceGit = initGitRepo(sourceDir, "feat/ship");
		const otherDir = makeTempDirectory("resume-fork-other-");
		dirs.push(otherDir);
		initGitRepo(otherDir, "release/9");
		const nonGitDir = makeTempDirectory("resume-fork-nongit-");
		dirs.push(nonGitDir);
		const journalDir = makeTempDirectory("resume-fork-journal-");
		dirs.push(journalDir);
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(journalDir, "journal.sqlite")));
		opened.push(backend);
		setDurableBackend(backend);

		const runId = testRunId("fork-branch-run");
		await executeWorkflow(
			branchWorkflow,
			{},
			{ runId, cwd: sourceDir, store, durableBackend: backend, ...sessionOpts },
		);
		await backend.commitWorkflowStatus(runId, "paused", 0, true);
		assert.equal(backend.getWorkflow(runId)?.branch, "feat/ship");
		sourceGit("checkout", "-q", "-b", "chore/after-run");

		const forkBranch = async (cwd: string) => {
			const fork = await forkDurableRun(backend, {
				source: "sdk",
				runId,
				carryMessages: "before",
				cwd,
				definition: branchWorkflow,
			});
			await backend.hydrateWorkflow(fork.runId);
			return backend.getWorkflow(fork.runId)?.branch;
		};
		assert.equal(await forkBranch(sourceDir), "feat/ship");
		assert.equal(await forkBranch(otherDir), "release/9");
		assert.equal(await forkBranch(nonGitDir), undefined);
	});

	test("reads the branch of a reftable repository through git", () => {
		const repoDir = makeTempDirectory("resume-reftable-");
		dirs.push(repoDir);
		execFileSync("git", ["init", "-q", "--ref-format=reftable", "-b", "feat/reftable"], {
			cwd: repoDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert.equal(resolveInvocationGitBranch(repoDir), "feat/reftable");
	});
});
