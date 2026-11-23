import type {
	IntercomRecipientGoneErrorCode,
	SerializedIntercomRecipientGoneError,
	SubagentEndedOutcome,
} from "./broker/recipient-gone-errors.js";
import type { SerializedIntercomHostedSessionError } from "./broker/hosted-session-errors.js";
import type { SerializedIntercomReleasedReplyError } from "./broker/released-reply-errors.js";

export interface SessionInfo {
  id: string;
  /** Host-declared connection purpose; omitted by legacy agent clients. Immutable after registration. */
  readonly recipientPurpose?: "agent" | "control";
  /** Host-owned execution capability, independent of idle/thinking presence. */
  replyCapability?: "live" | "terminal";
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  /** Session's normalized intercom group memberships. */
  groups?: string[];
  /** Legacy single-group membership; accepted alongside `groups` for compatibility. */
  group?: string;
}

export interface SessionDirectory {
	readonly sessions: SessionInfo[];
	/** The peeked group is outside this session's Intercom reach policy, so its sessions are not listed. */
	readonly restricted?: true;
}

export interface GroupSummary {
	group: string;
	sessionCount: number;
	member: boolean;
}

export interface ReachPolicyFrame {
	home: string;
	reachable: string[];
}

/** A broker's multi-node routing state, as `broker_status` reports it. */
export interface BrokerMultiNodeStatus {
	status: "off" | "starting" | "on" | "unavailable";
	/** Why routing is off or unavailable. */
	reason?: string;
	/** The shared selection's adapter module, or `sqlite` for a `path` selection. */
	adapter?: string;
	prefix?: string;
	/** Host names of the other brokers whose membership lease is live, while routing is on. */
	peers?: string[];
}

/** What a broker reports about itself; read before registering by `atomic intercom restart` and `atomic storage status`. */
export interface BrokerStatusReport {
	pid: number;
	/** Sessions connected to this broker. */
	sessions: number;
	/** Reservations this broker holds for subagents that are being restored or released; absent from an older broker. */
	reservations?: number;
	/** Sends this broker holds for those reservations; absent from an older broker. */
	heldSends?: number;
	/** Released-asker reply routes refused at capacity since broker start; absent from an older broker. */
	droppedReleasedReplyRoutes?: number;
	/** #5999: bytes of the messages queued for subagents that ended, to reach them when resumed; absent from an older broker. */
	queuedBytes?: number;
	/** The shared storage selection the broker read, as a digest of its JSON, and where it read it; absent without one. */
	storage?: { digest: string; source: "env" | "settings" };
	multiNode: BrokerMultiNodeStatus;
	/** #4538: the wire protocol versions this broker accepts; absent from a broker of protocol 1 (0.9.71 and earlier). */
	protocol?: { min: number; max: number };
}

/**
 * #4386: why a reply to a subagent released while it waited on that question was refused before reaching its owner.
 * `released_reply_answered`: the owner already took another reply. `released_reply_in_flight`: another reply is
 * still being handed to the owner.
 */
export type ReleasedReplyRefusalCode = "released_reply_answered" | "released_reply_in_flight";

/**
 * Why a send or ask was refused, for callers that branch on it; the free-text `reason` stays for people.
 * `recipient_not_restored`: the sender was held for a subagent that was being restored or woken, and the hold ended
 * first. `recipient_parked`: the subagent's owner keeps it parked (paused or quit) and never wakes it for a send.
 * The `IntercomRecipientGoneErrorCode`s (#4639) reach a client only inside `delivery_failed.recipientError`, never as
 * its wire `reasonCode`, which older clients validate against the codes they know.
 */
export type DeliveryFailureReasonCode =
	| "message_id_conflict"
	| "session_not_found"
	| "recipient_not_restored"
	| "recipient_parked"
	| ReleasedReplyRefusalCode
	| IntercomRecipientGoneErrorCode
	| "not_hosted_by_connection"
	/**
	 * #4997, #5101: a reply no route authorizes yet, while its ask's route is still being restored or a broker that may
	 * keep it is down: it may be authorized shortly. Carried as `delivery_failed.routeUnavailable`, not as the wire
	 * `reasonCode`, which older clients validate against the codes they know.
	 */
	| "route_unavailable";

/** #4642: why the broker refused a hosted-session request; see `IntercomHostedSessionError`. */
export type HostedSessionRefusalCode = "invalid_hosted_frame" | "invalid_hosted_session" | "not_hosted_by_connection";

