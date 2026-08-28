import type net from "node:net";
import { addGroup, normalizeGroups, removeGroup, validateRuntimeGroup } from "../group.js";
import type { BrokerMessage } from "../types.js";
import { sessionGroups, sessionsShareGroup, setSessionGroups } from "./group-membership.js";
import type { BrokerConnectedSession } from "./send-handler.js";

interface PresenceClientMessage extends Record<string, unknown> {
	type: string;
}

type WriteMessage = (socket: net.Socket, message: BrokerMessage) => void;

function broadcastMembershipChange(
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
	session: BrokerConnectedSession,
	previous: ReadonlySet<string>,
): void {
	const previousInfo = { ...session.info, groups: [...previous], group: previous.values().next().value };
	for (const [id, peer] of sessions) {
		if (id === session.info.id) continue;
		const sharedBefore = sessionsShareGroup(previousInfo, peer.info);
		const sharedAfter = sessionsShareGroup(session.info, peer.info);
		if (!sharedBefore && sharedAfter) {
			write(peer.socket, { type: "session_joined", session: session.info });
		} else if (sharedBefore && !sharedAfter) {
			write(peer.socket, { type: "session_left", sessionId: session.info.id });
		} else if (sharedAfter) {
			write(peer.socket, { type: "presence_update", session: session.info });
		}
	}
}

/** Apply one presence or membership update and notify every affected group member. */
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
	const session = currentId === null ? undefined : sessions.get(currentId);
	if (!session) {
		if (requestId !== undefined) write(socket, { type: "presence_failed", requestId, reason: "Session not found" });
		return;
	}

	const fail = (reason: string): true => {
		if (requestId === undefined) throw new Error(reason);
		write(socket, { type: "presence_failed", requestId, reason });
		return true;
	};
	const previousGroups = sessionGroups(session.info);
	let nextGroups = new Set(previousGroups);
	let legacyGroup = session.info.group;

	try {
		if (clientMessage.type === "join_group") {
			nextGroups = addGroup(previousGroups, clientMessage.group);
		} else if (clientMessage.type === "leave_group") {
			if (clientMessage.group === undefined) {
				nextGroups = normalizeGroups(undefined, session.registrationGroup);
				legacyGroup = session.registrationGroup;
			} else {
				if (typeof clientMessage.group !== "string") return void fail("Invalid presence group");
				const group = validateRuntimeGroup(clientMessage.group);
				nextGroups = removeGroup(previousGroups, group);
				if (legacyGroup === group) legacyGroup = undefined;
			}
		} else {
			const rawGroups = clientMessage.groups;
			if (rawGroups !== undefined) {
				if (!Array.isArray(rawGroups) || !rawGroups.every((group) => typeof group === "string")) {
					return void fail("Invalid presence groups");
				}
				nextGroups = normalizeGroups(rawGroups.map(validateRuntimeGroup));
				legacyGroup = nextGroups.values().next().value;
			} else if (clientMessage.group !== undefined) {
				if (typeof clientMessage.group !== "string") return void fail("Invalid presence group");
				legacyGroup = validateRuntimeGroup(clientMessage.group);
				nextGroups = new Set([legacyGroup]);
			}
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return void fail(`Invalid presence group: ${reason}`);
	}

	const name = clientMessage.name;
	if (name !== undefined && typeof name !== "string") return void fail("Invalid presence name");
	const status = clientMessage.status;
	if (status !== undefined && typeof status !== "string") return void fail("Invalid presence status");
	const model = clientMessage.model;
	if (model !== undefined && typeof model !== "string") return void fail("Invalid presence model");

	if (typeof name === "string") session.info.name = name;
	if (typeof status === "string") session.info.status = status;
	if (typeof model === "string") session.info.model = model;
	setSessionGroups(session.info, nextGroups, legacyGroup);
	session.info.lastActivity = Date.now();
	broadcastMembershipChange(sessions, write, session, previousGroups);

	if (requestId !== undefined) {
		if (clientMessage.type === "join_group" || clientMessage.type === "leave_group") {
			write(socket, { type: "membership_ack", requestId, groups: session.info.groups ?? [] });
		} else {
			write(socket, { type: "presence_ack", requestId, group: session.info.group ?? "default" });
		}
	}
}
