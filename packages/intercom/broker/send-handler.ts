import { TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import type net from "node:net";
import type { BrokerMessage, Message, SessionInfo } from "../types.js";
import { normalizeGroup } from "../group.js";
import { isMessage } from "./client-message-validation.js";
import { intercomMessageSizeError } from "../message-size.js";
import {
	resolveSessionTarget,
	resolveSessionTargetByHostSessionId,
	sessionTargetFailureReason,
} from "../session-target.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { type ReceiptSender, type RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { isVerticalBypass } from "./group-isolation.js";
import { reachesSession, sessionGroups } from "./group-membership.js";
import { type IntercomReachPolicy, notFoundInReachReason, outsideReachReason } from "../reach-policy.js";
import { HELD_FOR_AWAY_ASKER_TARGET } from "./held-reply-targets.js";
import { PendingQuestionIndex } from "./pending-question-index.js";
import { ROUTE_UNAVAILABLE_REASON } from "./delivery-failure-reason.js";
import { type ReturnPathParty, type ReturnPaths, returnPathClosedReason } from "./return-paths.js";
import { returnAddressOf } from "./multinode-state-store.js";
import { isAgentRecipient, NON_AGENT_RECIPIENT_REFUSAL } from "../recipient-purpose.js";
import { isWorkflowTarget, WORKFLOW_TARGET_REMOVED_REASON } from "./legacy-workflow-frames.js";

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
  /** #4639: the supervisor's host session, as it registered: where its next session takes its subagents over. */
  readonly supervisorReturnAddress?: string;
  /** Private issuer identity used to restore child capabilities after reconnects. */
  supervisorOwnerToken?: string;
  /** #3761: the recipient confirms each message once it has saved it; `delivered` waits for that confirmation. */
  readonly acknowledgesReceipt?: true;
  /** #4642: the session id of the connection hosting this session, whose `socket` it shares. */
  readonly hostedBy?: string;
  reach?: IntercomReachPolicy;
}

/** A message frame for `recipient`; the connection hosting a hosted recipient learns which of its sessions it is for. */
export function messageFrameFor(
  recipient: BrokerConnectedSession,
  from: SessionInfo,
  message: Message,
  channel?: "supervisor",
): Extract<BrokerMessage, { type: "message" }> {
  return {
    type: "message",
    from,
    message,
    ...(channel === undefined ? {} : { channel }),
    ...(recipient.hostedBy === undefined ? {} : { hostedRecipient: recipient.info.id }),
  };
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
export type ConfirmedMessageWriter = (
	target: net.Socket,
	message: BrokerMessage,
	onSettled: (written: boolean) => void,
) => void;

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
  readonly answersAsk?: true;
}) => boolean;

export interface SendClientMessage extends Record<string, unknown> {
  type: string;
}

export type ReleasedAskerReplyRouter = (reply: {
  readonly socket: net.Socket;
  readonly from: BrokerConnectedSession;
  readonly message: Message & { readonly replyTo: string };
  readonly target: string;
  readonly attemptId?: string;
  readonly expectedRecipientId?: string;
}) => boolean;

/**
 * Return paths across intercom groups (see `return-paths.ts`): a session that received a message from a sender
 * outside its groups may send back to that sender, and only to it, for a bounded number of messages and time.
 */
export interface ReturnPathAuthority {
	/** Whether `sender` holds a return path to `target`, open or closed: such a target resolves by name. */
	holds(sender: BrokerConnectedSession, target: ReturnPathParty): boolean;
	/**
	 * The live sessions `sender` holds return paths to, open or closed: every live registration of each held identity.
	 * A sender that holds none costs nothing; one that does costs one pass over the sessions, never one per session.
	 */
	answerable(sender: BrokerConnectedSession): BrokerConnectedSession[];
	/** Counts `messageId` as an answer to `target`; false when no open return path allows it. */
	use(sender: BrokerConnectedSession, target: ReturnPathParty, messageId: string): boolean;
	/** Whether `sender` holds a return path to `target` that has closed. */
	closed(sender: BrokerConnectedSession, target: ReturnPathParty): boolean;
	/**
	 * The message `operationId` from `from` reached `recipient`: opens its path back when they share no group. `since`
	 * is the {@link mark} taken when the message was handed over; a sender whose registrations all ended for good since
	 * then gets no path, however late the recipient confirmed it.
	 */
	delivered(
		recipient: BrokerConnectedSession,
		from: ReturnPathParty,
		fromInfo: SessionInfo,
		operationId: string,
		since?: number,
	): void;
	/** A mark to pass to {@link delivered} for a message handed over now. */
	mark(): number;
}

