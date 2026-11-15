import { readFileSync, readlinkSync } from "node:fs";
import { uptime } from "node:os";

/** Rounds the boot time where no boot id can be read, so two readings from one boot agree. */
const BOOT_TIME_ROUNDING_MS = 60_000;

const readOr = (read: () => string): string | undefined => {
	try {
		return read().trim() || undefined;
	} catch {
		return undefined;
	}
};

/**
 * #5038: what tells this host apart from another with the same host name, such as a cloned VM or a container with a
 * fixed `--hostname` and the same home path: the kernel's boot id and this process's pid namespace where they exist,
 * otherwise the boot time. Two brokers on one socket path with the same host identity run in one process space, so
 * whether an earlier one is still running can be checked by its pid.
 */
export function brokerHostIdentity(): string {
	const bootId = readOr(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
	if (bootId === undefined) {
		return `boot-${Math.round((Date.now() - uptime() * 1000) / BOOT_TIME_ROUNDING_MS)}`;
	}
	const pidNamespace = readOr(() => readlinkSync("/proc/self/ns/pid"));
	return pidNamespace === undefined ? bootId : `${bootId}/${pidNamespace}`;
}

/** Whether a process with this id runs here; one this process may not signal still runs. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
