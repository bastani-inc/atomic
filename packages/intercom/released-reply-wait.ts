import { markToolCallReadyForDetachment, toolCallNeedsDetachmentHandoff, type ExtensionAPI } from "@bastani/atomic";
import type { JsonValue } from "@bastani/pi-ai";
import type { ReplyWait } from "./reply-waiter.js";
import type { Message } from "./types.js";

/** Child-session entry written before an acknowledged question may detach. */
export const RELEASED_REPLY_WAIT_ENTRY = "intercom_reply_wait";

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

/** Record the question before allowing its wait to outlive the child's live session. */
export async function prepareReleasedReplyWait(
	pi: Pick<ExtensionAPI, "appendEntry">,
	wait: ReplyWait,
	signal: AbortSignal | undefined,
	data: Omit<ReleasedReplyWaitData, "deadline">,
): Promise<void> {
	if (signal === undefined || !toolCallNeedsDetachmentHandoff(signal)) return;
	await pi.appendEntry(RELEASED_REPLY_WAIT_ENTRY, { ...data, deadline: wait.deadline });
	if (!wait.isPending()) return;
	wait.readyForHandoff();
	markToolCallReadyForDetachment(signal);
}
