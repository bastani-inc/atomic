export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}

export interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
}

export interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

export interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

export interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
}

export interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

export interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

export interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

export interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

export interface GitWorktreeSetupOptions {
	gitWorktreeDir: string;
	baseBranch?: string;
	cwd: string;
}

export interface GitWorktreeSetupResult {
	/** Root checkout path that was requested/created/reused. */
	worktreeRoot: string;
	/** Effective workflow cwd, preserving the caller's repo-relative subdirectory inside the worktree. */
	cwd: string;
	/** Invoking checkout root reported by Git. */
	repositoryRoot: string;
	/** Whether this call created a new linked worktree. Existing roots are reused as-is. */
	created: boolean;
}

export interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}
