import { readFileSync } from "node:fs";
import { IntercomBrokerUpgradeError, isIntercomBrokerStopTimeoutError } from "@bastani/atomic";
import type { SqliteExecutor } from "@bastani/atomic/storage";
import type { BrokerStatusReport } from "../types.js";
import { describeMultiNodeStatus, isBrokerStatusReport } from "./broker-status.js";
import { BROKER_STOP_TIMEOUT_MS, isProcessAlive, requestBrokerShutdown, waitForBrokerExit } from "./broker-stop.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "./multinode-state-store.js";
import { getBrokerPidPath, getBrokerSocketPath } from "./paths.js";
import {
	BROKER_PROTOCOL,
	type BrokerProtocolDecision,
	type BrokerProtocolRange,
	decideBrokerProtocol,
	protocolRangeOf,
} from "./protocol-version.js";
import {
	describeSharedStorage,
	readSharedStorageSetting,
	sharedStorageDigest,
	sharedStorageSettingSource,
} from "./shared-storage-setting.js";
import { readLiveBrokerNodes } from "./sql-lease-store.js";

/**
 * Broker control for the Atomic CLI (`atomic intercom restart`, `atomic storage status`): it asks the agent
 * directory's running broker about itself, or to shut down, over the broker's own socket, without registering a
 * session. The CLI loads this module from the bundled Intercom package.
 */

export { describeMultiNodeStatus };
export { projectHomeGroup } from "../project-group.js";

export { BROKER_CONTROL_TIMEOUT_MS, BROKER_STOP_TIMEOUT_MS };
/** The protocol versions this version's broker accepts. */
export { BROKER_PROTOCOL };
/** How long `restartIntercomBroker` waits for a reconnecting session to start a new broker (first retry after 1 s). */
export const BROKER_RECONNECT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

export type BrokerQuery =
	| { readonly state: "stopped" }
	| { readonly state: "running"; readonly report: BrokerStatusReport }
	/** A broker older than `broker_status`: it answers on its socket but drops a connection that asks. */
	| { readonly state: "legacy"; readonly pid?: number };

/** The shared storage a broker started now from this environment would read: what `broker_status` compares with. */
export interface ExpectedBrokerStorage {
	readonly digest: string;
	readonly source: "env" | "settings";
	readonly adapter: string;
	readonly prefix?: string;
}

