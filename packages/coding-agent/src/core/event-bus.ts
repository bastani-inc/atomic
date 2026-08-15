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

const canonicalBusByFacade = new WeakMap<object, object>();

/**
 * Record that `facade` is a per-extension events surface delegating to the
 * shared `bus`. The loader creates one facade per extension per load, so
 * facade identity is unstable across extensions and across `/reload`;
 * consumers that key state by events-object identity resolve through this
 * registry to stay on the one bus that outlives every facade.
 */
export function registerEventBusFacade(facade: object, bus: object): void {
	canonicalBusByFacade.set(facade, bus);
}

/** Resolve an events object to the shared bus it delegates to, when known. */
export function canonicalEventBusFor(events: object): object {
	return canonicalBusByFacade.get(events) ?? events;
}
