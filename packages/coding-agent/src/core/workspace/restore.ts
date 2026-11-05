import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { WorkspaceBindingError, WorkspaceRestoreError } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import {
	type BoundWorkspace,
	openWorkspaceRepository,
	remotesOf,
	verifyWorktree,
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

async function hasCommit(cwd: string, ref: string, signal: AbortSignal | undefined): Promise<boolean> {
	const result = await runWorkspaceGit({
		cwd,
		args: ["rev-parse", "--verify", `${ref}^{commit}`],
		phase: "probe",
		allowFailure: true,
		signal,
	});
	return result.status === 0;
}

/** Add a deleted worktree back from its branch, or from the remote's copy of the branch. */
async function readd(
	binding: BoundWorkspace,
	root: string,
	signal: AbortSignal | undefined,
	recreateMissingBranch: boolean,
): Promise<void> {
	const run = (args: readonly string[]) => runWorkspaceGit({ cwd: root, args, phase: "worktree-add", signal });
	if (classifyRepository(binding.repo)?.kind === "remote")
		await runWorkspaceGit({ cwd: root, args: ["fetch", "origin"], phase: "fetch", signal });
	await run(["worktree", "prune"]);
	if (await hasCommit(root, `refs/heads/${binding.branch}`, signal)) {
		await run(["worktree", "add", binding.worktree, binding.branch]);
		return;
	}
	if (await hasCommit(root, `refs/remotes/origin/${binding.branch}`, signal)) {
		await run(["worktree", "add", "-b", binding.branch, binding.worktree, `origin/${binding.branch}`]);
		return;
	}
	if (recreateMissingBranch && (await hasCommit(root, binding.head, signal))) {
		await run(["worktree", "add", "-b", binding.branch, binding.worktree, binding.head]);
		return;
	}
	throw new WorkspaceRestoreError({
		reason: "branch-missing",
		fields: { repo: binding.repo, branch: binding.branch, worktree: binding.worktree, repository: root },
	});
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

/**
 * Restore a recorded binding and return its verified worktree path. The repository must still be the recorded one,
 * the worktree must be on the recorded branch, the recorded HEAD must still be in the branch's history and the recorded
 * remotes unchanged; otherwise the call fails closed. A missing worktree is re-added from its branch, or from the
 * remote's copy of it; new commits and uncommitted changes are expected work, not drift.
 */
export async function restoreWorkspace(
	binding: BoundWorkspace,
	options: RestoreWorkspaceOptions = {},
): Promise<string> {
	const { signal } = options;
	await assertWorkspaceGitAvailable(signal);
	const local = classifyRepository(binding.repo)?.kind !== "remote";
	if (local && !existsSync(binding.repository))
		throw new WorkspaceRestoreError({
			reason: "repository-missing",
			fields: {
				repo: binding.repo,
				branch: binding.branch,
				worktree: binding.worktree,
				repository: binding.repository,
			},
		});
	const repository = await openWorkspaceRepository(local ? binding.repository : binding.repo, signal);
	if (!existsSync(binding.worktree))
		await readd(binding, repository.root, signal, options.recreateMissingBranch === true);
	await verifyWorktree(repository, binding.repo, binding.worktree, binding.branch, signal);
	await assertNoDrift(binding, signal);
	return realpath(binding.worktree);
}
