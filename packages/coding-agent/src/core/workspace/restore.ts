import { existsSync } from "node:fs";
import { WorkspaceBindingError, WorkspaceRestoreError } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import { withRepositoryLock } from "./lease.ts";
import {
	type BoundWorkspace,
	commitOf,
	ensureWorktree,
	type OpenRepository,
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
	/**
	 * Commits that work done after the binding recorded, for example the `changeSet.headCommit` of completed steps.
	 * Each must still be in the branch's history: one that is nowhere to be found fails with `commits-unavailable`, one
	 * the branch no longer contains with `drift`, so a resume never continues past work that is gone.
	 */
	readonly recordedHeads?: readonly string[];
}

async function assertInHistory(binding: WorktreeBinding, head: string, signal: AbortSignal | undefined): Promise<void> {
	const contains = await runWorkspaceGit({
		cwd: binding.worktree,
		args: ["merge-base", "--is-ancestor", head, "HEAD"],
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
				expected: head,
				actual: await gitOutput({
					cwd: binding.worktree,
					args: ["rev-parse", "HEAD"],
					phase: "validate",
					signal,
				}),
			},
		});
}

/** The recorded heads `repository` does not have. */
async function absentCommits(repository: OpenRepository, heads: readonly string[]): Promise<string[]> {
	const absent: string[] = [];
	for (const head of heads) if ((await commitOf(repository, head)) === undefined) absent.push(head);
	return absent;
}

/**
 * Every head recorded after the binding must still be in the branch's history. A shared store fetches once for heads
 * it lacks, since another machine may have pushed them; heads found nowhere fail with `commits-unavailable`.
 */
async function assertRecordedHeads(
	binding: BoundWorkspace,
	repository: OpenRepository,
	heads: readonly string[],
	signal: AbortSignal | undefined,
): Promise<void> {
	let absent = await absentCommits(repository, heads);
	if (absent.length > 0 && repository.spec.kind === "remote") {
		await withRepositoryLock(repository.commonDir, () =>
			gitOutput({ cwd: repository.root, args: ["fetch", "origin"], phase: "fetch", signal }),
		);
		absent = await absentCommits(repository, absent);
	}
	if (absent.length > 0)
		throw new WorkspaceRestoreError({
			reason: "commits-unavailable",
			fields: {
				repo: binding.repo,
				branch: binding.branch,
				worktree: binding.worktree,
				repository: repository.root,
				missingCommits: absent,
			},
		});
	for (const head of heads) await assertInHistory(binding, head, signal);
}

async function assertNoDrift(binding: WorktreeBinding, signal: AbortSignal | undefined): Promise<void> {
	await assertInHistory(binding, binding.head, signal);
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
	await assertRecordedHeads(binding, repository, [...new Set(options.recordedHeads ?? [])], signal);
	return { worktree, commonDir: repository.commonDir };
}

/** Restore a recorded binding and return its verified worktree path; see `restoreRecordedWorkspace`. */
export async function restoreWorkspace(
	binding: BoundWorkspace,
	options: RestoreWorkspaceOptions = {},
): Promise<string> {
	return (await restoreRecordedWorkspace(binding, options)).worktree;
}
