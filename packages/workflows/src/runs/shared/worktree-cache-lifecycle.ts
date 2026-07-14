import { createGitWorktreeSetupCache, type GitWorktreeSetupCache } from "./worktree-git.js";

export interface GitWorktreeSetupCacheOwner {
	readonly cache: GitWorktreeSetupCache;
	release(finalizer: () => void): void;
}

export function createGitWorktreeSetupCacheOwner(
	suppliedCache?: GitWorktreeSetupCache,
): GitWorktreeSetupCacheOwner {
	const cache = suppliedCache ?? createGitWorktreeSetupCache();
	const ownsCache = suppliedCache === undefined;
	let released = false;
	return {
		cache,
		release(finalizer) {
			try {
				if (!released && ownsCache) cache.dispose();
				released = true;
			} finally {
				finalizer();
			}
		},
	};
}
