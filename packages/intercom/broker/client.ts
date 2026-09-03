import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerSocketPath } from "./paths.js";
import type {
	SessionInfo,
	Message,
	Attachment,
	GroupSummary,
	SupervisorRegistration,
	SessionDirectory,
	WorkflowStageRosterAnnouncement,
	WorkflowStageRosterEntry,
	WorkflowFutureStageRosterEntry,
	WorkflowPossibleStageAnnouncement,
} from "../types.js";
import { buildSendSignature, PendingSendRegistry } from "./pending-send-registry.js";
import { readSubagentMessageSource } from "../source-ownership.js";
import { isMessage, isSessionInfo } from "./client-message-validation.js";
import { normalizeGroups } from "../group.js";
import { IntercomClientDisconnectedError } from "../recoverable-disconnect.js";

const BROKER_SOCKET = getBrokerSocketPath();
const GROUP_REQUEST_TIMEOUT_MS = 5000;
const PRESENCE_ACK_TIMEOUT_MS = 5000;


export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  replyError?: string;
  messageId?: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  queued?: boolean;
  reason?: string;
	reasonCode?: "message_id_conflict";
	target?: string;
  position?: number;
  /** D4 speculative accept: the sticky target is not in the run's persisted possible-stage set. */
  notInKnownSet?: true;
}

export interface PendingStageMessageRequest {
	readonly requestId: string;
	readonly from: SessionInfo;
	readonly runId: string;
	readonly target: string;
	readonly message: Message;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly live?: boolean;
}

/** Broker → route owner: the live stage targets a sticky broadcast was actually written to. */
export interface StickyLiveDeliveredNotice {
	readonly runId: string;
	readonly messageId: string;
	readonly target: string;
	readonly deliveredTargets: readonly string[];
}

export interface PendingStageNotificationRequest {
	readonly requestId: string;
	readonly from: SessionInfo;
	readonly message: Message;
}

export type PendingStageMessageResult =
	| {
			readonly outcome: "queued";
			readonly position: number;
			readonly notInKnownSet?: true;
			readonly forwardTargets?: readonly string[];
	  }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "forward"; readonly target: string }
	| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" };
export interface PresenceUpdates {
  name?: string;
  status?: string;
  model?: string;
  groups?: string[];
  group?: string;
}


export interface SupervisorAuthorization extends SupervisorRegistration {
  childName: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}



function isWorkflowFutureStageRosterEntries(value: unknown): value is WorkflowFutureStageRosterEntry[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as WorkflowFutureStageRosterEntry).kind === "workflow-future-stage" &&
				typeof (entry as WorkflowFutureStageRosterEntry).runId === "string" &&
				typeof (entry as WorkflowFutureStageRosterEntry).target === "string" &&
				typeof (entry as WorkflowFutureStageRosterEntry).queuedCount === "number" &&
				Number.isInteger((entry as WorkflowFutureStageRosterEntry).queuedCount) &&
				(entry as WorkflowFutureStageRosterEntry).queuedCount >= 0 &&
				typeof (entry as WorkflowFutureStageRosterEntry).group === "string",
		)
	);
}
function isWorkflowStageRosterEntries(value: unknown): value is WorkflowStageRosterEntry[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as WorkflowStageRosterEntry).kind === "workflow-stage" &&
				typeof (entry as WorkflowStageRosterEntry).runId === "string" &&
				typeof (entry as WorkflowStageRosterEntry).stageId === "string" &&
				typeof (entry as WorkflowStageRosterEntry).stageName === "string" &&
				typeof (entry as WorkflowStageRosterEntry).target === "string" &&
				((entry as WorkflowStageRosterEntry).lifecycle === "pending" ||
					(entry as WorkflowStageRosterEntry).lifecycle === "running") &&
				typeof (entry as WorkflowStageRosterEntry).group === "string" &&
				((entry as WorkflowStageRosterEntry).sessionId === undefined ||
					typeof (entry as WorkflowStageRosterEntry).sessionId === "string"),
		)
	);
}

