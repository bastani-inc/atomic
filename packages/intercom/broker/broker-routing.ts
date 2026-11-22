import { readFile, stat } from "node:fs/promises";
import {
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
} from "@bastani/atomic";
import { IntercomBrokerRetiringError } from "../recoverable-disconnect.js";
import { nativeProcessCreationTime, readProcessStartToken } from "./broker-process.js";
import { isBrokerStatusReport } from "./broker-status.js";
import { isProcessAlive } from "./broker-stop.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";
import { getBrokerPidPath, getBrokerSocketPathAsync, getBrokerSpawnLockPath } from "./paths.js";
import { type BrokerProtocolRange, protocolRangeOf } from "./protocol-version.js";
import { isSocketAnswering } from "./socket-liveness.js";
import { completeLines, writerStateAsync } from "./stale-lock-file.js";

/** Matches `BROKER_SPAWN_LOCK_MAX_AGE_MS` in `spawn.ts` without pulling the spawner into routing checks. */
const SPAWN_LOCK_MAX_AGE_MS = 60_000;

export interface BrokerRouting {
	readonly acrossMachines: boolean;
	readonly hasSharedStorage: boolean;
	/** #4538: the protocol versions the broker accepts; a broker that advertises none speaks protocol 1. */
	readonly protocol: BrokerProtocolRange;
}

type BrokerPidSnapshot =
	| { readonly kind: "missing" }
	| { readonly kind: "present"; readonly pid: number; readonly ino: bigint; readonly mtimeNs: bigint }
	| { readonly kind: "changing" };

async function readBrokerPidSnapshotAsync(pidPath: string): Promise<BrokerPidSnapshot> {
	try {
		const before = await stat(pidPath, { bigint: true });
		const raw = (await readFile(pidPath, "utf8")).trim();
		const after = await stat(pidPath, { bigint: true });
		const pid = Number.parseInt(raw, 10);
		if (
			before.ino !== after.ino ||
			before.mtimeNs !== after.mtimeNs ||
			before.size !== after.size ||
			!Number.isSafeInteger(pid)
		) {
			return { kind: "changing" };
		}
		return { kind: "present", pid, ino: after.ino, mtimeNs: after.mtimeNs };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
		return { kind: "changing" };
	}
}

function sameBrokerPidSnapshot(before: BrokerPidSnapshot, after: BrokerPidSnapshot): boolean {
	if (before.kind === "changing" || after.kind === "changing") return false;
	if (before.kind === "missing" && after.kind === "missing") return true;
	if (before.kind === "present" && after.kind === "present") {
		return before.pid === after.pid && before.ino === after.ino && before.mtimeNs === after.mtimeNs;
	}
	return false;
}

function isBrokerPidSnapshotAlive(snapshot: BrokerPidSnapshot): boolean {
	if (snapshot.kind === "missing") return true;
	if (snapshot.kind === "changing") return false;
	return isProcessAlive(snapshot.pid);
}

async function lockProcessStartAsync(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") return readProcessStartToken(pid);
	if (process.platform === "win32") return nativeProcessCreationTime(pid);
	return undefined;
}

async function isSpawnLockLiveAsync(agentDir: string, nowMs: number = Date.now()): Promise<boolean> {
	const lockPath = getBrokerSpawnLockPath(agentDir);
	let written: string;
	try {
		written = await readFile(lockPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		// Transient sharing violation while another spawner is writing or renaming the lock on Windows.
		return code === "EBUSY" || code === "EPERM";
	}
	const content = completeLines(written) ?? "";
	const [spawnerLine = "", createdAtLine = "", brokerLine = ""] = content.split("\n");
	const spawnerPid = Number.parseInt(spawnerLine, 10);
	const createdAt = Number.parseInt(createdAtLine, 10);
	if (!Number.isFinite(spawnerPid) || !Number.isFinite(createdAt)) {
		return (await writerStateAsync(lockPath, written)) === "held";
	}
	if (nowMs - createdAt > SPAWN_LOCK_MAX_AGE_MS) return false;
	const brokerPid = Number.parseInt(brokerLine, 10);
	const line = Number.isFinite(brokerPid) ? brokerLine : spawnerLine;
	const pid = Number.parseInt(line, 10);
	if (!isProcessAlive(pid)) return false;
	const space = line.indexOf(" ");
	if (space === -1) return true;
	const recorded = line.slice(space + 1);
	if (recorded === "") return true;
	const current = await lockProcessStartAsync(pid);
	return current === undefined || current === recorded;
}

/**
 * Distinguish a live broker that does not support `broker_status` from a broker that retired, crashed, or was
 * replaced while the status request was in flight. Only an answering, unchanged broker with no live spawn lock
 * is classified as unsupported; everything else is a recoverable retiring-broker race.
 */
async function isUnansweredStatusFromRetiringBroker(
	agentDir: string,
	socketPath: string,
	pidBefore: BrokerPidSnapshot,
): Promise<boolean> {
	const [answering, pidAfter, liveSpawnLock] = await Promise.all([
		isSocketAnswering(socketPath),
		readBrokerPidSnapshotAsync(getBrokerPidPath(agentDir)),
		isSpawnLockLiveAsync(agentDir),
	]);
	return (
		!answering ||
		!sameBrokerPidSnapshot(pidBefore, pidAfter) ||
		!isBrokerPidSnapshotAlive(pidAfter) ||
		liveSpawnLock
	);
}

export async function queryBrokerRouting(agentDir: string): Promise<BrokerRouting> {
	const startedAt = Date.now();
	const [socketPath, pidBefore] = await Promise.all([
		getBrokerSocketPathAsync(process.platform, agentDir),
		readBrokerPidSnapshotAsync(getBrokerPidPath(agentDir)),
	]);
	const answer = await controlRequest(
		socketPath,
		"broker_status",
		"broker_status",
		BROKER_CONTROL_TIMEOUT_MS,
	);
	if (!answer.connected) throw new IntercomBrokerRetiringError();
	if (answer.timedOut === true) {
		throw new IntercomRoutingTimeoutError({
			timeoutMs: BROKER_CONTROL_TIMEOUT_MS,
			elapsedMs: Math.max(Date.now() - startedAt, BROKER_CONTROL_TIMEOUT_MS),
			phase: "broker_status",
		});
	}
	const reply = answer.reply;
	if (reply === undefined) {
		if (await isUnansweredStatusFromRetiringBroker(agentDir, socketPath, pidBefore)) {
			throw new IntercomBrokerRetiringError();
		}
		throw new IntercomRoutingUnavailableError("unsupported", "broker_status");
	}
	if (typeof reply !== "object" || reply === null || Array.isArray(reply) || !isBrokerStatusReport(reply.report)) {
		throw new IntercomRoutingUnavailableError("malformed", "broker_status");
	}
	return {
		acrossMachines: reply.report.multiNode.status !== "off",
		hasSharedStorage: reply.report.storage !== undefined,
		protocol: protocolRangeOf(reply.report.protocol),
	};
}
