import type net from "node:net";
import { notFoundInReachReason, type IntercomReachPolicy } from "../reach-policy.js";
import { sessionTargetFailureReason } from "../session-target.js";
import type { JsonWireValue } from "./framing.js";
import type { SendClientMessage } from "./send-handler.js";
import { writeMessageIfOpen } from "./socket-writes.js";

/**
 * Atomic 0.10.0 removed workflows. The Intercom protocol range is unchanged, so a 0.9.x session keeps using a broker
 * of this version, and a session of this version keeps using a 0.9.x broker, for everything else.
 *
 * A 0.9.x session still sends the frames its workflow routes used. This broker keeps no workflow route: it answers each
 * frame with one those clients already handle, and never ends the connection over it, which would cost the session its
 * sends and asks too. Route registrations are acknowledged without creating a route: a 0.9.x workflow run waits for its
 * pending-stage route before starting each stage, and fails the stage on a refusal, while a running stage closes its own
 * connection over any refusal of its live route. Its started stages are ordinary sessions. A send to a workflow target
 * is answered as one to a name no session has (see {@link workflowTargetFailure}), so nothing is queued for a stage
 * that has not started.
 */

/** Whether `to` names a workflow stage target, which this version answers as an unknown name, never resolving it. */
export function isWorkflowTarget(to: string): boolean {
	return to.trim().startsWith("workflow:");
}

/**
 * The answer to a send, ask or reply to a workflow stage target (`workflow:<rootRunId>/...`): the `delivery_failed`
 * reason and code this broker gives one to a name no session has. A reply that names the recipient it expects gets
 * `Session not found` alone; otherwise a sender with a reach policy is also told what it reaches, and an answer that
 * requires a pending reply gets `session_not_found`.
 */
export function workflowTargetFailure(request: {
	readonly to: string;
	readonly requirePendingReply: boolean;
	readonly expectedRecipientId?: string;
	readonly reach?: IntercomReachPolicy;
}): { readonly reason: string; readonly reasonCode?: "session_not_found" } {
	const notFound = sessionTargetFailureReason(request.to, { kind: "not_found" });
	if (request.expectedRecipientId !== undefined) return { reason: notFound };
	return {
		reason: request.reach === undefined ? notFound : `${notFound}. ${notFoundInReachReason(request.reach)}`,
		...(request.requirePendingReply ? { reasonCode: "session_not_found" as const } : {}),
	};
}

/** What {@link legacyNotificationSend} reads of a connected session. */
export interface NotificationRecipientCandidate {
	readonly info: { readonly id: string };
	readonly registrationGroup?: string;
	readonly registrationName?: string;
	readonly registrationReturnAddress?: string;
}

/**
 * A 0.9.x run's `send_pending_stage_notification` tells the sender of a message queued for one of its stages that it
 * will not be delivered. Its `message` (with `replyTo` and `replyError`) and `attemptId` go on as an ordinary send
 * from the same connection, under the ordinary group rules, so it is answered as that send is: `delivered` only once
 * it is. The 0.9.x run marks the notice sent only when it is delivered, and otherwise sends it again on its next
 * settlement pass. It goes to the session `to` names. A sender that reconnected under another session id since is
 * found as a 0.9.x broker found it: the one session registered in the run's group (`routeGroup`, the group the run's
 * connection registered in) with the frame's `senderReturnAddress`, or without one, with its `senderRegistrationName`.
 */
export function legacyNotificationSend(
	frame: { readonly [key: string]: JsonWireValue },
	sessions: Iterable<NotificationRecipientCandidate>,
	routeGroup: string | undefined,
): SendClientMessage {
	return {
		type: "send",
		to: notificationRecipient(frame, [...sessions], routeGroup),
		message: frame.message,
		...(Object.prototype.hasOwnProperty.call(frame, "attemptId") ? { attemptId: frame.attemptId } : {}),
	};
}

function notificationRecipient(
	frame: { readonly [key: string]: JsonWireValue },
	sessions: readonly NotificationRecipientCandidate[],
	routeGroup: string | undefined,
): JsonWireValue | undefined {
	const to = frame.to;
	if (typeof to !== "string" || routeGroup === undefined || sessions.some((session) => session.info.id === to)) return to;
	const inRouteGroup = sessions.filter((session) => session.registrationGroup === routeGroup);
	const returnAddress = wireString(frame.senderReturnAddress);
	const registrationName = wireString(frame.senderRegistrationName)?.trim().toLowerCase();
	const matches =
		returnAddress !== undefined
			? inRouteGroup.filter((session) => session.registrationReturnAddress === returnAddress)
			: registrationName
				? inRouteGroup.filter((session) => session.registrationName?.toLowerCase() === registrationName)
				: [];
	return matches.length === 1 ? matches[0]!.info.id : to;
}

function wireString(value: JsonWireValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Answer one legacy workflow frame from a registered 0.9.x session (`send_pending_stage_notification` is relayed
 * instead; see {@link legacyNotificationSend}). Every answer is a frame type the 0.9.x client validates and settles
 * the request with:
 * - `register_pending_stage_route`: acknowledged, from every client. A 0.9.x workflow run awaits this answer before it
 *   creates each stage's session, and fails the stage on `pending_stage_route_refused`; silence would time it out.
 * - `register_live_workflow_stage_route`: acknowledged. A 0.9.x client answers its only refusal, `registration_failed`,
 *   by closing its connection and registering again, over and over; silence would hang its registration.
 * - `withdraw_pending_stage_route`: acknowledged; there is nothing to withdraw.
 * - `claim_workflow_invocation`: `claimed: false`. This broker does not advertise the claim, so 0.9.x never sends it.
 * - `pending_stage_message_result`, `pending_stage_notification_result`: answers to requests this broker never makes;
 *   ignored.
 */
export function answerLegacyWorkflowFrame(socket: net.Socket, frame: { readonly [key: string]: JsonWireValue }): void {
	const requestId = wireString(frame.requestId);
	switch (frame.type) {
		case "register_pending_stage_route":
		case "withdraw_pending_stage_route":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "pending_stage_route_registered", requestId });
			return;
		case "register_live_workflow_stage_route":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "live_workflow_stage_route_registered", requestId });
			return;
		case "claim_workflow_invocation":
			if (requestId !== undefined) writeMessageIfOpen(socket, { type: "workflow_invocation_claimed", requestId, claimed: false });
			return;
		default:
			return;
	}
}
