import type { PendingRecoveryDelivery, SessionEntry, SessionRecoveryReplayResult } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { SessionInfo } from "./types.js";

/** Subagents asks Intercom to confirm that a restored child re-registered with the broker (#3760). */
export const SUBAGENT_AWAIT_INTERCOM_PEER_EVENT = "subagent:await-intercom-peer";
/**
 * Intercom asks Subagents whether a restored child of this session is still coming back before it sends to it (#3760).
 * The target may be the child's name, its Atomic session id, or the Intercom id it had before the restart.
 */
export const SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT = "subagent:await-child-restoration";
/** Longest a send waits for a child that a resume is restoring: its relaunch plus the 15s re-registration wait. */
export const CHILD_RESTORATION_WAIT_MS = 20_000;
/**
 * Subagents asks Intercom, as the child's supervisor, to have the broker hold sends from any sender to a child
 * it is restoring, by the capability it was just issued for that child (#3760).
 */
export const SUBAGENT_RESERVE_RESTORING_CHILD_EVENT = "subagent:reserve-restoring-child";
/** Subagents ends that hold; with `gone` (the reason) senders are told the child did not survive the restart. */
export const SUBAGENT_RELEASE_RESTORING_CHILD_EVENT = "subagent:release-restoring-child";
/**
 * Intercom asks Subagents, when it decides about the interrupted deliveries of a resumed session, which children of
 * this session were relaunched in this recovery but have not registered with Intercom yet (#3760). They may still
 * reconnect, so what they sent is neither replayed as if they were live nor discarded as if they were gone.
 */
export const SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT = "subagent:restored-intercom-peers";
/** Lazy-runtime request for the peers this session can reach after it reconnects on resume. */
export const INTERCOM_RECOVERY_PEERS_EVENT = "intercom:recovery-peers";

const PEER_POLL_INTERVAL_MS = 200;
const RECOVERED_BODY_MAX_CHARS = 2_000;
const LOCAL_RELAY_SENDERS = new Set(["subagent-control", "subagent-result"]);

export interface AwaitIntercomPeerRequest {
	readonly name: string;
	readonly group?: string;
	readonly timeoutMs: number;
	completion?: Promise<boolean>;
}

export interface AwaitChildRestorationRequest {
	readonly ownerSessionId: string;
	readonly target: string;
	readonly timeoutMs: number;
	/** Resolves a refusal message when the send must not go out, or `undefined` when it may proceed. */
	completion?: Promise<string | undefined>;
}

/** A child that was relaunched but has not registered with Intercom yet. */
export interface RestoredIntercomPeer {
	/** Its Intercom name. */
	readonly name: string;
	/** Its Atomic session id and the Intercom id it had before the restart, when known. */
	readonly ids: readonly string[];
}

export interface RestoredIntercomPeersRequest {
	readonly ownerSessionId: string;
	completion?: Promise<readonly RestoredIntercomPeer[]>;
}

/** The relaunched children of this session that have not registered with Intercom yet; none without a Subagents extension. */
export async function awaitRestoredIntercomPeers(
	events: { emit(eventName: string, payload: unknown): void },
	ownerSessionId: string,
): Promise<readonly RestoredIntercomPeer[]> {
	const request: RestoredIntercomPeersRequest = { ownerSessionId };
	try {
		events.emit(SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT, request);
		return request.completion ? await request.completion : [];
	} catch {
		return [];
	}
}

export interface ReserveRestoringChildRequest {
	readonly capability: string;
	readonly group?: string;
	/** The child's Atomic session id and the Intercom id it had before the restart. */
	readonly aliases: readonly string[];
	/** Only keeps the child addressable until the supervisor that restores it reserves it and takes the hold over. */
	readonly dormant?: boolean;
	completion?: Promise<void>;
}

export interface ReleaseRestoringChildRequest {
	readonly capability: string;
	readonly gone?: string;
	/** Told to the senders held now when the child is coming back elsewhere; later sends are routed normally. */
	readonly refusal?: string;
	completion?: Promise<void>;
}

