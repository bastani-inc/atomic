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
/** Per active wake: settles with the task its relaunch started, or undefined once it decided not to relaunch. */
const relaunches = new Map<string, PromiseWithResolvers<string | undefined>>();

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
	if (value) {
		active.add(key);
		openReleasedChildRelaunch(key);
	} else {
		active.delete(key);
		relaunches.get(key)?.resolve(undefined);
		relaunches.delete(key);
	}
}

/** A wake of this child may relaunch it again, as after its previous woken run settled. */
export function openReleasedChildRelaunch(key: string): void {
	relaunches.get(key)?.resolve(undefined);
	relaunches.set(key, Promise.withResolvers());
}

/** The active wake of this child relaunched it as `taskId`, or decided not to relaunch it (undefined). */
export function settleReleasedChildRelaunch(key: string, taskId: string | undefined): void {
	relaunches.get(key)?.resolve(taskId);
}

/** Whether a pause or quit of this child is in flight, so its wake must hold what it carries instead (#4845). */
export function isReleasedChildStopPending(key: string): boolean {
	return (pendingStops.get(key) ?? 0) > 0;
}

/**
 * Begin a pause or quit of a child that is not running in this process (#4845). From now until `end` is called, no wake
 * of the child relaunches it. When its wake is active, waits until that wake decided: the task it relaunched, which the
 * caller stops as a running child, or undefined when it relaunched nothing. Marked in the same turn as the active check,
 * so no wake can start between them unseen.
 */
export function beginReleasedChildStop(key: string): { readonly relaunched: Promise<string | undefined>; end(): void } {
	pendingStops.set(key, (pendingStops.get(key) ?? 0) + 1);
	let ended = false;
	return {
		relaunched: active.has(key)
			? (relaunches.get(key)?.promise ?? Promise.resolve(undefined))
			: Promise.resolve(undefined),
		end() {
			if (ended) return;
			ended = true;
			const left = (pendingStops.get(key) ?? 1) - 1;
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
