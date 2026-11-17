import { createGitWorktreeSetupCache, type GitWorktreeSetupCache } from "./worktree-git.js";

export interface GitWorktreeSetupCacheOwner {
	readonly cache: GitWorktreeSetupCache;
	release(finalizer: () => void): Promise<void>;
}

export function createGitWorktreeSetupCacheOwner(
	suppliedCache?: GitWorktreeSetupCache,
	ownerRunId?: string,
): GitWorktreeSetupCacheOwner {
	const cache = suppliedCache ?? createGitWorktreeSetupCache(ownerRunId);
	const ownsCache = suppliedCache === undefined;
	let released = false;
	return {
		cache,
		async release(finalizer) {
			try {
				if (!released && ownsCache) await cache.dispose();
				released = true;
			} finally {
				finalizer();
			}
		},
	};
}
