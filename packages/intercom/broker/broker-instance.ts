import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { getIntercomDirPath } from "./paths.js";

/** Rounds the boot time where no boot id can be read, so two readings from one boot agree. */
const BOOT_TIME_ROUNDING_MS = 60_000;
/** A machine-id command that does not answer by then leaves the host without a machine id. */
const MACHINE_ID_COMMAND_TIMEOUT_MS = 2_000;

const orUndefined = (read: () => string | undefined): string | undefined => {
	try {
		return read()?.trim() || undefined;
	} catch {
		return undefined;
	}
};

/** What the identity sources read from the host; tests pass fakes. */
export interface HostIdentitySources {
	readonly platform: NodeJS.Platform;
	readFile(path: string): string;
	readLink(path: string): string;
	/** Runs a command and returns its standard output; throws when it fails. */
	run(command: string, args: readonly string[]): string;
	/** Writes a file only this user may read, failing when it already exists. */
	writeNewPrivateFile(path: string, content: string): void;
	readonly configDir: string;
	readonly bootTimeMs: number;
}

/** This host's real identity sources, saving a machine id under `configDir`. */
export const systemSources = (configDir: string = getIntercomDirPath()): HostIdentitySources => ({
	platform: process.platform,
	readFile: (path) => readFileSync(path, "utf8"),
	readLink: (path) => readlinkSync(path),
	run: (command, args) =>
		execFileSync(command, [...args], {
			encoding: "utf8",
			timeout: MACHINE_ID_COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		}),
	writeNewPrivateFile: (path, content) => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, content, { mode: 0o600, flag: "wx" });
	},
	configDir,
	bootTimeMs: Date.now() - uptime() * 1000,
});

/** The OS's own id of this machine: the registry's MachineGuid, the IOPlatformUUID, or `/etc/machine-id`. */
export function osMachineId(sources: HostIdentitySources): string | undefined {
	if (sources.platform === "win32") {
		const output = orUndefined(() =>
			sources.run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
		);
		return output?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
	}
	if (sources.platform === "darwin") {
		const output = orUndefined(() => sources.run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
		return output?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
	}
	return (
		orUndefined(() => sources.readFile("/etc/machine-id")) ??
		orUndefined(() => sources.readFile("/var/lib/dbus/machine-id"))
	);
}

/** A random id saved once, readable only by this user, in the Atomic config directory. */
export function persistedMachineId(sources: HostIdentitySources): string | undefined {
	const path = join(sources.configDir, "machine-id");
	try {
		sources.writeNewPrivateFile(path, randomUUID());
	} catch {
		// It was saved before, or cannot be written: what is there now, if anything, is the id.
	}
	return orUndefined(() => sources.readFile(path));
}

/**
 * #5038: what tells this host apart from another with the same host name, such as a cloned VM or a container with a
 * fixed `--hostname` and the same home path, so that an earlier broker on this socket path can be checked by its pid.
 * On Linux, the kernel's boot id and this process's pid namespace. Elsewhere, the machine's id (the OS's, or one saved
 * in the config directory) with the boot time. `undefined` when there is no reliable id: an earlier instance is then
 * never retired early, and its leases go stale as before.
 */
export function brokerHostIdentity(sources: HostIdentitySources = systemSources()): string | undefined {
	const bootId = orUndefined(() => sources.readFile("/proc/sys/kernel/random/boot_id"));
	if (bootId !== undefined) {
		const pidNamespace = orUndefined(() => sources.readLink("/proc/self/ns/pid"));
		return pidNamespace === undefined ? bootId : `${bootId}/${pidNamespace}`;
	}
	const machineId = osMachineId(sources) ?? persistedMachineId(sources);
	if (machineId === undefined) return undefined;
	return `${machineId}/boot-${Math.round(sources.bootTimeMs / BOOT_TIME_ROUNDING_MS)}`;
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
