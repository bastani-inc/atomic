import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import { isMessage } from "./client-message-validation.js";
import { resolveSessionTarget, sessionTargetFailureReason } from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { isVerticalBypass, sameGroup } from "./group-isolation.js";
import { normalizeGroup } from "../group.js";
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
  readonly runId: string;
  readonly stageKey: string;
  readonly message: Message;
  readonly attemptId?: string;
	readonly liveTargetId?: string;
	readonly signature?: string;
}

export type PendingStageRouter = (route: PendingStageRoute) => boolean;

export type LiveWorkflowStageResolver = (target: string) => BrokerConnectedSession | undefined;

const WORKFLOW_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePendingStageTarget(target: string): { runId: string; stageKey: string } | undefined {
  const separator = target.indexOf(":");
  if (separator < 0) return undefined;
  const runId = target.slice(0, separator);
  const stageKey = target.slice(separator + 1);
  return WORKFLOW_RUN_ID_PATTERN.test(runId) && stageKey.length > 0 ? { runId, stageKey } : undefined;
}
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
  write: (target: net.Socket, message: BrokerMessage) => void,
  supervisorCache: SupervisorChannelCache = new SupervisorChannelCache(),
  pendingQuestions: PendingQuestionIndex = new PendingQuestionIndex(),
  routePendingStage?: PendingStageRouter,
  resolveLiveWorkflowStage?: LiveWorkflowStageResolver,
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


  // Exact-id targeting always resolves against the full pool so a cross-group id
  // is caught by the defense-in-depth group check below. Only a broker-authorized
  // supervisor frame or an exact recorded reply may resolve across groups.
	const liveWorkflowTarget = sessions.has(trimmedTo) ? undefined : resolveLiveWorkflowStage?.(trimmedTo);
	const exactIdTarget = sessions.get(trimmedTo) ?? liveWorkflowTarget;
  const senderGroup = normalizeGroup(fromSession.info.group);
  const reachableAcrossGroups = supervisorSend || Boolean(message.replyTo);
  const candidates = reachableAcrossGroups
    ? Array.from(sessions.values(), (session) => session.info)
    : Array.from(sessions.values(), (session) => session.info).filter(
        (info) => normalizeGroup(info.group) === senderGroup,
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
    const bypass = supervisorSend || isVerticalBypass({
      replyTo: message.replyTo,
      sender: fromSession.info,
      target: target.info,
      supervisorCache,
    });
    if (!bypass && !sameGroup(target.info, fromSession.info)) {
      write(socket, {
        type: "delivery_failed",
        messageId: message.id,
        attemptId,
        reason: "Target session is in a different intercom group",
      });
      return;
    }
		const liveTarget = parsePendingStageTarget(trimmedTo);
		if (
			liveWorkflowTarget !== undefined &&
			liveTarget !== undefined &&
			routePendingStage?.({
				socket,
				from: fromSession,
				...liveTarget,
				message,
				...(attemptId ? { attemptId } : {}),
				liveTargetId: target.info.id,
				signature,
			})
		) {
			return;
		}
    write(target.socket, supervisorSend
      ? { type: "message", from: fromSession.info, message, channel: "supervisor" }
      : { type: "message", from: fromSession.info, message });
    deliveredMessages.record(message.id, signature);
    if (message.expectsReply === true) {
      pendingQuestions.record(fromSession.info.id, target.info.id, message.id);
    }
    if (message.replyTo !== undefined) {
      pendingQuestions.clearReply(fromSession.info.id, target.info.id, message.replyTo);
    }
    if (supervisorSend) supervisorCache.record(message.id, fromSession.info.id, target.info.id);
    write(socket, { type: "delivered", messageId: message.id, attemptId });
    return;
  }
  if (resolution.kind === "not_found" && !supervisorSend && routePendingStage !== undefined) {
    const pendingTarget = parsePendingStageTarget(trimmedTo);
    if (
      pendingTarget !== undefined &&
      routePendingStage({ socket, from: fromSession, ...pendingTarget, message, ...(attemptId ? { attemptId } : {}) })
    ) {
      return;
    }
  }
  write(socket, {
    type: "delivery_failed",
    messageId: message.id,
    attemptId,
    reason: sessionTargetFailureReason(clientMessage.to, resolution),
  });
}
