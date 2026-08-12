import type net from "node:net";
import type { BrokerMessage } from "../types.js";
import { normalizeGroup, validateRuntimeGroup } from "../group.js";
import type { BrokerConnectedSession } from "./send-handler.js";

interface PresenceClientMessage extends Record<string, unknown> {
	type: string;
}

type WriteMessage = (socket: net.Socket, message: BrokerMessage) => void;

function broadcastToGroup(
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
	message: BrokerMessage,
	group: string | undefined,
	exclude?: string,
): void {
	const target = normalizeGroup(group);
	for (const [id, session] of sessions) {
		if (id !== exclude && normalizeGroup(session.info.group) === target) {
			write(session.socket, message);
		}
	}
}

/** Apply one presence update and notify only the affected group members. */
export function handleBrokerPresence(
	socket: net.Socket,
	clientMessage: PresenceClientMessage,
	currentId: string | null,
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
): void {
	const rawRequestId = clientMessage.requestId;
	if (rawRequestId !== undefined && typeof rawRequestId !== "string") {
		throw new Error("Invalid presence requestId");
	}
	const requestId = typeof rawRequestId === "string" ? rawRequestId : undefined;
	if (currentId === null) {
		if (requestId !== undefined) {
			write(socket, { type: "presence_failed", requestId, reason: "Session not found" });
		}
		return;
	}
	const sessionId = currentId;
	const session = sessions.get(sessionId);
	if (!session) {
		if (requestId !== undefined) {
			write(socket, { type: "presence_failed", requestId, reason: "Session not found" });
		}
		return;
	}

	const fail = (reason: string): boolean => {
		if (requestId === undefined) throw new Error(reason);
		write(socket, { type: "presence_failed", requestId, reason });
		return true;
	};

	const previousGroup = normalizeGroup(session.info.group);
	let nextGroup = previousGroup;
	const rawGroup = clientMessage.group;
	if (rawGroup !== undefined) {
		if (typeof rawGroup !== "string") {
			if (fail("Invalid presence group")) return;
		} else {
			try {
				nextGroup = validateRuntimeGroup(rawGroup);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				if (fail(`Invalid presence group: ${reason}`)) return;
			}
		}
	}
	const name = clientMessage.name;
	if (name !== undefined && typeof name !== "string") {
		if (fail("Invalid presence name")) return;
	}
	const status = clientMessage.status;
	if (status !== undefined && typeof status !== "string") {
		if (fail("Invalid presence status")) return;
	}
	const model = clientMessage.model;
	if (model !== undefined && typeof model !== "string") {
		if (fail("Invalid presence model")) return;
	}

	if (typeof name === "string") session.info.name = name;
	if (typeof status === "string") session.info.status = status;
	if (typeof model === "string") session.info.model = model;
	session.info.group = nextGroup;
	session.info.lastActivity = Date.now();
	if (nextGroup !== previousGroup) {
		broadcastToGroup(sessions, write, { type: "session_left", sessionId }, previousGroup, sessionId);
		broadcastToGroup(sessions, write, { type: "session_joined", session: session.info }, nextGroup, sessionId);
	} else {
		broadcastToGroup(sessions, write, { type: "presence_update", session: session.info }, nextGroup, sessionId);
	}
	if (requestId !== undefined) {
		write(socket, { type: "presence_ack", requestId, group: nextGroup });
	}
}
