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

export interface PreparedEventBusCommit {
	commit(): void;
	rollback(): void;
}

export interface StagedEventBus {
	readonly bus: EventBus;
	prepareCommit(): PreparedEventBusCommit;
	commit(): void;
}

type StagedSubscription = {
	channel: string;
	handler: (data: unknown) => void;
	active: boolean;
	unsubscribe: () => void;
};

/** Isolate reload-candidate events from the live bus until publication. */
export function createStagedEventBus(target: EventBus): StagedEventBus {
	const local = createEventBus();
	const subscriptions = new Set<StagedSubscription>();
	let committed = false;
	let prepared = false;
	const bus: EventBus = {
		emit(channel, data) {
			if (committed) target.emit(channel, data);
			else local.emit(channel, data);
		},
		on(channel, handler) {
			if (committed) return target.on(channel, handler);
			if (prepared) throw new Error("Cannot add staged event subscriptions after commit preparation");
			const subscription: StagedSubscription = {
				channel,
				handler,
				active: true,
				unsubscribe: local.on(channel, handler),
			};
			subscriptions.add(subscription);
			return () => {
				if (!subscription.active) return;
				subscription.active = false;
				subscriptions.delete(subscription);
				subscription.unsubscribe();
			};
		},
	};
	registerCanonicalEventBus(bus, canonicalEventBusFor(target));
	const prepareCommit = (): PreparedEventBusCommit => {
		if (committed) return { commit: () => {}, rollback: () => {} };
		if (prepared) throw new Error("Staged event bus commit is already prepared");
		prepared = true;
		let activated = false;
		let settled = false;
		const targetSubscriptions: Array<{ subscription: StagedSubscription; unsubscribe: () => void }> = [];
		try {
			for (const subscription of subscriptions) {
				if (!subscription.active) continue;
				const unsubscribe = target.on(subscription.channel, (data) => {
					if (activated && subscription.active) subscription.handler(data);
				});
				targetSubscriptions.push({ subscription, unsubscribe });
			}
		} catch (error) {
			for (const registered of targetSubscriptions.reverse()) registered.unsubscribe();
			prepared = false;
			throw error;
		}
		return {
			commit() {
				if (settled) return;
				settled = true;
				activated = true;
				committed = true;
				for (const { subscription, unsubscribe } of targetSubscriptions) {
					if (!subscription.active) {
						unsubscribe();
						continue;
					}
					subscription.unsubscribe();
					subscription.unsubscribe = unsubscribe;
				}
				local.clear();
			},
			rollback() {
				if (settled) return;
				settled = true;
				for (const registered of targetSubscriptions.reverse()) registered.unsubscribe();
				prepared = false;
			},
		};
	};
	return {
		bus,
		prepareCommit,
		commit() {
			prepareCommit().commit();
		},
	};
}

/**
 * Shared by duplicate host-module instances in packaged/split-loader builds.
 * The `@1` suffix versions the stored WeakMap shape.
 */
const CANONICAL_EVENT_BUSES_KEY = Symbol.for("atomic-coding-agent/canonical-event-buses@1");

type CanonicalEventBuses = WeakMap<object, object>;

function canonicalEventBusBag(): Record<symbol, CanonicalEventBuses | undefined> {
	return globalThis as typeof globalThis & Record<symbol, CanonicalEventBuses | undefined>;
}

/**
 * Per-extension `events` facades mapped back to the canonical EventBus each
 * forwards to. Weak so neither facades nor buses are retained: an entry lives
 * exactly as long as the facade it keys on.
 */
function getCanonicalEventBuses(): CanonicalEventBuses {
	const bag = canonicalEventBusBag();
	const existing = bag[CANONICAL_EVENT_BUSES_KEY];
	if (existing !== undefined) return existing;
	const created = new WeakMap<object, object>();
	bag[CANONICAL_EVENT_BUSES_KEY] = created;
	return created;
}

/**
 * Register `facade` as forwarding to `bus`, so `canonicalEventBusFor(facade)`
 * resolves to `bus`.
 */
export function registerCanonicalEventBus(facade: object, bus: object): void {
	getCanonicalEventBuses().set(facade, bus);
}

/**
 * Resolve a scope object to the canonical EventBus it forwards to. A
 * registered per-extension `events` facade yields the shared bus behind it;
 * anything else — including a canonical bus itself — is returned unchanged,
 * so canonical buses are fixed points.
 */
export function canonicalEventBusFor(scope: object): object {
	return getCanonicalEventBuses().get(scope) ?? scope;
}
