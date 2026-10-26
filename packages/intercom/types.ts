import type { LiveWorkflowStageRouteRefusalCode } from "./live-route-refusal.js";

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

export interface WorkflowStageRosterEntry {
	readonly kind: "workflow-stage";
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly target: string;
	readonly lifecycle: "pending" | "running";
	readonly group: string;
	/** Broker session identity, present only while the workflow stage is connected. */
	readonly sessionId?: string;
}

/** Internal run-tree edge used to resolve known recipients before dispatching to the owner. */
export interface WorkflowRunParentAnnouncement {
	readonly runId: string;
	/** Boundary spellings that resolve uniquely to this child, with stage-ID precedence applied by the host. */
	readonly stageKeys: readonly string[];
}

export interface WorkflowStickyDeliveryState {
	readonly messageId: string;
	readonly runId: string;
	readonly stageId: string;
	readonly sessionId?: string;
	readonly state: string;
	readonly reason: string;
}

export interface WorkflowPossibleStageAnnouncement {
	/** Canonical depth-faithful path target, e.g. `workflow:<rootRunId>/orchestrator-*`. */
	readonly target: string;
	/** Current number of queued sticky entries matching this target. */
	readonly queuedCount: number;
	/** At most a fixed number of exemplar states: unresolved states first, then the latest delivered. */
	readonly deliveryStates?: readonly WorkflowStickyDeliveryState[];
	/** Delivery states per state, over every state of this row, including omitted ones. */
	readonly deliveryStateCounts?: Readonly<Record<string, number>>;
	/** Delivery states left out of `deliveryStates`. */
	readonly omittedDeliveryStates?: number;
	readonly deliveryOnly?: true;
}

export interface WorkflowFutureStageRosterEntry {
	readonly kind: "workflow-future-stage";
	readonly runId: string;
	readonly target: string;
	readonly queuedCount: number;
	readonly group: string;
	readonly deliveryStates?: readonly WorkflowStickyDeliveryState[];
	readonly deliveryStateCounts?: Readonly<Record<string, number>>;
	readonly omittedDeliveryStates?: number;
	readonly deliveryOnly?: true;
}

export interface SessionDirectory {
	readonly sessions: SessionInfo[];
 	readonly workflowStages: WorkflowStageRosterEntry[];
	readonly workflowFutureStages: WorkflowFutureStageRosterEntry[];
	/** The peeked workflow invocation group exists but is visible only to its members. */
	readonly restricted?: true;
 }

export interface WorkflowStageRosterAnnouncement {
	readonly stageId: string;
	readonly stageName: string;
	readonly target: string;
	readonly lifecycle: "pending" | "running";
	readonly routeEligible: boolean;
	/** Host-declared node purpose, independent of legacy pending-route eligibility. */
	readonly recipientPurpose?: "agent" | "control";
	/** Actual stage group after workflow invocation ownership resolution. */
	readonly group: string;
}


export interface GroupSummary {
	group: string;
	sessionCount: number;
	member: boolean;
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
	/** The shared storage selection the broker read, as a digest of its JSON, and where it read it; absent without one. */
	storage?: { digest: string; source: "env" | "settings" };
	multiNode: BrokerMultiNodeStatus;
}

