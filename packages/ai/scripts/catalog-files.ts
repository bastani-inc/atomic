import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * How long a refused rename is tried again: Windows refuses to replace a file while another program, such as a test
 * importing it or an antivirus scan, has it open, which is usually for moments. About two seconds, as the repository's
 * dist refresh (scripts/refresh-package-dist.mjs) does.
 */
const RENAME_TRIES = 50;
const RENAME_RETRY_MS = 40;
const RETRIED_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function lstatIfExists(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Whether `path` exists as a regular file (not a directory or symlink). */
export function isRegularFile(path: string): boolean {
	return lstatIfExists(path)?.isFile() === true;
}

/**
 * Replaces `to` with `from` in one rename, keeping the permissions of the file it replaces, so a process reading `to`
 * meanwhile reads all of the old file or all of the new one. A file another program keeps open past the retries is
 * written in place instead, as the generator always did.
 */
export function replaceFile(from: string, to: string): void {
	const existing = lstatIfExists(to);
	if (existing?.isFile()) chmodSync(from, existing.mode);
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!RETRIED_RENAME_CODES.has(code)) throw error;
			if (attempt >= RENAME_TRIES) {
				writeFileSync(to, readFileSync(from));
				return;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
		}
	}
}

/**
 * Moves each file directly in `staged` whose bytes differ from its namesake in `target` into `target` with
 * {@link replaceFile}, creating `target` if needed. A file whose bytes are the same is left as it is. Returns the names
 * of the files `staged` had, sorted.
 */
export function moveChangedFiles(staged: string, target: string): string[] {
	mkdirSync(target, { recursive: true });
	const names = readdirSync(staged, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	for (const name of names) {
		const from = join(staged, name);
		const to = join(target, name);
		const existing = lstatIfExists(to);
		if (existing?.isFile()) {
			if (readFileSync(from).equals(readFileSync(to))) continue;
		} else if (existing !== undefined) {
			removeCatalogFile(to);
		}
		replaceFile(from, to);
	}
	return names;
}

/** Removes a catalog file, trying again for a moment while Windows still has it open in another program. */
export function removeCatalogFile(path: string): void {
	rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