/** The broker's typed refusal of a hosted-session request; `key` or `sessionId` names the offending item. */
export interface HostedSessionRefusal {
	code: HostedSessionRefusalCode;
	key?: string;
	sessionId?: string;
}

/**
 * #4642: one session a connection hosts in a `host_sessions` frame of at most 500. It is listed and addressed like a
 * connected session, without a connection of its own; `key` is the host's name for it in the answer.
 */
export interface HostedSessionFrameItem {
	key: string;
	session: Omit<SessionInfo, "id">;
	returnAddress?: string;
}

/** The broker id of one hosted session. */
export interface HostedSessionAssignment {
	key: string;
	sessionId: string;
}

/** One subagent in a `mark_ended_children` frame: its owner reports how its last run ended (#4639). */
export interface EndedChildFrame {
	childName: string;
	group?: string;
	aliases?: string[];
	outcome: SubagentEndedOutcome;
	childId?: string;
	/**
	 * #5999: what the owner does with a send that asks to wake this subagent (`send.wakeEndedRecipient`): resume it for the
	 * message (`wake`, for one that finished on its own), or keep the message until it continues it (`hold`, for one
	 * paused or quit). Sent only to a broker that advertised `wakesEndedChildren`; never with the `cancelled` outcome.
	 */
	messages?: "wake" | "hold";
}

/** One released subagent in a `reserve_released_children` frame. */
export interface ReleasedChildReservationFrame {
	childName: string;
	group?: string;
	aliases?: string[];
	wake: boolean;
}

export type ReleasedChildRefusalCode =
	| "invalid_frame"
	| "invalid_child_name"
	| "invalid_alias"
	| "too_many_aliases"
	| "invalid_group"
	| "unknown_released_child"
	| "not_owner"
	/** Sent only by a 0.9.x broker, for a workflow group the owner was not a member of. */
	| "group_not_allowed";

/** The broker's typed refusal of a released-child request; `childName` names the offending item when there is one. */
export interface ReleasedChildRefusal {
	code: ReleasedChildRefusalCode;
	childName?: string;
}

export type IntercomDeliveryMode = "steer" | "followUp" | "interrupt";

