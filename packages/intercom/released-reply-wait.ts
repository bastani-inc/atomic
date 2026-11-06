import { markToolCallReadyForDetachment, toolCallNeedsDetachmentHandoff, type ExtensionAPI } from "@bastani/atomic";
import type { JsonValue } from "@bastani/pi-ai";
import type { ReplyWait } from "./reply-waiter.ts";
import type { BrokerMultiNodeStatus, Message } from "./types.js";

/** Child-session entry written before an acknowledged question may detach. */
export const RELEASED_REPLY_WAIT_ENTRY = "intercom_reply_wait";

/**
 * Whether a connected session's question wait may outlive it: its broker keeps the question's route for a released
 * asker with local routing, and in the shared state with multi-node routing (#4386). While multi-node routing is
 * starting or unavailable, or with a broker that does not report it, the call stays live.
 */
export function replyWaitMayDetach(connected: boolean, routing: BrokerMultiNodeStatus["status"] | undefined): boolean {
	return connected && (routing === "off" || routing === "on");
}

/** A call made before the session connects is admitted; it detaches only once `replyWaitMayDetach` holds. */
export function replyWaitMayBeAdmitted(
	connected: boolean,
	routing: BrokerMultiNodeStatus["status"] | undefined,
): boolean {
	return !connected || replyWaitMayDetach(connected, routing);
}

/** What the gates read of the session's connection, if it has one. */
export interface ReplyWaitConnection {
	isConnected(): boolean;
	readonly multiNodeRouting: BrokerMultiNodeStatus["status"] | undefined;
}

/** The `ask` and `contact_supervisor` gates for the session's current connection. */
export function replyWaitGates(connection: () => ReplyWaitConnection | null): {
	readonly mayDetachReplyWait: () => boolean;
	readonly mayAdmitReplyWait: () => boolean;
} {
	const read = () => {
		const current = connection();
		return [current?.isConnected() === true, current?.multiNodeRouting] as const;
	};
	return {
		mayDetachReplyWait: () => replyWaitMayDetach(...read()),
		mayAdmitReplyWait: () => replyWaitMayBeAdmitted(...read()),
	};
}

/** Intercom asks the child's owner to save a broker reply before confirming delivery. */
export const RELEASED_CHILD_REPLY_EVENT = "subagent:released-child-reply";
export interface ReleasedChildReplyRequest {
	readonly childName: string;
	readonly replyTo: string;
	readonly message: Message;
	completion?: Promise<boolean>;
}

export interface ReleasedReplyWaitData {
	readonly toolCallId: string;
	readonly questionId: string;
	readonly deadline: number;
	readonly from: string;
	readonly retryCount: number;
}

const HANDOFF_RESULT = Symbol.for("@bastani/intercom/released-reply-handoff");

/** A result that means the child owner's broker route now owns this question, not a tool failure. */
export function releasedReplyHandoffResult() {
	return { content: [], details: { [HANDOFF_RESULT]: true }, isError: false };
}

export function isReleasedReplyHandoffResult(details: JsonValue | undefined): boolean {
	return typeof details === "object" && details !== null && (details as { [HANDOFF_RESULT]?: boolean })[HANDOFF_RESULT] === true;
}

/**
 * Record the question before allowing its wait to outlive the child's live session. A call that was admitted before
 * its connection existed marks itself ready only once local routing is confirmed.
 */
export async function prepareReleasedReplyWait(
	pi: Pick<ExtensionAPI, "appendEntry">,
	wait: ReplyWait,
	signal: AbortSignal | undefined,
	data: Omit<ReleasedReplyWaitData, "deadline">,
	routingConfirmedLocal: () => boolean,
): Promise<void> {
	if (signal === undefined || !toolCallNeedsDetachmentHandoff(signal) || !routingConfirmedLocal()) return;
	await pi.appendEntry(RELEASED_REPLY_WAIT_ENTRY, { ...data, deadline: wait.deadline });
	if (!wait.isPending()) return;
	wait.readyForHandoff();
	markToolCallReadyForDetachment(signal);
}
