import { AsyncLocalStorage } from "node:async_hooks";

export type QueuedInputLane = "steer" | "followUp";

export interface QueuedInputAdmission {
	/** Resolves once every earlier admission in the same lane has queued, been handled, or failed. */
	readonly turn: Promise<void>;
	release(): void;
}

const laneTails = new WeakMap<object, Map<QueuedInputLane, Promise<void>>>();
const insideInputHook = new AsyncLocalStorage<true>();

export const UNORDERED_ADMISSION: QueuedInputAdmission = { turn: Promise.resolve(), release: () => undefined };

/**
 * Reserve a place in a session's steer or follow-up lane at submission time, so asynchronous
 * input hooks cannot reorder same-lane messages. Input submitted from inside an input hook
 * is not ordered: the hook may await it, and it would otherwise wait for the hook's own message.
 */
export function reserveQueuedInputAdmission(session: object, lane: QueuedInputLane): QueuedInputAdmission {
	if (insideInputHook.getStore()) return UNORDERED_ADMISSION;
	const tails = laneTails.get(session) ?? new Map<QueuedInputLane, Promise<void>>();
	laneTails.set(session, tails);
	const turn = tails.get(lane) ?? Promise.resolve();
	const released = Promise.withResolvers<void>();
	const tail = turn.then(() => released.promise);
	tails.set(lane, tail);
	void tail.then(() => {
		if (tails.get(lane) === tail) tails.delete(lane);
	});
	return { turn, release: () => released.resolve() };
}

export function runInputHook<T>(hook: () => Promise<T>): Promise<T> {
	return insideInputHook.run(true, hook);
}
