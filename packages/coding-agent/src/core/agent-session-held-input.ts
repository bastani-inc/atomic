import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

/**
 * User input that reached the session while it compacts (#4251). It is registered when `prompt()` is entered, so
 * held input keeps its arrival order across every sender. It shows in the session's queue view while it waits,
 * and `clearQueue()` cancels it and returns its text.
 */
export interface HeldInput {
	readonly text: string;
	readonly lane: "steer" | "followUp";
	/** Shown in the queue view and cancellable until the input stops waiting. */
	waiting: boolean;
	/** Set by `clearQueue()`: the text went back to the caller and must not be sent. */
	cancelled: boolean;
	/** Settles once the input has started its turn, queued, been handled, or failed. */
	readonly admitted: PromiseWithResolvers<void>;
	readonly cancellation: PromiseWithResolvers<void>;
}

const heldInputs = new WeakMap<object, HeldInput[]>();

function emitQueueUpdate(session: AgentSession): void {
	// Guarded because prompt-handshake suites drive prompts on a synthetic session.
	if (typeof session._emitQueueUpdate === "function") session._emitQueueUpdate();
}

export function hasHeldInput(session: AgentSession): boolean {
	return (heldInputs.get(session)?.length ?? 0) > 0;
}

export function registerHeldInput(session: AgentSession, text: string, lane: "steer" | "followUp"): HeldInput {
	const entry: HeldInput = {
		text,
		lane,
		waiting: true,
		cancelled: false,
		admitted: Promise.withResolvers<void>(),
		cancellation: Promise.withResolvers<void>(),
	};
	const entries = heldInputs.get(session) ?? [];
	entries.push(entry);
	heldInputs.set(session, entries);
	emitQueueUpdate(session);
	return entry;
}

export function earlierHeldInputs(session: AgentSession, entry: HeldInput): HeldInput[] {
	const entries = heldInputs.get(session) ?? [];
	const index = entries.indexOf(entry);
	return index <= 0 ? [] : entries.slice(0, index);
}

/** The input leaves the queue view; later held input still waits until it is admitted. */
export function stopWaiting(session: AgentSession, entry: HeldInput): void {
	if (!entry.waiting) return;
	entry.waiting = false;
	emitQueueUpdate(session);
}

export function finishHeldInput(session: AgentSession, entry: HeldInput): void {
	const wasWaiting = entry.waiting;
	entry.waiting = false;
	entry.admitted.resolve();
	const entries = heldInputs.get(session);
	const index = entries?.indexOf(entry) ?? -1;
	if (entries && index !== -1) entries.splice(index, 1);
	if (entries?.length === 0) heldInputs.delete(session);
	if (wasWaiting) emitQueueUpdate(session);
}

export function heldInputView(session: AgentSession): { steering: string[]; followUp: string[] } {
	const steering: string[] = [];
	const followUp: string[] = [];
	for (const entry of heldInputs.get(session) ?? []) {
		if (!entry.waiting) continue;
		(entry.lane === "followUp" ? followUp : steering).push(entry.text);
	}
	return { steering, followUp };
}

/** Cancel every waiting held input and return its text; the caller publishes the queue update. */
export function cancelHeldInput(session: AgentSession): { steering: string[]; followUp: string[] } {
	const cancelled = heldInputView(session);
	for (const entry of heldInputs.get(session) ?? []) {
		if (!entry.waiting) continue;
		entry.waiting = false;
		entry.cancelled = true;
		entry.cancellation.resolve();
	}
	return cancelled;
}
