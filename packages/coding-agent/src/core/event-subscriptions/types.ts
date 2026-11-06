/** Event stream contracts shared by `ctx.subscribe`, `ctx.events` and `session.subscribe`. */

export type SubscriptionEventPayload =
	| string
	| number
	| boolean
	| null
	| readonly SubscriptionEventPayload[]
	| { readonly [key: string]: SubscriptionEventPayload };

/** One event from a stream. `id` identifies it: a subscription processes each id once. */
export interface SubscriptionEvent {
	readonly id: string;
	readonly type?: string;
	readonly payload?: SubscriptionEventPayload;
}

/** Hands one event to the subscription. Throws `SubscriptionEventError` for an event without a string id. */
export type EmitSubscriptionEvent = (event: SubscriptionEvent) => void;

/**
 * A pluggable event stream. `start` begins producing events and passes each to `emit`. The source ends when the
 * promise `start` returns settles; a source that returns nothing runs until `signal` aborts, which is how a
 * subscription stops it.
 */
export interface EventSource {
	readonly id: string;
	start(signal: AbortSignal, emit: EmitSubscriptionEvent): void | Promise<void>;
}

/** At most `events` event children (or inline deliveries) start within any `intervalMs` window. */
export interface SubscriptionRate {
	readonly events: number;
	readonly intervalMs: number;
}

export interface SubscriptionAdmission {
	/** Event handlers that may run at once. Defaults to 4; `ctx.events` and inline delivery use 1. */
	readonly maxConcurrent?: number;
	/** Maximum start rate. Events over the rate wait in arrival order; none are dropped. */
	readonly maxRate?: SubscriptionRate;
}

export interface SubscriptionStats {
	/** Events the source or `publishEvent` delivered, duplicates included. */
	readonly received: number;
	/** Events dropped because their id was already processed or is in flight. */
	readonly duplicates: number;
	/** Events whose handling finished. */
	readonly handled: number;
	/** Events handling now. */
	readonly active: number;
	/** Events waiting for a concurrency or rate slot. */
	readonly queued: number;
	/** Reports delivered to the subscriber. */
	readonly reports: number;
}

/** A live subscription. `done` settles once the source has ended or `close()` ran, and every admitted event is handled. */
export interface Subscription {
	readonly id: string;
	readonly done: Promise<SubscriptionStats>;
	stats(): SubscriptionStats;
	/** Stops the source, lets admitted and queued events finish, then resolves with the final stats. */
	close(): Promise<SubscriptionStats>;
}
