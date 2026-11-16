import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getIntercomDirPath } from "./paths.js";

/**
 * A machine-id or boot command that does not answer by then leaves the host without that fact. PowerShell can take
 * a few seconds to start; the broker reads this once, as it starts.
 */
const HOST_COMMAND_TIMEOUT_MS = 10_000;
/**
 * #5252: how many times a host command that failed to answer is run before the host is left without that fact. A
 * loaded host can keep PowerShell from answering once; a broker that misses its host's identity has another instance key
 * than the instance before it, and cannot supersede it after that instance was killed.
 */
export const HOST_COMMAND_ATTEMPTS = 3;
/** Windows' boot time, to the microsecond, as WMI records it. */
export const WINDOWS_BOOT_TIME_COMMAND = [
	"powershell",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	"(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
] as const;

const orUndefined = (read: () => string | undefined): string | undefined => {
	try {
		return read()?.trim() || undefined;
	} catch {
		return undefined;
	}
};

/**
 * A host command's output, run up to `HOST_COMMAND_ATTEMPTS` times while it fails to answer; undefined once it never
 * did. A command that is not installed is not run again.
 */
function hostCommandOutput(sources: HostIdentitySources, command: string, args: readonly string[]): string | undefined {
	for (let attempt = 1; attempt <= HOST_COMMAND_ATTEMPTS; attempt++) {
		try {
			const output = sources.run(command, args).trim();
			if (output !== "") return output;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		}
	}
	return undefined;
}

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
}

/** This host's real identity sources, saving a machine id under `configDir`. */
export const systemSources = (configDir: string = getIntercomDirPath()): HostIdentitySources => ({
	platform: process.platform,
	readFile: (path) => readFileSync(path, "utf8"),
	readLink: (path) => readlinkSync(path),
	run: (command, args) =>
		execFileSync(command, [...args], {
			encoding: "utf8",
			timeout: HOST_COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		}),
	writeNewPrivateFile: (path, content) => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, content, { mode: 0o600, flag: "wx" });
	},
	configDir,
});

/** The OS's own id of this machine: the registry's MachineGuid on Windows, the IOPlatformUUID on macOS. */
export function osMachineId(sources: HostIdentitySources): string | undefined {
	if (sources.platform === "win32") {
		const output = hostCommandOutput(sources, "reg", [
			"query",
			"HKLM\\SOFTWARE\\Microsoft\\Cryptography",
			"/v",
			"MachineGuid",
		]);
		return output?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
	}
	if (sources.platform === "darwin") {
		const output = hostCommandOutput(sources, "ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
		return output?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
	}
	return undefined;
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
 * What tells this boot apart from another of a machine with the same id, such as a clone of its image started at the
 * same moment: macOS's random boot session id, Windows' precise boot time. `undefined` where neither can be read,
 * including every other platform: a boot time any coarser could be shared by clones started together.
 */
export function bootSession(sources: HostIdentitySources): string | undefined {
	if (sources.platform === "darwin") {
		const session = hostCommandOutput(sources, "sysctl", ["-n", "kern.bootsessionuuid"]);
		return session === undefined ? undefined : `session-${session}`;
	}
	if (sources.platform === "win32") {
		const [command, ...args] = WINDOWS_BOOT_TIME_COMMAND;
		const bootTime = hostCommandOutput(sources, command, args);
		return bootTime === undefined ? undefined : `boot-${bootTime}`;
	}
	return undefined;
}

/**
 * #5038: what tells this host apart from another with the same host name, such as a cloned VM or a container with a
 * fixed `--hostname` and the same home path, so that an earlier broker on this socket path can be checked by its pid.
 * Where the kernel's boot id can be read (Linux), it and this process's pid namespace. On macOS and Windows, the
 * machine's id (the OS's, or one saved in the config directory) with its `bootSession`. `undefined` otherwise, or when
 * any of these is missing: an earlier instance is then never retired early, and its leases go stale as before.
 */
export function brokerHostIdentity(sources: HostIdentitySources = systemSources()): string | undefined {
	const bootId = orUndefined(() => sources.readFile("/proc/sys/kernel/random/boot_id"));
	if (bootId !== undefined) {
		const pidNamespace = orUndefined(() => sources.readLink("/proc/self/ns/pid"));
		return pidNamespace === undefined ? bootId : `${bootId}/${pidNamespace}`;
	}
	const session = bootSession(sources);
	const machineId = session === undefined ? undefined : (osMachineId(sources) ?? persistedMachineId(sources));
	return machineId === undefined ? undefined : `${machineId}/${session}`;
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