export class IntercomClient extends EventEmitter {
	private readonly returnAddress: string;
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private _supervisorSessionId: string | null = null;
  /** Source identity is captured once at connect, never read from env per message. */
  private _messageSource: Message["source"] | undefined;
  private pendingSends = new PendingSendRegistry();
  private pendingGroupLists = new Map<string, { resolve: (groups: GroupSummary[]) => void; reject: (error: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (directory: SessionDirectory) => void; reject: (e: Error) => void }>();
  private pendingPresence = new Map<string, {
    resolve: (group: string) => void;
    reject: (error: Error) => void;
    groups?: string[];
  }>();
  private pendingMemberships = new Map<string, { resolve: (groups: string[]) => void; reject: (error: Error) => void }>();
  private _groups = normalizeGroups();
  private pendingLiveWorkflowStageRoutes = new Map<string, { resolve(): void; reject(error: Error): void }>();

  private pendingSupervisorAuthorizations = new Map<string, {
    resolve: (authorization: SupervisorAuthorization) => void;
    reject: (error: Error) => void;
  }>();
  private disconnecting = false;
  private disconnectError: Error | null = null;

	constructor(returnAddress: string = randomUUID()) {
		super();
		if (returnAddress.length === 0) throw new Error("Intercom return address must not be empty");
		this.returnAddress = returnAddress;
	}

  private failPending(error: Error): void {
    this.pendingSends.rejectAll(error);
    for (const pending of this.pendingGroupLists.values()) pending.reject(error);
    for (const pending of this.pendingLists.values()) pending.reject(error);
    for (const pending of this.pendingSupervisorAuthorizations.values()) pending.reject(error);
    for (const pending of this.pendingPresence.values()) pending.reject(error);
    for (const pending of this.pendingMemberships.values()) pending.reject(error);
    for (const pending of this.pendingLiveWorkflowStageRoutes.values()) pending.reject(error);
    this.pendingLists.clear();
    this.pendingGroupLists.clear();
    this.pendingSupervisorAuthorizations.clear();
    this.pendingPresence.clear();
    this.pendingMemberships.clear();
    this.pendingLiveWorkflowStageRoutes.clear();
  }


  get sessionId(): string | null {
    return this._sessionId;
  }
  get supervisorSessionId(): string | null {
    return this._supervisorSessionId;
  }
  get groups(): string[] {
    return [...this._groups];
  }



  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new IntercomClientDisconnectedError();
    }

