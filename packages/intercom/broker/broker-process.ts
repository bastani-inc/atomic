import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as atomicHost from "@bastani/atomic";
import { hostCommandEnvironment } from "./host-command-environment.js";
import { processCreationTimeOf, recognisedProcessStart } from "./start-announcement.js";
import { resolveSafeWindowsWorkingDirectoryAsync } from "./windows-cwd.js";

/**
 * A broker process found by its pid, told apart from a later process the OS gives the same pid (#6133). Windows gives
 * the pid of an exited process to another within seconds, so a pid alone names the broker only while it runs.
 *
 * On Windows a process is told by its creation time, on Linux by its start token (`/proc`), on macOS by its start to the
 * microsecond, read by the native module without starting a process, in the same form as the spawn and socket locks
 * record it.
 */
export interface BrokerProcess {
	readonly pid: number;
	/** When the process `pid` named was started, read while the broker was found; undefined where it could not be read. */
	readonly started: string | undefined;
	/**
	 * Windows: whether that process wrote `broker.pid`, which names it. `yes`: it was created before `broker.pid` was last
	 * written, so it held the pid then and is the broker that wrote it (a process keeps its pid for life, and two
	 * processes never hold one pid at once). `no`: it was created well after that write, so the pid was given to a later
	 * process. Both assume the system clock was not set back in between. `unavailable`: the write time is a whole number
	 * of 10 ms, as a volume that keeps write times too coarsely to tell (FAT, exFAT, maybe in local time) keeps them, so
	 * the pid is taken as the broker's, as before. `unknown` elsewhere, where either time could not be read, or when they
	 * are too close to tell.
	 */
	readonly wroteBrokerPid: "yes" | "no" | "unknown" | "unavailable";
}

/**
 * The host's process start readers. A host older than this package, as one still running while an update replaces this
 * package's files, may lack any of them: a missing reader reads no start, so a pid decides alone, as before.
 */
const hostStarts = atomicHost as {
	readonly processStartToken?: (pid: number) => string | undefined;
	readonly readProcessStartToken?: (pid: number) => Promise<string | undefined>;
	readonly readProcessCreationTime?: (pid: number) => Promise<string | undefined>;
	readonly nativeProcessCreationTime?: (pid: number) => string | null | undefined;
	readonly nativeTerminateProcess?: (pid: number, started: string, descendants: boolean) => number | null | undefined;
};

/** The start token of process `pid` (Linux `/proc`), read now and synchronously; undefined where it cannot be read. */
export function processStartToken(pid: number): string | undefined {
	return hostStarts.processStartToken?.(pid);
}

/** The start token of process `pid`, read now without blocking; undefined where it cannot be read. */
export async function readProcessStartToken(pid: number): Promise<string | undefined> {
	return hostStarts.readProcessStartToken?.(pid);
}

/** When Windows process `pid` was created, read now; undefined where it cannot be read. */
export async function readProcessCreationTime(pid: number): Promise<string | undefined> {
	return hostStarts.readProcessCreationTime?.(pid);
}

/** When Windows process `pid` was created, from the native module only, without starting a process. */
export function nativeProcessCreationTime(pid: number): string | undefined {
	return hostStarts.nativeProcessCreationTime?.(pid) ?? undefined;
}

/** Windows file times count 100 ns intervals from 1601-01-01 UTC; Node reports times from 1970-01-01 UTC. */
const WINDOWS_EPOCH_OFFSET_TICKS = 116_444_736_000_000_000n;

function windowsCreationNs(created: string): bigint {
	return (BigInt(created) - WINDOWS_EPOCH_OFFSET_TICKS) * 100n;
}

/**
 * The step of the write times of a volume too coarse to compare with a creation time. NTFS and ReFS keep write times in
 * UTC to 100 ns. FAT keeps them in local time, rounded up to 2 s, so after the clocks change they read an hour off;
 * exFAT keeps them to 10 ms. A write time that is a whole number of these steps comes from such a volume (on NTFS, one
 * write in 100,000 does too, and is then treated the same way).
 */
const COARSE_WRITE_TIME_NS = 10_000_000n;

/**
 * How much later than the write a process must have been created to be taken for a later process given the pid, so
 * that a small correction of the system clock does not make the broker that wrote it look like one.
 */
const LATER_PROCESS_MARGIN_NS = 2_000_000_000n;