export function isReserveRestoringChildRequest(value: unknown): value is ReserveRestoringChildRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<ReserveRestoringChildRequest>;
	return (
		typeof request.capability === "string" &&
		request.capability.length > 0 &&
		(request.group === undefined || typeof request.group === "string") &&
		(request.dormant === undefined || typeof request.dormant === "boolean") &&
		Array.isArray(request.aliases) &&
		request.aliases.every((alias) => typeof alias === "string")
	);
}

export function isReleaseRestoringChildRequest(value: unknown): value is ReleaseRestoringChildRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<ReleaseRestoringChildRequest>;
	return (
		typeof request.capability === "string" &&
		request.capability.length > 0 &&
		(request.gone === undefined || typeof request.gone === "string") &&
		(request.refusal === undefined || typeof request.refusal === "string")
	);
}

/**
 * While a resume restores a background subagent, hold a send addressed to it (by its original name, its Atomic
 * session id, or its pre-restart Intercom id) until the restoration settles. Returns why the send must not go
 * out (the subagent is gone), or `undefined` to send normally. Without a Subagents extension answering, or when
 * the answer fails, the send proceeds unchanged.
 */
export async function awaitSubagentChildRestoration(
	events: { emit(eventName: string, payload: unknown): void },
	ownerSessionId: string,
	target: string,
): Promise<string | undefined> {
	const request: AwaitChildRestorationRequest = { ownerSessionId, target, timeoutMs: CHILD_RESTORATION_WAIT_MS };
	try {
		events.emit(SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT, request);
		return request.completion ? await request.completion : undefined;
	} catch {
		return undefined;
	}
}

export interface IntercomRecoveryPeersRequest {
	completion?: Promise<SessionInfo[]>;
}

export function isAwaitIntercomPeerRequest(value: object): value is AwaitIntercomPeerRequest {
	const request = value as Partial<AwaitIntercomPeerRequest>;
	return (
		typeof request.name === "string" &&
		request.name.trim().length > 0 &&
		typeof request.timeoutMs === "number" &&
		(request.group === undefined || typeof request.group === "string")
	);
}

/** A resumed session that used Intercom before re-registers at once, so peers can address it by its name again. */
export function hasIntercomHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "custom_message" && entry.customType === "intercom_message") ||
			(entry.type === "custom" && entry.customType === "subagent-child") ||
			(entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.toolName === "intercom" || entry.message.toolName === "contact_supervisor")),
	);
}

/** Poll the broker until a peer with this name is registered, or report that it never came back. */
export async function waitForIntercomPeer(
	client: Pick<IntercomClient, "listSessions">,
	request: Pick<AwaitIntercomPeerRequest, "name" | "group" | "timeoutMs">,
): Promise<boolean> {
	const name = request.name.trim().toLowerCase();
	const deadline = Date.now() + request.timeoutMs;
	for (;;) {
		const sessions = await client.listSessions(request.group);
		if (sessions.some((session) => session.name?.trim().toLowerCase() === name)) return true;
		if (Date.now() + PEER_POLL_INTERVAL_MS > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, PEER_POLL_INTERVAL_MS));
	}
}

function inboundEntry(delivery: PendingRecoveryDelivery): InboundMessageEntry | undefined {
	if (delivery.customType !== "intercom_message") return undefined;
	const details = delivery.details as Partial<InboundMessageEntry> | undefined;
	return typeof details?.from?.id === "string" && typeof details.message?.id === "string"
		? (details as InboundMessageEntry)
		: undefined;
}

function peerLabel(from: SessionInfo): string {
	return from.name ? `\`${from.name}\`` : `\`${from.id}\``;
}

function isLivePeer(from: SessionInfo, peers: readonly SessionInfo[]): boolean {
	const name = from.name?.trim().toLowerCase();
	return peers.some((peer) => peer.id === from.id || (name !== undefined && peer.name?.trim().toLowerCase() === name));
}

/** A sender that Subagents relaunched in this recovery and that may still register under its name or an id it had. */
function isRestoredPeer(from: SessionInfo, restored: readonly RestoredIntercomPeer[]): boolean {
	const name = from.name?.trim().toLowerCase();
	return restored.some(
		(peer) => peer.ids.includes(from.id) || (name !== undefined && peer.name.trim().toLowerCase() === name),
	);
}

