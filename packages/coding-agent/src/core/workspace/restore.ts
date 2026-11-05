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
}

async function hasCommit(cwd: string, ref: string, signal: AbortSignal | undefined): Promise<boolean> {
	const result = await runWorkspaceGit({
		cwd,
		args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		phase: "probe",
		allowFailure: true,
		signal,
	});
	return result.status === 0;
}

async function readd(
	binding: BoundWorkspace,
	root: string,
	fresh: boolean,
	signal: AbortSignal | undefined,
): Promise<void> {
	const run = (args: readonly string[]) => runWorkspaceGit({ cwd: root, args, phase: "worktree-add", signal });
	const remote = classifyRepository(binding.repo)?.kind === "remote";
	if (remote && !fresh) await run(["fetch", "--quiet", "origin"]);
	await run(["worktree", "prune"]);
	if (await hasCommit(root, `refs/heads/${binding.branch}`, signal)) {
		await run(["worktree", "add", "--quiet", binding.worktree, binding.branch]);
		return;
	}
	if (remote && (await hasCommit(root, `refs/remotes/origin/${binding.branch}`, signal))) {
		await run(["worktree", "add", "--quiet", "-b", binding.branch, binding.worktree, `origin/${binding.branch}`]);
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
 * remotes unchanged; otherwise the call fails closed. A missing worktree is re-added from its branch; new commits and
 * uncommitted changes are expected work, not drift.
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
	if (!existsSync(binding.worktree)) await readd(binding, repository.root, repository.fresh, signal);
	await verifyWorktree(repository, binding.repo, binding.worktree, binding.branch, signal);
	await assertNoDrift(binding, signal);
	return realpath(binding.worktree);
}
