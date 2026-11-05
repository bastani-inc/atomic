import type { JsonValue } from "@bastani/pi-ai";

export type {
	ReleasedReplyFormatRequest,
	ReleasedReplyPayload,
} from "../../../../intercom/released-reply-format.js";
export type { ReleasedChildReplyRequest, ReleasedReplyWaitData } from "../../../../intercom/released-reply-wait.js";

/** Child-session entry Intercom writes before a question may detach; it names the question its reply answers. */
export const RELEASED_REPLY_WAIT_ENTRY = "intercom_reply_wait";

/** Intercom → Subagents: save a released asker's reply in its record before the broker is told it was delivered. */
export const RELEASED_CHILD_REPLY_EVENT = "subagent:released-child-reply";

/** Subagents → Intercom: format a saved reply or a deadline as the result its inline call returns. */
export const RELEASED_REPLY_FORMAT_EVENT = "intercom:format-released-reply";

const HANDOFF_RESULT = Symbol.for("@bastani/intercom/released-reply-handoff");

/** The result Intercom settles a handed-off question's call with: not a result of the call, so it is never forwarded. */
export function isReleasedReplyHandoffResult(details: JsonValue | undefined): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { [HANDOFF_RESULT]?: boolean })[HANDOFF_RESULT] === true
	);
}