/** The broker's return paths, over the sessions it serves. */
export function createReturnPathAuthority(
	paths: ReturnPaths,
	sessions: ReadonlyMap<string, BrokerConnectedSession>,
): ReturnPathAuthority {
	return {
		holds: (sender, target) => paths.holds(returnPathParty(sender), target),
		answerable: (sender) => {
			// Paths name their senders by registration identity, never by a broker id that a reconnect replaces: every
			// live session of a held identity is a candidate, so a name two of them share stays ambiguous.
			const held = new Set(paths.sendersOf(returnPathParty(sender)).map((path) => path.identity));
			if (held.size === 0) return [];
			// Compare return addresses first: a session whose address no held identity names is not a candidate.
			const addresses = new Set([...held].map(returnAddressOf));
			const live: BrokerConnectedSession[] = [];
			for (const session of sessions.values()) {
				if (session.registrationReturnAddress === undefined || !addresses.has(session.registrationReturnAddress)) continue;
				const identity = returnPathParty(session).identity;
				if (identity !== undefined && held.has(identity)) live.push(session);
			}
			return live;
		},
		use: (sender, target, messageId) => paths.use(returnPathParty(sender), target, messageId),
		closed: (sender, target) => paths.closed(returnPathParty(sender), target),
		delivered: (recipient, from, fromInfo, operationId, since) => {
			// A recipient that can already reach the sender needs no path; one with a reach policy never uses one.
			if (recipient.reach === undefined && !reachesSession(recipient, fromInfo))
				paths.open(returnPathParty(recipient), from, operationId, since);
		},
		mark: () => paths.mark(),
	};
}

/**
 * The stable identity of a registration, which a return path binds: its return address and registration group. A
 * session registered without a return address has none, so another session given its id later is never mistaken for it.
 */
export function returnPathParty(session: BrokerConnectedSession): ReturnPathParty {
	return {
		sessionId: session.info.id,
		identity: session.registrationReturnAddress === undefined ? undefined : deliveryTargetIdentity(session),
	};
}

/**
 * Whether a send may travel on a return path at all: an explicit direct send or ask from a session without a reach
 * policy. A copy of a pattern send (it carries a `broadcastId`) never does, so `subagents:` and glob sends reach only
 * what they reached before; a session whose host gave it a reach policy sends only within that policy.
 */
export function mayUseReturnPath(
	message: Message,
	supervisorSend: boolean,
	sender: Pick<BrokerConnectedSession, "reach">,
): boolean {
	return !supervisorSend && message.broadcastId === undefined && sender.reach === undefined;
}

/**
 * Multi-node S5: a validated send whose target no local session or local hold resolved. The
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
const sendersAtReceipt = new WeakMap<SendClientMessage, BrokerConnectedSession>();

export type RemoteSendRouter = (request: RemoteSendRequest) => void;
function wireMessageId(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : "unknown";
}


/**
 * #5101: the longest a reply waits for a peer's routes to be restored before it is refused as retryable. A broker
 * completes a registration, and so restores its routes, within its presence bound (5 s).
 */