export type RestartOutcome =
	| { readonly status: "not-running" }
	/** Stopped, and no broker came back: no session was connected, or none reconnected in time. */
	| { readonly status: "stopped"; readonly previous: { readonly pid: number; readonly sessions?: number } }
	| {
			readonly status: "restarted";
			readonly previous: { readonly pid: number; readonly sessions?: number };
			readonly current: Exclude<BrokerQuery, { state: "stopped" }>;
	  };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBrokerPid(agentDir: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Ask the agent directory's broker for its status. */
export async function queryIntercomBroker(
	agentDir: string,
	timeoutMs: number = BROKER_CONTROL_TIMEOUT_MS,
): Promise<BrokerQuery> {
	const answer = await controlRequest(
		getBrokerSocketPath(process.platform, agentDir),
		"broker_status",
		"broker_status",
		timeoutMs,
	);
	if (!answer.connected) return { state: "stopped" };
	const reply = answer.reply;
	if (typeof reply === "object" && reply !== null && !Array.isArray(reply) && isBrokerStatusReport(reply.report)) {
		return { state: "running", report: reply.report };
	}
	const pid = readBrokerPid(agentDir);
	// Windows can briefly accept a named-pipe connection after its broker has terminated.
	if (pid !== undefined && !isProcessAlive(pid)) return { state: "stopped" };
	return pid === undefined ? { state: "legacy" } : { state: "legacy", pid };
}

/** The shared selection a broker started from this environment and agent directory would read, if any. */
export function expectedBrokerStorage(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): ExpectedBrokerStorage | undefined {
	const setting = readSharedStorageSetting(agentDir, env);
	if (setting === undefined) return undefined;
	return { digest: sharedStorageDigest(setting), source: sharedStorageSettingSource(env), ...describeSharedStorage(setting) };
}

/** Host names of the brokers live in a shared database, without creating Intercom's tables. */
export function readLiveBrokers(database: SqliteExecutor, prefix: string | undefined): Promise<string[] | undefined> {
	return readLiveBrokerNodes(database, prefix, BROKER_LEASE_STALE_AFTER_MS);
}

export interface RestartOptions {
	readonly stopTimeoutMs?: number;
	readonly reconnectTimeoutMs?: number;
	/** Progress lines, for example `Stopping the Intercom broker (pid 123, 2 sessions)`. */
	readonly onProgress?: (line: string) => void;
}

/**
 * Restart the agent directory's broker so it reads the current storage selection: ask it to shut down (a broker
 * older than this request gets SIGTERM, which it handles the same way), wait for it to exit, then wait for its
 * sessions to reconnect, which starts a new broker. Without connected sessions the next session starts one.
 */
export async function restartIntercomBroker(agentDir: string, options: RestartOptions = {}): Promise<RestartOutcome> {
	const stopTimeoutMs = options.stopTimeoutMs ?? BROKER_STOP_TIMEOUT_MS;
	const reconnectTimeoutMs = options.reconnectTimeoutMs ?? BROKER_RECONNECT_TIMEOUT_MS;
	const before = await queryIntercomBroker(agentDir);
	if (before.state === "stopped") return { status: "not-running" };
	const pid = before.state === "running" ? before.report.pid : before.pid;
	if (pid === undefined) {
		throw new Error(`The Intercom broker answers, but ${getBrokerPidPath(agentDir)} does not name its process.`);
	}
	const sessions = before.state === "running" ? before.report.sessions : undefined;
	const previous = sessions === undefined ? { pid } : { pid, sessions };
	options.onProgress?.(
		`Stopping the Intercom broker (pid ${pid}${sessions === undefined ? "" : `, ${sessions} session${sessions === 1 ? "" : "s"} connected`}).`,
	);
	const answer =
		before.state === "running"
			? await controlRequest(
					getBrokerSocketPath(process.platform, agentDir),
					"shutdown",
					"shutdown_ack",
					BROKER_CONTROL_TIMEOUT_MS,
				)
			: undefined;
	if (answer === undefined || !answer.connected || answer.reply === undefined) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	await waitForBrokerExit(pid, stopTimeoutMs);
	if (sessions === 0) return { status: "stopped", previous };
	options.onProgress?.("Stopped. Waiting for its sessions to reconnect and start a new broker.");
	const reconnectDeadline = Date.now() + reconnectTimeoutMs;
	let current: BrokerQuery = { state: "stopped" };
	while (Date.now() < reconnectDeadline) {
		current = await queryIntercomBroker(agentDir);
		const settled =
			current.state === "legacy" || (current.state === "running" && current.report.multiNode.status !== "starting");
		if (settled) break;
		await sleep(POLL_INTERVAL_MS * 2);
	}
	return current.state === "stopped" ? { status: "stopped", previous } : { status: "restarted", previous, current };
}

export type UpgradeOutcome =
	| { readonly status: "not-running" }
	/** A broker older than `broker_status`: it cannot report its sessions, so stopping it is never known to be safe. */
	| { readonly status: "unreported"; readonly pid?: number }
	/** The running broker is this version's, newer, or shares no protocol version with it: it is left alone. */
	| {
			readonly status: "current";
			readonly pid: number;
			readonly protocol: BrokerProtocolRange;
			readonly decision: Exclude<BrokerProtocolDecision, "upgrade">;
	  }
	/** An older broker with sessions connected: the next session of this version hands it over to a new broker. */
	| { readonly status: "deferred"; readonly pid: number; readonly sessions: number; readonly protocol: BrokerProtocolRange }
	/** An older broker with no session connected was stopped; the next session starts this version's broker. */
	| { readonly status: "stopped"; readonly previous: { readonly pid: number; readonly protocol: BrokerProtocolRange } };

export interface UpgradeOptions {
	readonly stopTimeoutMs?: number;
	readonly onProgress?: (line: string) => void;
}

/**
 * #4538: after an install or update, replace an older broker when that is safe. An older broker with no session
 * connected is stopped, so the next session starts this version's broker; with sessions connected it is left to the
 * next session of this version, which hands it over without disconnecting them. Anything else is left alone.
 */
export async function upgradeIntercomBroker(agentDir: string, options: UpgradeOptions = {}): Promise<UpgradeOutcome> {
	const query = await queryIntercomBroker(agentDir);
	if (query.state === "stopped") return { status: "not-running" };
	if (query.state === "legacy") return query.pid === undefined ? { status: "unreported" } : { status: "unreported", pid: query.pid };
	const { pid, sessions } = query.report;
	const protocol = protocolRangeOf(query.report.protocol);
	const decision = decideBrokerProtocol(BROKER_PROTOCOL, protocol);
	if (decision !== "upgrade") return { status: "current", pid, protocol, decision };
	if (sessions > 0) return { status: "deferred", pid, sessions, protocol };
	options.onProgress?.(`Stopping the older Intercom broker (pid ${pid}); no session is connected.`);
	const failed = (cause?: Error): IntercomBrokerUpgradeError =>
		new IntercomBrokerUpgradeError({ phase: "stop", previousPid: pid, previousProtocolMax: protocol.max }, { cause });
	const answer = await requestBrokerShutdown(getBrokerSocketPath(process.platform, agentDir));
	if (answer === "unanswered") throw failed();
	try {
		await waitForBrokerExit(pid, options.stopTimeoutMs ?? BROKER_STOP_TIMEOUT_MS);
	} catch (error) {
		if (isIntercomBrokerStopTimeoutError(error)) throw failed(error);
		throw error;
	}
	return { status: "stopped", previous: { pid, protocol } };
}
