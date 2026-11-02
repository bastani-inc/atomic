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
	baseBranch?: string;
	symlinkDirectories?: readonly string[];
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
	signal?: NodeJS.Signals | null;
	error?: Error;
	argv?: readonly string[];
	cwd?: string;
	timeoutMs?: number;
	elapsedMs?: number;
	attempts?: number;
}

export interface GitWorktreeSetupOptions {
	gitWorktreeDir: string;
	baseBranch?: string;
	cwd: string;
}

export interface GitWorktreeSetupResult {
	/** Root of the checkout in use: the requested path, or the checkout allocated beneath a non-empty requested directory. */
	worktreeRoot: string;
	/** Effective workflow cwd: the caller's repo-relative subdirectory inside the worktree when the caller is in the same repository, otherwise the worktree root. */
	cwd: string;
	/** Invoking checkout root reported by Git when the worktree belongs to the invoking repository; otherwise the worktree root itself. */
	repositoryRoot: string;
	/** Whether this call created a new linked worktree. Existing worktrees are reused as-is. */
	created: boolean;
}

export interface RepoState {
	toplevel: string;
	mainRoot: string;
	cwdRelative: string;
	baseCommit: string;
	baseRef: string;
}
