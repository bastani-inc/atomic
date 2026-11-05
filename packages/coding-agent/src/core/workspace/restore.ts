import { existsSync } from "node:fs";
import { WorkspaceBindingError, WorkspaceRestoreError } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import {
	type BoundWorkspace,
	commitOf,
	ensureWorktree,
	openWorkspaceRepository,
	remotesOf,
	type WorktreeBinding,
} from "./resolve.ts";
import { classifyRepository } from "./spec.ts";

export interface RestoreWorkspaceOptions {
	readonly signal?: AbortSignal;
	/**
	 * Re-create a branch that is gone both locally and on the remote at the recorded head, instead of failing with
	 * `branch-missing`. Use it only when no work after the recorded head needs keeping, for example when a resumed
	 * child recorded no checkpoint before its node stopped. Default false.
	 */
	readonly recreateMissingBranch?: boolean;
}

async function assertNoDrift(binding: WorktreeBinding, signal: AbortSignal | undefined): Promise<void> {
	const contains = await runWorkspaceGit({
		cwd: binding.worktree,
		args: ["merge-base", "--is-ancestor", binding.head, "HEAD"],
		phase: "validate",
		allowFailure: true,
		signal,
	});
	if (contains.status !== 0)
		throw new WorkspaceBindingError({
			code: "drift",
			reason: "history-rewritten",
			fields: {
				repo: binding.repo,
				worktree: binding.worktree,
				branch: binding.branch,
				expected: binding.head,
				actual: await gitOutput({
					cwd: binding.worktree,
					args: ["rev-parse", "HEAD"],
					phase: "validate",
					signal,
				}),
			},
		});
	const remotes = await remotesOf(binding.worktree, signal);
	const missing = binding.remotes.find((url) => !remotes.includes(url));
	if (missing !== undefined)
		throw new WorkspaceBindingError({
			code: "drift",
			reason: "remote-changed",
			fields: {
				repo: binding.repo,
				worktree: binding.worktree,
				branch: binding.branch,
				expected: missing,
				actual: remotes,
			},
		});
}

/** A restored binding's verified worktree, and the repository identity it was verified against. */
export interface RestoredWorkspace {
	readonly worktree: string;
	readonly commonDir: string;
}

/**
 * Restore a recorded binding. The repository must still be the recorded one, the worktree must be on the recorded
 * branch, the recorded HEAD must still be in the branch's history and the recorded remotes unchanged; otherwise the
 * call fails closed. A missing worktree is added again the way resolution adds one, from the branch as the remote has
 * it now; new commits and uncommitted changes are expected work, not drift.
 */
export async function restoreRecordedWorkspace(
	binding: BoundWorkspace,
	options: RestoreWorkspaceOptions = {},
): Promise<RestoredWorkspace> {
	const { signal } = options;
	await assertWorkspaceGitAvailable(signal);
	const local = classifyRepository(binding.repo)?.kind !== "remote";
	const missing = (reason: "repository-missing" | "branch-missing", repository: string) =>
		new WorkspaceRestoreError({
			reason,
			fields: { repo: binding.repo, branch: binding.branch, worktree: binding.worktree, repository },
		});
	if (local && !existsSync(binding.repository)) throw missing("repository-missing", binding.repository);
	const repository = await openWorkspaceRepository(local ? binding.repository : binding.repo, signal);
	const worktree = await ensureWorktree(
		repository,
		binding.repo,
		binding.worktree,
		binding.branch,
		{
			missingBranchStart: async () => {
				if (options.recreateMissingBranch === true && (await commitOf(repository, binding.head)) !== undefined)
					return binding.head;
				throw missing("branch-missing", repository.root);
			},
		},
		signal,
	);
	await assertNoDrift(binding, signal);
	return { worktree, commonDir: repository.commonDir };
}

/** Restore a recorded binding and return its verified worktree path; see `restoreRecordedWorkspace`. */
export async function restoreWorkspace(
	binding: BoundWorkspace,
	options: RestoreWorkspaceOptions = {},
): Promise<string> {
	return (await restoreRecordedWorkspace(binding, options)).worktree;
}
