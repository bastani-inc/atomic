import {
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
} from "@bastani/atomic";
import { IntercomBrokerRetiringError } from "../recoverable-disconnect.js";
import { isBrokerStatusReport } from "./broker-status.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";
import { getBrokerSocketPath } from "./paths.js";

export interface BrokerRouting {
	readonly acrossMachines: boolean;
	readonly hasSharedStorage: boolean;
}

export async function queryBrokerRouting(agentDir: string): Promise<BrokerRouting> {
	const startedAt = Date.now();
	const answer = await controlRequest(
		getBrokerSocketPath(process.platform, agentDir),
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
	if (reply === undefined) throw new IntercomRoutingUnavailableError("unsupported", "broker_status");
	if (typeof reply !== "object" || reply === null || Array.isArray(reply) || !isBrokerStatusReport(reply.report)) {
		throw new IntercomRoutingUnavailableError("malformed", "broker_status");
	}
	return { acrossMachines: reply.report.multiNode.status !== "off", hasSharedStorage: reply.report.storage !== undefined };
}
