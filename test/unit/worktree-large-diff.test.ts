import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	type BrokenIncludeScenarioResult,
	type FailedCaptureScenarioResult,
	INCLUDED_CONFIG_FILES,
	type LargeDiffScenarioResult,
	MANY_FILES,
	type NoisyHookScenarioResult,
	runBrokenIncludeScenario,
	runFailedCaptureScenario,
	runLargeDiffScenario,
	runManyFilesScenario,
	runNoisyHookScenario,
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

function inBun<T>(
	scenario: "large" | "failed" | "include" | "hook" | "broken",
	root: string,
	module: WorktreeModule,
): T {
	const result = spawnSync(
		bunExecutable(),
		[join(moduleDir(import.meta.url), "..", "fixtures", "worktree-large-diff-bun.ts"), scenario, root, module],
		{ encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
	);
	assert.equal(result.status, 0, `bun scenario failed: ${result.stderr}`);
	return JSON.parse(result.stdout) as T;
}

/**
 * The numstat scenario's cost is its real git children (about 25 of them, on a 400-file change), which took up to 34 s
 * on Windows with twenty suites running at once.
 */
const MANY_FILES_SCENARIO_TIMEOUT_MS = 60_000;
/**
 * Copying 200 included files runs about 400 git children (each path component is checked against the index), which
 * took up to 55 s on Windows with twenty suites running at once.
 */
const INCLUDE_SCENARIO_TIMEOUT_MS = 120_000;

type Runtime = "Node" | "Bun";
const cases: Array<{ runtime: Runtime; module: WorktreeModule }> = [
	{ runtime: "Node", module: "subagents" },
	{ runtime: "Bun", module: "subagents" },
];

describe.each(cases)("$module worktrees under $runtime", ({ runtime, module }) => {
	test("a worktree change over 1 MiB is saved in full before the worktree is removed (#4876)", async () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? await runLargeDiffScenario(root, module)
				: inBun<LargeDiffScenarioResult>("large", root, module);
		assert.ok(result.largeFileBytes > 1024 * 1024 * 1.5, "the change is well over the 1 MiB output cap");
		assert.equal(result.largePatchApplied, true, `the large patch applies: ${result.largePatchStderr}`);
		assert.equal(result.largeFileRestored, true, "applying the patch restores the large file exactly");
		assert.equal(result.smallFileRestored, true, "applying the small patch restores the small file");
		assert.match(result.summary, /Task 1 \(large\): 1 files changed, \+30000 -0/);
		assert.match(result.summary, /Task 2 \(small\): 1 files changed, \+1 -0/);
		assert.doesNotMatch(result.summary, /Task 3/, "a task without changes is not listed");
		assert.equal(result.worktreesRemoved, true, "worktrees whose diffs were saved are removed");
	});

	test("a worktree whose diff capture failed is kept and reported with its path (#4876)", async () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? await runFailedCaptureScenario(root, module)
				: inBun<FailedCaptureScenarioResult>("failed", root, module);
		assert.equal(result.worktreeKept, true, "the worktree is not removed");
		assert.equal(result.workKept, true, "the child's work is still in it");
		assert.ok(result.captureError, "the diff records the capture failure");
		assert.ok(result.summary.includes(result.worktreePath), `the summary names the kept worktree: ${result.summary}`);
		assert.match(result.summary, /Task 1 \(worker\): diff capture failed/);
		assert.equal(
			result.laterSweepSavedWork,
			true,
			"a later sweep saves the work once capture works, then removes it",
		);
	});

	test("a .worktreeinclude file is copied into a new worktree when the ignored files list to over 1 MiB (#4876)", {
		timeout: INCLUDE_SCENARIO_TIMEOUT_MS,
	}, async () => {
		const root = tempRoot();
		const result =
			runtime === "Node"
				? await runWorktreeIncludeScenario(root, module)
				: inBun<WorktreeIncludeScenarioResult>("include", root, module);
		assert.ok(result.ignoredListingBytes > 1024 * 1024, "the ignored-file listing is over the 1 MiB output cap");
		assert.equal(result.envCopied, true, ".env reaches the new worktree");
		assert.equal(result.includedFilesCopied, INCLUDED_CONFIG_FILES, "every included file reaches the new worktree");
		assert.equal(result.notIncludedCopied, false, "an ignored file .worktreeinclude does not name stays out");
	});

	// The git runner and its buffer are the same under Bun.
	test.runIf(runtime === "Node")(
		"a worktree change of so many files that its numstat is over 1 MiB is saved in full (#4876)",
		{ timeout: MANY_FILES_SCENARIO_TIMEOUT_MS },
		async () => {
			const result = await runManyFilesScenario(tempRoot(), module);
			assert.ok(result.numstatBytes > 1024 * 1024, "the numstat is over the 1 MiB output cap");
			assert.match(
				result.summary,
				new RegExp(`Task 1 \\(many\\): ${MANY_FILES} files changed, \\+${MANY_FILES} -0`),
			);
			assert.equal(result.patchApplied, true, "the patch applies to a clean checkout");
			assert.equal(result.filesRestored, MANY_FILES, "the patch restores every file");
			assert.equal(result.worktreeRemoved, true, "the captured worktree is removed");
		},
	);

	// Git for Windows reads a directory as an empty exclude file instead of failing.
	test.skipIf(process.platform === "win32")(
		"a .worktreeinclude git cannot read still creates the worktree and warns with git's reason (#4876)",
		async () => {
			const root = tempRoot();
			const result =
				runtime === "Node"
					? await runBrokenIncludeScenario(root, module)
					: inBun<BrokenIncludeScenarioResult>("broken", root, module);
			assert.equal(result.error, undefined, "worktree creation does not fail");
			assert.equal(result.worktreeCreated, true);
			assert.equal(result.setupWarnings?.length, 1, `one setup warning: ${JSON.stringify(result.setupWarnings)}`);
			const warning = result.setupWarnings?.[0] ?? "";
			assert.ok(warning.includes(result.worktreePath), "the warning names the worktree");
			assert.match(
				warning,
				/\.worktreeinclude files were not copied into .*: could not list \.worktreeinclude files: .*cannot use \.worktreeinclude/,
			);
			assert.doesNotMatch(warning, /\s$/, "git's reason is trimmed");
			assert.ok(
				result.summary.includes(`Warning: Task 1 (worker): ${warning}`),
				`the summary carries the warning: ${result.summary}`,
			);
		},
	);

	// The hook is a POSIX shell script; Windows runs hooks only as executables.
	test.skipIf(process.platform === "win32")(
		"a setup hook that logs over 1 MiB still sets up its worktree (#4876)",
		async () => {
			const root = tempRoot();
			const result =
				runtime === "Node"
					? await runNoisyHookScenario(root, module)
					: inBun<NoisyHookScenarioResult>("hook", root, module);
			assert.equal(result.error, undefined);
			assert.equal(result.created, true);
		},
	);
});