export type IntercomDeliveryMode = "steer" | "followUp" | "interrupt";

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
  source?: {
    subagentRunId: string;
    subagentAgent?: string;
    subagentIndex?: number;
  };
  content: {
    text: string;
    attachments?: Attachment[];
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


export type ClientMessage =
	| { type: "health"; requestId: string }
	| {
			type: "register";
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
	  }
	| { type: "unregister" }
	/** #3761: the recipient saved this message; it ignores a copy of it sent again. */
	| { type: "received"; messageId: string }
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
  | { type: "reserve_restoring_recipient"; requestId: string; capability: string; group?: string; aliases?: string[]; dormant?: boolean }
  /**
   * #3760: end that hold. With `gone` (the reason), held and later senders are told the child is gone. With `refusal`,
   * the senders held now are told that reason instead and later ones are routed normally. Otherwise held sends are
   * routed normally.
   */
  | { type: "release_restoring_recipient"; requestId: string; capability: string; gone?: string; refusal?: string }
  | {
      type: "send" | "supervisor_send";
      to: string;
      logicalTarget?: string;
      requirePendingReply?: true;
      expectedRecipientId?: string;
      resolveReplyTarget?: true;
      /** The sender understands `send_held` and may wait past its usual acknowledgement timeout (#3760). */
      awaitRestoringRecipient?: true;
      message: Message;
      attemptId?: string;
    }
	| {
			type: "send_pending_stage_notification";
			runId: string;
			capability: string;
			to: string;
			senderRegistrationName?: string;
			senderReturnAddress?: string;
			message: Message;
			attemptId?: string;
	  }
	| { type: "pending_stage_notification_result"; requestId: string; delivered: boolean }
 | {
		type: "register_pending_stage_route";
		/** When present, the broker answers with `pending_stage_route_registered` once the route is applied. */
		requestId?: string;
		runId: string;
		group: string;
		capability: string;
		stages?: WorkflowStageRosterAnnouncement[];
		possibleStages?: WorkflowPossibleStageAnnouncement[];
		parent?: WorkflowRunParentAnnouncement;
		/** Interrupted run queued by its restarted owner before resume; yields to the process that resumes it (#3760). */
		dormant?: true;
		/**
		 * #3906: the connection carries the routes of many runs, so a refusal of this one is answered with
		 * `pending_stage_route_refused` and leaves the connection open. Honoured only with a `requestId`, and sent only to
		 * a broker that advertised `refusesPendingStageRoutesInPlace`; an older broker ignores it and ends the connection.
		 */
		refusalKeepsConnection?: true;
	}
  | {
      type: "register_live_workflow_stage_route";
      requestId: string;
      runId: string;
      stageKeys: string[];
      capability: string;
    }
	/**
	 * #4006: the session that launched a run proves it with the run's route capability and gains the
	 * invocation's send authority without joining `workflow:<rootRunId>`. Sent only to a broker that
	 * advertised `claimsWorkflowInvocations`; the broker answers with `workflow_invocation_claimed`.
	 */
	| { type: "claim_workflow_invocation"; requestId: string; runId: string; capability: string }
	| {
		type: "pending_stage_message_result";
		requestId: string;
		outcome: "queued" | "delivered" | "forward" | "refused";
		position?: number;
		target?: string;
		reason?: string;
		reasonCode?: "message_id_conflict";
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
	/** Allowed before `register`: the broker's own status. */
	| { type: "broker_status"; requestId: string }
	/** Allowed before `register`: shut the broker down; its sessions reconnect to a new broker. */
	| { type: "shutdown"; requestId: string };

/** Why the broker refused a pending-stage route registration (#3906). Authorization decides these, not the client. */
export type PendingStageRouteRefusalCode = "not_authorized" | "invalid_stage_roster" | "invalid_possible_stage_roster";

export type BrokerMessage =
	| { type: "health"; requestId: string; instanceId: string }
	| {
			type: "registered";
			sessionId: string;
			supervisorSessionId?: string;
			/** #3761: echoed only to a client that advertised it; that client may now send `received`. */
			acknowledgesReceipt?: true;
			/** This broker acknowledges a `register_pending_stage_route` that carries a `requestId`; absent on older brokers. */
			acknowledgesPendingStageRoutes?: true;
			/** #3906: this broker honours `refusalKeepsConnection`; absent on older brokers, which end the connection. */
			refusesPendingStageRoutesInPlace?: true;
			/** This broker answers `broker_status`; absent on older brokers, which drop a client that sends it. */
			brokerStatus?: true;
			/** #4006: this broker accepts `claim_workflow_invocation`; absent on older brokers, which drop a client that sends it. */
			claimsWorkflowInvocations?: true;
	  }
	| { type: "workflow_invocation_claimed"; requestId: string; claimed: boolean }
  | { type: "registration_failed"; reason: string; code?: LiveWorkflowStageRouteRefusalCode; requestId?: string }
  | { type: "question_target"; messageId: string; attemptId: string; sessionId: string }
 | { type: "sessions"; requestId: string; sessions: SessionInfo[]; workflowStages?: WorkflowStageRosterEntry[]; workflowFutureStages?: WorkflowFutureStageRosterEntry[]; restricted?: true }
	| { type: "groups"; requestId: string; groups: GroupSummary[] }
	| { type: "membership_ack"; requestId: string; groups: string[] }
  | { type: "supervisor_authorized"; requestId: string; capability: string; supervisorSessionId: string; childName: string }
  | { type: "message"; from: SessionInfo; message: Message; channel?: "supervisor" }
	| { type: "pending_stage_notification"; requestId: string; from: SessionInfo; message: Message }
	| {
			type: "pending_stage_message";
			requestId: string;
			from: SessionInfo;
			senderRegistrationName?: string;
			senderReturnAddress?: string;
			runId: string;
			target: string;
			message: Message;
			live?: boolean;
			/** #4006: the broker authorized the sender as the session that launched this run, not by membership. */
			invocationControl?: true;
	  }
  | { type: "live_workflow_stage_route_registered"; requestId: string }
	| { type: "pending_stage_route_registered"; requestId: string }
	/** #3906: the registration `requestId` of run `runId` was refused; the connection and its other routes are kept. */
	| {
			type: "pending_stage_route_refused";
			requestId: string;
			runId: string;
			code: PendingStageRouteRefusalCode;
			reason: string;
	  }
	/** A dormant route's run was resumed by another process, which now owns the run's routes (#3760). */
	| { type: "pending_stage_route_revoked"; runId: string }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "peer_disconnected"; replyTo: string; peerSessionId: string; peerName?: string }
  | { type: "presence_ack"; requestId: string; group: string }
  | { type: "presence_failed"; requestId: string; reason: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; attemptId?: string }
	| { type: "queued"; messageId: string; attemptId?: string; target: string; position: number }
	/** #3760: the send is held for a subagent that is being restored; wait up to `timeoutMs` for its outcome. */
	| { type: "send_held"; messageId: string; attemptId?: string; timeoutMs: number }
	| { type: "restoring_recipient_ack"; requestId: string; error?: string }
	| { type: "delivery_failed"; messageId: string; reason: string; reasonCode?: "message_id_conflict" | "session_not_found"; attemptId?: string }
	| { type: "broker_status"; requestId: string; report: BrokerStatusReport }
	| { type: "shutdown_ack"; requestId: string };
