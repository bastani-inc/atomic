/** Bun child for the #4876 suite: runs one worktree scenario and prints its result as JSON. */
import {
	runBrokenIncludeScenario,
	runFailedCaptureScenario,
	runLargeDiffScenario,
	runNoisyHookScenario,
	runWorktreeIncludeScenario,
	type WorktreeModule,
} from "./worktree-large-diff-scenario.ts";

const scenarios = {
	large: runLargeDiffScenario,
	failed: runFailedCaptureScenario,
	include: runWorktreeIncludeScenario,
	hook: runNoisyHookScenario,
	broken: runBrokenIncludeScenario,
} as const;

const [scenario, root, module] = process.argv.slice(2) as [keyof typeof scenarios, string, WorktreeModule];
process.stdout.write(JSON.stringify(scenarios[scenario](root, module)));
