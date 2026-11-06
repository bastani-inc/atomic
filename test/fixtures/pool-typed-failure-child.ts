import { GitUnavailableError, StageRehydrationError, WorkflowGitRequiredError, workflow } from "@bastani/atomic/workflows";

/** The fields of the error the child fails with, so a test can compare what reaches the root (#4309). */
export const REHYDRATION_FIELDS = {
	runId: "pooled-child-run",
	stageId: "waiting-stage",
	stageName: "review",
	sessionId: "session-1",
} as const;

/** A pooled child that fails with a StageRehydrationError wrapping the store's failure (#4309). */
export const child = workflow({
	name: "pool-typed-failure-child",
	description: "Fails on a local worker with a typed stage-wait error",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("rehydrate", {}, async () => {
			throw new StageRehydrationError(REHYDRATION_FIELDS, { cause: new Error("session store unreachable") });
		});
		return {};
	},
});

/** What the git-required child names, so a test can compare what reaches the root (#4378). */
export const GIT_REQUIRED_FIELDS = {
	workflow: "pool-git-required-child",
	runId: "pooled-child-run",
	source: "input",
	field: "worktree",
	gitWorktreeDir: "/worktrees/child",
} as const;

/** A pooled child that fails because its worker has no git: a WorkflowGitRequiredError with its git cause (#4378). */
export const gitRequiredChild = workflow({
	name: "pool-git-required-child",
	description: "Fails on a local worker with a typed git-required error",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("worktree", {}, async () => {
			throw new WorkflowGitRequiredError(
				GIT_REQUIRED_FIELDS,
				new GitUnavailableError({ code: "offline", offlineVariable: "ATOMIC_OFFLINE", platform: "linux", arch: "x64" }),
			);
		});
		return {};
	},
});
