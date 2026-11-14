import {
	isGitUnavailableError,
	isWorkspaceError,
	isWorkspaceRestoreError,
	type WorkspaceRestoreError,
} from "./errors.ts";
import {
	type DegradedWorktree,
	isDegradableRestoreFailure,
	type RestoreDegradedWorktreeOptions,
	type RestoredWorktree,
	type RestoreWorktreeSnapshotOptions,
	restoreDegradedWorktree,
	restoreWorktree,
} from "./restore.ts";
import type {
	WorkspaceBinding,
	WorktreeDegradedRestore,
	WorktreeRestoreWarning,
	WorktreeSnapshot,
	WorktreeUnrestored,
} from "./types.ts";

/**
 * Whether a failed restore of one checkout leaves the resume able to continue without the exact state (#4733): any
 * typed workspace or Git failure, except a snapshot record that fails the security checks (`invalid-snapshot`) and a
 * target that holds other files (`unsafe-target`), which refuse the resume.
 */
export function isRecoverableRestoreFailure(error: unknown): error is Error {
	if (isWorkspaceRestoreError(error) && (error.code === "invalid-snapshot" || error.code === "unsafe-target")) {
		return false;
	}
	return (isWorkspaceError(error) && error.code !== "invalid-setting") || isGitUnavailableError(error);
}

export interface RestoreBestWorktreeOptions extends RestoreDegradedWorktreeOptions {
	/** What the exact restore rebuilds: `snapshot` itself (the default), or a binding found among `snapshots`. */
	readonly target?: WorkspaceBinding;
	/** Recorded snapshots the exact restore of `target` searches. */
	readonly snapshots?: readonly WorktreeSnapshot[];
	/** What restores exactly instead of `restoreWorktree`. */
	readonly restore?: (
		target: WorkspaceBinding | WorktreeSnapshot,
		options: RestoreWorktreeSnapshotOptions,
	) => Promise<Pick<RestoredWorktree, "path"> & Partial<Pick<RestoredWorktree, "warnings">>>;
	/** What restores the best reachable state instead of `restoreDegradedWorktree`. */
	readonly restoreDegraded?: (
		snapshot: WorktreeSnapshot,
		failure: WorkspaceRestoreError,
		options: RestoreDegradedWorktreeOptions,
	) => Promise<DegradedWorktree>;
}

/** The best restore of a checkout this host could make (#4733, #4738). */
export type BestWorktreeRestore =
	| {
			readonly status: "restored";
			readonly path: string;
			readonly warnings: readonly WorktreeRestoreWarning[];
			/** Present when the worktree holds less than the snapshot: what it holds and what is missing. */
			readonly degraded?: WorktreeDegradedRestore;
	  }
	/** Nothing of the snapshot could be restored here; `reason` says why. Nothing was written. */
	| { readonly status: "unrestored"; readonly reason: Error };

/**
 * Restores `snapshot` into a new worktree as well as this host can (#4733): exactly; else, after a failure a degraded
 * restore can follow, its recorded `HEAD` with the change sets that apply, or the closest commit it can fetch; else
 * nothing, resolving `unrestored` with the exact restore's failure. Rejects with a failure that is not recoverable
 * (`invalid-snapshot`, `unsafe-target`, or an error that is not a typed workspace or Git failure), and, once `signal`
 * aborted, with the failure the abort caused.
 */
export async function restoreBestWorktree(
	snapshot: WorktreeSnapshot,
	options: RestoreBestWorktreeOptions = {},
): Promise<BestWorktreeRestore> {
	const {
		target,
		snapshots,
		restore = restoreWorktree,
		restoreDegraded = restoreDegradedWorktree,
		candidates,
		...shared
	} = options;
	try {
		const exact = await restore(target ?? snapshot, { ...shared, ...(snapshots === undefined ? {} : { snapshots }) });
		return { status: "restored", path: exact.path, warnings: exact.warnings ?? [] };
	} catch (error) {
		if (options.signal?.aborted || !isRecoverableRestoreFailure(error)) throw error;
		if (isDegradableRestoreFailure(error)) {
			try {
				const degraded = await restoreDegraded(snapshot, error, {
					...shared,
					...(candidates === undefined ? {} : { candidates }),
				});
				return { status: "restored", ...degraded };
			} catch (degradedError) {
				if (options.signal?.aborted || !isRecoverableRestoreFailure(degradedError)) throw degradedError;
			}
		}
		return { status: "unrestored", reason: error };
	}
}

/** What a resume tells about a checkout it continued without: why, as a clause, and what to do. */
export function unrestoredReason(snapshot: WorktreeSnapshot, reason: Error): { detail: string; hint: string } {
	const head = snapshot.head.slice(0, 12);
	if (isGitUnavailableError(reason)) {
		return {
			detail: `Git is unavailable here (${reason.code}), which checking and restoring it need`,
			hint: reason.hint ?? "",
		};
	}
	if (isWorkspaceRestoreError(reason)) {
		switch (reason.code) {
			case "commits-unavailable":
				return {
					detail:
						reason.reason === "denied-history"
							? `its commit ${head} is not on its recorded remotes, and its unpushed commits touch files snapshots never copy`
							: reason.reason === "bundle-over-cap"
								? `its commit ${head} is not on its recorded remotes, and its unpushed commits were too large to record`
								: `its commit ${head} and the commits around it are not on its recorded remotes`,
					hint: reason.hint,
				};
			case "snapshot-not-found":
				return { detail: "the session holds no record of its snapshot", hint: reason.hint };
			case "blob-missing":
			case "blob-corrupt":
				return { detail: "part of its recorded content is not in this storage", hint: reason.hint };
			default:
				return { detail: reason.summary, hint: reason.hint };
		}
	}
	return {
		detail: isWorkspaceError(reason) ? reason.summary : reason.message,
		hint: isWorkspaceError(reason) ? reason.hint : "",
	};
}

/** The record of a checkout a resume continued without, in `continuedIn`, because of `reason` (#4733). */
export function unrestoredRecord(
	snapshot: WorktreeSnapshot,
	reason: Error,
	continuedIn: string,
	place: WorktreeUnrestored["place"],
	at = new Date().toISOString(),
): WorktreeUnrestored {
	return {
		snapshotId: snapshot.id,
		continuedIn,
		place,
		cause: isWorkspaceError(reason) || isGitUnavailableError(reason) ? reason.code : "error",
		...(isWorkspaceRestoreError(reason) && reason.reason !== undefined ? { causeReason: String(reason.reason) } : {}),
		...unrestoredReason(snapshot, reason),
		at,
	};
}
