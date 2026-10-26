import { TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import {
	legacyWorkflowStageTargetMigrationHint,
	parseLegacyWorkflowStageTarget,
	parseWorkflowStageTarget,
} from "../workflow-stage-target.js";
import { normalizeGroup, workflowInvocationGroupRefusal } from "../group.js";
import { isMessage } from "./client-message-validation.js";
import {
	resolveSessionTarget,
	resolveSessionTargetByHostSessionId,
	sessionTargetFailureReason,
} from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { type ReceiptSender, type RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { isVerticalBypass, sameGroup } from "./group-isolation.js";
import { sessionGroups, sessionsShareGroup } from "./group-membership.js";
import { PendingQuestionIndex } from "./pending-question-index.js";
import { isAgentRecipient, NON_AGENT_RECIPIENT_REFUSAL } from "../recipient-purpose.js";

export interface BrokerConnectedSession {
  socket: net.Socket;
  info: SessionInfo;
  /**
   * Immutable route authority from the host-admitted registration context.
   * Model-accessible presence changes only `info.group`; they never rewrite this field.
   * The local broker trusts initial registration metadata, matching all existing session fields.
   */
  readonly registrationGroup?: string;
	/** Immutable registration-time name; mutable presence names never rewrite this reconnect alias. */
	readonly registrationName?: string;
	/** Opaque host-owned return identity; immutable after initial registration. */
	readonly registrationReturnAddress?: string;
  /** Broker-bound supervisor relationship established by a capability. */
  supervisorId?: string;
  /** Private issuer identity used to restore child capabilities after reconnects. */
  supervisorOwnerToken?: string;
  /** #3761: the recipient confirms each message once it has saved it; `delivered` waits for that confirmation. */
  readonly acknowledgesReceipt?: true;
}

/** Immutable registration authority plus normalized memberships used when an accepted ask is rebound. */
export function senderGroupIdentity(session: BrokerConnectedSession): string {
	return JSON.stringify([
		normalizeGroup(session.registrationGroup),
		[...sessionGroups(session.info)].sort((left, right) => left.localeCompare(right)),
	]);
}


/** Stable recipient authority used independently from the freshly resolved transport ID. */
export function deliveryTargetIdentity(session: BrokerConnectedSession): string {
	return session.registrationReturnAddress === undefined
		? JSON.stringify(["session", session.info.id])
		: JSON.stringify(["return", session.registrationReturnAddress, normalizeGroup(session.registrationGroup)]);
}
export interface PendingStageRoute {
  readonly socket: net.Socket;
  readonly from: BrokerConnectedSession;
	readonly target: string;
  readonly message: Message;
  readonly attemptId?: string;
	readonly liveTargetId?: string;
	readonly signature?: string;
	readonly resolveReplyTarget?: true;
}

export type PendingStageRouter = (route: PendingStageRoute) => boolean;
export type ConfirmedMessageWriter = (
	target: net.Socket,
	message: BrokerMessage,
	onSettled: (written: boolean) => void,
) => void;

export type LiveWorkflowStageResolver = (target: string) => BrokerConnectedSession | undefined;
export type LiveWorkflowStageController = (
	sender: BrokerConnectedSession,
	target: BrokerConnectedSession,
	logicalTarget: string,
) => boolean;

export type LegacyWorkflowStageTargetResolver = (runId: string, stageKey: string) => string | undefined;
export const PENDING_STAGE_ASK_REFUSAL =
  "Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.";

/**
 * #3760: offered every send or ask that found no live recipient, before it fails with `Session not found`.
 * Returns true when it answered or held the send (a subagent that its owner is restoring).
 */
export type RestoringRecipientHold = (send: {
  readonly socket: net.Socket;
  readonly from: BrokerConnectedSession;
  readonly clientMessage: SendClientMessage & { readonly to: string };
  readonly target: string;
  readonly messageId: string;
  readonly attemptId?: string;
}) => boolean;

export interface SendClientMessage extends Record<string, unknown> {
  type: string;
}

/**
 * Multi-node S5: a validated send whose target no local session, local hold or workflow route resolved. The
 * router answers it through the shared state (another broker's recipient, a shared hold or an offline session),
 * or calls `notFound`, which answers exactly as a single-node broker would.
 */
export interface RemoteSendRequest {
  readonly socket: net.Socket;
  readonly from: BrokerConnectedSession;
  readonly clientMessage: SendClientMessage & { readonly to: string };
  readonly message: Message;
  /** The trimmed `to`. */
  readonly target: string;
  /** The canonical send whose unkeyed SHA-256 is the cross-node digest. */
  readonly signature: string;
  readonly attemptId?: string;
  readonly supervisorSend: boolean;
  readonly requirePendingReply: boolean;
  readonly expectedRecipientId?: string;
  readonly resolveReplyTarget: boolean;
  readonly awaitRestoringRecipient: boolean;
  /**
   * Set when the target resolved to a session on this broker: the router answers a same-id retry of a send that
   * already went through the shared outbox from that row, and calls `notFound` to deliver anything else locally.
   */
  readonly localTarget?: BrokerConnectedSession;
  /** Without `localTarget`, nothing on any node: answer exactly as a single-node broker does. */
  readonly notFound: () => void;
}

/** Local sends the multi-node router has already checked against the shared outbox. */
const checkedAgainstSharedOutbox = new WeakSet<SendClientMessage>();

export type RemoteSendRouter = (request: RemoteSendRequest) => void;
function wireMessageId(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : "unknown";
}


/** Validate and route one wire-level send request. */
export function handleBrokerSend(
	socket: net.Socket,
	clientMessage: SendClientMessage,
	currentId: string | null,
	sessions: Map<string, BrokerConnectedSession>,
	deliveredMessages: DeliveredMessageCache,
	/**
	 * Hand one frame to a socket. Returns whether the frame was actually written.
	 * Durable acceptance is reserved before this call to close the restart window;
	 * a `false` answer removes that exact reservation, while only `true` is
	 * acknowledged to the sender.
	 */
	write: (target: net.Socket, message: BrokerMessage) => boolean,
	supervisorCache: SupervisorChannelCache = new SupervisorChannelCache(),
	pendingQuestions: PendingQuestionIndex = new PendingQuestionIndex(),
	routePendingStage?: PendingStageRouter,
	resolveLiveWorkflowStage?: LiveWorkflowStageResolver,
	canControlLiveWorkflowStage?: LiveWorkflowStageController,
	resolveLegacyWorkflowStageTarget?: LegacyWorkflowStageTargetResolver,
	writeConfirmed?: ConfirmedMessageWriter,
	isNonAgentWorkflowTarget?: (target: string) => boolean,
	holdForRestoringRecipient?: RestoringRecipientHold,
	receipts?: RecipientReceipts<BrokerConnectedSession>,
	routeRemote?: RemoteSendRouter,
): void {
  const message = clientMessage.message;
  const messageId = wireMessageId(message);
  const hasAttemptId = Object.prototype.hasOwnProperty.call(clientMessage, "attemptId");
  if (hasAttemptId && typeof clientMessage.attemptId !== "string") {
    write(socket, {
      type: "delivery_failed",
      messageId,
      reason: "Invalid attemptId format",
    });
    return;
  }
  const attemptId = typeof clientMessage.attemptId === "string" ? clientMessage.attemptId : undefined;
  const hasLogicalTarget = Object.prototype.hasOwnProperty.call(clientMessage, "logicalTarget");
  if (hasLogicalTarget && typeof clientMessage.logicalTarget !== "string") {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid logicalTarget format" });
    return;
  }
  if (typeof clientMessage.to !== "string" || !isMessage(message)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid message format" });
    return;
  }
  const hasRequirePendingReply = Object.prototype.hasOwnProperty.call(clientMessage, "requirePendingReply");
  if (hasRequirePendingReply && clientMessage.requirePendingReply !== true) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid requirePendingReply format" });
    return;
  }
  const requirePendingReply = clientMessage.requirePendingReply === true;
  const hasExpectedRecipientId = Object.prototype.hasOwnProperty.call(clientMessage, "expectedRecipientId");
  if (hasExpectedRecipientId && (typeof clientMessage.expectedRecipientId !== "string" || !clientMessage.expectedRecipientId.trim())) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid expectedRecipientId format" });
    return;
  }
  const expectedRecipientId = hasExpectedRecipientId ? clientMessage.expectedRecipientId as string : undefined;
  if (Object.prototype.hasOwnProperty.call(clientMessage, "channel")) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Invalid channel" });
    return;
  }
  const supervisorSend = clientMessage.type === "supervisor_send";
  if (requirePendingReply && (supervisorSend || message.replyTo === undefined || message.expectsReply === true)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid requirePendingReply message" });
    return;
  }
  if (expectedRecipientId !== undefined && (supervisorSend || message.replyTo === undefined || message.expectsReply === true)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid expectedRecipientId message" });
    return;
  }


  const fromSession = currentId ? sessions.get(currentId) : undefined;
  if (!fromSession) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Sender session not found" });
    return;
  }
	const senderIdentity = fromSession.registrationReturnAddress ?? fromSession.info.id;
	const logicalTarget = typeof clientMessage.logicalTarget === "string" ? clientMessage.logicalTarget : clientMessage.to;
	const messageSignature = buildMessageSendSignature(logicalTarget, message, senderIdentity);
	const baseSignature = expectedRecipientId === undefined ? messageSignature : JSON.stringify({ expectedRecipientId, messageSignature });
	const signature = requirePendingReply
		? JSON.stringify({
				requirePendingReply: true,
				senderGroupIdentity: senderGroupIdentity(fromSession),
				baseSignature,
			})
		: baseSignature;
  const trimmedTo = clientMessage.to.trim();
  if (supervisorSend && !fromSession.supervisorId) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Supervisor channel is not authorized" });
    return;
  }
  if (supervisorSend && trimmedTo !== fromSession.supervisorId) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Supervisor target does not match the authorized relationship" });
    return;
  }
	const workflowTarget = parseWorkflowStageTarget(trimmedTo);
	if (isNonAgentWorkflowTarget?.(trimmedTo)) {
		write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: NON_AGENT_RECIPIENT_REFUSAL });
		return;
	}
	// Slice 3 (D3): asks to pattern/future stage targets stay refused; `send` is queued
	// sticky by the workflow host, so the refusal must happen before any live delivery.
	if (workflowTarget !== undefined && workflowTarget.kind !== "path" && message.expectsReply === true) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			...(attemptId ? { attemptId } : {}),
			reason: PENDING_STAGE_ASK_REFUSAL,
		});
		return;
	}
	const legacyTarget = parseLegacyWorkflowStageTarget(trimmedTo);
	if (legacyTarget !== undefined) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			...(attemptId ? { attemptId } : {}),
			reason: legacyWorkflowStageTargetMigrationHint(
				resolveLegacyWorkflowStageTarget?.(legacyTarget.runId, legacyTarget.stageKey),
			),
		});
		return;
	}


  // Exact-id targeting always resolves against the full pool so a cross-group id
  // is caught by the defense-in-depth group check below. Only a broker-authorized
  // supervisor frame or an exact recorded reply may resolve across groups.
	const liveWorkflowTarget = sessions.has(trimmedTo) ? undefined : resolveLiveWorkflowStage?.(trimmedTo);
	const exactIdTarget = sessions.get(trimmedTo) ?? liveWorkflowTarget;
  const visibleCandidates = Array.from(sessions.values(), (session) => session.info).filter(
	(info) => sessionsShareGroup(info, fromSession.info) ||
      (supervisorSend && info.id === fromSession.supervisorId) ||
      (message.replyTo !== undefined && (
        pendingQuestions.matchesReply(fromSession.info.id, info.id, message.replyTo) ||
        isVerticalBypass({ replyTo: message.replyTo, sender: fromSession.info, target: info, supervisorCache })
      )),
  );
  const candidates = visibleCandidates.filter(isAgentRecipient);
  // Preserve explicit named-reply collision rejection without exposing hidden identities (#2603).
  const originalSelector = logicalTarget.trim();
  const hiddenReplyCollision = (selector: string) =>
    Array.from(sessions.values()).some(
      ({ info }) =>
        isAgentRecipient(info) &&
        (info.id === selector || info.name?.toLowerCase() === selector.toLowerCase()) &&
        !candidates.some((candidate) => candidate.id === info.id),
    );
  if (
    expectedRecipientId !== undefined &&
    ((!exactIdTarget && hiddenReplyCollision(trimmedTo)) ||
      (originalSelector !== trimmedTo && hiddenReplyCollision(originalSelector)))
  ) {
    write(socket, { type: "delivery_failed", messageId, attemptId,
      reason: "Reply target cannot be resolved safely; use the exact sender ID",
    });
    return;
  }
  // Canonicalized UUID prefixes must still mean the same identity against the
  // current authorized catalog; a newly visible UUID, exact name, or custom ID
  // must not inherit the previously unique transport ID (#2603). Name-fallback
  // retries keep `to` as a display name, so they are not prefix canonicalization.
  // Unauthorized exact transport targets stay out of prefix diagnostics so a
  // formerly visible UUID cannot disclose a hidden peer's current name.
  if (
    originalSelector !== trimmedTo &&
    exactIdTarget !== undefined &&
    candidates.some((candidate) => candidate.id === exactIdTarget.info.id)
  ) {
    const originalResolution = resolveSessionTarget(candidates, originalSelector);
    if (
      originalResolution.kind !== "resolved" ||
      originalResolution.session.id !== exactIdTarget.info.id ||
      (expectedRecipientId !== undefined && originalResolution.session.id !== expectedRecipientId)
    ) {
      let reason: string;
      if (originalResolution.kind !== "resolved") {
        reason = sessionTargetFailureReason(originalSelector, originalResolution);
      } else if (expectedRecipientId !== undefined) {
        reason = "Reply target does not match the expected recipient";
      } else {
        reason = "Reply target cannot be resolved safely; use the exact sender ID";
      }
      write(socket, {
        type: "delivery_failed",
        messageId,
        attemptId,
        reason,
      });
      return;
    }
  }
  const nameOrIdResolution = exactIdTarget
    ? ({ kind: "resolved", session: exactIdTarget.info } as const)
    : resolveSessionTarget(candidates, trimmedTo);
  // #3760: a host session id (a resumed session's or a restored subagent's own session id) reaches the one
  // visible session it registered, under the same group visibility as names.
  const resolution = nameOrIdResolution.kind === "not_found"
    ? resolveSessionTargetByHostSessionId(
        candidates,
        trimmedTo,
        (info) => sessions.get(info.id)?.registrationReturnAddress,
      )
    : nameOrIdResolution;
  if (
    routeRemote !== undefined &&
    resolution.kind === "not_found" &&
    workflowTarget === undefined &&
    !visibleCandidates.some((info) => !isAgentRecipient(info) && info.name?.toLowerCase() === trimmedTo.toLowerCase())
  ) {
    const send = clientMessage as SendClientMessage & { readonly to: string };
    if (
      !supervisorSend &&
      !requirePendingReply &&
      expectedRecipientId === undefined &&
      holdForRestoringRecipient?.({
        socket,
        from: fromSession,
        clientMessage: send,
        target: trimmedTo,
        messageId: message.id,
        ...(attemptId ? { attemptId } : {}),
      })
    ) {
      return;
    }
    routeRemote({
      socket,
      from: fromSession,
      clientMessage: send,
      message,
      target: trimmedTo,
      signature,
      ...(attemptId === undefined ? {} : { attemptId }),
      supervisorSend,
      requirePendingReply,
      ...(expectedRecipientId === undefined ? {} : { expectedRecipientId }),
      resolveReplyTarget: clientMessage.resolveReplyTarget === true,
      awaitRestoringRecipient: clientMessage.awaitRestoringRecipient === true,
      // Nothing on any node: answer exactly as a single-node broker does.
      notFound: () =>
        handleBrokerSend(
          socket,
          clientMessage,
          currentId,
          sessions,
          deliveredMessages,
          write,
          supervisorCache,
          pendingQuestions,
          routePendingStage,
          resolveLiveWorkflowStage,
          canControlLiveWorkflowStage,
          resolveLegacyWorkflowStageTarget,
          writeConfirmed,
          isNonAgentWorkflowTarget,
          holdForRestoringRecipient,
          receipts,
        ),
    });
    return;
  }
  if (expectedRecipientId !== undefined && (resolution.kind !== "resolved" || resolution.session.id !== expectedRecipientId)) {
    write(socket, { type: "delivery_failed", messageId, attemptId,
      reason: resolution.kind === "resolved" ? "Reply target does not match the expected recipient" : sessionTargetFailureReason(clientMessage.to, resolution),
    });
    return;
  }
  if (resolution.kind === "resolved") {
    const target = sessions.get(resolution.session.id);
    if (!target) {
      write(socket, {
        type: "delivery_failed",
        messageId: message.id,
        attemptId,
        reason: "Session not found",
        ...(requirePendingReply ? { reasonCode: "session_not_found" as const } : {}),
      });
      return;
    }
	if (!isAgentRecipient(target.info)) {
		write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: NON_AGENT_RECIPIENT_REFUSAL });
		return;
	}
    if (target.info.id === fromSession.info.id) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Cannot message the current session" });
      return;
    }
	if (routeRemote !== undefined && !checkedAgainstSharedOutbox.delete(clientMessage)) {
		// Multi-node: a retry whose first attempt reached this recipient through another broker is answered from the
		// shared outbox row; `DeliveredMessageCache` never saw that delivery.
		routeRemote({
			socket,
			from: fromSession,
			clientMessage: clientMessage as SendClientMessage & { readonly to: string },
			message,
			target: trimmedTo,
			signature,
			...(attemptId === undefined ? {} : { attemptId }),
			supervisorSend,
			requirePendingReply,
			...(expectedRecipientId === undefined ? {} : { expectedRecipientId }),
			resolveReplyTarget: clientMessage.resolveReplyTarget === true,
			awaitRestoringRecipient: clientMessage.awaitRestoringRecipient === true,
			localTarget: target,
			notFound: () => {
				checkedAgainstSharedOutbox.add(clientMessage);
				handleBrokerSend(
					socket,
					clientMessage,
					currentId,
					sessions,
					deliveredMessages,
					write,
					supervisorCache,
					pendingQuestions,
					routePendingStage,
					resolveLiveWorkflowStage,
					canControlLiveWorkflowStage,
					resolveLegacyWorkflowStageTarget,
					writeConfirmed,
					isNonAgentWorkflowTarget,
					holdForRestoringRecipient,
					receipts,
					routeRemote,
				);
			},
		});
		return;
	}
	const targetIdentity = deliveryTargetIdentity(target);
	const deliveredMatch = deliveredMessages.lookupForTarget(message.id, signature, targetIdentity);
	// #3761: a recipient that confirms saves ignores a copy it already saved, so a reserved message is sent again.
	const confirmsSaves = target.acknowledgesReceipt === true && receipts !== undefined;
	if (requirePendingReply && deliveredMatch === "match") {
		write(socket, { type: "delivered", messageId: message.id, attemptId });
		return;
	}
	if (requirePendingReply && deliveredMatch === "conflict") {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: `Intercom message ID '${message.id}' was already delivered with a different target or payload`,
			reasonCode: "message_id_conflict",
		});
		return;
	}
	if (requirePendingReply && deliveredMatch === "invalid") {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
		});
		return;
	}
	if (requirePendingReply && deliveredMatch === "uncertain" && !confirmsSaves) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery",
		});
		return;
	}
	const correlatedReply =
		message.replyTo !== undefined &&
		pendingQuestions.matchesReply(fromSession.info.id, target.info.id, message.replyTo);
	if (requirePendingReply && !correlatedReply) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Pending question route does not authorize this public reply",
		});
		return;
	}
	const bypass =
		supervisorSend ||
		isVerticalBypass({
			replyTo: message.replyTo,
			sender: fromSession.info,
			target: target.info,
			supervisorCache,
		}) ||
		correlatedReply ||
		(liveWorkflowTarget !== undefined && canControlLiveWorkflowStage?.(fromSession, target, trimmedTo) === true);
	if (!bypass && !sameGroup(target.info, fromSession.info)) {
      write(socket, {
        type: "delivery_failed",
        messageId: message.id,
        attemptId,
        // #4006: a live workflow stage is reached through its invocation; name the group to join.
        reason: liveWorkflowTarget !== undefined && workflowTarget !== undefined
          ? workflowInvocationGroupRefusal(`workflow:${workflowTarget.rootRunId}`)
          : "Target session is in a different intercom group",
      });
      return;
    }
  if (message.expectsReply === true && target.info.replyCapability === "terminal") {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: TERMINAL_CHILD_ASK_REFUSAL });
    return;
  }
	if (deliveredMatch === "match") {
		if (message.expectsReply === true) {
			const acceptedQuestionTarget = deliveredMessages.lookupQuestionTarget(
				message.id,
				signature,
				senderGroupIdentity(fromSession),
			);
			if (acceptedQuestionTarget === undefined) {
				write(socket, {
					type: "delivery_failed",
					messageId: message.id,
					attemptId,
					reason: "Accepted Intercom question route could not be securely rebound",
				});
				return;
			}
			if (!deliveredMessages.isQuestionAnswered(message.id))
				pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
			if (clientMessage.resolveReplyTarget === true && attemptId !== undefined)
				write(socket, { type: "question_target", messageId: message.id, attemptId, sessionId: target.info.id });
		}
		write(socket, { type: "delivered", messageId: message.id, attemptId });
		return;
	}
	if (deliveredMatch === "conflict") {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: `Intercom message ID '${message.id}' was already delivered with a different target or payload`,
			reasonCode: "message_id_conflict",
		});
		return;
	}
	if (deliveredMatch === "invalid") {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
		});
		return;
	}
	if (deliveredMatch === "uncertain" && !confirmsSaves) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery",
		});
		return;
	}
		if (
			liveWorkflowTarget !== undefined &&
			workflowTarget !== undefined &&
			routePendingStage?.({
				socket,
				from: fromSession,
				target: trimmedTo,
				message,
				...(attemptId ? { attemptId } : {}),
				liveTargetId: target.info.id,
				signature,
				...(clientMessage.resolveReplyTarget === true ? { resolveReplyTarget: true } : {}),
			})
		) {
			return;
		}
    const outbound = supervisorSend
      ? ({ type: "message", from: fromSession.info, message, channel: "supervisor" } as const)
      : ({ type: "message", from: fromSession.info, message } as const);
    const failDelivery = (): void => {
	  if (reservation === "recorded") deliveredMessages.forget(message.id, signature);
      write(socket, {
        type: "delivery_failed",
        messageId: message.id,
        attemptId,
        reason: "Session not found",
        ...(requirePendingReply ? { reasonCode: "session_not_found" as const } : {}),
      });
    };
	const reservation = message.expectsReply === true
		? deliveredMessages.reserveQuestion(
			message.id,
			signature,
			{
				targetSessionId: target.info.id,
				senderGroupIdentity: senderGroupIdentity(fromSession),
			},
			Date.now(),
			targetIdentity,
		)
		: deliveredMessages.reserve(message.id, signature, Date.now(), targetIdentity);
	if (reservation === "match") {
		if (
			message.expectsReply === true &&
			deliveredMessages.lookupQuestionTarget(
				message.id,
				signature,
				senderGroupIdentity(fromSession),
			) === undefined
		) {
			write(socket, {
				type: "delivery_failed",
				messageId: message.id,
				attemptId,
				reason: "Accepted Intercom question route could not be securely rebound",
			});
			return;
		}
		if (message.expectsReply === true && !deliveredMessages.isQuestionAnswered(message.id))
			pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
		if (message.expectsReply === true && clientMessage.resolveReplyTarget === true && attemptId !== undefined)
			write(socket, { type: "question_target", messageId: message.id, attemptId, sessionId: target.info.id });
		write(socket, { type: "delivered", messageId: message.id, attemptId });
		return;
	}
	if (reservation !== "recorded" && !(reservation === "uncertain" && confirmsSaves)) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: reservation === "capacity"
				? "Intercom accepted-delivery capacity is full; refusing delivery without evicting live retry authority"
				: reservation === "uncertain"
					? "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery"
					: "Intercom accepted-delivery authority changed before forwarding; refusing possible duplicate delivery",
			...(reservation === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
		});
		return;
	}
	if (message.expectsReply === true && clientMessage.resolveReplyTarget === true && attemptId !== undefined)
		write(socket, { type: "question_target", messageId: message.id, attemptId, sessionId: target.info.id });
    const finishDelivery = (recipient: BrokerConnectedSession, sender: ReceiptSender | undefined): void => {
	  const notify = (frame: BrokerMessage): void => {
		if (sender !== undefined) write(sender.socket, frame);
	  };
	  const senderAttemptId = sender?.attemptId;
	  let accepted: ReturnType<DeliveredMessageCache["accept"]>;
	  try {
		accepted = deliveredMessages.accept(message.id, signature, targetIdentity);
	  } catch {
		notify({
			type: "delivery_failed",
			messageId: message.id,
			attemptId: senderAttemptId,
			reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
		});
		return;
	  }
	  if (accepted !== "accepted") {
		notify({
			type: "delivery_failed",
			messageId: message.id,
			attemptId: senderAttemptId,
			reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
			...(accepted === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
		});
		return;
	  }
      // A terminal presence frame can arrive while the socket write callback is pending.
      // Retain accepted-delivery authority, but never open a reply route after termination.
      if (message.expectsReply === true && recipient.info.replyCapability === "terminal") {
        notify({ type: "delivery_failed", messageId: message.id, attemptId: senderAttemptId, reason: TERMINAL_CHILD_ASK_REFUSAL });
        return;
      }
      if (message.expectsReply === true && sessions.get(recipient.info.id) !== recipient) {
        notify({ type: "delivery_failed", messageId: message.id, attemptId: senderAttemptId,
          reason: `Session "${recipient.info.name ?? recipient.info.id}" disconnected before replying` });
        return;
      }
      // A sender whose wait already ended was told the outcome is uncertain; its retry opens the reply route.
      if (message.expectsReply === true && sender !== undefined) {
        pendingQuestions.record(fromSession.info.id, recipient.info.id, message.id);
        // #3761: a recipient that reconnected before confirming answers under its new session id.
        if (recipient.info.id !== target.info.id && clientMessage.resolveReplyTarget === true && senderAttemptId !== undefined)
          notify({ type: "question_target", messageId: message.id, attemptId: senderAttemptId, sessionId: recipient.info.id });
	  }
      if (message.replyTo !== undefined && pendingQuestions.clearReply(fromSession.info.id, recipient.info.id, message.replyTo)) {
        deliveredMessages.settleQuestion(message.replyTo);
      }
      if (supervisorSend) supervisorCache.record(message.id, fromSession.info.id, recipient.info.id);
      notify({ type: "delivered", messageId: message.id, attemptId: senderAttemptId });
    };
    const senderWaiting: ReceiptSender = { socket, ...(attemptId === undefined ? {} : { attemptId }) };
    if (confirmsSaves && receipts !== undefined) {
      receipts.await(
        {
          messageId: message.id,
          targetIdentity,
          frame: outbound,
          complete: finishDelivery,
          expire: (waiting) => {
            write(waiting.socket, { type: "delivery_failed", messageId: message.id, attemptId: waiting.attemptId, reason: UNCERTAIN_RECEIPT_REASON });
          },
        },
        senderWaiting,
      );
      const unwritten = (): void => {
        receipts.drop(message.id);
        failDelivery();
      };
      if (writeConfirmed !== undefined) {
        writeConfirmed(target.socket, outbound, (written) => {
          if (!written) unwritten();
        });
        return;
      }
      if (!write(target.socket, outbound)) unwritten();
      return;
    }
    if (writeConfirmed !== undefined) {
      writeConfirmed(target.socket, outbound, (written) => {
        if (written) finishDelivery(target, senderWaiting);
        else failDelivery();
      });
      return;
    }
    if (!write(target.socket, outbound)) {
      // Nothing was written, so the message id and reply authorization remain
      // available for an honest retry.
      failDelivery();
      return;
    }
    finishDelivery(target, senderWaiting);
    return;
  }
	if (resolution.kind === "not_found" && visibleCandidates.some((info) => !isAgentRecipient(info) && info.name?.toLowerCase() === trimmedTo.toLowerCase())) {
		write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: NON_AGENT_RECIPIENT_REFUSAL });
		return;
	}
	if (
		resolution.kind === "not_found" &&
		!supervisorSend &&
		!requirePendingReply &&
		workflowTarget === undefined &&
		holdForRestoringRecipient?.({
			socket,
			from: fromSession,
			clientMessage: clientMessage as SendClientMessage & { readonly to: string },
			target: trimmedTo,
			messageId: message.id,
			...(attemptId ? { attemptId } : {}),
		})
	) {
		return;
	}
	if (
		resolution.kind === "not_found" &&
		!supervisorSend &&
		routePendingStage !== undefined &&
		workflowTarget !== undefined &&
		routePendingStage({
			socket,
			from: fromSession,
			target: trimmedTo,
			message,
			...(attemptId ? { attemptId } : {}),
			signature,
			...(clientMessage.resolveReplyTarget === true ? { resolveReplyTarget: true } : {}),
		})
	) {
		return;
	}
  write(socket, {
    type: "delivery_failed",
    messageId: message.id,
    attemptId,
    reason: sessionTargetFailureReason(clientMessage.to, resolution),
		...(requirePendingReply && resolution.kind === "not_found"
			? { reasonCode: "session_not_found" as const }
			: {}),
  });
}
