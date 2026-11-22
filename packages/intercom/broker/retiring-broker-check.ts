import { readFile, stat } from "node:fs/promises";
import { nativeProcessCreationTime, readProcessStartToken, wroteFileAt } from "./broker-process.js";
import { isProcessAlive } from "./broker-stop.js";
import { getBrokerPidPath, getBrokerSpawnLockPath } from "./paths.js";
import { isSocketAnswering } from "./socket-liveness.js";
import { completeLines, writerStateAsync } from "./stale-lock-file.js";
import { processCreationTimeOf, recognisedProcessStart } from "./start-announcement.js";

/** Matches `BROKER_SPAWN_LOCK_MAX_AGE_MS` in `spawn.ts` without pulling the spawner into routing/client checks. */
const SPAWN_LOCK_MAX_AGE_MS = 60_000;

/** Windows file times count 100 ns intervals from 1601-01-01 UTC; Node stat times count from 1970-01-01 UTC. */
const WINDOWS_EPOCH_OFFSET_TICKS = 116_444_736_000_000_000n;

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

export type BrokerPidStat =
	| { readonly kind: "missing" }
	| { readonly kind: "present"; readonly ino: bigint; readonly mtimeNs: bigint; readonly size: bigint }
	| { readonly kind: "unreadable"; readonly code: string };

function parsePositivePid(value: string): number | undefined {
	const trimmed = value.trim();
	if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) return undefined;
	const pid = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function parseLeadingPositivePid(line: string): number | undefined {
	const space = line.indexOf(" ");
	return parsePositivePid(space === -1 ? line : line.slice(0, space));
}

function windowsCreationNs(created: string): bigint {
	return (BigInt(created) - WINDOWS_EPOCH_OFFSET_TICKS) * 100n;
}

/**
 * Lightweight single-`stat` snapshot of `broker.pid` taken before a broker request (`broker_status` or
 * `register_verified`), so the happy path pays at most one async `stat` and `readFile` runs only if the
 * connection closes unanswered. Returns `undefined` when `agentDir` is `undefined` (for an explicit socket
 * path unrelated to the ambient agent directory).
 */
export async function snapshotBrokerPidBeforeRequest(
	agentDir: string | undefined,
): Promise<BrokerPidStat | undefined> {
	if (agentDir === undefined) return undefined;
	return statBrokerPidAsync(getBrokerPidPath(agentDir));
}

async function statBrokerPidAsync(pidPath: string): Promise<BrokerPidStat> {
	try {
		const info = await stat(pidPath, { bigint: true });
		return { kind: "present", ino: info.ino, mtimeNs: info.mtimeNs, size: info.size };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
		return { kind: "unreadable", code };
	}
}

function sameBrokerPidStat(before: BrokerPidStat, after: BrokerPidStat): boolean {
	if (before.kind === "missing" && after.kind === "missing") return true;
	if (before.kind === "unreadable" && after.kind === "unreadable") return before.code === after.code;
	if (before.kind === "present" && after.kind === "present") {
		return before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.size === after.size;
	}
	return false;
}

type BrokerPidCheck =
	| { readonly status: "dead" }
	| { readonly status: "alive"; readonly pid: number }
	| { readonly status: "unknown" };

/**
 * Read `broker.pid` after an unanswered close to see whether it names a process known to be gone (dead PID,
 * unlinked mid-read, or on Windows a PID recycled to a later process after `broker.pid` was written).
 * Permanently missing, empty, non-positive, corrupt, or unreadable pid files yield `"unknown"` rather than
 * `"dead"` so they never trigger a retiring retry loop against a live broker.
 */
