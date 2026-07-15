export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
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

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message; attemptId?: string }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string; attemptId?: string }
  | { type: "delivery_failed"; messageId: string; reason: string; attemptId?: string };
