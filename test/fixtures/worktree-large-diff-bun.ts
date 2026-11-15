/** Bun child for the #4876 suite: runs one worktree diff scenario and prints its result as JSON. */
import {
	runFailedCaptureScenario,
	runLargeDiffScenario,
	runWorktreeIncludeScenario,
	type WorktreeModule,
} from "./worktree-large-diff-scenario.ts";

const [scenario, root, module] = process.argv.slice(2) as [string, string, WorktreeModule];
const result =
	scenario === "large"
		? runLargeDiffScenario(root, module)
		: scenario === "include"
			? runWorktreeIncludeScenario(root, module)
			: runFailedCaptureScenario(root, module);
process.stdout.write(JSON.stringify(result));
