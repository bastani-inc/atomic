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
	readonly deliveryStates?: readonly WorkflowStickyDeliveryState[];
	readonly deliveryOnly?: true;
}

export interface WorkflowFutureStageRosterEntry {
	readonly kind: "workflow-future-stage";
	readonly runId: string;
	readonly target: string;
	readonly queuedCount: number;
	readonly group: string;
	readonly deliveryStates?: readonly WorkflowStickyDeliveryState[];
	readonly deliveryOnly?: true;
}

export interface SessionDirectory {
	readonly sessions: SessionInfo[];
 	readonly workflowStages: WorkflowStageRosterEntry[];
	readonly workflowFutureStages: WorkflowFutureStageRosterEntry[];
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

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
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
	  }
	| { type: "unregister" }
  | { type: "list"; requestId: string; group?: string }
	| { type: "list_groups"; requestId: string }
	| { type: "join_group"; requestId: string; group: string }
	| { type: "leave_group"; requestId: string; group?: string }
  | { type: "authorize_supervisor"; requestId: string; childName: string; capability?: string }
  /**
   * #3760: the supervisor that holds `capability` for a child it is restoring holds sends to that child's name and
   * `aliases` (its Atomic session id and pre-restart Intercom id) until the child registers with the capability.
   */
  | { type: "reserve_restoring_recipient"; requestId: string; capability: string; group?: string; aliases?: string[] }
  /** #3760: end that hold; with `gone` (the reason), held and later senders are told the child is gone. */
  | { type: "release_restoring_recipient"; requestId: string; capability: string; gone?: string }
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
		runId: string;
		group: string;
		capability: string;
		stages?: WorkflowStageRosterAnnouncement[];
		possibleStages?: WorkflowPossibleStageAnnouncement[];
		parent?: WorkflowRunParentAnnouncement;
		/** Interrupted run queued by its restarted owner before resume; yields to the process that resumes it (#3760). */
		dormant?: true;
	}
  | {
      type: "register_live_workflow_stage_route";
      requestId: string;
      runId: string;
      stageKeys: string[];
      capability: string;
    }
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
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; supervisorSessionId?: string }
  | { type: "registration_failed"; reason: string; code?: LiveWorkflowStageRouteRefusalCode }
  | { type: "question_target"; messageId: string; attemptId: string; sessionId: string }
 | { type: "sessions"; requestId: string; sessions: SessionInfo[]; workflowStages?: WorkflowStageRosterEntry[]; workflowFutureStages?: WorkflowFutureStageRosterEntry[] }
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
	  }
  | { type: "live_workflow_stage_route_registered"; requestId: string }
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
	| { type: "delivery_failed"; messageId: string; reason: string; reasonCode?: "message_id_conflict" | "session_not_found"; attemptId?: string };
