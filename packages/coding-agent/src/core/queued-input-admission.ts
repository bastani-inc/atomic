import { AsyncLocalStorage } from "node:async_hooks";

export type QueuedInputLane = "steer" | "followUp";

export interface QueuedInputAdmission {
	/**
	 * Resolves once every earlier admission in the same lane has queued, been handled, or failed,
	 * or once the session lifetime ends, so closing or reloading the session never waits on a hook
	 * that is itself waiting on that close. Returns undefined when nothing is pending, so an
	 * uncontended submission queues without yielding.
	 */
	waitForTurn(): Promise<void> | undefined;
	release(): void;
}

interface Reservation {
	readonly released: Promise<void>;
	readonly release: () => void;
}

function createReservation(): Reservation {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { released, release };
}

const lanes = new WeakMap<object, Map<QueuedInputLane, Reservation[]>>();
const insideInputHook = new AsyncLocalStorage<true>();

export const UNORDERED_ADMISSION: QueuedInputAdmission = {
	waitForTurn: () => undefined,
	release: () => undefined,
};

/**
 * Reserve a place in a session's steer or follow-up lane at submission time, so asynchronous
 * input hooks cannot reorder same-lane messages. Input submitted from inside an input hook
 * is not ordered: the hook may await it, and it would otherwise wait for the hook's own message.
 */
export function reserveQueuedInputAdmission(
	session: object,
	lane: QueuedInputLane,
	lifetime: AbortSignal,
): QueuedInputAdmission {
	if (insideInputHook.getStore()) return UNORDERED_ADMISSION;
	const sessionLanes = lanes.get(session) ?? new Map<QueuedInputLane, Reservation[]>();
	lanes.set(session, sessionLanes);
	const reservations = sessionLanes.get(lane) ?? [];
	sessionLanes.set(lane, reservations);
	const reservation = createReservation();
	reservations.push(reservation);
	return {
		waitForTurn() {
			const earlier = reservations.slice(0, reservations.indexOf(reservation));
			if (earlier.length === 0 || lifetime.aborted) return undefined;
			return new Promise<void>((resolve) => {
				const finish = () => {
					lifetime.removeEventListener("abort", finish);
					resolve();
				};
				lifetime.addEventListener("abort", finish, { once: true });
				void Promise.all(earlier.map((entry) => entry.released)).then(finish);
			});
		},
		release() {
			const index = reservations.indexOf(reservation);
			if (index === -1) return;
			reservations.splice(index, 1);
			reservation.release();
		},
	};
}

export function runInputHook<T>(hook: () => Promise<T>): Promise<T> {
	return insideInputHook.run(true, hook);
}
