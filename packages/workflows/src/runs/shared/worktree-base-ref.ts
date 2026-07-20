import type { GitResult } from "./worktree-types.js";

type GitRunner = (cwd: string, args: readonly string[]) => GitResult;

function refExists(cwd: string, ref: string, runGit: GitRunner): boolean {
	return runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

function defaultBranchName(cwd: string, runGit: GitRunner): string | undefined {
	const remoteHead = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remoteHead.status === 0) {
		const value = remoteHead.stdout.trim();
		if (value.startsWith("origin/") && value.length > 7) return value.slice(7);
	}
	const advertisedHead = runGit(cwd, ["ls-remote", "--symref", "origin", "HEAD"]);
	if (advertisedHead.status !== 0) return undefined;
	const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(advertisedHead.stdout);
	return match?.[1];
}

export function resolveTemporaryWorktreeBaseRef(
	mainRoot: string,
	_baseCommit: string,
	explicitBaseBranch: string | undefined,
	runGit: GitRunner,
): string {
	const explicit = explicitBaseBranch?.trim();
	if (explicit) return explicit;
	const defaultBranch = defaultBranchName(mainRoot, runGit);
	if (defaultBranch === undefined) return "HEAD";
	const originRef = `origin/${defaultBranch}`;
	if (refExists(mainRoot, originRef, runGit)) return originRef;
	runGit(mainRoot, ["fetch", "origin", `${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
	return refExists(mainRoot, originRef, runGit) ? originRef : "HEAD";
}