    return socket;
  }

  connect(
    session: Omit<SessionInfo, "id">,
    supervisor?: SupervisorRegistration,
    supervisorOwnerToken?: string,
    messageSource?: Message["source"],
  ): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    this._messageSource = messageSource ?? readSubagentMessageSource();
    this._groups = normalizeGroups(session.groups, session.group);

    return new Promise((resolve, reject) => {
      const socket = net.connect(BROKER_SOCKET);
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 10000);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      const onRegistrationFailed = (error: Error) => onError(error);
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new IntercomClientDisconnectedError();
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this._supervisorSessionId = null;
        this._messageSource = undefined;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          // A transport error on an already-registered socket (ECONNRESET, EPIPE,
          // ETIMEDOUT, or a write-after-end from our own write) is a *recoverable*
          // disconnect: the broker connection is gone, and the lightweight wrapper
          // re-imports and reconnects on the next call. Record it as the typed
          // recoverable error so `onClose` rejects pending work and emits
          // `disconnected` with something the classifier recognizes, and keep the
          // raw transport error as `cause` so the code is still diagnosable.
          //
          // `??=`, not `=`: `onReaderError` records a protocol error and then
          // destroys the socket, and a socket 'error' can still follow. Overwriting
          // would silently downgrade a non-recoverable protocol failure into a
          // recoverable one. First error recorded wins.
          this.disconnectError ??= new IntercomClientDisconnectedError({ cause: err });
          // The raw error keeps flowing to `error` listeners: that channel exists for
          // diagnosis, and the transport code is what a debugger wants to see.
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        this.off("_registration_failed", onRegistrationFailed);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      this.once("_registration_failed", onRegistrationFailed);
      
      try {
        writeMessage(socket, {
          type: "register",
          session,
			returnAddress: this.returnAddress,
          ...(supervisor ? { supervisor } : {}),
          ...(supervisorOwnerToken ? { supervisorOwnerToken } : {}),
        });
      } catch (error) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error));
      }
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null
      && brokerMessage.type !== "registered"
      && brokerMessage.type !== "registration_failed") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string"
          || (brokerMessage.supervisorSessionId !== undefined && typeof brokerMessage.supervisorSessionId !== "string")) {
          throw new Error("Invalid registered message");
        }

        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        this._sessionId = brokerMessage.sessionId;
        this._supervisorSessionId = typeof brokerMessage.supervisorSessionId === "string"
          ? brokerMessage.supervisorSessionId
          : null;
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "registration_failed": {
        if (typeof brokerMessage.reason !== "string") throw new Error("Invalid registration_failed message");
        this.emit("_registration_failed", new Error(brokerMessage.reason));
        break;
      }
      case "sessions": {
		const { requestId, sessions, workflowStages, workflowFutureStages } = brokerMessage;
		if (
			typeof requestId !== "string" ||
			!Array.isArray(sessions) ||
			!sessions.every(isSessionInfo) ||
			(workflowStages !== undefined && !isWorkflowStageRosterEntries(workflowStages)) ||
			(workflowFutureStages !== undefined && !isWorkflowFutureStageRosterEntries(workflowFutureStages))
		) {
			throw new Error("Invalid sessions message");
		}
		const pending = this.pendingLists.get(requestId);
		if (!pending) return;
		this.pendingLists.delete(requestId);
		pending.resolve({
			sessions,
			workflowStages: workflowStages ?? [],
			workflowFutureStages: workflowFutureStages ?? [],
		});
		break;
	  }
      case "groups": {
        const { requestId, groups } = brokerMessage;
        if (
          typeof requestId !== "string" ||
          !Array.isArray(groups) ||
          !groups.every((summary) =>
            typeof summary === "object" &&
            summary !== null &&
            typeof summary.group === "string" &&
            typeof summary.sessionCount === "number" &&
            typeof summary.member === "boolean"
          )
        ) {
          throw new Error("Invalid groups message");
        }
        const pending = this.pendingGroupLists.get(requestId);
        if (!pending) return;
        this.pendingGroupLists.delete(requestId);
        pending.resolve(groups as GroupSummary[]);
        break;
      }
      case "supervisor_authorized": {
        const { requestId, capability, supervisorSessionId, childName } = brokerMessage;
        if (typeof requestId !== "string" || typeof capability !== "string"
          || typeof supervisorSessionId !== "string" || typeof childName !== "string") {
          throw new Error("Invalid supervisor_authorized message");
        }
        const pending = this.pendingSupervisorAuthorizations.get(requestId);
        if (!pending) return;
        this.pendingSupervisorAuthorizations.delete(requestId);
        pending.resolve({ capability, supervisorSessionId, childName });
        break;
      }
      case "message": {
        const { from, message, channel } = brokerMessage;
        if (!isSessionInfo(from) || !isMessage(message) || (channel !== undefined && channel !== "supervisor")) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message, channel);
        break;
      }
		case "pending_stage_message": {
			const { requestId, from, senderRegistrationName, senderReturnAddress, runId, target, message, live } = brokerMessage;
			if (
				typeof requestId !== "string" ||
				!isSessionInfo(from) ||
				(senderRegistrationName !== undefined && typeof senderRegistrationName !== "string") ||
				(senderReturnAddress !== undefined && typeof senderReturnAddress !== "string") ||
				typeof runId !== "string" ||
				typeof target !== "string" ||
				!isMessage(message) ||
				(live !== undefined && typeof live !== "boolean")
			) {
				throw new Error("Invalid pending-stage message event");
			}
			this.emit("pending_stage_message", {
				requestId,
				from,
				...(senderRegistrationName === undefined ? {} : { senderRegistrationName }),
				...(senderReturnAddress === undefined ? {} : { senderReturnAddress }),
				runId,
				target,
				message,
				...(live === true ? { live: true } : {}),
			} satisfies PendingStageMessageRequest);
			break;
		}
		case "pending_stage_notification": {
			const { requestId, from, message } = brokerMessage;
			if (typeof requestId !== "string" || !isSessionInfo(from) || !isMessage(message)) {
				throw new Error("Invalid pending-stage notification event");
			}
			this.emit("pending_stage_notification", {
				requestId,
				from,
				message,
			} satisfies PendingStageNotificationRequest);
			break;
		}
		case "sticky_live_delivered": {
			const { runId, messageId, target, deliveredTargets } = brokerMessage;
			if (
				typeof runId !== "string" ||
				typeof messageId !== "string" ||
				typeof target !== "string" ||
				!Array.isArray(deliveredTargets) ||
				!deliveredTargets.every((entry) => typeof entry === "string")
			) {
				throw new Error("Invalid sticky live-delivery event");
			}
			this.emit("sticky_live_delivered", {
				runId,
				messageId,
				target,
				deliveredTargets,
			} satisfies StickyLiveDeliveredNotice);
			break;
		}
      case "live_workflow_stage_route_registered": {
        const { requestId } = brokerMessage;
        if (typeof requestId !== "string") throw new Error("Invalid live workflow-stage route registration");
        const pending = this.pendingLiveWorkflowStageRoutes.get(requestId);
        if (!pending) return;
        this.pendingLiveWorkflowStageRoutes.delete(requestId);
        pending.resolve();
        break;
      }
      case "queued": {
		const { messageId, attemptId, target, position, notInKnownSet } = brokerMessage;
        if (
          typeof messageId !== "string" ||
          (attemptId !== undefined && typeof attemptId !== "string") ||
			typeof target !== "string" ||
          typeof position !== "number" ||
          position < 1 ||
			(notInKnownSet !== undefined && notInKnownSet !== true)
        ) {
          throw new Error("Invalid queued message");
        }
		const result = {
			id: messageId,
			delivered: false,
			queued: true,
			target,
			position,
			...(notInKnownSet === true ? { notInKnownSet: true as const } : {}),
		} as const;
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "delivered": {
        const { messageId, attemptId } = brokerMessage;
        if (typeof messageId !== "string" || (attemptId !== undefined && typeof attemptId !== "string")) {
          throw new Error("Invalid delivered message");
        }
        const result = { id: messageId, delivered: true } as const;
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "delivery_failed": {
		const { messageId, attemptId, reason, reasonCode } = brokerMessage;
		if (
			typeof messageId !== "string" ||
			(attemptId !== undefined && typeof attemptId !== "string") ||
			typeof reason !== "string" ||
			(reasonCode !== undefined && reasonCode !== "message_id_conflict")
		) {
			throw new Error("Invalid delivery_failed message");
		}
		const result = {
			id: messageId,
			delivered: false,
			reason,
			...(reasonCode === undefined ? {} : { reasonCode }),
		} as const;
		if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
		else this.pendingSends.resolve(messageId, attemptId, result);
		break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "presence_ack": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.group !== "string") {
          throw new Error("Invalid presence_ack message");
        }
        const pending = this.pendingPresence.get(brokerMessage.requestId);
        if (!pending) return;
        this.pendingPresence.delete(brokerMessage.requestId);
        this._groups = pending.groups === undefined
          ? normalizeGroups(undefined, brokerMessage.group)
          : normalizeGroups(pending.groups);
        pending.resolve(brokerMessage.group);
        break;
      }
      case "membership_ack": {
        const { requestId, groups } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(groups) || !groups.every((group) => typeof group === "string")) {
          throw new Error("Invalid membership_ack message");
        }
        const pending = this.pendingMemberships.get(requestId);
        if (!pending) return;
        this.pendingMemberships.delete(requestId);
        const normalizedGroups = [...normalizeGroups(groups)];
        this._groups = new Set(normalizedGroups);
        pending.resolve(normalizedGroups);
        break;
      }
      case "presence_failed": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.reason !== "string") {
          throw new Error("Invalid presence_failed message");
        }
        const presence = this.pendingPresence.get(brokerMessage.requestId);
        if (presence) {
          this.pendingPresence.delete(brokerMessage.requestId);
          presence.reject(new Error(brokerMessage.reason));
          break;
        }
        const membership = this.pendingMemberships.get(brokerMessage.requestId);
        if (!membership) return;
        this.pendingMemberships.delete(brokerMessage.requestId);
        membership.reject(new Error(brokerMessage.reason));
        break;
      }
      case "peer_disconnected": {
        const { replyTo, peerSessionId, peerName } = brokerMessage;
        if (typeof replyTo !== "string" || typeof peerSessionId !== "string"
          || (peerName !== undefined && typeof peerName !== "string")) {
          throw new Error("Invalid peer_disconnected message");
        }
        this.emit("peer_disconnected", {
          replyTo,
          peerSessionId,
          ...(peerName !== undefined ? { peerName } : {}),
        });
        break;
      }
      case "error": {
        if (typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        this.emit("error", new Error(brokerMessage.error));
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new IntercomClientDisconnectedError());
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }
  async listSessions(group?: string): Promise<SessionInfo[]> {
	return (await this.listDirectory(group)).sessions;
  }

  listDirectory(group?: string): Promise<SessionDirectory> {
	let socket: net.Socket;
	try {
		socket = this.requireActiveSocket();
	} catch (error) {
		return Promise.reject(toError(error));
	}
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const timeout = setTimeout(() => {
			if (!this.pendingLists.delete(requestId)) return;
			reject(new Error("List sessions timeout"));
		}, 5000);
		this.pendingLists.set(requestId, {
			resolve: (directory) => {
				clearTimeout(timeout);
				resolve(directory);
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		});
		try {
			writeMessage(socket, group === undefined ? { type: "list", requestId } : { type: "list", requestId, group });
		} catch (error) {
			clearTimeout(timeout);
			this.pendingLists.delete(requestId);
			reject(toError(error));
		}
	});
  }
  listGroups(): Promise<GroupSummary[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingGroupLists.delete(requestId)) return;
        reject(new Error("List groups timeout"));
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingGroupLists.set(requestId, {
        resolve: (groups) => { clearTimeout(timeout); resolve(groups); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, { type: "list_groups", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingGroupLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  joinGroup(group: string): Promise<string[]> {
    return this.updateMembership("join_group", group);
  }

  leaveGroup(group?: string): Promise<string[]> {
    return this.updateMembership("leave_group", group);
  }

  private updateMembership(type: "join_group" | "leave_group", group?: string): Promise<string[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingMemberships.delete(requestId)) return;
        reject(new Error("Membership update timeout"));
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingMemberships.set(requestId, {
        resolve: (groups) => { clearTimeout(timeout); resolve(groups); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, group === undefined ? { type, requestId } : { type, requestId, group });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMemberships.delete(requestId);
        reject(toError(error));
      }
    });
  }


  authorizeSupervisorChild(childName: string, capability?: string): Promise<SupervisorAuthorization> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const normalizedChildName = childName.trim();
    if (!normalizedChildName) return Promise.reject(new Error("Child session name is required"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        if (!this.pendingSupervisorAuthorizations.delete(requestId)) return;
        reject(new Error("Supervisor authorization timeout"));
      }, 5000);
      this.pendingSupervisorAuthorizations.set(requestId, {
        resolve: (authorization) => { clearTimeout(timeout); resolve(authorization); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, capability
          ? { type: "authorize_supervisor", requestId, childName: normalizedChildName, capability }
          : { type: "authorize_supervisor", requestId, childName: normalizedChildName });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSupervisorAuthorizations.delete(requestId);
        reject(toError(error));
      }
    });
  }
  registerPendingStageRoute(
	runId: string,
	group: string,
	capability: string,
	stages?: WorkflowStageRosterAnnouncement[],
	possibleStages?: WorkflowPossibleStageAnnouncement[],
  ): void {
	writeMessage(this.requireActiveSocket(), {
		type: "register_pending_stage_route",
		runId,
		group,
		capability,
		stages,
		possibleStages,
	});
  }

  registerLiveWorkflowStageRoute(runId: string, stageKeys: readonly string[], capability: string): Promise<void> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingLiveWorkflowStageRoutes.set(requestId, { resolve, reject });
      try {
        writeMessage(socket, {
          type: "register_live_workflow_stage_route",
          requestId,
          runId,
          stageKeys: [...stageKeys],
          capability,
        });
      } catch (error) {
        this.pendingLiveWorkflowStageRoutes.delete(requestId);
        reject(toError(error));
      }
    });
  }

	respondPendingStageMessage(requestId: string, result: PendingStageMessageResult): void {
		const socket = this.requireActiveSocket();
		writeMessage(
			socket,
			result.outcome === "queued"
				? {
						type: "pending_stage_message_result",
						requestId,
						outcome: "queued",
						position: result.position,
						...(result.notInKnownSet === true ? { notInKnownSet: true as const } : {}),
						...(result.forwardTargets === undefined ? {} : { forwardTargets: [...result.forwardTargets] }),
					}
				: result.outcome === "forward"
					? { type: "pending_stage_message_result", requestId, outcome: "forward", target: result.target }
					: result.outcome === "refused"
						? {
								type: "pending_stage_message_result",
								requestId,
								outcome: "refused",
								reason: result.reason,
								...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
							}
						: { type: "pending_stage_message_result", requestId, outcome: result.outcome },
		);
	}

	respondPendingStageNotification(requestId: string, delivered: boolean): void {
		writeMessage(this.requireActiveSocket(), { type: "pending_stage_notification_result", requestId, delivered });
	}

  send(to: string, options: SendOptions): Promise<SendResult> {
    return this.sendFrame("send", to, options);
  }

	sendPendingStageNotification(
		runId: string,
		capability: string,
		to: string,
		senderRegistrationName: string | undefined,
		options: SendOptions,
		senderReturnAddress?: string,
	): Promise<SendResult> {
		return this.sendFrame("send_pending_stage_notification", to, options, {
			runId,
			capability,
			...(senderRegistrationName === undefined ? {} : { senderRegistrationName }),
			...(senderReturnAddress === undefined ? {} : { senderReturnAddress }),
		});
	}

  sendToSupervisor(to: string, options: SendOptions): Promise<SendResult> {
    return this.sendFrame("supervisor_send", to, options);
  }

	private sendFrame(
		type: "send" | "supervisor_send" | "send_pending_stage_notification",
		to: string,
		options: SendOptions,
		extra: {
			readonly runId: string;
			readonly capability: string;
			readonly senderRegistrationName?: string;
			readonly senderReturnAddress?: string;
		} | undefined = undefined,
	): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID();
    let acquired;
    try {
      acquired = this.pendingSends.acquire(messageId, buildSendSignature(to, options), 10000);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (!acquired.owner) return acquired.attempt.promise;
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      replyError: options.replyError,
      source: this._messageSource,
      content: { text: options.text, attachments: options.attachments },
    };
    try {
		writeMessage(socket, { type, to, message, attemptId: acquired.attempt.attemptId, ...extra });
    } catch (error) {
      this.pendingSends.reject(acquired.attempt, toError(error));
    }
    return acquired.attempt.promise;
  }
  updatePresence(updates: PresenceUpdates): boolean {
    if (this.disconnecting) {
      return false;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }
    writeMessage(socket, { type: "presence", ...updates });
    if (updates.groups !== undefined) this._groups = normalizeGroups(updates.groups, updates.group);
    else if (updates.group !== undefined) this._groups = normalizeGroups(undefined, updates.group);
    return true;
  }

  updatePresenceAcked(updates: PresenceUpdates): Promise<string> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const wrappedResolve = (group: string): void => {
        clearTimeout(timeout);
        resolve(group);
      };
      const wrappedReject = (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (!this.pendingPresence.delete(requestId)) return;
        reject(new Error("Presence update timeout"));
      }, PRESENCE_ACK_TIMEOUT_MS);
      this.pendingPresence.set(requestId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        ...(updates.groups === undefined ? {} : { groups: [...updates.groups] }),
      });
      try {
        writeMessage(socket, { type: "presence", ...updates, requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingPresence.delete(requestId);
        reject(toError(error));
      }
    });
  }
}
