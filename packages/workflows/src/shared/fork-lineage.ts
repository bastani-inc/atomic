/** Run lineage and repository bindings a fork carries (#4321, #3109, #4245). Dependency-free for the authoring surface. */

/** Lineage of a forked run: the source run and, for a fork from a stage, that stage's path. */
export interface WorkflowForkedFrom {
	readonly runId: string;
	/** Dot path of the stage the fork re-runs from; absent when the fork copied the whole run. */
	readonly stagePath?: string;
}

/** A repository state: its remotes, `HEAD` commit, tree id and environment fingerprint (#4245). */
export interface DurableRepositoryBinding {
	readonly remotes: readonly string[];
	readonly head: string;
	readonly tree: string;
	readonly envHash: string;
}

/** A resolved repository workspace (#3109): its repository state plus repository, branch, worktree and label. */
export interface DurableWorkspaceBinding extends DurableRepositoryBinding {
	readonly repository: string;
	readonly branch?: string;
	readonly worktree?: string;
	readonly label?: string;
}
