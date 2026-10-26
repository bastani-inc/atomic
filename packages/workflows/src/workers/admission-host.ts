import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

export const admissionHost = hostname();

let bootIdentity: Promise<string | null> | undefined;
export function admissionBootIdentity(): Promise<string | null> {
	bootIdentity ??= (async () => {
		try {
			if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
			if (process.platform === "darwin") {
				return await new Promise<string | null>((resolve) => {
					execFile("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 1000 }, (error, stdout) =>
						resolve(error ? null : stdout.trim() || null),
					);
				});
			}
		} catch {}
		return null;
	})();
	return bootIdentity;
}

export function admissionProcessStopped(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** What remains of a Unix process group: nothing, only zombies (which hold no resources), or a live member. */
export type ProcessGroupState = "gone" | "zombie" | "alive";

/**
 * One scan of a process group's members: each member's pid and state letter, and whether every candidate process
 * was read. A process that disappears or cannot be read mid-scan makes the scan incomplete.
 */
export interface ProcessGroupScan {
	readonly members: ReadonlyMap<number, string>;
	readonly complete: boolean;
}

export type ProcessGroupScanner = (group: number) => ProcessGroupScan;

/** Scans the process table for the members of `group`: `/proc` on Linux, `ps` elsewhere. */
export function scanProcessGroup(group: number): ProcessGroupScan {
	const members = new Map<number, string>();
	if (process.platform === "linux") {
		let complete = true;
		let entries: string[];
		try {
			entries = readdirSync("/proc");
		} catch {
			return { members, complete: false };
		}
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			let stat: string;
			try {
				stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			} catch {
				// The process may have been a member that exited, or forked one, after the listing: unconfirmed.
				complete = false;
				continue;
			}
			// Fields after the parenthesized command: state, ppid, pgrp, ...
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (fields.length < 3 || !fields[0]) {
				complete = false;
				continue;
			}
			if (Number(fields[2]) === group) members.set(Number(entry), fields[0]);
		}
		return { members, complete };
	}
	let output: string;
	try {
		output = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000 });
	} catch {
		return { members, complete: false };
	}
	let complete = true;
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const [pid, pgid, stat] = line.trim().split(/\s+/);
		if (!pid || !pgid || !stat || !/^\d+$/.test(pid) || !/^\d+$/.test(pgid)) {
			complete = false;
			continue;
		}
		if (Number(pgid) === group) members.set(Number(pid), stat);
	}
	return { members, complete };
}

function zombieOnly(scan: ProcessGroupScan): boolean {
	return scan.complete && scan.members.size > 0 && [...scan.members.values()].every((state) => state.startsWith("Z"));
}

/**
 * The kernel alone decides that a group is gone (`kill(-group, 0)` fails with ESRCH). A group holds only zombies when
 * two consecutive complete scans find the same non-empty set of members, all zombies. A zombie cannot fork, so a
 * member forked during the first scan by a member that then exited shows up in the second. Anything else (an empty,
 * partial, failed or changing scan) counts as alive.
 */
export function processGroupState(group: number, scan: ProcessGroupScanner = scanProcessGroup): ProcessGroupState {
	if (admissionProcessStopped(-group)) return "gone";
	const first = scan(group);
	if (!zombieOnly(first)) return "alive";
	const second = scan(group);
	if (!zombieOnly(second) || second.members.size !== first.members.size) return "alive";
	return [...second.members.keys()].every((pid) => first.members.has(pid)) ? "zombie" : "alive";
}

export function signalProcessGroup(group: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-group, signal);
	} catch {
		// Already gone, or not ours to signal; the next probe decides.
	}
}

/** The pause between probes of a process group being reaped. */
export function reapPause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
