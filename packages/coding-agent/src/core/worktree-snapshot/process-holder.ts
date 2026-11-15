import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { processStartToken } from "../process-start-token.ts";

/** Names this host, so a process on the same host can tell whether a process another one named still runs. */
export const HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/** A process that holds something: its host, its id, and when it started where that can be read. */
export interface ProcessHolder {
	readonly host: string;
	readonly pid: number;
	readonly start?: string | undefined;
}

let ownStart: { readonly start: string | undefined } | undefined;

/** This process, as a {@link ProcessHolder}; its start is read once, on first use, as reading it may start a process. */
export function thisProcess(): ProcessHolder {
	ownStart ??= { start: processStartToken(process.pid) };
	return { host: HOST, pid: process.pid, start: ownStart.start };
}

/**
 * Whether `holder` still runs (#4830, #4990): a process of this host with its id that, when it names its start, started
 * then; one that names no start only while its hold is younger than `unstartedLimitMs`. A process this one may not
 * signal runs too. A holder of another host never runs here.
 */
export function holderRuns(holder: ProcessHolder, ageMs: number, unstartedLimitMs: number): boolean {
	if (holder.host !== HOST) return false;
	const started = holder.start === undefined ? undefined : processStartToken(holder.pid);
	if (started !== undefined) return started === holder.start;
	if (ageMs > unstartedLimitMs) return false;
	try {
		process.kill(holder.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
