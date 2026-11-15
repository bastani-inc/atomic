import { randomUUID } from "node:crypto";
import type { AgentWake, AgentWakeDispatcher } from "@bastani/atomic";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import { subagentWakeKey } from "./released-children.js";
import type { SubagentChildRestoreOutcome, SubagentChildResumeRequest } from "./subagent-child-restore.js";

/** A resume carries only data through the wake dispatcher; its admission waiter exists only until it is admitted. */
export interface ReleasedChildResumeWake extends AgentWake {
	readonly resume: SubagentChildResumeRequest;
}

const dispatchers = new Map<string, { readonly dispatcher: AgentWakeDispatcher }>();
const waiters = new Map<string, PromiseWithResolvers<SubagentChildRestoreOutcome>>();
const active = new Set<string>();
/** Pause and quit calls in flight per wake key: while one is, a wake of that child does not relaunch it (#4845). */
const pendingStops = new Map<string, number>();
/**
 * Per active wake: settles once the wake has relaunched the child, its new run's record written, or decided not to.
 * Until then a pause or quit could not tell a child about to run again from a released one.
 */
const relaunches = new Map<string, PromiseWithResolvers<void>>();

export function bindResumeDispatcher(owner: string, dispatcher: AgentWakeDispatcher): () => void {
	const binding = { dispatcher };
	dispatchers.set(owner, binding);
	return () => {
		if (dispatchers.get(owner) === binding) dispatchers.delete(owner);
	};
}

export function resumeWaiterCount(): number {
	return waiters.size;
}
export function isReleasedChildWakeActive(key: string): boolean {
	return active.has(key);
}
export function setReleasedChildWakeActive(key: string, value: boolean): void {
	if (value) active.add(key);
	else active.delete(key);
	settleReleasedChildRelaunch(key);
	if (value) relaunches.set(key, Promise.withResolvers());
	else relaunches.delete(key);
}

/**
 * The active wake of this child has relaunched it, its new run's record written, or will not relaunch it now. A later
 * relaunch in the same wake opens a new window with {@link openReleasedChildRelaunch}.
 */
export function settleReleasedChildRelaunch(key: string): void {
	relaunches.get(key)?.resolve();
}

/** The active wake of this child may relaunch it again, as after its previous woken run settled. */
export function openReleasedChildRelaunch(key: string): void {
	settleReleasedChildRelaunch(key);
	if (active.has(key)) relaunches.set(key, Promise.withResolvers());
}

/** Whether a pause or quit of this child is in flight, so its wake must hold what it carries instead (#4845). */
export function isReleasedChildStopPending(key: string): boolean {
	return pendingStops.has(key);
}

/**
 * Begin a pause or quit of a child that is not running in this process (#4845). Until `end` is called, no wake of the
 * child relaunches it. `decided` settles once its active wake, if any, has relaunched it, its new run's record written,
 * or decided not to: the child's latest record then says whether it runs. Marked in the same turn as the active check,
 * so no wake can start between them unseen.
 */
export function beginReleasedChildStop(key: string): { readonly decided: Promise<void>; end(): void } {
	pendingStops.set(key, (pendingStops.get(key) ?? 0) + 1);
	return {
		decided: relaunches.get(key)?.promise ?? Promise.resolve(),
		end() {
			const left = (pendingStops.get(key) ?? 0) - 1;
			if (left > 0) pendingStops.set(key, left);
			else pendingStops.delete(key);
		},
	};
}
export function resumeReleasedChild(
	owner: string,
	child: string,
	request: SubagentChildResumeRequest,
): Promise<SubagentChildRestoreOutcome> | undefined {
	const dispatcher = dispatchers.get(owner)?.dispatcher;
	if (dispatcher === undefined) return undefined;
	const id = `resume:${randomUUID()}`;
	const waiter = Promise.withResolvers<SubagentChildRestoreOutcome>();
	waiters.set(id, waiter);
	const wake: ReleasedChildResumeWake = { id, kind: "intercom", resume: request };
	void dispatcher.deliver(subagentWakeKey(owner, child), wake).catch((error: Error) => {
		const pending = waiters.get(id);
		if (pending !== undefined) {
			waiters.delete(id);
			const cause = error.cause instanceof Error && isReleasedChildError(error.cause) ? error.cause : undefined;
			pending.reject(
				cause ??
					new ReleasedChildError(
						"wake-failed",
						{ ownerSessionId: owner, childId: child, reason: error.message },
						{ cause: error },
					),
			);
		}
	});
	return waiter.promise;
}

export function settleResumeWake(id: string, outcome: SubagentChildRestoreOutcome): void {
	const waiter = waiters.get(id);
	if (waiter === undefined) return;
	waiters.delete(id);
	waiter.resolve(outcome);
}
