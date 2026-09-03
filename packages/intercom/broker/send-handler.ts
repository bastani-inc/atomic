import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import {
	legacyWorkflowStageTargetMigrationHint,
	parseLegacyWorkflowStageTarget,
	parseWorkflowStageTarget,
} from "../workflow-stage-target.js";
import { isMessage } from "./client-message-validation.js";
import { resolveSessionTarget, sessionTargetFailureReason } from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { isVerticalBypass, sameGroup } from "./group-isolation.js";
import { sessionsShareGroup } from "./group-membership.js";
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
	 * Hand one frame to a socket. Returns whether the frame was actually written:
	 * the broker's `writeMessageIfOpen` answers `false` for a socket whose
	 * writable side has already ended, and a target delivery may only be recorded
	 * and acknowledged when the answer is `true`.
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
  if (typeof clientMessage.to !== "string" || !isMessage(message)) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: "Invalid message format" });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(clientMessage, "channel")) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Invalid channel" });
    return;
  }
  const supervisorSend = clientMessage.type === "supervisor_send";


  const fromSession = currentId ? sessions.get(currentId) : undefined;
  if (!fromSession) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Sender session not found" });
    return;
  }
	const signature = buildMessageSendSignature(clientMessage.to, message, fromSession.info.id);
	const deliveredMatch = deliveredMessages.lookup(message.id, signature);
	if (deliveredMatch === "match") {
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
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Session not found" });
      return;
    }
    if (target.info.id === fromSession.info.id) {
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Cannot message the current session" });
      return;
    }
	const correlatedReply =
		message.replyTo !== undefined &&
		pendingQuestions.matchesReply(fromSession.info.id, target.info.id, message.replyTo);
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
      write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Session not found" });
    };
    const finishDelivery = (): void => {
      deliveredMessages.record(message.id, signature);
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
  });
}
