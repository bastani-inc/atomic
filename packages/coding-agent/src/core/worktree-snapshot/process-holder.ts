import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** Names this host, so a process on the same host can tell whether a process another one named still runs. */
export const HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);

/**
 * When process `pid` of this host started, as `sha12` of the boot and the process's start time since boot, so a later
 * process given the same id is told apart (#4990); undefined where that cannot be read: without Linux's `/proc`, or
 * once the process is gone.
 */
export function processStartToken(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces and parentheses: the start time is the 22nd field.
		const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (started === undefined || !/^\d+$/.test(started) || boot === "") return undefined;
		return createHash("sha256").update(`${boot}\n${started}`).digest("hex").slice(0, 12);
	} catch {
		return undefined;
	}
}

/** A process that holds something: its host, its id, and when it started where that can be read. */
export interface ProcessHolder {
	readonly host: string;
	readonly pid: number;
	readonly start?: string | undefined;
}

const PROCESS_START = processStartToken(process.pid);

/** This process, as a {@link ProcessHolder}. */
export function thisProcess(): ProcessHolder {
	return { host: HOST, pid: process.pid, start: PROCESS_START };
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
