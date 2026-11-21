import { type PendingRecoveryDelivery, type SessionEntry, type SessionRecoveryReplayResult, sliceHead } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.js";
import { SUBAGENT_ENDED_OUTCOMES, type SubagentEndedOutcome } from "./broker/recipient-gone-errors.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { Message, SessionInfo } from "./types.js";

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
/**
 * Intercom tells Subagents that a send or ask waits at the broker for a released child of this session (#4326), so
 * Subagents wakes it. Payload: {@link ReleasedChildWakeNotice}.
 */
export const SUBAGENT_RELEASED_CHILD_WAKE_EVENT = "subagent:released-child-wake";

/** A send or ask waits for the released child named `childName`. */
export interface ReleasedChildWakeNotice {
	readonly childName: string;
}

/**
 * #5999: Intercom asks Subagents to resume a child this session launched, which it reported ended with `wake`, for a
 * message the broker queued for it. Payload: {@link EndedChildWakeRequest}; Subagents answers through `answer`.
 */
export const SUBAGENT_ENDED_CHILD_WAKE_EVENT = "subagent:ended-child-wake";

export interface EndedChildWakeRequest {
	readonly childName: string;
	readonly childId?: string;
	/** The sender of the message that woke it, as the broker named it. */
	readonly from: { readonly id: string; readonly name?: string };
	/** How far down a chain of wakes this one is (1: its sender was not itself woken). */
	readonly depth: number;
	/**
	 * Resuming it (`true`), or not, and why. A resume that is accepted and fails later answers again with `false`; the
	 * messages queued for the child then fail with that reason.
	 */
	readonly answer: (accepted: boolean, reason?: string) => void;
	/** Set by the extension that takes the request. */
	handled?: boolean;
}

/**
 * #5999: Subagents asks Intercom to send `message` to `to`, a subagent another session launched, waking it through that
 * session if it ended: `subagent({ action: "resume" })` of a child this session did not launch.
 */
export const SUBAGENT_PEER_RESUME_EVENT = "subagent:peer-resume";

export type PeerResumeOutcome =
	/** It had ended: the message is queued for it and its launching session is resuming it. */
	| { readonly kind: "resuming" }
	/** It is live: the message was delivered to it as any message is. */
	| { readonly kind: "delivered" }
	/** It was paused or quit: it is not resumed for a message; the message waits until its launching session continues it. */
	| { readonly kind: "paused" }
	/** Queued for another reason (it is offline elsewhere). */
	| { readonly kind: "queued" }
	/** It is a live session: nothing was sent, as `resume` refuses a running child. */
	| { readonly kind: "running"; readonly name: string }
	/** No session or subagent answers to it here. */
	| { readonly kind: "unknown" }
	| { readonly kind: "refused"; readonly reason: string };

export interface PeerResumeRequest {
	readonly to: string;
	readonly message: string;
	completion?: Promise<PeerResumeOutcome>;
}

export function isPeerResumeRequest(value: unknown): value is PeerResumeRequest {
	const request = value as Partial<PeerResumeRequest> | null | undefined;
	return typeof request?.to === "string" && typeof request.message === "string";
}

/**
 * Subagents asks Intercom to reserve released children by name for this session's broker connection, any number at a
 * time, or to park them (`wake: false`); calling again replaces a child's reservation (#4326).
 */
export const SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT = "subagent:reserve-released-children";
/** Subagents tells Intercom that released children ended or were taken over, so their reservations end (#4326). */
export const SUBAGENT_DROP_RELEASED_CHILDREN_EVENT = "subagent:drop-released-children";
/** Subagents tells Intercom it is waking a released child, so the sends held for it may wait longer (#4326). */
export const SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT = "subagent:acknowledge-released-child-wake";
/**
 * Subagents tells Intercom how children this session launched ended, so the broker refuses a send to one with no live
 * session with why and the next step instead of `Session not found` (#4639). Payload: {@link MarkEndedChildrenRequest}.
 */
export const SUBAGENT_MARK_ENDED_CHILDREN_EVENT = "subagent:mark-ended-children";
/**
 * Intercom tells every extension that this session is connected to the broker, at start and after each reconnect,
 * when the broker has forgotten every reservation this connection made (#4326). Payload: {@link IntercomConnectedNotice}.
 */
export const INTERCOM_CONNECTED_EVENT = "intercom:connected";

/** One released child to reserve: see {@link SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT}. */
export interface ReleasedChildReservationRequest {
	readonly childName: string;
	readonly group?: string;
	readonly aliases?: readonly string[];
	readonly wake: boolean;
}

export interface ReserveReleasedChildrenRequest {
	readonly children: readonly ReleasedChildReservationRequest[];
	completion?: Promise<void>;
}

export interface DropReleasedChildrenRequest {
	readonly childNames: readonly string[];
	readonly gone?: string;
	readonly refusal?: string;
	completion?: Promise<void>;
}

/** One child that ended, as {@link SUBAGENT_MARK_ENDED_CHILDREN_EVENT} reports it. */
export interface EndedChildRequest {
	readonly childName: string;
	readonly group?: string;
	readonly aliases?: readonly string[];
	readonly outcome: SubagentEndedOutcome;
	readonly childId?: string;
	/** #5999: resume it for a message that asks to wake it (`wake`), or keep the message until it is continued (`hold`). */
	readonly messages?: "wake" | "hold";
}

export interface MarkEndedChildrenRequest {
	readonly children: readonly EndedChildRequest[];
	completion?: Promise<void>;
}

export interface AcknowledgeReleasedChildWakeRequest {
	readonly childName: string;
	completion?: Promise<void>;
}

