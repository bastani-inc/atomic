/**
 * The text that was submitted for each queued message, which an `input` hook or a skill or prompt template expansion
 * may have changed. `clearQueue()` gives a cleared message back as submitted, so sending it again runs those steps once
 * (#4284). The records mirror the session's queues: one per queued message, in queue order, also for a message queued
 * as submitted, so a message rewritten to the text of an earlier one never takes that one's record.
 */
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export type QueueLane = "steer" | "followUp";

/** A queued message: the text it was queued as and the text that was submitted. */
export interface TypedQueuedText {
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
): TypedQueuedText {
	const records = typedQueuedTexts.get(session) ?? [];
	const record = { lane, queued, typed: typed ?? queued };
	records.push(record);
	typedQueuedTexts.set(session, records);
	return record;
}

/**
 * The session took the message `record` was kept for out of its queue. Returns how many messages queued before it in
 * its lane have its queued text: its place among them in the session's list of that lane.
 */
export function forgetTypedQueuedRecord(session: AgentSession, record: TypedQueuedText): number {
	const records = typedQueuedTexts.get(session);
	const index = records?.indexOf(record) ?? -1;
	if (!records || index === -1) return 0;
	const rank = records
		.slice(0, index)
		.filter((earlier) => earlier.lane === record.lane && earlier.queued === record.queued).length;
	records.splice(index, 1);
	if (records.length === 0) typedQueuedTexts.delete(session);
	return rank;
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

/** A message the session took out of its queue is queued again, ahead of the others: it keeps its submitted text. */
export function restoreTypedQueuedText(session: AgentSession, record: TypedQueuedText): void {
	const records = typedQueuedTexts.get(session) ?? [];
	records.unshift(record);
	typedQueuedTexts.set(session, records);
}

/** The session's queue was cleared. */
export function forgetAllTypedQueuedTexts(session: AgentSession): void {
	typedQueuedTexts.delete(session);
}