export interface MessageDisplayRange {
  readonly start: number;
  readonly end: number;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  /**
   * How a busy recipient receives this message. `steer` (default when absent) queues it until the current turn's tool
   * calls finish, never cancelling in-flight work. `followUp` waits until the recipient's agent finishes and stops.
   * `interrupt` cancels the current model call or cancellable tool call and handles the message next.
   */
  delivery?: IntercomDeliveryMode;
  /** Correlated delivery refusal: settles a waiting ask, otherwise surfaces as send feedback. */
  replyError?: string;
  /** #5154: with `replyError`: the recipient may only be away, so asking again later may reach it. */
  retryLater?: true;
  /**
   * #5999: set by the broker on a message it kept for a subagent that was paused or quit: the subagent takes it after
   * what it is continued with, not as context before it. A client that does not know it takes it as before.
   */
  heldWhilePaused?: true;
  /**
   * Shared by every copy of one pattern send (`subagent-*`, `subagents:*`), each of which has its own `id`. A session
   * that several copies reach shows it once.
   */
  broadcastId?: string;
  source?: {
    subagentRunId: string;
    subagentAgent?: string;
    subagentIndex?: number;
  };
  content: {
    text: string;
    attachments?: Attachment[];
    displayRanges?: readonly MessageDisplayRange[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}
/** Broker capability metadata binding a child registration to its supervisor. */
export interface SupervisorRegistration {
  capability: string;
  supervisorSessionId: string;
}


export interface RegisterRequest {
	session: Omit<SessionInfo, "id">;
			/** Internal host-owned identity retained across broker reconnects. */
			returnAddress?: string;
			/**
			 * The Intercom session id this session held before a restart or reconnect (#3760). The broker grants it
			 * only when no live session holds it and it was not last held under another return address.
			 */
			preferredSessionId?: string;
			/** Immutable session origin; separate from mutable group memberships. Legacy clients use session.group. */
			registrationGroup?: string;
			supervisor?: SupervisorRegistration;
			supervisorOwnerToken?: string;
			/** #3761: this recipient sends `received` once it has saved each message; `delivered` waits for it. */
			acknowledgesReceipt?: true;
			/** #4538: the wire protocol versions this client speaks; absent from a client of protocol 1 (0.9.71 and earlier). */
			protocol?: { min: number; max: number };
			reach?: ReachPolicyFrame;
			/** Client's own registration timeout in ms, so the broker keeps internal waits within the client's deadline. */
			connectTimeoutMs?: number;
			/** Client's local-host epoch deadline (`Date.now() + connectTimeoutMs`) when this connect attempt started. */
			connectDeadlineAt?: number;
}

export type ClientMessage =
	| { type: "health"; requestId: string }
	| ({ type: "register" } & RegisterRequest)
	| ({
			type: "register_verified";
			/** The registration is refused, before it takes effect, unless the broker's multi-node routing is still this. */
			expectedRouting: { acrossMachines: boolean };
	  } & RegisterRequest)
	/** `resumable`: the session can be resumed, so its asks stay pending while it is away (#4751). */
	| { type: "unregister"; resumable?: true }
	/** #3761: the recipient saved this message; it ignores a copy of it sent again. */
	/**
	 * `paused` (#5999): the recipient is a subagent whose turn its user paused; it keeps the message until it is
	 * continued, and its sender is told so instead of `delivered`.
	 */
	| { type: "received"; messageId: string; paused?: true }
	/** #3983: the recipient is still saving this message; its sender keeps waiting. Sent only to a broker that advertised `extendsSaves`. */
	| { type: "saving"; messageId: string }
  | { type: "list"; requestId: string; group?: string }
	| { type: "list_groups"; requestId: string }
	| { type: "join_group"; requestId: string; group: string }
	| { type: "leave_group"; requestId: string; group?: string }
  | { type: "authorize_supervisor"; requestId: string; childName: string; capability?: string }
  /**
   * #3760: the supervisor that holds `capability` for a child it is restoring, or is about to restore, holds sends to
   * that child's name and `aliases` (its Atomic session id and pre-restart Intercom id) until the child registers
   * with the capability. A `dormant` hold only keeps the child addressable until the supervisor that restores it
   * reserves the same child and group, which takes the hold over together with the sends held so far.
   */
  | {
      type: "reserve_restoring_recipient";
      requestId: string;
      capability: string;
      group?: string;
      aliases?: string[];
      dormant?: boolean;
      wake?: boolean;
      /** The child is starting: hold each send this long for it (bounded by the broker). */
      holdMs?: number;
    }
  /**
   * #3760: end that hold. With `gone` (the reason), held and later senders are told the child is gone. With `refusal`,
   * the senders held now are told that reason instead and later ones are routed normally. Otherwise held sends are
   * routed normally.
   */
  | { type: "release_restoring_recipient"; requestId: string; capability: string; gone?: string; refusal?: string }
  /** #4326: reserve released subagents by child name, in a frame of at most 500; this connection becomes their owner. */
  | { type: "reserve_released_children"; requestId: string; children: ReleasedChildReservationFrame[]; releaseStamp?: true }
  /** #4326: end the reservations this connection made for these child names. */
  | { type: "drop_released_children"; requestId: string; childNames: string[]; gone?: string; refusal?: string }
  /**
   * #4639: this connection reports how subagents it launched ended, so a send to one with no live session is refused
   * with why and what to do next. Sent only to a broker that advertised `marksEndedChildren`.
   */
  | { type: "mark_ended_children"; requestId: string; children: EndedChildFrame[] }
  /** #4326: the owner is waking this child; the broker extends the sends held for it once per wake. */
  | { type: "acknowledge_released_child_wake"; requestId: string; childName: string; releaseStamp?: true }
  /**
   * #5999: the owner answers one `ended_child_wake`: it is resuming the child (`accepted`), or it is not, and `reason`
   * says why; the messages queued for the child then fail with it. An answer that names another wake is ignored. Sent
   * only in answer to a broker's `ended_child_wake`.
   */
  | { type: "answer_ended_child_wake"; childName: string; wakeId: string; accepted: boolean; reason?: string }
  /**
   * Durable wake queue: this session was told these messages it queued for subagents that ended were lost (an older
   * broker served in between); the broker that kept them after all drops them, untold. Sent only to a broker that
   * advertised `dropsEndedQueued`.
   */
  | { type: "drop_ended_queued"; messageIds: string[] }
  | { type: "verify_released_child"; requestId: string; childName: string; broker: string; order: number }
  /** #4326: the owner answers one `released_child_reply` handoff; an ack that names another handoff is ignored. */
  /**
   * #4751: `deliverToChild`: the released child has no call waiting for this reply (its `ask` already returned), so the
   * broker delivers the reply to the child as an ordinary send, held for the child and waking it.
   */
  | { type: "released_child_reply_ack"; messageId: string; handoffId: string; accepted: boolean; deliverToChild?: true }
  /** #4642: host sessions without a connection each; protocol 3. The broker answers `hosted_sessions_ack`. */
  | { type: "host_sessions"; requestId: string; sessions: HostedSessionFrameItem[] }
  /** #4642: remove sessions this connection hosts, in a frame of at most 500. */
  | { type: "unhost_sessions"; requestId: string; sessionIds: string[] }
  | {
      type: "send" | "supervisor_send";
      to: string;
      logicalTarget?: string;
      requirePendingReply?: true;
      expectedRecipientId?: string;
      resolveReplyTarget?: true;
      /** The sender understands `send_held` and may wait past its usual acknowledgement timeout (#3760). */
      awaitRestoringRecipient?: true;
      /**
       * #5999: a subagent that ended but can be resumed is resumed for this message by its owner; the send is answered
       * `queued` (target `resuming subagent`) at once. Never set on one copy of a pattern send. An older broker ignores it.
       */
      wakeEndedRecipient?: true;
      /** #4642: send as this session, which this connection hosts. */
      hostedSender?: string;
      message: Message;
      attemptId?: string;
    }
  | {
      type: "presence";
      name?: string;
      status?: string;
      replyCapability?: SessionInfo["replyCapability"];
      model?: string;
      groups?: string[];
      /** Legacy single-group membership; accepted alongside `groups` for compatibility. */
      group?: string;
      requestId?: string;
    }
	| { type: "set_reach"; requestId: string; reachable: string[] }
	/** Allowed before `register`: the broker's own status. */
	| { type: "broker_status"; requestId: string }
	/** Allowed before `register`: shut the broker down; its sessions reconnect to a new broker. */
	| { type: "shutdown"; requestId: string };

export type BrokerMessage =
	| { type: "health"; requestId: string; instanceId: string }
	| {
			type: "registered";
			sessionId: string;
			supervisorSessionId?: string;
			/** #3761: echoed only to a client that advertised it; that client may now send `received`. */
			acknowledgesReceipt?: true;
			/**
			 * Kept for 0.9.x clients, which register workflow routes only with these: they then send each one with a
			 * `requestId`, which this broker answers in place (see `broker/legacy-workflow-frames.ts`).
			 */
			acknowledgesPendingStageRoutes?: true;
			withdrawsPendingStageRoutes?: true;
			refusesPendingStageRoutesInPlace?: true;
			/** This broker answers `broker_status`; absent on older brokers, which drop a client that sends it. */
			brokerStatus?: true;
			/** #3983: this broker accepts `saving`; absent on older brokers, which drop a client that sends it. */
			extendsSaves?: true;
			/** #4639: this broker accepts `mark_ended_children`; absent on older brokers, which drop a client that sends it. */
			marksEndedChildren?: true;
			/** #5999: this broker wakes ended subagents for a send that asks it, and accepts `answer_ended_child_wake`. */
			wakesEndedChildren?: true;
			/**
			 * #5999: this broker process's id. A client whose messages were queued for subagents that ended, and that
			 * registers with another one, knows they were lost with the broker that kept them.
			 */
			instanceId?: string;
			/**
			 * Durable wake queue: this broker keeps queued messages across restarts and takes `drop_ended_queued`: a client
			 * told some were lost (an older broker served in between) has them dropped before they are delivered.
			 */
			dropsEndedQueued?: true;
			/** This connection accepts stamped release requests and read-only checks of a stamped hold. */
			stampsReleasedChildren?: true;
			/** Broker routing mode at registration, for deciding whether a reply wait may release. */
			multiNodeRouting?: BrokerMultiNodeStatus["status"];
			/** #4538: the wire protocol versions this broker accepts; absent on brokers of protocol 1. */
			protocol?: { min: number; max: number };
			enforcesReach?: true;
	  }
  | {
      type: "registration_failed";
      reason: string;
      code?: "broker_retiring" | "broker_routing_changed" | "reach_policy_refused" | "supervisor_authorization_refused";
      requestId?: string;
    }
  | { type: "question_target"; messageId: string; attemptId: string; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[]; restricted?: true }
	| { type: "groups"; requestId: string; groups: GroupSummary[] }
	| { type: "membership_ack"; requestId: string; groups: string[] }
	| { type: "reach_ack"; requestId: string; reachable: string[]; groups: string[] }
	| { type: "reach_failed"; requestId: string; reason: string }
  | { type: "supervisor_authorized"; requestId: string; capability: string; supervisorSessionId: string; childName: string }
  /** `hostedRecipient` names the hosted session the message is for, written only to the connection hosting it (#4642). */
  | {
      type: "message";
      from: SessionInfo;
      message: Message;
      channel?: "supervisor";
      hostedRecipient?: string;
      /**
       * Multi-node: the origin broker carried this answer on a return path (its recipient wrote to its sender first).
       * Set only between brokers, on outbox rows; never sent to a client.
       */
      returnPath?: true;
      /**
       * Multi-node: the stable registration identity of `from`, written by the origin broker, which the recipient's
       * broker binds a return path to. Set only between brokers, on outbox rows; never sent to a client.
       */
      senderIdentity?: string;
    }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "peer_disconnected"; replyTo: string; peerSessionId: string; peerName?: string }
  | { type: "peer_rebound"; replyTo: string; previousSessionId: string; sessionId: string }
  /** #5607: the id this session awaited is held for it; its next registration presents `handoff` to take it. */
  | { type: "id_handoff"; sessionId: string; handoff: string }
  | { type: "presence_ack"; requestId: string; group: string }
  | { type: "presence_failed"; requestId: string; reason: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; attemptId?: string }
	| { type: "queued"; messageId: string; attemptId?: string; target: string; position: number }
	/** #3760: the send is held for a subagent that is being restored; wait up to `timeoutMs` for its outcome. */
	| { type: "send_held"; messageId: string; attemptId?: string; timeoutMs: number }
	/**
	 * #4326: a send or ask is held for a released subagent this session reserved with `wake`; wake it. Sent once per
	 * hold that starts empty, so a wake that fails is asked for again by the next send.
	 */
	| { type: "restoring_recipient_wake"; childName: string; capability?: string }
	/**
	 * #5999: a message is queued for a subagent this session reported ended with `wake`: resume it, and answer with
	 * `answer_ended_child_wake` naming `wakeId`. `from` is the sender of the message that woke it; `depth` how far down a
	 * chain of wakes this one is. Sent once per wake, until the child registers or the wake fails.
	 */
	| {
			type: "ended_child_wake";
			childName: string;
			childId?: string;
			wakeId: string;
			from: { id: string; name?: string };
			depth: number;
	  }
	/** #4326: `handoffId` identifies this handoff, so the owner's acknowledgement cannot confirm another reply that reuses the message id. */
	| { type: "released_child_reply"; childName: string; handoffId: string; replyTo: string; from: SessionInfo; message: Message }
	/**
	 * #5352: `published: false` when the reservation holds sends on the owner's broker but did not reach the shared
	 * database within the broker's bound; the broker keeps writing it there until it lands or the reservation ends.
	 */
	| { type: "restoring_recipient_ack"; requestId: string; error?: string; published?: boolean }
	| { type: "released_children_ack"; requestId: string; refusal?: ReleasedChildRefusal; published?: boolean; releaseStamp?: { broker: string; order: number }; current?: boolean }
	| { type: "hosted_sessions_ack"; requestId: string; sessions?: HostedSessionAssignment[]; refusal?: HostedSessionRefusal }
	| {
			type: "delivery_failed";
			messageId: string;
			reason: string;
			reasonCode?: DeliveryFailureReasonCode;
			attemptId?: string;
			/** #4997, #5101: the refusal may not be final (`route_unavailable`); older clients ignore it. */
			routeUnavailable?: true;
			/** #4386: the typed refusal of a reply to a released subagent; its `code` equals `reasonCode`. */
			error?: SerializedIntercomReleasedReplyError | SerializedIntercomHostedSessionError;
			/**
			 * #4639: why a subagent with no live session is gone. Carried apart from `error` and `reasonCode`, which older
			 * clients validate strictly; they read only `reason`, which is this error's message.
			 */
			recipientError?: SerializedIntercomRecipientGoneError;
	  }
	| { type: "broker_status"; requestId: string; report: BrokerStatusReport }
	| { type: "shutdown_ack"; requestId: string };
