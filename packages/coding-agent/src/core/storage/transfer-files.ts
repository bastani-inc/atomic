/**
 * The files `atomic storage export` writes and `atomic storage import` reads (#4716, #4720): one JSONL file per session
 * or workflow run, in its own subdirectory of the export directory. Each file is written whole through a temporary
 * file, and one that already holds the same bytes is left untouched.
 */

import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withCleanup } from "./cleanup.js";
import { StorageError, type StorageFailureCause } from "./errors.js";

/** The file name extension of an exported session or run; import reads every file with it and ignores the rest. */
export const TRANSFER_FILE_EXTENSION = ".jsonl";
/** The subdirectory of an export directory that holds sessions. */
export const SESSIONS_TRANSFER_DIRECTORY = "sessions";
/** The subdirectory of an export directory that holds workflow runs. */
export const WORKFLOWS_TRANSFER_DIRECTORY = "workflows";

export interface StorageTransferErrorInit {
	/** The file or storage location the error is about. */
	readonly path: string;
	/** The 1-based line of `path`. */
	readonly line?: number;
	/** The session or run the error is about. */
	readonly id?: string;
	readonly reason: string;
	readonly cause?: StorageFailureCause;
}

/** An export or import that could not be done; an import that fails this way wrote nothing. */
export class StorageTransferError extends StorageError {
	override readonly name = "StorageTransferError" as const;
	readonly path: string;
	readonly line: number | undefined;
	readonly id: string | undefined;
	readonly reason: string;

	constructor(init: StorageTransferErrorInit) {
		super(`${init.path}${init.line === undefined ? "" : `:${init.line}`}: ${init.reason}`, { cause: init.cause });
		this.path = init.path;
		this.line = init.line;
		this.id = init.id;
		this.reason = init.reason;
	}
}

/** The sessions and workflow runs an import wrote, or did not write. */
export interface TransferredIds {
	readonly sessions: readonly string[];
	readonly workflows: readonly string[];
}

/**
 * An import that failed after it wrote some sessions or runs: `written` names exactly what it wrote, and `notWritten`
 * what it did not. Importing the same files again writes only what is missing.
 */
export class StorageImportIncompleteError extends StorageError {
	override readonly name = "StorageImportIncompleteError" as const;
	readonly written: TransferredIds;
	readonly notWritten: TransferredIds;

	constructor(cause: Error, outcome: { readonly written: TransferredIds; readonly notWritten: TransferredIds }) {
		super(cause.message, { cause });
		this.written = outcome.written;
		this.notWritten = outcome.notWritten;
	}
}

export function isStorageImportIncompleteError(value: unknown): value is StorageImportIncompleteError {
	if (value instanceof StorageImportIncompleteError) return true;
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { name?: unknown }).name === "StorageImportIncompleteError"
	);
}

export function isStorageTransferError(value: unknown): value is StorageTransferError {
	if (value instanceof StorageTransferError) return true;
	return typeof value === "object" && value !== null && (value as { name?: unknown }).name === "StorageTransferError";
}

/** The file a session or run with `id` is exported to in `directory`. */
export function transferFile(directory: string, id: string): string {
	return join(directory, `${encodeURIComponent(id)}${TRANSFER_FILE_EXTENSION}`);
}

async function sameBytes(left: string, right: string): Promise<boolean> {
	const [a, b] = await Promise.all([open(left, "r"), open(right, "r").catch(() => undefined)]);
	if (b === undefined) {
		await a.close();
		return false;
	}
	return withCleanup(
		async () => {
			const [sizeA, sizeB] = await Promise.all([a.stat(), b.stat()]);
			if (sizeA.size !== sizeB.size) return false;
			const chunkA = Buffer.alloc(64 * 1024);
			const chunkB = Buffer.alloc(64 * 1024);
			for (let offset = 0; offset < sizeA.size; ) {
				const [readA, readB] = await Promise.all([
					a.read(chunkA, 0, chunkA.length, offset),
					b.read(chunkB, 0, chunkB.length, offset),
				]);
				if (readA.bytesRead === 0 || readA.bytesRead !== readB.bytesRead) return false;
				if (!chunkA.subarray(0, readA.bytesRead).equals(chunkB.subarray(0, readB.bytesRead))) return false;
				offset += readA.bytesRead;
			}
			return true;
		},
		async () => {
			await Promise.allSettled([a.close(), b.close()]);
		},
	);
}

/**
 * Writes `lines`, each followed by a newline, to `file` through an owner-only temporary file in the same directory
 * that is flushed and then renamed over it, so `file` holds either its earlier content or all of the new content. The
 * lines are written as they come, so a large session is never held as one string. A file that already holds exactly
 * these bytes is left alone.
 */
export async function writeLinesAtomically(
	file: string,
	lines: Iterable<string> | AsyncIterable<string>,
): Promise<"written" | "unchanged"> {
	const temporary = join(file, "..", `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		await withCleanup(
			async () => {
				for await (const line of lines) await handle.write(`${line}\n`, null, "utf8");
				await handle.sync();
			},
			() => handle.close(),
		);
		if (await sameBytes(temporary, file)) {
			await rm(temporary, { force: true });
			return "unchanged";
		}
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		if (isStorageTransferError(error)) throw error;
		throw new StorageTransferError({
			path: file,
			reason: `cannot write the export file: ${(error as Error).message}`,
			cause: error as StorageFailureCause,
		});
	}
	return "written";
}

/** One export file as import reads it: its path and its lines, each with its 1-based line number. */
export interface TransferFileLines {
	readonly file: string;
	readonly lines: readonly { readonly line: number; readonly text: string }[];
}

/**
 * The `*.jsonl` files of `directory`, in name order, each decoded as UTF-8 and split into lines; a final newline does
 * not start another line. A directory that does not exist holds no files. Throws `StorageTransferError` naming the
 * file when one cannot be read or is not UTF-8.
 */
export async function readTransferDirectory(directory: string): Promise<TransferFileLines[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new StorageTransferError({
			path: directory,
			reason: `cannot read the directory: ${(error as Error).message}`,
			cause: error as StorageFailureCause,
		});
	}
	const files: TransferFileLines[] = [];
	for (const name of names.filter((entry) => entry.endsWith(TRANSFER_FILE_EXTENSION)).sort()) {
		const file = join(directory, name);
		let bytes: Buffer;
		try {
			bytes = await readFile(file);
		} catch (error) {
			throw new StorageTransferError({
				path: file,
				reason: `cannot read the file: ${(error as Error).message}`,
				cause: error as StorageFailureCause,
			});
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new StorageTransferError({ path: file, reason: "is not valid UTF-8 text" });
		}
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		files.push({ file, lines: lines.map((line, index) => ({ line: index + 1, text: line })) });
	}
	return files;
}