function boundedBody(text: string): string {
	return text.length > RECOVERED_BODY_MAX_CHARS ? `${text.slice(0, RECOVERED_BODY_MAX_CHARS)}…` : text;
}

/**
 * Decide which interrupted Intercom cards may still start a turn on resume (#3760).
 * A card replays only when its sender is connected again (restored subagents included).
 * A card from a subagent that was relaunched in this recovery but has not registered yet (`restored`) may still
 * come back, so it is deferred like an unknown peer: it stays pending and the next resume decides about it again.
 * A card from a peer that is gone is dropped instead: its text is surfaced once as
 * history in a non-triggering notice that tells the agent the peer is gone.
 * `peers` is undefined when Intercom could not be reached. Then no sender's liveness is known, so every
 * card is deferred: it stays pending, starts no turn, and the next resume decides about it again.
 */
export function planIntercomRecoveryReplay(
	pending: readonly PendingRecoveryDelivery[],
	peers: readonly SessionInfo[] | undefined,
	restored: readonly RestoredIntercomPeer[] = [],
): SessionRecoveryReplayResult {
	const decisions: NonNullable<SessionRecoveryReplayResult["decisions"]> = [];
	const gone = new Map<string, { from: SessionInfo; entries: InboundMessageEntry[] }>();
	const deferred = new Map<string, { from: SessionInfo; count: number }>();
	const reconnecting = new Map<string, { from: SessionInfo; count: number }>();
	const tally = (counts: Map<string, { from: SessionInfo; count: number }>, key: string, from: SessionInfo): void => {
		const sender = counts.get(key) ?? { from, count: 0 };
		sender.count += 1;
		counts.set(key, sender);
	};
	for (const delivery of pending) {
		const entry = inboundEntry(delivery);
		if (!entry || LOCAL_RELAY_SENDERS.has(entry.from.id)) continue;
		const key = entry.from.name?.trim().toLowerCase() ?? entry.from.id;
		if (peers === undefined) {
			decisions.push({ entryId: delivery.entryId, action: "defer" });
			tally(deferred, key, entry.from);
			continue;
		}
		if (isLivePeer(entry.from, peers)) {
			decisions.push({ entryId: delivery.entryId, action: "replay" });
			continue;
		}
		if (isRestoredPeer(entry.from, restored)) {
			decisions.push({ entryId: delivery.entryId, action: "defer" });
			tally(reconnecting, key, entry.from);
			continue;
		}
		decisions.push({ entryId: delivery.entryId, action: "drop" });
		const group = gone.get(key) ?? { from: entry.from, entries: [] };
		group.entries.push(entry);
		gone.set(key, group);
	}
	const notices = [...gone.values()].map(({ from, entries }) => {
		const history = entries
			.map((entry) => `- Sent ${new Date(entry.message.timestamp).toISOString()}: ${boundedBody(entry.bodyText)}`)
			.join("\n");
		return `Intercom peer ${peerLabel(from)} is gone: it is no longer connected after the restart. ${entries.length} message(s) it sent before the restart were not replayed as new turns; they are shown here as history only. Do not reply to it or send it new messages; launch a fresh subagent if its work is still needed.\n${history}`;
	});
	for (const { from, count } of reconnecting.values()) {
		notices.push(
			`Intercom peer ${peerLabel(from)} was relaunched after the restart but has not reconnected to Intercom yet, so ${count === 1 ? "1 interrupted delivery" : `${count} interrupted deliveries`} from it ${count === 1 ? "was" : "were"} deferred: not replayed now and not discarded. It is not gone; treat it as unreachable until it reconnects. The next resume of this session tries them again.`,
		);
	}
	if (deferred.size > 0) {
		const count = [...deferred.values()].reduce((total, sender) => total + sender.count, 0);
		const senders = [...deferred.values()].map(({ from }) => peerLabel(from)).join(", ");
		notices.push(
			`Intercom could not be reached after the restart, so ${count === 1 ? "1 interrupted Intercom delivery" : `${count} interrupted Intercom deliveries`} from ${senders} ${count === 1 ? "was" : "were"} deferred: not replayed now and not discarded. Whether their senders are still connected is unknown. The next resume of this session tries them again.`,
		);
	}
	return { decisions, ...(notices.length > 0 ? { notices } : {}) };
}
