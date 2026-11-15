import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type FailedCaptureScenarioResult,
	type LargeDiffScenarioResult,
	runFailedCaptureScenario,
	runLargeDiffScenario,
	runWorktreeIncludeScenario,
	type WorktreeIncludeScenarioResult,
	type WorktreeModule,
} from "../fixtures/worktree-large-diff-scenario.js";
import { bunExecutable, makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		// A kept worktree is registered in its repository; removing the temp root removes both.
		rmSync(root, { recursive: true, force: true });
	}
});

function tempRoot(): string {
	const root = makeTempDirectory("atomic-worktree-large-diff-");
	roots.push(root);
	return root;
}

function inBun<T>(scenario: "large" | "failed" | "include", root: string, module: WorktreeModule): T {
	const result = spawnSync(
		bunExecutable(),
		[join(moduleDir(import.meta.url), "..", "fixtures", "worktree-large-diff-bun.ts"), scenario, root, module],
		{ encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
	);
	assert.equal(result.status, 0, `bun scenario failed: ${result.stderr}`);
	return JSON.parse(result.stdout) as T;
}

type Runtime = "Node" | "Bun";
const cases: Array<{ runtime: Runtime; module: WorktreeModule }> = [
	{ runtime: "Node", module: "subagents" },
	{ runtime: "Bun", module: "subagents" },
	{ runtime: "Node", module: "workflows" },
	{ runtime: "Bun", module: "workflows" },
];

describe.each(cases)("$module worktrees under $runtime", ({ runtime, module }) => {
	test("a worktree change over 1 MiB is saved in full before the worktree is removed (#4876)", () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? runLargeDiffScenario(root, module)
				: inBun<LargeDiffScenarioResult>("large", root, module);
		assert.ok(result.largeFileBytes > 1024 * 1024 * 1.5, "the change is well over the 1 MiB output cap");
		assert.equal(result.largePatchApplied, true, `the large patch applies: ${result.largePatchStderr}`);
		assert.equal(result.largeFileRestored, true, "applying the patch restores the large file exactly");
		assert.equal(result.smallFileRestored, true, "applying the small patch restores the small file");
		assert.match(result.summary, /Task 1 \(large\): 1 files changed, \+30000 -0/);
		assert.match(result.summary, /Task 2 \(small\): 1 files changed, \+1 -0/);
		assert.equal(result.worktreesRemoved, true, "worktrees whose diffs were saved are removed");
	});

	test("a worktree whose diff capture failed is kept and reported with its path (#4876)", () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? runFailedCaptureScenario(root, module)
				: inBun<FailedCaptureScenarioResult>("failed", root, module);
		assert.equal(result.worktreeKept, true, "the worktree is not removed");
		assert.equal(result.workKept, true, "the child's work is still in it");
		assert.ok(result.captureError, "the diff records the capture failure");
		assert.ok(result.summary.includes(result.worktreePath), `the summary names the kept worktree: ${result.summary}`);
		assert.match(result.summary, /Task 1 \(worker\): diff capture failed/);
	});

	test("a .worktreeinclude file is copied into a new worktree when the ignored files list to over 1 MiB (#4876)", () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? runWorktreeIncludeScenario(root, module)
				: inBun<WorktreeIncludeScenarioResult>("include", root, module);
		assert.ok(result.ignoredListingBytes > 1024 * 1024, "the ignored-file listing is over the 1 MiB output cap");
		assert.equal(result.envCopied, true, ".env reaches the new worktree");
	});
});
