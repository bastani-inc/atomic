// Produces the error a pooled child run fails with when its worktree input needs git, and writes its wire form to
// stdout (#4322).
import { prepareRunGit } from "../../../packages/workflows/src/runs/shared/worktree-git-runner.ts";

const error = await prepareRunGit(new AbortController().signal, {
	workflow: "goal",
	runId: "child-run",
	source: "input",
	field: "git_worktree_dir",
	gitWorktreeDir: "../wt",
}).catch((caught: Error) => caught);
process.stdout.write(`${JSON.stringify(error)}\n`);
