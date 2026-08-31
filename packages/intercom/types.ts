export interface SessionInfo {
  id: string;
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
  /** Actionable remote failure for a correlated ask reply. */
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
			supervisor?: SupervisorRegistration;
			supervisorOwnerToken?: string;
	  }
	| { type: "unregister" }
  | { type: "list"; requestId: string; group?: string }
	| { type: "list_groups"; requestId: string }
	| { type: "join_group"; requestId: string; group: string }
	| { type: "leave_group"; requestId: string; group?: string }
  | { type: "authorize_supervisor"; requestId: string; childName: string; capability?: string }
  | { type: "send" | "supervisor_send"; to: string; message: Message; attemptId?: string }
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
  | { type: "register_pending_stage_route"; runId: string; group: string; capability: string }
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
		reason?: string;
		reasonCode?: "message_id_conflict";
	  }
  | {
      type: "presence";
      name?: string;
      status?: string;
      model?: string;
      groups?: string[];
      /** Legacy single-group membership; accepted alongside `groups` for compatibility. */
      group?: string;
      requestId?: string;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; supervisorSessionId?: string }
  | { type: "registration_failed"; reason: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
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
			stageKey: string;
			message: Message;
			live?: boolean;
	  }
  | { type: "live_workflow_stage_route_registered"; requestId: string }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "peer_disconnected"; replyTo: string; peerSessionId: string; peerName?: string }
  | { type: "presence_ack"; requestId: string; group: string }
  | { type: "presence_failed"; requestId: string; reason: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; attemptId?: string }
  | { type: "queued"; messageId: string; attemptId?: string; runId: string; stageKey: string; position: number }
	| { type: "delivery_failed"; messageId: string; reason: string; reasonCode?: "message_id_conflict"; attemptId?: string };
