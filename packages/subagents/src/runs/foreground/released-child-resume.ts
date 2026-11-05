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
