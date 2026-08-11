import { isStaleExtensionContextError, STALE_EXTENSION_CONTEXT_MARKER } from "@bastani/atomic";

export interface BridgeRequestSettlement {
	reject(error: unknown): void;
}

interface BridgeEventSurface {
	emit(event: string, data: unknown): void;
}

export type BridgeSettlementScope = "slash" | "prompt-template";

function bridgeSettlementRegistry(): Map<string, BridgeRequestSettlement> {
	const key = "__atomicSubagentBridgeRequestSettlements";
	const store = globalThis as Record<string, unknown>;
	const existing = store[key];
	if (existing instanceof Map) return existing as Map<string, BridgeRequestSettlement>;
	const registry = new Map<string, BridgeRequestSettlement>();
	store[key] = registry;
	return registry;
}

function settlementKey(scope: BridgeSettlementScope, requestId: string): string {
	return `${scope}\0${requestId}`;
}

export function registerBridgeRequestSettlement(
	scope: BridgeSettlementScope,
	requestId: string,
	settlement: BridgeRequestSettlement,
): () => void {
	const registry = bridgeSettlementRegistry();
	const key = settlementKey(scope, requestId);
	registry.set(key, settlement);
	return () => {
		if (registry.get(key) === settlement) registry.delete(key);
	};
}

export function readBridgeRequestSettlement(
	data: unknown,
	scope: BridgeSettlementScope,
): BridgeRequestSettlement | undefined {
	if (!data || typeof data !== "object") return undefined;
	const requestId = (data as { requestId?: unknown }).requestId;
	if (typeof requestId === "string") {
		const registered = bridgeSettlementRegistry().get(settlementKey(scope, requestId));
		if (registered) return registered;
	}
	const settlement = (data as { settlement?: unknown }).settlement;
	if (!settlement || typeof settlement !== "object") return undefined;
	const reject = (settlement as { reject?: unknown }).reject;
	if (typeof reject !== "function") return undefined;
	return { reject: (error) => reject(error) };
}

export function rejectStoppedBridgeRequest(settlement: BridgeRequestSettlement | undefined): void {
	settlement?.reject(
		new Error(
			`Subagent response delivery stopped because its ${STALE_EXTENSION_CONTEXT_MARKER} during reload or session replacement.`,
		),
	);
}

/**
 * Emit through the captured extension runtime. A stale runtime means the event
 * was dropped, so reject the request's direct settlement path instead of
 * letting an event-only caller wait forever.
 */
export function emitBridgeEvent(
	events: BridgeEventSurface,
	event: string,
	data: unknown,
	settlement: BridgeRequestSettlement | undefined,
): boolean {
	try {
		events.emit(event, data);
		return true;
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		settlement?.reject(error);
		return false;
	}
}
