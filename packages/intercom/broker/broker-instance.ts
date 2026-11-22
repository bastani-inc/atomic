import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { hostCommandEnvironment } from "./host-command-environment.js";
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
async function hostCommandOutput(
	sources: HostIdentitySources,
	command: string,
	args: readonly string[],
): Promise<string | undefined> {
	for (let attempt = 1; attempt <= HOST_COMMAND_ATTEMPTS; attempt++) {
		try {
			const output = (await sources.run(command, args)).trim();
			if (output !== "") return output;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		}
	}
	return undefined;
}

export { hostCommandEnvironment } from "./host-command-environment.js";

/** What the identity sources read from the host; tests pass fakes. */
export interface HostIdentitySources {
	readonly platform: NodeJS.Platform;
	readFile(path: string): string;
	readLink(path: string): string;
	/** Runs a command and resolves to its standard output; rejects when it fails. */
	run(command: string, args: readonly string[]): Promise<string>;
	/** Writes a file only this user may read, failing when it already exists. */
	writeNewPrivateFile(path: string, content: string): void;
	readonly configDir: string;
}

/**
 * Where a host command lives: the operating system's own copy, started by its absolute path, so neither the working
 * directory nor PATH can put another program in its place.
 */
function hostCommandPath(command: string): string {
	if (/[\\/]/.test(command)) return command;
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		return command === "powershell"
			? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: win32.join(systemRoot, "System32", `${command}.exe`);
	}
	return process.platform === "darwin" ? `/usr/sbin/${command}` : command;
}

/**
 * This host's real identity sources, saving a machine id under `configDir`. With `directoryHeld`, `configDir` is its
 * caller's: it is not created, and the id is saved only while `directoryHeld` says the directory is still there.
 */
export const systemSources = (
	configDir: string = getIntercomDirPath(),
	directoryHeld?: () => boolean,
): HostIdentitySources => ({
	platform: process.platform,
	readFile: (path) => readFileSync(path, "utf8"),
	readLink: (path) => readlinkSync(path),
	run: (command, args) =>
		new Promise<string>((resolve, reject) => {
			const child = execFile(
				hostCommandPath(command),
				[...args],
				{
					encoding: "utf8",
					env: hostCommandEnvironment(),
					timeout: HOST_COMMAND_TIMEOUT_MS,
					windowsHide: true,
					// On Windows, in the system directory: a host command never keeps the folder Atomic runs in in use.
					...(process.platform === "win32"
						? { cwd: process.env.SystemRoot || process.env.windir || "C:\\Windows" }
						: {}),
				},
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
			child.stdin?.end();
		}),
	writeNewPrivateFile: (path, content) => {
		if (directoryHeld === undefined) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		else if (!directoryHeld()) throw new Error(`${dirname(path)} was removed`);
		writeFileSync(path, content, { mode: 0o600, flag: "wx" });
	},
	configDir,
});

/** The OS's own id of this machine: the registry's MachineGuid on Windows, the IOPlatformUUID on macOS. */
export async function osMachineId(sources: HostIdentitySources): Promise<string | undefined> {
	if (sources.platform === "win32") {
		const output = await hostCommandOutput(sources, "reg", [
			"query",
			"HKLM\\SOFTWARE\\Microsoft\\Cryptography",
			"/v",
			"MachineGuid",
		]);
		return output?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
	}
	if (sources.platform === "darwin") {
		const output = await hostCommandOutput(sources, "ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
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
export async function bootSession(sources: HostIdentitySources): Promise<string | undefined> {
	if (sources.platform === "darwin") {
		const session = await hostCommandOutput(sources, "sysctl", ["-n", "kern.bootsessionuuid"]);
		return session === undefined ? undefined : `session-${session}`;
	}
	if (sources.platform === "win32") {
		const [command, ...args] = WINDOWS_BOOT_TIME_COMMAND;
		const bootTime = await hostCommandOutput(sources, command, args);
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
export function brokerHostIdentity(sources?: HostIdentitySources): Promise<string | undefined> {
	if (sources !== undefined) return readHostIdentity(sources);
	return readSystemHostIdentity();
}

const readSystemHostIdentity = createBrokerHostIdentityReader(systemSources);

export function createBrokerHostIdentityReader(
	sourcesForRead: () => HostIdentitySources,
): () => Promise<string | undefined> {
	const identities = new Map<string, Promise<string | undefined>>();
	return () => {
		const sources = sourcesForRead();
		const known = identities.get(sources.configDir);
		if (known !== undefined) return known;
		const reading = readHostIdentity(sources);
		identities.set(sources.configDir, reading);
		void reading.then((identity) => {
			if (identity === undefined && identities.get(sources.configDir) === reading) {
				identities.delete(sources.configDir);
			}
		});
		return reading;
	};
}

async function readHostIdentity(sources: HostIdentitySources): Promise<string | undefined> {
	const bootId = orUndefined(() => sources.readFile("/proc/sys/kernel/random/boot_id"));
	if (bootId !== undefined) {
		const pidNamespace = orUndefined(() => sources.readLink("/proc/self/ns/pid"));
		return pidNamespace === undefined ? bootId : `${bootId}/${pidNamespace}`;
	}
	const session = await bootSession(sources);
	const machineId = session === undefined ? undefined : ((await osMachineId(sources)) ?? persistedMachineId(sources));
	return machineId === undefined ? undefined : `${machineId}/${session}`;
}

/** Milliseconds between the Windows file-time epoch (1601) and the Unix epoch. */
const WINDOWS_FILE_TIME_EPOCH_MS = 11_644_473_600_000;

/**
 * #5252: when process `pid` of this host started, in milliseconds since the epoch, so an earlier broker instance is told
 * apart from a later process the host gave its id. Windows gives an exited process's id to another within seconds when
 * many start, so there it is read, as `processStartToken` in the coding agent reads it: PowerShell's `Get-Process`
 * creation time as a UTC file time, for a process that has not exited, bounded by the host command timeout. `undefined`
 * when it cannot be read, which is unknown, never the same process. A process this one may not signal belongs to
 * another user, so it is no instance of this user's broker: it counts as started now. `null` elsewhere: ids are handed
 * out in sequence, the start is not read, and a running pid is taken for the instance.
 */
export async function processStartedAt(
	pid: number,
	sources: HostIdentitySources = systemSources(),
): Promise<number | null | undefined> {
	if (sources.platform !== "win32") return null;
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? Date.now() : undefined;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const output = await hostCommandOutput(sources, "powershell", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { $p.StartTime.ToFileTimeUtc() }`,
	]);
	if (output === undefined || !/^[1-9]\d*$/.test(output)) return undefined;
	return Number(BigInt(output) / 10_000n) - WINDOWS_FILE_TIME_EPOCH_MS;
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
