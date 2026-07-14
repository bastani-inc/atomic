import * as fs from "node:fs";
import * as path from "node:path";

export interface GitWorktreeGenerationAnchor {
	assertCurrent(): void;
	dispose(): void;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function openMainCheckoutAnchor(gitDir: string): GitWorktreeGenerationAnchor {
	let disposed = false;
	return {
		assertCurrent() {
			if (disposed) throw new Error(`cached .git identity anchor is already disposed: ${gitDir}`);
			if (!fs.lstatSync(gitDir).isDirectory()) {
				throw new Error(`cached main-checkout .git directory is no longer current: ${gitDir}`);
			}
		},
		dispose() {
			disposed = true;
		},
	};
}

export function openGitWorktreeGenerationAnchor(worktreeRoot: string): GitWorktreeGenerationAnchor {
	const gitFile = path.join(worktreeRoot, ".git");
	if (fs.lstatSync(gitFile).isDirectory()) return openMainCheckoutAnchor(gitFile);
	const descriptor = fs.openSync(gitFile, "r");
	let disposed = false;

	const anchor: GitWorktreeGenerationAnchor = {
		assertCurrent() {
			if (disposed) throw new Error(`cached .git identity anchor is already disposed: ${gitFile}`);
			const held = fs.fstatSync(descriptor, { bigint: true });
			const current = fs.lstatSync(gitFile, { bigint: true });
			if (!current.isFile() || !sameFileIdentity(held, current)) {
				throw new Error(`cached .git identity anchor no longer matches the selected checkout: ${gitFile}`);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			fs.closeSync(descriptor);
		},
	};

	try {
		anchor.assertCurrent();
		return anchor;
	} catch (error) {
		anchor.dispose();
		throw error;
	}
}
