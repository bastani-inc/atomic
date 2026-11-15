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

/** What `brokerHostIdentity` reads of this host; absent where the platform has no such thing. */
export interface BrokerHostFacts {
	readonly bootId?: string;
	readonly pidNamespace?: string;
	readonly bootTimeMs: number;
}

export function readBrokerHostFacts(): BrokerHostFacts {
	const bootId = readOr(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
	const pidNamespace = readOr(() => readlinkSync("/proc/self/ns/pid"));
	return {
		...(bootId === undefined ? {} : { bootId }),
		...(pidNamespace === undefined ? {} : { pidNamespace }),
		bootTimeMs: Date.now() - uptime() * 1000,
	};
}

/**
 * #5038: what tells this host apart from another with the same host name, such as a cloned VM or a container with a
 * fixed `--hostname` and the same home path: the kernel's boot id and this process's pid namespace where they exist,
 * otherwise the boot time. Two brokers on one socket path with the same host identity run in one process space, so
 * whether an earlier one is still running can be checked by its pid.
 */
export function brokerHostIdentity(facts: BrokerHostFacts = readBrokerHostFacts()): string {
	if (facts.bootId === undefined) return `boot-${Math.round(facts.bootTimeMs / BOOT_TIME_ROUNDING_MS)}`;
	return facts.pidNamespace === undefined ? facts.bootId : `${facts.bootId}/${facts.pidNamespace}`;
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