export interface IntercomConnectedNotice {
	readonly sessionId: string;
}

/** Subagents ends that hold; with `gone` (the reason) senders are told the child did not survive the restart. */
export const SUBAGENT_RELEASE_RESTORING_CHILD_EVENT = "subagent:release-restoring-child";
/**
 * Intercom asks Subagents, when it decides about the interrupted deliveries of a resumed session, which children of
 * this session were relaunched in this recovery but have not registered with Intercom yet (#3760). They may still
 * reconnect, so what they sent is neither replayed as if they were live nor discarded as if they were gone.
 */
export const SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT = "subagent:restored-intercom-peers";
/**
 * #6168: Intercom asks Subagents which of the asks this session holds unanswered came from an attempt of one of its
 * children that is over, so no reply can reach it. Payload: {@link FinishedAsksRequest}.
 */
export const SUBAGENT_FINISHED_ASKS_EVENT = "subagent:finished-asks";

/** One ask this session holds unanswered, as it arrived. */
export interface HeldAsk {
	readonly messageId: string;
	readonly from: { readonly id: string; readonly name?: string };
	readonly source?: { readonly subagentRunId: string; readonly subagentIndex?: number };
	/** When this session received it, by its own clock. */
	readonly receivedAt: number;
}

export interface FinishedAsksRequest {
	readonly ownerSessionId: string;
	readonly asks: readonly HeldAsk[];
	completion?: Promise<readonly string[]>;
}

/** The ids of `asks` whose asking attempt Subagents knows is over; none without a Subagents extension. */
export async function finishedChildAsks(
	events: { emit(eventName: string, payload: unknown): void },
	ownerSessionId: string,
	asks: readonly IntercomContextLike[],
): Promise<ReadonlySet<string>> {
	if (asks.length === 0) return new Set();
	const request: FinishedAsksRequest = {
		ownerSessionId,
		asks: asks.map(({ from, message, receivedAt }) => ({
			messageId: message.id,
			from: { id: from.id, ...(from.name === undefined ? {} : { name: from.name }) },
			...(message.source === undefined
				? {}
				: {
						source: {
							subagentRunId: message.source.subagentRunId,
							...(message.source.subagentIndex === undefined ? {} : { subagentIndex: message.source.subagentIndex }),
						},
					}),
			receivedAt,
		})),
	};
	try {
		events.emit(SUBAGENT_FINISHED_ASKS_EVENT, request);
		return new Set(request.completion ? await request.completion : []);
	} catch {
		return new Set();
	}
}

/** An unanswered ask as the reply tracker holds it. */
interface IntercomContextLike {
	readonly from: SessionInfo;
	readonly message: Pick<Message, "id" | "source">;
	readonly receivedAt: number;
}

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
	/** The child is starting: each send waits this long for it to register. */
	readonly holdMs?: number;
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
		(request.holdMs === undefined || (typeof request.holdMs === "number" && Number.isInteger(request.holdMs))) &&
		Array.isArray(request.aliases) &&
		request.aliases.every((alias) => typeof alias === "string")
	);
}

export function isReserveReleasedChildrenRequest(value: unknown): value is ReserveReleasedChildrenRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<ReserveReleasedChildrenRequest>;
	return (
		Array.isArray(request.children) &&
		request.children.every(
			(child: Partial<ReleasedChildReservationRequest> | null) =>
				typeof child === "object" &&
				child !== null &&
				typeof child.childName === "string" &&
				typeof child.wake === "boolean" &&
				(child.group === undefined || typeof child.group === "string") &&
				(child.aliases === undefined ||
					(Array.isArray(child.aliases) && child.aliases.every((alias) => typeof alias === "string"))),
		)
	);
}

export function isDropReleasedChildrenRequest(value: unknown): value is DropReleasedChildrenRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<DropReleasedChildrenRequest>;
	return (
		Array.isArray(request.childNames) &&
		request.childNames.every((name) => typeof name === "string") &&
		(request.gone === undefined || typeof request.gone === "string") &&
		(request.refusal === undefined || typeof request.refusal === "string")
	);
}

const ENDED_OUTCOMES: ReadonlySet<unknown> = new Set(SUBAGENT_ENDED_OUTCOMES);

function isEndedChildRequest(value: unknown): value is EndedChildRequest {
	const child = value as Partial<EndedChildRequest> | null | undefined;
	return (
		typeof child?.childName === "string" &&
		ENDED_OUTCOMES.has(child.outcome) &&
		(child.group === undefined || typeof child.group === "string") &&
		(child.childId === undefined || typeof child.childId === "string") &&
		(child.messages === undefined || child.messages === "wake" || child.messages === "hold") &&
		(child.aliases === undefined ||
			(Array.isArray(child.aliases) && child.aliases.every((alias) => typeof alias === "string")))
	);
}

export function isMarkEndedChildrenRequest(value: unknown): value is MarkEndedChildrenRequest {
	const children = (value as Partial<MarkEndedChildrenRequest> | null | undefined)?.children;
	return Array.isArray(children) && children.every(isEndedChildRequest);
}

export function isAcknowledgeReleasedChildWakeRequest(value: unknown): value is AcknowledgeReleasedChildWakeRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<AcknowledgeReleasedChildWakeRequest>).childName === "string"
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
			(entry.type === "custom" && entry.customType === "intercom_inbox") ||
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
	return text.length > RECOVERED_BODY_MAX_CHARS ? `${sliceHead(text, RECOVERED_BODY_MAX_CHARS)}…` : text;
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