/** Whether a process created at `createdNs` wrote a file last written at `writtenNs` (see {@link BrokerProcess}). */
export function wroteFileAt(createdNs: bigint, writtenNs: bigint): "yes" | "no" | "unknown" | "unavailable" {
	if (writtenNs % COARSE_WRITE_TIME_NS === 0n) return "unavailable";
	if (createdNs < writtenNs) return "yes";
	return createdNs >= writtenNs + LATER_PROCESS_MARGIN_NS ? "no" : "unknown";
}

/**
 * The pid `broker.pid` names and when it was last written, or undefined while it cannot be read, or it changed while it
 * was read (a later broker wrote it in between).
 */
function readBrokerPidRecord(pidPath: string): { readonly pid: number; readonly writtenNs: bigint } | undefined {
	try {
		const before = statSync(pidPath, { bigint: true });
		const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		const after = statSync(pidPath, { bigint: true });
		if (before.mtimeNs !== after.mtimeNs || before.size !== after.size || !Number.isSafeInteger(pid)) return undefined;
		return { pid, writtenNs: after.mtimeNs };
	} catch {
		return undefined;
	}
}

/** {@link readBrokerPidRecord} without blocking the event loop, for a session's own use. */
async function readBrokerPidRecordAsync(
	pidPath: string,
): Promise<{ readonly pid: number; readonly writtenNs: bigint } | undefined> {
	try {
		const before = await stat(pidPath, { bigint: true });
		const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
		const after = await stat(pidPath, { bigint: true });
		if (before.mtimeNs !== after.mtimeNs || before.size !== after.size || !Number.isSafeInteger(pid)) return undefined;
		return { pid, writtenNs: after.mtimeNs };
	} catch {
		return undefined;
	}
}

/** When process `pid` started, as this platform records it, read now; undefined where it cannot be read. */
export async function readProcessStart(pid: number): Promise<string | undefined> {
	try {
		if (process.platform === "win32") return await readProcessCreationTime(pid);
		if (process.platform === "linux") return await readProcessStartToken(pid);
		if (process.platform === "darwin") return processCreationTimeOf(pid);
	} catch {
		// A reader that failed read no start.
	}
	return undefined;
}

/**
 * When process `pid` started, as {@link readProcessStart} reads it, but only where reading it starts no process: Linux
 * `/proc` and the native module on Windows and macOS. Undefined elsewhere (the Windows PowerShell fallback).
 */
export async function readProcessStartWithoutProcess(pid: number): Promise<string | undefined> {
	try {
		if (process.platform === "linux") return await readProcessStartToken(pid);
		if (process.platform === "win32") return nativeProcessCreationTime(pid);
		if (process.platform === "darwin") return processCreationTimeOf(pid);
	} catch {
		// A reader that failed read no start.
	}
	return undefined;
}

/**
 * The broker process `pid` names now. Call it while that broker was just found, and before it is asked to shut down:
 * `broker.pid` is read before this returns (the broker removes it when it exits); the start is read after, as the
 * Windows creation time can take a PowerShell query.
 */
export function identifyBrokerProcess(pid: number, pidPath: string): Promise<BrokerProcess> {
	const reading = readProcessStart(pid);
	const record = process.platform === "win32" ? readBrokerPidRecord(pidPath) : undefined;
	return reading.then((started) => brokerProcess(pid, started, record));
}

/**
 * {@link identifyBrokerProcess} for a session, which never blocks its event loop: `broker.pid` is read beside the start,
 * starting before this returns, so call it, too, before the broker is asked to shut down. A `broker.pid` the broker has
 * already removed by the time it is read proves nothing either way.
 */
export function identifyBrokerProcessAsync(pid: number, pidPath: string): Promise<BrokerProcess> {
	const reading = readProcessStart(pid);
	const record = process.platform === "win32" ? readBrokerPidRecordAsync(pidPath) : Promise.resolve(undefined);
	return Promise.all([reading, record]).then(([started, written]) => brokerProcess(pid, started, written));
}

function brokerProcess(
	pid: number,
	started: string | undefined,
	record: { readonly pid: number; readonly writtenNs: bigint } | undefined,
): BrokerProcess {
	if (record === undefined || record.pid !== pid) return { pid, started, wroteBrokerPid: "unknown" };
	if (record.writtenNs % COARSE_WRITE_TIME_NS === 0n) return { pid, started, wroteBrokerPid: "unavailable" };
	if (started === undefined) return { pid, started, wroteBrokerPid: "unknown" };
	return { pid, started, wroteBrokerPid: wroteFileAt(windowsCreationNs(started), record.writtenNs) };
}

