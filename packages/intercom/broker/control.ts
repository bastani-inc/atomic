import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import type { SqliteExecutor } from "@bastani/atomic/storage";
import type { BrokerStatusReport } from "../types.js";
import { describeMultiNodeStatus, isBrokerStatusReport } from "./broker-status.js";
import { createMessageReader, type JsonWireValue, writeMessage } from "./framing.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "./multinode-state-store.js";
import { getBrokerPidPath, getBrokerSocketPath } from "./paths.js";
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

/** How long a control request waits for its answer; a status report may wait up to 2 s for the shared database. */
export const BROKER_CONTROL_TIMEOUT_MS = 5_000;
/** How long `restartIntercomBroker` waits for the old broker to exit; its multi-node close is bounded at 2 s. */
export const BROKER_STOP_TIMEOUT_MS = 10_000;
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

type ControlReply = { readonly connected: false } | { readonly connected: true; readonly reply?: JsonWireValue };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send one control frame and wait for the reply of `replyType`; a broker that closes without one yields no reply. */
function controlRequest(
	socketPath: string,
	type: "broker_status" | "shutdown",
	replyType: "broker_status" | "shutdown_ack",
	timeoutMs: number,
): Promise<ControlReply> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		const socket = net.connect(socketPath);
		let connected = false;
		let settled = false;
		const finish = (result: ControlReply): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish(connected ? { connected } : { connected: false }), timeoutMs);
		socket.on("connect", () => {
			connected = true;
			writeMessage(socket, { type, requestId });
		});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (
						typeof message === "object" &&
						message !== null &&
						!Array.isArray(message) &&
						message.type === replyType &&
						message.requestId === requestId
					)
						finish({ connected: true, reply: message });
				},
				() => finish({ connected }),
			),
		);
		socket.on("error", () => finish(connected ? { connected } : { connected: false }));
		socket.on("close", () => finish(connected ? { connected } : { connected: false }));
	});
}

function readBrokerPid(agentDir: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
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
	const stopDeadline = Date.now() + stopTimeoutMs;
	while (isProcessAlive(pid)) {
		if (Date.now() >= stopDeadline) {
			throw new Error(`The Intercom broker (pid ${pid}) did not exit within ${Math.round(stopTimeoutMs / 1000)} s.`);
		}
		await sleep(POLL_INTERVAL_MS);
	}
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
