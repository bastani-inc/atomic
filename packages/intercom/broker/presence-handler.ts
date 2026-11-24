import type net from "node:net";
import { addGroup, normalizeGroups, removeGroup, validateRuntimeGroup } from "../group.js";
import type { BrokerMessage } from "../types.js";
import { reachesSession, sessionGroups, setSessionGroups } from "./group-membership.js";
import { admitsMemberships, canJoin, canLeave, type IntercomReachPolicy, narrowMemberships } from "../reach-policy.js";
import type { BrokerConnectedSession } from "./send-handler.js";
import { isAgentRecipient } from "../recipient-purpose.js";
import type { PendingQuestionIndex } from "./pending-question-index.js";
import { failTerminalQuestions } from "./terminal-questions.js";

interface PresenceClientMessage extends Record<string, unknown> {
	type: string;
}

type WriteMessage = (socket: net.Socket, message: BrokerMessage) => void;

/** #5146: queues `session`'s presence for `peer`; without one, it is written at once. */
type QueuePresence = (peer: BrokerConnectedSession, session: BrokerConnectedSession) => void;

/** #5146: what a `presence_update` tells a peer, without the activity time every Intercom tool call refreshes. */
function visiblePresence(info: BrokerConnectedSession["info"]): string {
	const { name, model, status, replyCapability, groups, group } = info;
	return JSON.stringify([name, model, status, replyCapability, groups, group]);
}

function broadcastMembershipChange(
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
	session: BrokerConnectedSession,
	previous: ReadonlySet<string>,
	presenceChanged: boolean,
	queuePresence: QueuePresence | undefined,
): void {
	if (!isAgentRecipient(session.info)) return;
	const previousInfo = { ...session.info, groups: [...previous], group: previous.values().next().value };
	for (const [id, peer] of sessions) {
		// #4642: a hosted session shares its host's socket and needs no copy of its own.
		if (id === session.info.id || peer.hostedBy !== undefined) continue;
		const sharedBefore = reachesSession(peer, previousInfo);
		const sharedAfter = reachesSession(peer, session.info);
		if (!sharedBefore && sharedAfter) {
			write(peer.socket, { type: "session_joined", session: session.info });
		} else if (sharedBefore && !sharedAfter) {
			write(peer.socket, { type: "session_left", sessionId: session.info.id });
		} else if (sharedAfter && presenceChanged) {
			if (queuePresence === undefined) write(peer.socket, { type: "presence_update", session: session.info });
			else queuePresence(peer, session);
		}
	}
}

export function replaceSessionReach(
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
	session: BrokerConnectedSession,
	reach: IntercomReachPolicy,
	queuePresence?: QueuePresence,
): void {
	const previousGroups = sessionGroups(session.info);
	const presenceBefore = visiblePresence(session.info);
	session.reach = reach;
	setSessionGroups(session.info, new Set(narrowMemberships(reach, [...previousGroups])), reach.home);
	broadcastMembershipChange(
		sessions,
		write,
		session,
		previousGroups,
		visiblePresence(session.info) !== presenceBefore,
		queuePresence,
	);
}

function membershipReachRefusal(
	reach: IntercomReachPolicy,
	clientMessage: PresenceClientMessage,
	nextGroups: ReadonlySet<string>,
): string | undefined {
	const scope = `home group ${reach.home}; reachable groups: ${reach.reachable.join(", ") || "none"}`;
	if (clientMessage.type === "join_group") {
		const group = [...nextGroups].find((candidate) => !canJoin(reach, candidate));
		return group === undefined ? undefined : `Group ${group} is outside this session's Intercom reach (${scope})`;
	}
	if (clientMessage.type === "leave_group" && typeof clientMessage.group === "string" && !canLeave(reach, clientMessage.group.trim()))
		return `This session's home group ${reach.home} can't be left`;
	if (!admitsMemberships(reach, [...nextGroups]))
		return `Intercom memberships ${[...nextGroups].join(", ")} are outside this session's reach (${scope})`;
	return undefined;
}

/** Apply one presence or membership update and notify every affected group member. */
export function handleBrokerPresence(
	socket: net.Socket,
	clientMessage: PresenceClientMessage,
	currentId: string | null,
	sessions: Map<string, BrokerConnectedSession>,
	write: WriteMessage,
	pendingQuestions?: PendingQuestionIndex,
	queuePresence?: QueuePresence,
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
				nextGroups = removeGroup(previousGroups, group, session.registrationGroup);
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
	const reachRefusal = session.reach === undefined ? undefined : membershipReachRefusal(session.reach, clientMessage, nextGroups);
	if (reachRefusal !== undefined) return void fail(reachRefusal);

	const name = clientMessage.name;
	if (name !== undefined && typeof name !== "string") return void fail("Invalid presence name");
	const status = clientMessage.status;
	if (status !== undefined && typeof status !== "string") return void fail("Invalid presence status");
	const model = clientMessage.model;
	if (model !== undefined && typeof model !== "string") return void fail("Invalid presence model");
	const capability = clientMessage.replyCapability;
	if (capability !== undefined && capability !== "live" && capability !== "terminal") {
		return void fail("Invalid reply capability");
	}
	if (capability === "live" && session.info.replyCapability === "terminal") {
		return void fail("Terminal reply capability cannot be revived");
	}

	const presenceBefore = visiblePresence(session.info);
	if (typeof name === "string") session.info.name = name;
	if (typeof status === "string") session.info.status = status;
	if (typeof model === "string") session.info.model = model;
	if (capability === "live" || capability === "terminal") session.info.replyCapability = capability;
	if (capability === "terminal" && pendingQuestions) failTerminalQuestions(session, sessions, pendingQuestions, write);
	setSessionGroups(session.info, nextGroups, legacyGroup);
	session.info.lastActivity = Date.now();
	broadcastMembershipChange(
		sessions,
		write,
		session,
		previousGroups,
		visiblePresence(session.info) !== presenceBefore,
		queuePresence,
	);

	if (requestId !== undefined) {
		if (clientMessage.type === "join_group" || clientMessage.type === "leave_group") {
			write(socket, { type: "membership_ack", requestId, groups: session.info.groups ?? [] });
		} else {
			write(socket, { type: "presence_ack", requestId, group: session.info.group ?? "default" });
		}
	}
}
