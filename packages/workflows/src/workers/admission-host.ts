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

function groupMemberStates(group: number): string[] | undefined {
	if (process.platform === "linux") {
		const states: string[] = [];
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			let stat: string;
			try {
				stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			} catch {
				continue;
			}
			// Fields after the parenthesized command: state, ppid, pgrp, ...
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[2]) === group) states.push(fields[0]!);
		}
		return states;
	}
	try {
		return execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 5_000 })
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter(([pgid]) => Number(pgid) === group)
			.map(([, stat]) => stat ?? "");
	} catch {
		return undefined;
	}
}

export function processGroupState(group: number): ProcessGroupState {
	if (admissionProcessStopped(-group)) return "gone";
	const states = groupMemberStates(group);
	if (states === undefined) return "alive";
	return states.every((state) => state.startsWith("Z")) ? "zombie" : "alive";
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
