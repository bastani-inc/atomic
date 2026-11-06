import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";

/** Why a process log could not be written: the error's code (`EACCES`, `ENOSPC`, …), never its text. */
export function logFailureOf(error: Error): string {
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : error.name;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** A child process's stderr log. */
export interface ProcessLog {
	/** Stops writing the log, drains the process's stderr from then on, and resolves once the log's file is closed. */
	close(): Promise<void>;
}

/**
 * Appends a child process's stderr to `logPath`, creating its directory. A log that cannot be written never blocks the
 * process: its stderr is drained instead, and `onFailure` hears why, once.
 */
export function appendProcessLog(
	stderr: Readable | null | undefined,
	logPath: string,
	onFailure: (failure: string) => void,
): ProcessLog {
	let log: WriteStream | undefined;
	let failed = false;
	const drain = () => {
		stderr?.unpipe();
		stderr?.resume();
	};
	const fail = (error: Error) => {
		if (failed) return;
		failed = true;
		drain();
		log?.end();
		onFailure(logFailureOf(error));
	};
	const close = (): Promise<void> => {
		drain();
		const open = log;
		if (open === undefined || open.closed) return Promise.resolve();
		return new Promise((resolve) => {
			open.once("close", () => resolve());
			open.end();
		});
	};
	if (stderr === null || stderr === undefined) return { close };
	stderr.on("error", fail);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
	} catch (error) {
		fail(asError(error));
		return { close };
	}
	log = createWriteStream(logPath, { flags: "a" });
	log.on("error", fail);
	stderr.pipe(log);
	return { close };
}

/** Removes a process log and, when nothing else is left in it, its directory. */
export async function removeProcessLog(logPath: string): Promise<void> {
	await rm(logPath, { force: true });
	await rmdir(dirname(logPath)).catch((error: unknown) => {
		const code = (error as { readonly code?: unknown }).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	});
}
