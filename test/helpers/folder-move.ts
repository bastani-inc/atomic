import { renameSync } from "node:fs";

/**
 * What Windows reports, for a moment, when a folder is renamed while another process, such as a virus scanner or the
 * search indexer, has a file under it open.
 */
const HELD_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export const FOLDER_MOVE_MAX_ATTEMPTS = 20;
export const FOLDER_MOVE_RETRY_DELAY_MS = 50;

export interface FolderMoveOptions {
	readonly platform?: NodeJS.Platform;
	readonly rename?: (from: string, to: string) => void;
	readonly sleep?: (milliseconds: number) => void;
}

/**
 * Renames the folder `from` to `to`, as a person moving a folder would. On Windows a rename that another process's
 * open file refuses is tried again after a linear backoff, at most {@link FOLDER_MOVE_MAX_ATTEMPTS} attempts in all, and
 * the last error is thrown when every attempt was refused. Any other error, and any error elsewhere, is thrown at once.
 * Returns how many attempts the move took.
 */
export function moveFolderSync(from: string, to: string, options: FolderMoveOptions = {}): number {
	const platform = options.platform ?? process.platform;
	const rename = options.rename ?? renameSync;
	const sleep = options.sleep ?? sleepSync;
	for (let attempt = 1; ; attempt++) {
		try {
			rename(from, to);
			return attempt;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			const held = platform === "win32" && code !== undefined && HELD_CODES.has(code);
			if (!held || attempt === FOLDER_MOVE_MAX_ATTEMPTS) throw error;
			sleep(FOLDER_MOVE_RETRY_DELAY_MS * attempt);
		}
	}
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