/**
 * A check of whether the found broker's pid now names a later process, which never holds up its caller: each call starts
 * one read of the pid's start when none is running, and answers with what the reads so far found. A start that cannot
 * be read is no proof either way, and neither is anything before `found` resolves.
 */
export function laterProcessProbe(
	found: BrokerProcess | Promise<BrokerProcess>,
	readCurrentStart: (pid: number) => Promise<string | undefined> = readProcessStart,
): () => boolean {
	let broker: BrokerProcess | undefined;
	let later = false;
	let reading = false;
	void Promise.resolve(found).then(
		(resolved) => {
			broker = resolved;
			if (resolved.wroteBrokerPid === "no") later = true;
		},
		() => {},
	);
	return () => {
		// A start in a form this reader does not recognise is read as none recorded: it proves nothing either way.
		const started = recognisedProcessStart(broker?.started);
		if (broker !== undefined && !later && !reading && started !== undefined) {
			const { pid } = broker;
			reading = true;
			void readCurrentStart(pid).then(
				(current) => {
					reading = false;
					if (current !== undefined && current !== started) later = true;
				},
				() => {
					reading = false;
				},
			);
		}
		return later;
	};
}

/** How long a stop of a Windows process may take to check it and start PowerShell before the caller stops waiting. */
const WINDOWS_STOP_START_MS = 5_000;
/** Beyond the PowerShell's own bounds, how much longer the caller waits for it to end. */
const WINDOWS_STOP_MARGIN_MS = 1_000;

/**
 * The PowerShell that ends the Windows process `pid` created at `started` (#6133) and, with `descendants`, every process
 * it started. Each process is ended only through a handle this PowerShell holds to it, opened before it is checked and
 * kept until the PowerShell ends: Windows gives a pid to no other process while a handle to it is open, so a check made
 * through the handle stays true for the process it ends. So a PowerShell that is itself ended part way leaves processes
 * running, and never ends one that is not the one it checked.
 *
 * The process is the one whose creation time is `started`. Its descendants are found from one `Win32_Process` snapshot
 * by parent pid: a process counts as a child only if it was created no earlier than its parent (an older process naming
 * that pid as its parent was started by an earlier holder of the pid), and only if the process its handle holds was
 * created when the snapshot says (not a later process given the snapshot's pid). Without a snapshot it ends the process
 * alone. It waits up to `waitMs` for the process to exit. A process it may not open, or one created at another time, is
 * left alone.
 */
function stopWindowsProcessScript(pid: number, started: string, waitMs: number, descendants: boolean): string {
	return `$ErrorActionPreference = 'Stop'
function Hold([int]$id) {
  try { $p = [System.Diagnostics.Process]::GetProcessById($id); $null = $p.Handle; $p } catch { $null }
}
function Created($p) {
  try { $p.StartTime.ToFileTimeUtc() } catch { $null }
}
function Micros([datetime]$time) { $time.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') }
$broker = Hold ${pid}
if ($null -eq $broker) { exit 3 }
$brokerCreated = Created $broker
if ($null -eq $brokerCreated -or $brokerCreated -ne [long]'${started}') { exit 3 }
$held = New-Object System.Collections.ArrayList
[void]$held.Add($broker)
${descendants ? stopWindowsDescendantsScript : ""}foreach ($p in $held) { try { $p.Kill() } catch { } }
if ($broker.WaitForExit(${waitMs})) { exit 0 } else { exit 4 }
`;
}

const stopWindowsDescendantsScript = `$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($broker.Id)
$snapshot = @()
try { $snapshot = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate) } catch { }
$level = @(, @($broker, $brokerCreated))
while ($level.Count -gt 0) {
  $next = @()
  foreach ($parent in $level) {
    foreach ($entry in $snapshot) {
      if ($entry.ParentProcessId -ne $parent[0].Id -or $ids.Contains([int]$entry.ProcessId) -or $null -eq $entry.CreationDate) { continue }
      $child = Hold $entry.ProcessId
      if ($null -eq $child) { continue }
      $created = Created $child
      if ($null -eq $created -or $created -lt $parent[1]) { continue }
      if ((Micros $child.StartTime) -ne (Micros $entry.CreationDate)) { continue }
      [void]$held.Add($child)
      [void]$ids.Add($child.Id)
      $next += , @($child, $created)
    }
  }
  $level = $next
}
`;

/** How often a stop checks whether the process it ended is gone. */
const WINDOWS_STOP_POLL_MS = 10;

