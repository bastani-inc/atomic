import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import {
	legacyWorkflowStageTargetMigrationHint,
	parseLegacyWorkflowStageTarget,
	parseWorkflowStageTarget,
} from "../workflow-stage-target.js";
import { normalizeGroup } from "../group.js";
import { isMessage } from "./client-message-validation.js";
import { resolveSessionTarget, sessionTargetFailureReason } from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { isVerticalBypass, sameGroup } from "./group-isolation.js";
import { sessionGroups, sessionsShareGroup } from "./group-membership.js";
import { PendingQuestionIndex } from "./pending-question-index.js";

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




interface SendClientMessage extends Record<string, unknown> {
  type: string;
}
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
  if (Object.prototype.hasOwnProperty.call(clientMessage, "channel")) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Invalid channel" });
    return;
  }
  const supervisorSend = clientMessage.type === "supervisor_send";
  if (requirePendingReply && (supervisorSend || message.replyTo === undefined || message.expectsReply === true)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid requirePendingReply message" });
    return;
  }


  const fromSession = currentId ? sessions.get(currentId) : undefined;
  if (!fromSession) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Sender session not found" });
    return;
  }
	const senderIdentity = fromSession.registrationReturnAddress ?? fromSession.info.id;
	const logicalTarget = typeof clientMessage.logicalTarget === "string" ? clientMessage.logicalTarget : clientMessage.to;
	const baseSignature = buildMessageSendSignature(logicalTarget, message, senderIdentity);
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
  const reachableAcrossGroups = supervisorSend || Boolean(message.replyTo);
  const candidates = reachableAcrossGroups
    ? Array.from(sessions.values(), (session) => session.info)
    : Array.from(sessions.values(), (session) => session.info).filter(
        (info) => sessionsShareGroup(info, fromSession.info),
      );
  const resolution = exactIdTarget
    ? ({ kind: "resolved", session: exactIdTarget.info } as const)
    : resolveSessionTarget(candidates, trimmedTo);
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
    if (target.info.id === fromSession.info.id) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Cannot message the current session" });
      return;
    }
	const targetIdentity = deliveryTargetIdentity(target);
	const deliveredMatch = deliveredMessages.lookupForTarget(message.id, signature, targetIdentity);
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
	if (requirePendingReply && deliveredMatch === "uncertain") {
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
        reason: "Target session is in a different intercom group",
      });
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
			pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
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
	if (deliveredMatch === "uncertain") {
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
		if (message.expectsReply === true) pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
		write(socket, { type: "delivered", messageId: message.id, attemptId });
		return;
	}
	if (reservation !== "recorded") {
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
    const finishDelivery = (): void => {
	  let accepted: ReturnType<DeliveredMessageCache["accept"]>;
	  try {
		accepted = deliveredMessages.accept(message.id, signature, targetIdentity);
	  } catch {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
		});
		return;
	  }
	  if (accepted !== "accepted") {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			attemptId,
			reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
			...(accepted === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
		});
		return;
	  }
      if (message.expectsReply === true) {
        pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
	  }
      if (message.replyTo !== undefined) {
        pendingQuestions.clearReply(fromSession.info.id, target.info.id, message.replyTo);
      }
      if (supervisorSend) supervisorCache.record(message.id, fromSession.info.id, target.info.id);
      write(socket, { type: "delivered", messageId: message.id, attemptId });
    };
    if (writeConfirmed !== undefined) {
      writeConfirmed(target.socket, outbound, (written) => {
        if (written) finishDelivery();
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
    finishDelivery();
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
