import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerPidPath, getBrokerSocketPath, getIntercomDirPath } from "./paths.js";
import type { SessionInfo, BrokerMessage } from "../types.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import { handleBrokerSend, type BrokerConnectedSession } from "./send-handler.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { normalizeGroup } from "../group.js";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath();

type ConnectedSession = BrokerConnectedSession;

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.group !== undefined && typeof session.group !== "string") {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}

class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private deliveredMessages = new DeliveredMessageCache();
  private supervisorChannel = new SupervisorChannelCache();

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        const leavingGroup = this.sessions.get(sessionId)?.info.group;
        this.sessions.delete(sessionId);
        this.broadcastToGroup({ type: "session_left", sessionId }, leavingGroup, sessionId);

        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }

  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        const id = randomUUID();
        setId(id);
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          group: normalizeGroup(clientMessage.session.group),
        };
        this.sessions.set(id, { socket, info });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, { type: "registered", sessionId: id });
        this.broadcastToGroup({ type: "session_joined", session: info }, info.group, id);
        break;
      }

      case "unregister": {
        const leavingGroup = this.sessions.get(currentId)?.info.group;
        this.sessions.delete(currentId);
        this.broadcastToGroup({ type: "session_left", sessionId: currentId }, leavingGroup, currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        if (clientMessage.group !== undefined && typeof clientMessage.group !== "string") {
          throw new Error("Invalid list group");
        }

        const requester = currentId ? this.sessions.get(currentId) : undefined;
        const effectiveGroup = normalizeGroup(
          typeof clientMessage.group === "string" ? clientMessage.group : requester?.info.group,
        );
        const sessions = Array.from(this.sessions.values())
          .map((s) => s.info)
          .filter((info) => normalizeGroup(info.group) === effectiveGroup);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "send": {
        handleBrokerSend(socket, clientMessage, currentId, this.sessions, this.deliveredMessages, writeMessage, this.supervisorChannel);
        break;
      }

      case "presence": {
        const session = this.sessions.get(currentId);
        if (session) {
          if (clientMessage.name !== undefined) {
            if (typeof clientMessage.name !== "string") {
              throw new Error("Invalid presence name");
            }
            session.info.name = clientMessage.name;
          }
          if (clientMessage.status !== undefined) {
            if (typeof clientMessage.status !== "string") {
              throw new Error("Invalid presence status");
            }
            session.info.status = clientMessage.status;
          }
          if (clientMessage.model !== undefined) {
            if (typeof clientMessage.model !== "string") {
              throw new Error("Invalid presence model");
            }
            session.info.model = clientMessage.model;
          }
          session.info.lastActivity = Date.now();
          this.broadcastToGroup({ type: "presence_update", session: session.info }, session.info.group, currentId);
        }
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  /** Deliver a broadcast only to sessions in the given (normalized) group. */
  private broadcastToGroup(msg: BrokerMessage, group: string | undefined, exclude?: string): void {
    const target = normalizeGroup(group);
    for (const [id, session] of this.sessions) {
      if (id !== exclude && normalizeGroup(session.info.group) === target) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

new IntercomBroker().start();
