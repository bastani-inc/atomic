import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import * as path from "node:path";

export interface GitWorktreeGenerationAnchor {
	assertCurrent(): Promise<void>;
	dispose(): Promise<void>;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function openMainCheckoutAnchor(gitDir: string): GitWorktreeGenerationAnchor {
	let disposed = false;
	return {
		async assertCurrent() {
			if (disposed) throw new Error(`cached .git identity anchor is already disposed: ${gitDir}`);
			if (!(await lstat(gitDir)).isDirectory()) {
				throw new Error(`cached main-checkout .git directory is no longer current: ${gitDir}`);
			}
		},
		async dispose() {
			disposed = true;
		},
	};
}

export async function openGitWorktreeGenerationAnchor(worktreeRoot: string): Promise<GitWorktreeGenerationAnchor> {
	const gitFile = path.join(worktreeRoot, ".git");
	if ((await lstat(gitFile)).isDirectory()) return openMainCheckoutAnchor(gitFile);
	const handle: FileHandle = await open(gitFile, "r");
	let disposed = false;

	const anchor: GitWorktreeGenerationAnchor = {
		async assertCurrent() {
			if (disposed) throw new Error(`cached .git identity anchor is already disposed: ${gitFile}`);
			const held = await handle.stat({ bigint: true });
			const current = await lstat(gitFile, { bigint: true });
			if (!current.isFile() || !sameFileIdentity(held, current)) {
				throw new Error(`cached .git identity anchor no longer matches the selected checkout: ${gitFile}`);
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await handle.close();
		},
	};

	try {
		await anchor.assertCurrent();
		return anchor;
	} catch (error) {
		await anchor.dispose();
		throw error;
	}
}
