/**
 * The text that was submitted for each queued message, which an `input` hook or a skill or prompt template expansion
 * may have changed. `clearQueue()` gives a cleared message back as submitted, so sending it again runs those steps once
 * (#4284). The records mirror the session's queues: one per queued message, in queue order, also for a message queued
 * as submitted, so a message rewritten to the text of an earlier one never takes that one's record.
 */
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export type QueueLane = "steer" | "followUp";

/** A queued message: the text it was queued as and the text that was submitted. */
interface TypedQueuedText {
	lane: QueueLane;
	queued: string;
	typed: string;
}

/** Per session, oldest first: one record per queued steering or follow-up message. */
const typedQueuedTexts = new WeakMap<AgentSession, TypedQueuedText[]>();

export function rememberTypedQueuedText(
	session: AgentSession,
	lane: QueueLane,
	queued: string,
	typed: string | undefined,
): void {
	const records = typedQueuedTexts.get(session) ?? [];
	records.push({ lane, queued, typed: typed ?? queued });
	typedQueuedTexts.set(session, records);
}

/**
 * The session took the oldest message queued as `queued` in `lane` out of its queue, as it always takes the first match.
 * Returns its submitted text.
 */
export function forgetTypedQueuedText(session: AgentSession, lane: QueueLane, queued: string): string {
	const records = typedQueuedTexts.get(session);
	const index = records?.findIndex((record) => record.lane === lane && record.queued === queued) ?? -1;
	if (!records || index === -1) return queued;
	const [record] = records.splice(index, 1);
	if (records.length === 0) typedQueuedTexts.delete(session);
	return record.typed;
}

/** Move the submitted text of `source`'s queued messages ahead of `next`'s, as their queues move. */
export function transferTypedQueuedTexts(source: AgentSession, next: AgentSession): void {
	const moved = typedQueuedTexts.get(source);
	if (!moved) return;
	typedQueuedTexts.delete(source);
	typedQueuedTexts.set(next, [...moved, ...(typedQueuedTexts.get(next) ?? [])]);
}

/** The session's queue was cleared. */
export function forgetAllTypedQueuedTexts(session: AgentSession): void {
	typedQueuedTexts.delete(session);
}
