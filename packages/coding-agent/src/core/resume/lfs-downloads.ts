import { resolve } from "node:path";
import { formatWorktreeRestoreWarning } from "../session-worktree-snapshots.ts";

/**
 * How many restored worktrees of one resume download their Git LFS objects at once (#5099). Each `git lfs pull`
 * already runs several transfers of its own, so two keep the connection busy without many repositories at once
 * competing for it, and for the disk, with the restores and blueprint builds that run meanwhile.
 */
export const LFS_DOWNLOAD_CONCURRENCY = 2;

/** A warning about a worktree whose Git LFS download did not give it every file, as a resume reports it. */
export interface LfsDownloadNotice {
	readonly type: "warning";
	readonly message: string;
}

/**
 * The Git LFS downloads a resume took off its restores (#5099): each starts as soon as its worktree is restored, at
 * most {@link LFS_DOWNLOAD_CONCURRENCY} at once, while the other restores and the blueprint builds go on. A worktree's
 * blueprint waits for {@link ready}; a download that fails leaves its files as pointers with a warning, never a failure.
 */
export class LfsDownloads {
	private readonly downloads = new Map<string, Promise<LfsDownloadNotice | undefined>>();
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	/** Starts downloading into `worktree` with `pull`, which resolves to the files that still hold pointers. */
	readonly start = (worktree: string, pull: () => Promise<readonly string[]>): void => {
		this.downloads.set(resolve(worktree), this.limited(pull).then(pointersNotice, failureNotice(worktree)));
	};

	/** Settles once the download into `worktree`, if any, has ended, however it ended. */
	async ready(worktree: string): Promise<void> {
		await this.downloads.get(resolve(worktree));
	}

	/** The warnings of the downloads into `worktrees`, in that order, once each has ended. */
	async notices(worktrees: Iterable<string>): Promise<LfsDownloadNotice[]> {
		const notices: LfsDownloadNotice[] = [];
		for (const worktree of worktrees) {
			const notice = await this.downloads.get(resolve(worktree));
			if (notice !== undefined) notices.push(notice);
		}
		return notices;
	}

	private async limited<T>(work: () => Promise<T>): Promise<T> {
		// A download that ends hands its place to the next waiting one, so no other can take it in between.
		if (this.running < LFS_DOWNLOAD_CONCURRENCY) this.running++;
		else await new Promise<void>((resume) => this.waiting.push(resume));
		try {
			return await work();
		} finally {
			const next = this.waiting.shift();
			if (next === undefined) this.running--;
			else next();
		}
	}
}

function pointersNotice(paths: readonly string[]): LfsDownloadNotice | undefined {
	if (paths.length === 0) return undefined;
	return {
		type: "warning",
		message: formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: [...paths] }),
	};
}

function failureNotice(worktree: string): (error: unknown) => LfsDownloadNotice {
	return (error) => ({
		type: "warning",
		message: `Git LFS objects could not be fetched into ${worktree}, so its LFS files may hold pointers: ${error instanceof Error ? error.message : String(error)}`,
	});
}
