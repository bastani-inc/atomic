export { setupGitWorktree } from "./worktree-git.js";
export {
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeTaskCwdConflict,
	resolveExpectedWorktreeAgentCwd,
} from "./worktree-setup.js";
export { diffWorktrees, formatWorktreeDiffSummary } from "./worktree-diff.js";
export type {
	CreateWorktreesOptions,
	GitWorktreeSetupOptions,
	GitWorktreeSetupResult,
	WorktreeDiff,
	WorktreeInfo,
	WorktreeSetup,
	WorktreeTaskCwdConflict,
} from "./worktree-types.js";