/**
 * End the Windows process `pid` created at `started` and, with `descendants`, every process it started, and wait up to
 * `waitMs` for it to exit. The host's native module ends them at once, each through a handle checked first, as
 * {@link stopWindowsProcessScript} does. Without it, a PowerShell running that script ends them: a pid that already
 * names another process is left alone without starting PowerShell, and the caller waits at most
 * {@link WINDOWS_STOP_START_MS} for the check and PowerShell's start, `waitMs` for the process to exit, and
 * {@link WINDOWS_STOP_MARGIN_MS}. It never ends the PowerShell: once the caller stops waiting, the PowerShell finishes on
 * its own, or ends with this process, which can only leave processes running.
 */
export async function stopWindowsProcess(
	pid: number,
	started: string,
	{ waitMs, descendants }: { readonly waitMs: number; readonly descendants: boolean },
): Promise<void> {
	const entered = performance.now();
	let ended: number | null | undefined;
	try {
		ended = hostStarts.nativeTerminateProcess?.(pid, started, descendants);
	} catch {
		ended = undefined;
	}
	// Not the process created then: it is left alone.
	if (ended === null) return;
	if (ended !== undefined) {
		while (nativeProcessCreationTime(pid) === started && performance.now() - entered < waitMs) {
			await delay(WINDOWS_STOP_POLL_MS);
		}
		return;
	}
	const bound = WINDOWS_STOP_START_MS + waitMs + WINDOWS_STOP_MARGIN_MS;
	if ((await readProcessCreationTime(pid)) !== started) return;
	if (performance.now() - entered >= WINDOWS_STOP_START_MS) return;
	const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
	const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const cwdBudgetMs = Math.min(150, Math.max(0, Math.floor(WINDOWS_STOP_START_MS - (performance.now() - entered))));
	const cwd = await resolveSafeWindowsWorkingDirectoryAsync({
		commandPath: powershellPath,
		preferCommandDir: true,
		timeoutMs: cwdBudgetMs,
	});
	if (performance.now() - entered >= WINDOWS_STOP_START_MS) return;
	await new Promise<void>((resolve) => {
		let powershell: ReturnType<typeof spawn>;
		try {
			powershell = spawn(
				powershellPath,
				[
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					Buffer.from(stopWindowsProcessScript(pid, started, waitMs, descendants), "utf16le").toString("base64"),
				],
				{
					...(cwd === undefined ? {} : { cwd }),
					env: hostCommandEnvironment(),
					stdio: "ignore",
					windowsHide: true,
				},
			);
		} catch {
			resolve();
			return;
		}
		powershell.unref();
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(done, bound - (performance.now() - entered));
		powershell.once("error", done);
		powershell.once("exit", done);
	});
}

/** How long ending a broker that did not acknowledge its shutdown waits, on Windows, for it to exit. */
const UNANSWERED_BROKER_STOP_WAIT_MS = 5_000;

/**
 * End a broker that did not acknowledge its shutdown request, only while its pid still names it, and only the broker
 * itself, never a process it started:
 * - Windows: through a handle to the process created at `broker.started`, if that process wrote `broker.pid`, or where
 *   the volume's write times cannot tell (`unavailable`), in which case the pid is taken as the broker's, as before.
 *   Without a creation time nothing is ended.
 * - Linux: with SIGTERM while the pid's start token is still `broker.started`, read just before the signal.
 * - macOS: with SIGTERM to the pid, as before, unless its start, read again just before, shows another process.
 */
export async function endUnansweredBroker(found: BrokerProcess): Promise<void> {
	// A start in a form this reader does not recognise is ended as one never read.
	const broker: BrokerProcess = { ...found, started: recognisedProcessStart(found.started) };
	if (process.platform === "win32") {
		if (broker.started === undefined) return;
		if (broker.wroteBrokerPid !== "yes" && broker.wroteBrokerPid !== "unavailable") return;
		await stopWindowsProcess(broker.pid, broker.started, {
			waitMs: UNANSWERED_BROKER_STOP_WAIT_MS,
			descendants: false,
		});
		return;
	}
	// Linux: the check and the signal run in one turn of the event loop, with no await between them.
	if (process.platform === "linux" && (broker.started === undefined || processStartToken(broker.pid) !== broker.started)) {
		return;
	}
	if (process.platform === "darwin" && broker.started !== undefined) {
		const current = processCreationTimeOf(broker.pid);
		if (current !== undefined && current !== broker.started) return;
	}
	try {
		process.kill(broker.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
