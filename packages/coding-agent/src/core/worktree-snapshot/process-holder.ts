import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { processStartTokenAsync } from "../process-start-token.ts";

/** Names this host, so a process on the same host can tell whether a process another one named still runs. */
export const HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/** A process that holds something: its host, its id, and when it started where that can be read. */
export interface ProcessHolder {
	readonly host: string;
	readonly pid: number;
	readonly start?: string | undefined;
}

let ownStart: Promise<string | undefined> | undefined;

/** This process, as a {@link ProcessHolder}; its start is read once, on first use, as reading it may start a process. */
export async function thisProcess(): Promise<ProcessHolder> {
	ownStart ??= processStartTokenAsync(process.pid);
	return { host: HOST, pid: process.pid, start: await ownStart };
}

/**
 * Whether `holder` still runs (#4830, #4990): a process of this host with its id that, when it names its start, started
 * then; one that names no start only while its hold is younger than `unstartedLimitMs`. One naming a start that cannot
 * be read now runs while a process of its id does: an unreadable start is never another process's (#5141). A process
 * this one may not signal runs too. A holder of another host never runs here.
 */
export async function holderRuns(holder: ProcessHolder, ageMs: number, unstartedLimitMs: number): Promise<boolean> {
	if (holder.host !== HOST) return false;
	const started = holder.start === undefined ? undefined : await processStartTokenAsync(holder.pid);
	if (started !== undefined) return started === holder.start;
	// A hold naming a start that cannot be read right now, as when a read timed out, is its holder's while a process of
	// that id runs (#5141); only one naming no start is judged by its age.
	if (holder.start === undefined && ageMs > unstartedLimitMs) return false;
	try {
		process.kill(holder.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