export const ROUTE_RESTORATION_WAIT_MS = 5_000;

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
	writeConfirmed?: ConfirmedMessageWriter,
	holdForRestoringRecipient?: RestoringRecipientHold,
	receipts?: RecipientReceipts<BrokerConnectedSession>,
	routeRemote?: RemoteSendRouter,
	/** #4079: whether the sender's read-only `list` peek may inspect a group; names a hidden target's group. */
	canPeekGroup?: (sender: BrokerConnectedSession, group: string) => boolean,
	routeReleasedAskerReply?: ReleasedAskerReplyRouter,
	returnPaths?: ReturnPathAuthority,
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
  const sizeError = intercomMessageSizeError(message.content);
  if (sizeError !== undefined) {
    write(socket, { type: "delivery_failed", messageId, attemptId, reason: sizeError });
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


  const liveSender = currentId ? sessions.get(currentId) : undefined;
  if (!liveSender) {
    write(socket, { type: "delivery_failed", messageId: message.id, attemptId, reason: "Sender session not found" });
    return;
  }
  let fromSession = sendersAtReceipt.get(clientMessage);
  if (fromSession === undefined) {
    fromSession = liveSender.reach === undefined ? liveSender : {
      ...liveSender,
      info: { ...liveSender.info, groups: liveSender.info.groups?.slice() },
      reach: { home: liveSender.reach.home, reachable: [...liveSender.reach.reachable] },
    };
    sendersAtReceipt.set(clientMessage, fromSession);
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
	// Atomic 0.10.0 removed workflows: a 0.9.x session's send to a workflow stage target is refused, typed, never
	// resolved as a session name.
	if (isWorkflowTarget(trimmedTo)) {
		write(socket, {
			type: "delivery_failed",
			messageId: message.id,
			...(attemptId ? { attemptId } : {}),
			reason: WORKFLOW_TARGET_REMOVED_REASON,
			reasonCode: "session_not_found",
		});
		return;
	}
	const replyTo = message.replyTo;
	if (
		!supervisorSend &&
		replyTo !== undefined &&
		message.expectsReply !== true &&
		routeReleasedAskerReply?.({
			socket,
			from: fromSession,
			message: { ...message, replyTo },
			target: trimmedTo,
			...(attemptId === undefined ? {} : { attemptId }),
			...(expectedRecipientId === undefined ? {} : { expectedRecipientId }),
		}) === true
	) {
		return;
	}

  // Exact-id targeting always resolves against the full pool so a cross-group id
  // is caught by the defense-in-depth group check below. Only a broker-authorized
  // supervisor frame or an exact recorded reply may resolve across groups.
	const exactIdTarget = sessions.get(trimmedTo);
  const visibleCandidates = Array.from(sessions.values(), (session) => session.info).filter(
	(info) => reachesSession(fromSession, info) ||
      (supervisorSend && info.id === fromSession.supervisorId) ||
      (message.replyTo !== undefined && (
        pendingQuestions.matchesReply(fromSession.info.id, info.id, message.replyTo) ||
        isVerticalBypass({ replyTo: message.replyTo, sender: fromSession.info, target: info, supervisorCache })
      )),
  );
  const candidates = visibleCandidates.filter(isAgentRecipient);
  // A sender outside the sender's groups that wrote to it may be answered by the name its message showed. It is
  // considered only when nothing the sender can already see answers to that name, so no name resolves differently.
  const visibleIds = new Set(candidates.map((visible) => visible.id));
  const returnPathCandidates =
    returnPaths !== undefined && mayUseReturnPath(message, supervisorSend, fromSession)
      ? returnPaths
          .answerable(fromSession)
          .map((session) => session.info)
          .filter((info) => isAgentRecipient(info) && !visibleIds.has(info.id))
      : [];
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
  const visibleResolution = exactIdTarget
    ? ({ kind: "resolved", session: exactIdTarget.info } as const)
    : resolveSessionTarget(candidates, trimmedTo);
  const returnPathResolution =
    visibleResolution.kind === "not_found" && returnPathCandidates.length > 0
      ? resolveSessionTarget(returnPathCandidates, trimmedTo)
      : undefined;
  const nameOrIdResolution =
    returnPathResolution !== undefined && returnPathResolution.kind !== "not_found" ? returnPathResolution : visibleResolution;
  // #3760: a host session id (a resumed session's or a restored subagent's own session id) reaches the one
  // visible session it registered, under the same group visibility as names.
  const resolution = nameOrIdResolution.kind === "not_found"
    ? resolveSessionTargetByHostSessionId(
        candidates,
        trimmedTo,
        (info) => sessions.get(info.id)?.registrationReturnAddress,
      )
    : nameOrIdResolution;
  // #4751: a reply to an ask whose asker is closed (a top-level session that may resume) is held for it, once, and
  // delivered when it registers again; the replier learns that it is held. With multi-node routing, the shared outbox
  // queues it for the offline asker instead.
  const awayAsker =
    routeRemote === undefined && resolution.kind === "not_found" &&
    requirePendingReply && message.replyTo !== undefined
      ? pendingQuestions.dormantReply(message.replyTo, fromSession.info.id, fromSession.registrationReturnAddress)
      : undefined;
  // An asker already back under another Intercom id (its own session reconnected) is reached as before, by name.
  const askerBackElsewhere =
    awayAsker?.senderReturnAddress !== undefined &&
    [...sessions.values()].some((session) => session.registrationReturnAddress === awayAsker.senderReturnAddress);
  const heldAgain =
    routeRemote === undefined && resolution.kind === "not_found" && requirePendingReply &&
    pendingQuestions.isHeldForAwayAsker(message.id, fromSession.info.id);
  if (
    heldAgain ||
    (awayAsker?.senderReturnAddress !== undefined &&
      !askerBackElsewhere &&
      (expectedRecipientId === undefined || expectedRecipientId === awayAsker.senderSessionId))
  ) {
    if (!heldAgain && awayAsker?.senderReturnAddress !== undefined)
      pendingQuestions.holdForAwayAsker({ ...awayAsker, senderReturnAddress: awayAsker.senderReturnAddress }, fromSession.info, message);
    write(socket, {
      type: "queued",
      messageId: message.id,
      ...(attemptId ? { attemptId } : {}),
      target: HELD_FOR_AWAY_ASKER_TARGET,
      position: 1,
    });
    return;
  }
  if (
    routeRemote !== undefined &&
    resolution.kind === "not_found" &&
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
          writeConfirmed,
          holdForRestoringRecipient,
          receipts,
          undefined,
          canPeekGroup,
          routeReleasedAskerReply,
          returnPaths,
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
					writeConfirmed,
					holdForRestoringRecipient,
					receipts,
					routeRemote,
					canPeekGroup,
					routeReleasedAskerReply,
					returnPaths,
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
		// #5101: a peer back on this broker whose routes it has not restored yet (its registration is still completing)
		// may hold this reply's route. The reply waits for that restoration and is decided again; one still waiting when
		// the bound passes is refused as retryable, never as unauthorized.
		let refused = false;
		let bound: ReturnType<typeof setTimeout> | undefined;
		const decideAgain = (): void => {
			if (refused) return;
			clearTimeout(bound);
			handleBrokerSend(
				socket,
				clientMessage,
				currentId,
				sessions,
				deliveredMessages,
				write,
				supervisorCache,
				pendingQuestions,
				writeConfirmed,
				holdForRestoringRecipient,
				receipts,
				routeRemote,
				canPeekGroup,
				routeReleasedAskerReply,
				returnPaths,
			);
		};
		// #5252: the ask this replies to is written, but its write is not confirmed yet: its route opens then.
		if (
			message.replyTo !== undefined &&
			pendingQuestions.whenAskWritten(target.info.id, fromSession.info.id, message.replyTo, decideAgain)
		)
			return;
		if (
			pendingQuestions.whenRestored(target.info.id, decideAgain) ||
			pendingQuestions.whenRestored(fromSession.info.id, decideAgain)
		) {
			bound = setTimeout(() => {
				refused = true;
				write(socket, {
					type: "delivery_failed",
					messageId: message.id,
					attemptId,
					reason: ROUTE_UNAVAILABLE_REASON,
					routeUnavailable: true,
				});
			}, ROUTE_RESTORATION_WAIT_MS);
			bound.unref();
			return;
		}
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
		correlatedReply;
	const crossesGroups = !bypass && !reachesSession(fromSession, target.info);
	// A recipient answers a sender outside its reach that wrote to it, within the return path's bounds.
	const returnPath = crossesGroups && mayUseReturnPath(message, supervisorSend, fromSession) ? returnPathParty(target) : undefined;
	if (crossesGroups && (returnPath === undefined || returnPaths?.use(fromSession, returnPath, message.id) !== true)) {
      write(socket, {
        type: "delivery_failed",
        messageId: message.id,
        attemptId,
        reason: returnPath !== undefined && returnPaths?.closed(fromSession, returnPath) === true
            ? returnPathClosedReason(target.info.name ?? target.info.id)
            : fromSession.reach !== undefined
              ? outsideReachReason(fromSession.reach)
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
    const outbound = messageFrameFor(target, fromSession.info, message, supervisorSend ? "supervisor" : undefined);
    const failDelivery = (): void => {
	  if (reservation === "recorded") deliveredMessages.forget(message.id, signature);
	  // #5095: the reply was never written, so its ask is still unanswered.
	  if (message.replyTo !== undefined) pendingQuestions.unmarkReplied(fromSession.info.id, target.info.id, message.replyTo);
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
    // Taken as the message is handed over: its receipt opens nothing once every registration of the sender ended since.
    const handedOver = returnPaths?.mark();
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
      if (message.replyTo !== undefined)
        pendingQuestions.releaseHeldFailures(message.replyTo, fromSession.info.id, recipient.registrationReturnAddress);
      if (supervisorSend) supervisorCache.record(message.id, fromSession.info.id, recipient.info.id);
      returnPaths?.delivered(recipient, returnPathParty(fromSession), fromSession.info, message.id, handedOver);
      notify({ type: "delivered", messageId: message.id, attemptId: senderAttemptId });
    };
    const senderWaiting: ReceiptSender = { socket, ...(attemptId === undefined ? {} : { attemptId }) };
    // #5095: from here the reply is on its way: its ask is answered, so the replier ending before the asker saves the
    // reply does not also fail it. The asker's save clears its route as before.
    if (message.replyTo !== undefined) pendingQuestions.markReplied(fromSession.info.id, target.info.id, message.replyTo);
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
          hold: (waiting, timeoutMs) => {
            write(waiting.socket, { type: "send_held", messageId: message.id, attemptId: waiting.attemptId, timeoutMs });
          },
          // #5095: a reply its asker never saved did not answer the ask.
          ...(message.replyTo === undefined
            ? {}
            : { lapse: () => pendingQuestions.unmarkReplied(fromSession.info.id, target.info.id, message.replyTo as string) }),
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
      const askWritten =
        message.expectsReply === true ? pendingQuestions.beginAskWrite(fromSession.info.id, target.info.id, message.id) : undefined;
      writeConfirmed(target.socket, outbound, (written) => {
        if (written) finishDelivery(target, senderWaiting);
        else failDelivery();
        askWritten?.();
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
  const peekHint =
    resolution.kind === "not_found" && !supervisorSend && !requirePendingReply && expectedRecipientId === undefined &&
    message.replyTo === undefined && canPeekGroup !== undefined
      ? liveInPeekableGroupReason(sessions, fromSession, trimmedTo, canPeekGroup)
      : undefined;
  const targetFailure = sessionTargetFailureReason(clientMessage.to, resolution);
  write(socket, {
    type: "delivery_failed",
    messageId: message.id,
    attemptId,
    reason: peekHint ?? (fromSession.reach !== undefined && resolution.kind === "not_found"
      ? `${targetFailure}. ${notFoundInReachReason(fromSession.reach)}`
      : targetFailure),
		...(requirePendingReply && resolution.kind === "not_found"
			? { reasonCode: "session_not_found" as const }
			: {}),
  });
}

/**
 * #4079: a target outside every group the sender shares that is live in a group the sender's read-only `list`
 * peek already shows. Names one such group so the sender knows to join it. A target visible only in groups the
 * peek refuses, or matching more than one peekable session, gets no hint, so this reveals nothing `list` hides.
 */
function liveInPeekableGroupReason(
  sessions: Map<string, BrokerConnectedSession>,
  sender: BrokerConnectedSession,
  target: string,
  canPeekGroup: (sender: BrokerConnectedSession, group: string) => boolean,
): string | undefined {
  const peekable = new Map<string, string>();
  for (const { info } of sessions.values()) {
    if (info.id === sender.info.id || !isAgentRecipient(info) || reachesSession(sender, info)) continue;
    const group = [...sessionGroups(info)].find((candidate) => canPeekGroup(sender, candidate));
    if (group !== undefined) peekable.set(info.id, group);
  }
  const candidates = Array.from(peekable.keys(), (id) => sessions.get(id)!.info);
  const resolution = resolveSessionTarget(candidates, target);
  if (resolution.kind !== "resolved") return undefined;
  const group = peekable.get(resolution.session.id)!;
  return `${resolution.session.name ?? resolution.session.id} is live in group ${group}; join it to send`;
}
