import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

/**
 * Per-extension `events` facades mapped back to the canonical EventBus each
 * forwards to. Weak so neither facades nor buses are retained: an entry lives
 * exactly as long as the facade it keys on.
 */
const canonicalEventBuses = new WeakMap<object, object>();

/**
 * Register `facade` as forwarding to `bus`, so `canonicalEventBusFor(facade)`
 * resolves to `bus`.
 */
export function registerCanonicalEventBus(facade: object, bus: object): void {
	canonicalEventBuses.set(facade, bus);
}

/**
 * Resolve a scope object to the canonical EventBus it forwards to. A
 * registered per-extension `events` facade yields the shared bus behind it;
 * anything else — including a canonical bus itself — is returned unchanged,
 * so canonical buses are fixed points.
 */
export function canonicalEventBusFor(scope: object): object {
	return canonicalEventBuses.get(scope) ?? scope;
}
