import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
