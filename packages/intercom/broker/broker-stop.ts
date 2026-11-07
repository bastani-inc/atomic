import { IntercomBrokerStopTimeoutError } from "@bastani/atomic";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";

/** How long a stop waits for the broker to exit after its shutdown request; its multi-node close is bounded at 2 s. */
export const BROKER_STOP_TIMEOUT_MS = 10_000;
const EXIT_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type BrokerShutdownAnswer = "acknowledged" | "gone" | "unanswered";

/**
 * Ask the broker on `socketPath` to shut down. `gone`: nothing answered on the socket any more. `unanswered`: a broker
 * accepted the connection but closed it or stayed silent without acknowledging, as one older than the request does.
 */
export async function requestBrokerShutdown(
	socketPath: string,
	timeoutMs: number = BROKER_CONTROL_TIMEOUT_MS,
): Promise<BrokerShutdownAnswer> {
	const answer = await controlRequest(socketPath, "shutdown", "shutdown_ack", timeoutMs);
	if (!answer.connected) return "gone";
	return answer.reply === undefined ? "unanswered" : "acknowledged";
}

/**
 * Wait until the broker process `pid` has exited. The process, not the socket, decides: Windows can briefly accept a
 * named-pipe connection after its broker has terminated, and a successor can bind the pipe only once it has exited.
 */
export async function waitForBrokerExit(pid: number, timeoutMs: number = BROKER_STOP_TIMEOUT_MS): Promise<void> {
	const startedAt = Date.now();
	while (isProcessAlive(pid)) {
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= timeoutMs) throw new IntercomBrokerStopTimeoutError({ pid, timeoutMs, elapsedMs });
		await sleep(EXIT_POLL_INTERVAL_MS);
	}
}
