import type { BrokerMultiNodeStatus, BrokerStatusReport } from "../types.js";
import type { JsonWireValue } from "./framing.js";

type WireObject = { [key: string]: JsonWireValue };

function isObject(value: JsonWireValue | undefined): value is WireObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: JsonWireValue | undefined): boolean {
	return value === undefined || typeof value === "string";
}

/** Whether a `broker_status` frame's `report` has the shape this version reads. */
export function isBrokerStatusReport(value: JsonWireValue | undefined): value is WireObject & BrokerStatusReport {
	if (!isObject(value) || typeof value.pid !== "number" || typeof value.sessions !== "number") return false;
	const { storage, multiNode } = value;
	if (
		storage !== undefined &&
		(!isObject(storage) ||
			typeof storage.digest !== "string" ||
			(storage.source !== "env" && storage.source !== "settings"))
	)
		return false;
	return (
		isObject(multiNode) &&
		(multiNode.status === "off" ||
			multiNode.status === "starting" ||
			multiNode.status === "on" ||
			multiNode.status === "unavailable") &&
		isOptionalString(multiNode.reason) &&
		isOptionalString(multiNode.adapter) &&
		isOptionalString(multiNode.prefix) &&
		(multiNode.peers === undefined ||
			(Array.isArray(multiNode.peers) && multiNode.peers.every((peer) => typeof peer === "string")))
	);
}

/** One line for a broker's multi-node routing state, e.g. `on (adapter x, prefix none), 1 peer broker live (host-b)`. */
export function describeMultiNodeStatus(multiNode: BrokerMultiNodeStatus): string {
	const storage = multiNode.adapter === undefined ? "" : ` (adapter ${multiNode.adapter}, prefix ${multiNode.prefix ?? "none"})`;
	if (multiNode.status === "off" || multiNode.status === "unavailable") {
		return `${multiNode.status}${storage}${multiNode.reason === undefined ? "" : `: ${multiNode.reason}`}`;
	}
	if (multiNode.status === "starting" || multiNode.peers === undefined) return `${multiNode.status}${storage}`;
	const count = `${multiNode.peers.length} peer broker${multiNode.peers.length === 1 ? "" : "s"} live`;
	return `on${storage}, ${count}${multiNode.peers.length === 0 ? "" : ` (${[...new Set(multiNode.peers)].join(", ")})`}`;
}
