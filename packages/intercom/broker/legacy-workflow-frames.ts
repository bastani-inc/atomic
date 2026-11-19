import type net from "node:net";
import type { JsonWireValue } from "./framing.js";
import { isProtocol1Client, writeMessageIfOpen } from "./socket-writes.js";

/**
 * Atomic 0.10.0 removed workflows. The Intercom protocol range is unchanged, so a 0.9.x session keeps using a broker
 * of this version, and a session of this version keeps using a 0.9.x broker, for everything else.
 *
 * A 0.9.x session still sends the frames its workflow routes used. This broker keeps no workflow route: it answers each
 * frame with one those clients already handle, and never ends the connection over it, which would cost the session its
 * sends and asks too. Most get a refusal. Two frames have no refusal a 0.9.x client handles in place: each refusal it
 * knows makes it close its own connection. Those are acknowledged without creating a route, and a send to the
 * workflow target they named is refused at its sender (see {@link WORKFLOW_TARGET_REMOVED_REASON}).
 */

/** Why this broker refuses a 0.9.x session's workflow route or workflow notification. */
export const WORKFLOW_ROUTE_REMOVED_REASON =
	"This Intercom broker runs Atomic 0.10.0 or later, which removed workflows: it routes no workflow stages";

/** Why a send to a `workflow:` target is refused, by a broker or client of this version. */
export const WORKFLOW_TARGET_REMOVED_REASON =
	"Workflow stage targets (workflow:<rootRunId>/...) were removed in Atomic 0.10.0; send to a session by name or id";

/** Whether `to` names a workflow stage target, which this version refuses rather than resolving it as a session name. */
export function isWorkflowTarget(to: string): boolean {
	return to.trim().startsWith("workflow:");
}

function wireString(value: JsonWireValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Answer one legacy workflow frame from a registered 0.9.x session. Every answer is a frame type and code the 0.9.x
 * client validates and settles the request with:
 * - `register_pending_stage_route`: `pending_stage_route_refused` (from 0.9.44). A client that registered without a
 *   protocol range and did not ask for an in-place refusal may predate that frame, so it is acknowledged instead.
 * - `register_live_workflow_stage_route`: acknowledged. A 0.9.x client answers its only refusal, `registration_failed`,
 *   by closing its connection and registering again, over and over; silence would hang its registration.
 * - `withdraw_pending_stage_route`: acknowledged; there is nothing to withdraw.
 * - `claim_workflow_invocation`: `claimed: false`. This broker does not advertise the claim, so 0.9.x never sends it.
 * - `send_pending_stage_notification`: `delivery_failed`.
 * - `pending_stage_message_result`, `pending_stage_notification_result`: answers to requests this broker never makes;
 *   ignored.
 */
export function answerLegacyWorkflowFrame(socket: net.Socket, frame: { readonly [key: string]: JsonWireValue }): void {
	const requestId = wireString(frame.requestId);
	switch (frame.type) {
		case "register_pending_stage_route": {
			if (requestId === undefined) return;
			if (frame.refusalKeepsConnection !== true && isProtocol1Client(socket)) {
				writeMessageIfOpen(socket, { type: "pending_stage_route_registered", requestId });
				return;
			}
			writeMessageIfOpen(socket, {
				type: "pending_stage_route_refused",
				requestId,
				runId: wireString(frame.runId) ?? "",
				code: "not_authorized",
				reason: WORKFLOW_ROUTE_REMOVED_REASON,
			});
			return;
		}
		case "withdraw_pending_stage_route":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "pending_stage_route_registered", requestId });
			return;
		case "register_live_workflow_stage_route":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "live_workflow_stage_route_registered", requestId });
			return;
		case "claim_workflow_invocation":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "workflow_invocation_claimed", requestId, claimed: false });
			return;
		case "send_pending_stage_notification": {
			const message = frame.message;
			const messageId =
				typeof message === "object" && message !== null && !Array.isArray(message) ? wireString(message.id) : undefined;
			const attemptId = wireString(frame.attemptId);
			writeMessageIfOpen(socket, {
				type: "delivery_failed",
				messageId: messageId ?? "unknown",
				...(attemptId === undefined ? {} : { attemptId }),
				reason: WORKFLOW_ROUTE_REMOVED_REASON,
			});
			return;
		}
		default:
			return;
	}
}