async function inspectBrokerPidAsync(agentDir: string, statAfter: BrokerPidStat): Promise<BrokerPidCheck> {
	if (statAfter.kind !== "present") return { status: "unknown" };
	let raw: string;
	try {
		raw = await readFile(getBrokerPidPath(agentDir), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { status: "dead" } : { status: "unknown" };
	}
	const pid = parsePositivePid(raw);
	if (pid === undefined) return { status: "unknown" };
	if (!isProcessAlive(pid)) return { status: "dead" };
	if (process.platform === "win32") {
		const created = nativeProcessCreationTime(pid);
		if (created !== undefined && wroteFileAt(windowsCreationNs(created), statAfter.mtimeNs) === "no") {
			return { status: "dead" };
		}
	}
	return { status: "alive", pid };
}

/** Matches `spawn.ts:lockProcessStartAsync` across Linux, Windows, and macOS without starting a subprocess. */
async function lockProcessStartAsync(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") return readProcessStartToken(pid);
	if (process.platform === "win32") return nativeProcessCreationTime(pid);
	if (process.platform === "darwin") return processCreationTimeOf(pid);
	return undefined;
}

async function isSpawnLockLiveAsync(
	agentDir: string,
	runningBrokerPid: number | undefined,
	nowMs: number = Date.now(),
): Promise<boolean> {
	const lockPath = getBrokerSpawnLockPath(agentDir);
	let written: string;
	try {
		written = await readFile(lockPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Transient Windows sharing violation while a spawner is writing or renaming the lock.
		// Permanent errors (ENOENT, EACCES, EPERM, EISDIR) are not live locks.
		return code === "EBUSY";
	}
	const content = completeLines(written) ?? "";
	const [spawnerLine = "", createdAtLine = "", brokerLine = ""] = content.split("\n");
	const spawnerPid = parseLeadingPositivePid(spawnerLine);
	const createdAt = Number.parseInt(createdAtLine, 10);
	if (spawnerPid === undefined || !Number.isFinite(createdAt)) {
		return (await writerStateAsync(lockPath, written)) === "held";
	}
	if (nowMs - createdAt > SPAWN_LOCK_MAX_AGE_MS) return false;
	const brokerPid = parseLeadingPositivePid(brokerLine);
	// A 3-line lock handed off after a slow start to the same live broker that is already answering
	// does not indicate a replacement in progress.
	if (brokerPid !== undefined && runningBrokerPid !== undefined && brokerPid === runningBrokerPid) {
		return false;
	}
	const line = brokerPid !== undefined ? brokerLine : spawnerLine;
	const pid = brokerPid ?? spawnerPid;
	if (!isProcessAlive(pid)) return false;
	const space = line.indexOf(" ");
	if (space === -1) return true;
	const recorded = recognisedProcessStart(line.slice(space + 1));
	if (recorded === undefined || recorded === "") return true;
	const current = await lockProcessStartAsync(pid);
	return current === undefined || current === recorded;
}

/**
 * Shared retiring-broker classifier for connections that closed unanswered (`broker_status` in
 * `broker-routing.ts` / `control.ts` and `register` / `register_verified` in `client.ts`).
 *
 * Returns `true` when the broker retired, crashed, or was replaced while the request was in flight:
 * - nothing answers on `socketPath` anymore, or (when tied to an agent directory):
 * - `broker.pid` changed, was unlinked, or was created across the request,
 * - `broker.pid` names a process known to be gone (exited, or recycled on Windows), or
 * - a live (non-stale) `broker.spawn.lock` is held for a transition in progress.
 *
 * Returns `false` for an answering, unchanged live broker (including explicit custom sockets with
 * `agentDir === undefined` that still answer), so genuinely unsupported or refusing brokers are never
 * mistaken for retiring ones.
 */
export async function isUnansweredCloseFromRetiringBroker(
	socketPath: string,
	agentDir: string | undefined,
	statBefore: BrokerPidStat | undefined,
): Promise<boolean> {
	if (agentDir === undefined || statBefore === undefined) {
		return !(await isSocketAnswering(socketPath));
	}
	const [answering, statAfter] = await Promise.all([
		isSocketAnswering(socketPath),
		statBrokerPidAsync(getBrokerPidPath(agentDir)),
	]);
	if (!answering || !sameBrokerPidStat(statBefore, statAfter)) return true;
	const pidCheck = await inspectBrokerPidAsync(agentDir, statAfter);
	if (pidCheck.status === "dead") return true;
	return isSpawnLockLiveAsync(agentDir, pidCheck.status === "alive" ? pidCheck.pid : undefined);
}
