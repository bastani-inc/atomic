import { randomUUID } from "node:crypto";
import { rename as renameFile, rm, writeFile as writeFileContents } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";

/** What Windows reports, for a moment, when a reader or a scanner has the file open while it is replaced. */
const LOCK_ERROR_CODES: ReadonlySet<string | undefined> = new Set(["EPERM", "EBUSY"]);

export const ATOMIC_WRITE_MAX_ATTEMPTS = 8;
/** Doubled after every failed attempt, so all the retries together wait 1,270 ms at most. */
export const ATOMIC_WRITE_FIRST_RETRY_DELAY_MS = 10;

/**
 * - `write-failed`: the temporary file beside the target could not be written; the target was not touched.
 * - `rename-exhausted`: on Windows, every rename over the target hit a lock error (EPERM or EBUSY). The target still
 *   holds its previous contents, so a later write may succeed: the error is `retryable`.
 * - `rename-refused`: the rename failed with an error that is not a Windows lock, so it was not retried.
 */
export type AtomicWriteErrorCode = "write-failed" | "rename-exhausted" | "rename-refused";

export interface AtomicWriteErrorFields {
	readonly code: AtomicWriteErrorCode;
	readonly path: string;
	/** Renames attempted; 0 when writing the temporary file failed first. */
	readonly attempts: number;
	readonly errno: string | undefined;
}

const HINTS: Readonly<Record<AtomicWriteErrorCode, string>> = {
	"write-failed": "Check the directory's free space and permissions, and the cause",
	"rename-exhausted":
		"A process or scanner held the file open past every retry; write it again later, or find the holder (for example with handle.exe)",
	"rename-refused": "The failure is not a transient Windows lock; check the directory's permissions and the cause",
};

/**
 * A file that could not be replaced whole; the target keeps its previous contents. `cause` is the last fs error, and
 * `cleanupCause` the failure to remove the temporary file afterwards, when that failed too. No operation is cancelled:
 * the write takes no signal.
 */
export class AtomicWriteError extends Error {
	override readonly name = "AtomicWriteError" as const;
	readonly code: AtomicWriteErrorCode;
	readonly path: string;
	readonly attempts: number;
	readonly errno: string | undefined;
	readonly retryable: boolean;
	readonly hint: string;
	cleanupCause?: unknown;

	constructor(fields: AtomicWriteErrorFields, options: { readonly cause: unknown }) {
		const hint = HINTS[fields.code];
		super(
			`Atomic write failed: ${fields.path} (${fields.code}) after ${fields.attempts} rename attempts, last error ${fields.errno ?? "without a code"}. ${hint}.`,
			{ cause: options.cause },
		);
		this.code = fields.code;
		this.path = fields.path;
		this.attempts = fields.attempts;
		this.errno = fields.errno;
		this.retryable = fields.code === "rename-exhausted";
		this.hint = hint;
	}
}

export function isAtomicWriteError(error: unknown): error is AtomicWriteError {
	if (error instanceof AtomicWriteError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: string; readonly code?: string };
	return (
		candidate.name === "AtomicWriteError" &&
		(candidate.code === "write-failed" ||
			candidate.code === "rename-exhausted" ||
			candidate.code === "rename-refused")
	);
}

export interface AtomicWriteOptions {
	readonly platform?: NodeJS.Platform;
	readonly writeFile?: (path: string, contents: string) => Promise<void>;
	readonly rename?: (from: string, to: string) => Promise<void>;
	readonly remove?: (path: string) => Promise<void>;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Replaces `path` with `contents` whole: they are written to a temporary file in the same directory, which is then
 * renamed over `path`, so a concurrent reader sees either the previous file or the new one, never a partial one. On
 * Windows a rename that a lock blocks is retried after a doubling backoff, at most {@link ATOMIC_WRITE_MAX_ATTEMPTS}
 * attempts in all. On failure the temporary file is removed.
 *
 * @throws {AtomicWriteError} `write-failed`, `rename-exhausted` or `rename-refused`.
 */
export async function writeFileAtomically(
	path: string,
	contents: string,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const writeFile = options.writeFile ?? writeFileContents;
	const rename = options.rename ?? renameFile;
	const remove = options.remove ?? removeFile;
	const sleep = options.sleep ?? sleepFor;
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const fail = async (fields: AtomicWriteErrorFields, cause: unknown): Promise<AtomicWriteError> => {
		const error = new AtomicWriteError(fields, { cause });
		try {
			await remove(temporary);
		} catch (cleanupCause) {
			error.cleanupCause = cleanupCause;
		}
		return error;
	};
	try {
		await writeFile(temporary, contents);
	} catch (cause) {
		throw await fail({ code: "write-failed", path, attempts: 0, errno: errorCode(cause) }, cause);
	}
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(temporary, path);
			return;
		} catch (cause) {
			const errno = errorCode(cause);
			if (platform !== "win32" || !LOCK_ERROR_CODES.has(errno)) {
				throw await fail({ code: "rename-refused", path, attempts: attempt, errno }, cause);
			}
			if (attempt === ATOMIC_WRITE_MAX_ATTEMPTS) {
				throw await fail({ code: "rename-exhausted", path, attempts: attempt, errno }, cause);
			}
			await sleep(ATOMIC_WRITE_FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1));
		}
	}
}

function removeFile(path: string): Promise<void> {
	return rm(path, { force: true });
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
