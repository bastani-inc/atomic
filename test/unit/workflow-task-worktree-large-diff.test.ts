import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowArtifact, WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { createScenarioRepository } from "../fixtures/worktree-large-diff-scenario.js";
import { makeTempDirectory } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	setDurableBackend(undefined);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** Run one `ctx.task({ worktree: true })` whose agent edits its worktree with `edit`; returns the task's result. */
async function runWorktreeTask(
	repo: string,
	edit: (cwd: string) => void,
	taskOptions: { artifacts?: boolean } = {},
): Promise<WorkflowTaskResult> {
	let task: WorkflowTaskResult | undefined;
	const def = workflow({
		name: "large-worktree-task",
		description: "",
		inputs: {},
		outputs: { ok: Type.Optional(Type.Boolean()) },
		run: async (ctx) => {
			task = await ctx.task("edit", { prompt: "EDIT", worktree: true, ...taskOptions });
			return { ok: true };
		},
	});
	const result = await run(
		def,
		{},
		{
			store: createStore(),
			cwd: repo,
			adapters: {
				prompt: {
					prompt: async (_text, meta) => {
						edit((meta as { stageOptions?: { cwd?: string } } | undefined)?.stageOptions?.cwd ?? repo);
						return "edited";
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", `the run completes: ${JSON.stringify(result.error ?? "")}`);
	assert.ok(task, "the task returned");
	return task;
}

function diffArtifact(task: WorkflowTaskResult): WorkflowArtifact {
	const artifact = task.artifacts?.find((candidate) => candidate.kind === "diff");
	assert.ok(artifact, "the task reports a diff artifact");
	return artifact;
}

test("ctx.task with worktree: true saves a change over 1 MiB in full before removing its worktree (#4876)", async () => {
	const root = makeTempDirectory("atomic-task-large-diff-");
	roots.push(root);
	const repo = createScenarioRepository(root);
	const large = Array.from({ length: 30_000 }, (_, line) => `${line}:${"x".repeat(64)}`).join("\n");
	let worktree = "";
	const task = await runWorktreeTask(repo, (cwd) => {
		worktree = cwd;
		writeFileSync(join(cwd, "generated.lock"), large);
	});
	const artifact = diffArtifact(task);
	assert.equal(artifact.captureError, undefined);
	assert.equal("worktreePath" in artifact, false, "a captured diff names no kept worktree");
	assert.equal(task.warnings, undefined, "a captured diff adds no warning");
	assert.equal(artifact.filesChanged, 1);
	assert.equal(existsSync(worktree), false, "the captured worktree is removed");
	const clean = join(root, "clean");
	git(repo, ["worktree", "add", "--detach", clean, "HEAD"]);
	git(clean, ["apply", "--whitespace=nowarn", artifact.path]);
	assert.equal(readFileSync(join(clean, "generated.lock"), "utf-8"), large, "the patch restores the change exactly");
});

test("ctx.task with worktree: true keeps a worktree whose diff capture failed and says where (#4876)", async () => {
	const root = makeTempDirectory("atomic-task-failed-diff-");
	roots.push(root);
	const repo = createScenarioRepository(root);
	let worktree = "";
	const task = await runWorktreeTask(repo, (cwd) => {
		worktree = cwd;
		writeFileSync(join(cwd, "work.txt"), "the task's work\n");
		writeFileSync(join(git(cwd, ["rev-parse", "--absolute-git-dir"]).trim(), "index.lock"), "");
	});
	const artifact = diffArtifact(task);
	assert.ok(artifact.captureError, "the diff artifact records the capture failure");
	assert.equal(artifact.worktreePath, worktree);
	assert.equal(readFileSync(join(worktree, "work.txt"), "utf-8"), "the task's work\n", "the work is kept");
	assert.equal(task.warnings?.length, 1, `one warning: ${JSON.stringify(task.warnings)}`);
	assert.match(task.warnings?.[0] ?? "", /^Diff capture failed for task edit; its worktree was kept at /);
	assert.ok((task.warnings?.[0] ?? "").includes(worktree), "the warning names the kept worktree");
});

test("ctx.task with worktree: true and artifacts: false reports no artifacts (#4876)", async () => {
	const root = makeTempDirectory("atomic-task-no-artifacts-");
	roots.push(root);
	const repo = createScenarioRepository(root);
	const task = await runWorktreeTask(repo, (cwd) => writeFileSync(join(cwd, "work.txt"), "work\n"), {
		artifacts: false,
	});
	assert.equal(task.artifacts, undefined);
	assert.equal(task.warnings, undefined);
});

// Git for Windows reads a directory as an empty exclude file instead of failing.
test.skipIf(process.platform === "win32")(
	"ctx.task with worktree: true runs when .worktreeinclude cannot be read and warns where (#4876)",
	async () => {
		const root = makeTempDirectory("atomic-task-include-warning-");
		roots.push(root);
		const repo = createScenarioRepository(root);
		mkdirSync(join(repo, ".worktreeinclude"));
		let worktree = "";
		const task = await runWorktreeTask(repo, (cwd) => {
			worktree = cwd;
			writeFileSync(join(cwd, "work.txt"), "work\n");
		});
		const warning = `.worktreeinclude files were not copied into ${worktree}: could not list .worktreeinclude files:`;
		assert.equal(task.warnings?.length, 1, `one warning: ${JSON.stringify(task.warnings)}`);
		assert.ok((task.warnings?.[0] ?? "").startsWith(warning), `the task warns with the worktree: ${task.warnings}`);
		const artifact = diffArtifact(task);
		assert.equal(artifact.filesChanged, 1, "the task's work is captured");
		assert.deepEqual(artifact.setupWarnings, task.warnings, "the diff artifact carries the same warning");
	},
);
