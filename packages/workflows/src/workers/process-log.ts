import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, rmdir } from "node:fs/promises";
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
	readonly opened: Promise<void>;
	/** Stops writing the log, drains the process's stderr from then on, and resolves once the log's file is closed. */
	close(): Promise<void>;
}

/**
 * Appends a child process's stderr to `logPath`, creating its directory first; the process's stderr waits in its
 * stream meanwhile. A log that cannot be written never blocks the process: its stderr is drained instead, and
 * `onFailure` hears why, once.
 */
export function appendProcessLog(
	stderr: Readable | null | undefined,
	logPath: string,
	onFailure: (failure: string) => void,
	after: Promise<unknown> = Promise.resolve(),
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
	let opening: Promise<void> = after.then(
		() => {},
		() => {},
	);
	const close = async (): Promise<void> => {
		await opening;
		drain();
		const open = log;
		if (open === undefined || open.closed) return;
		await new Promise<void>((resolve) => {
			open.once("close", () => resolve());
			open.end();
		});
	};
	if (stderr === null || stderr === undefined) return { opened: opening, close };
	stderr.on("error", fail);
	opening = opening
		.then(() => mkdir(dirname(logPath), { recursive: true }))
		.then(
			() => {
				if (failed) return;
				log = createWriteStream(logPath, { flags: "a" });
				log.on("error", fail);
				stderr.pipe(log);
			},
			(error: unknown) => fail(asError(error)),
		);
	return { opened: opening, close };
}

/** Removes a process log and, when nothing else is left in it, its directory. */
export async function removeProcessLog(logPath: string): Promise<void> {
	await rm(logPath, { force: true });
	await rmdir(dirname(logPath)).catch((error: unknown) => {
		const code = (error as { readonly code?: unknown }).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	});
}
