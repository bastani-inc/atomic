import { RETURN_PATH_MESSAGE_LIMIT, RETURN_PATH_WINDOW_MS } from "../group.js";
import type { SessionInfo } from "../types.js";

export { RETURN_PATH_MESSAGE_LIMIT, RETURN_PATH_TOOL_NOTE, RETURN_PATH_WINDOW_MS, returnPathClosedReason } from "../group.js";

/** Return paths this broker keeps at once; the oldest goes first. */
export const RETURN_PATH_MAX_ENTRIES = 10_000;
/**
 * Inbound messages remembered as having opened a return path, so a retried, replayed or re-forwarded message never
 * opens one again. Kept apart from the paths and four times as many: dropping a path does not forget what opened it.
 */
export const RETURN_PATH_SEEN_OPENINGS = 4 * RETURN_PATH_MAX_ENTRIES;

/**
 * One end of a return path: its current broker session id, and the stable identity of its registration (its return
 * address and registration group). A session registered without a return address has no stable identity, so it can
 * neither open nor use a return path: a later session given the same id or name could not be told apart from it.
 */
export interface ReturnPathParty {
	readonly sessionId: string;
	readonly identity: string | undefined;
}

/** A sender `responder` holds a return path to, open or closed. */
export interface ReturnPathSender {
	readonly identity: string;
	/**
	 * The broker session id the sender wrote from. A reconnect can replace it: find the sender's live sessions by
	 * `identity`; this id only short-cuts a check that the sender is still that session.
	 */
	readonly sessionId: string;
}

interface ReturnPath {
	readonly responderIdentity: string;
	readonly senderIdentity: string;
	senderId: string;
	/** When the opening message reached the responder, on the broker's monotonic clock. */
	openedAt: number;
	/**
	 * Answers counted against this opening, with the arrival sequence when each was counted: distinct message ids, so a
	 * retried answer counts once.
	 */
	used: Map<string, number>;
}

/** An inbound cross-group delivery handed over to a responder whose confirmation has not settled yet. */
export interface PendingReturnPathOpeningInfo {
	readonly senderIdentity: string;
	readonly senderInfo: Pick<SessionInfo, "id" | "name">;
}

interface PendingReturnPathOpening extends PendingReturnPathOpeningInfo {
	readonly responderIdentity: string;
	readonly handedOverAt: number;
	readonly waiters: Set<() => void>;
}

/**
 * Response permissions across intercom groups, after NATS `allow_responses`: a session that received a message from
 * a sender outside its groups may send back to that sender, and only to it, with at most
 * {@link RETURN_PATH_MESSAGE_LIMIT} messages within {@link RETURN_PATH_WINDOW_MS} of the latest message from that
 * sender that reached it. Both ends are bound to stable registration identities, so a later session that takes an
 * ended sender's id or name inherits nothing. Dropping a path to stay within {@link RETURN_PATH_MAX_ENTRIES} removes
 * its permission with its count: a dropped path is closed, never reopened.
 */
export class ReturnPaths {
	private readonly paths = new Map<string, ReturnPath>();
	/** Path keys by responder identity, and by sender identity: a lookup costs the paths of one party, not all. */
	private readonly byResponder = new Map<string, Set<string>>();
	private readonly bySender = new Map<string, Set<string>>();
	/** The inbound messages that opened a path, per path: kept when the path itself is dropped. */
	private readonly seen = new Map<string, true>();
	/**
	 * Each identity whose registrations all ended for good, with the number of such ends counted when it last did: a
	 * message one of them sent before then opens nothing, however late its receipt arrives.
	 */
	private readonly ended = new Map<string, number>();
	private ends = 0;
	/** The latest end dropped from `ended` to stay within bounds: an opening older than it may be that identity's. */
	private endsForgotten = 0;
	/**
	 * Strictly monotonic sequence shared by inbound hand-overs and outbound answer arrivals, so answers that reached the
	 * broker before a newer message in the same clock tick never count toward that newer message.
	 */
	private handoverSeq = 0;
	/** In-flight deliveries whose return-path opening settles on confirmation, by pair and by responder. */
	private readonly pendingByPair = new Map<string, Set<PendingReturnPathOpening>>();
	private readonly pendingByResponder = new Map<string, Set<PendingReturnPathOpening>>();

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly windowMs = RETURN_PATH_WINDOW_MS,
		private readonly messageLimit = RETURN_PATH_MESSAGE_LIMIT,
		private readonly maxEntries = RETURN_PATH_MAX_ENTRIES,
	) {}

	/**
	 * The inbound message `operationId` from `sender` reached `responder`, which shares none of its groups. The same
	 * message reaching it again (a retry, a replay, a re-forward) changes nothing. `since` is the {@link mark} taken when
	 * the message was handed over: when every registration of the sender has ended for good since, it opens nothing.
	 * `handedOverAt` is the {@link handOverTime} taken then: the responder may have read the message, and answered,
	 * before it was known to have reached it, so answers counted on the path since then count toward the new opening.
	 */
	open(
		responder: ReturnPathParty,
		sender: ReturnPathParty,
		operationId: string,
		since?: number,
		handedOverAt?: number,
	): void {
		if (responder.identity === undefined || sender.identity === undefined) return;
		if (responder.identity === sender.identity) return;
		if (since !== undefined && this.endedSince(sender.identity, since)) return;
		const key = pathKey(responder.identity, sender.identity);
		const opening = `${key}\0${operationId}`;
		if (this.seen.has(opening)) return;
		this.seen.set(opening, true);
		this.bound(this.seen, RETURN_PATH_SEEN_OPENINGS);
		const earlier = this.paths.get(key);
		const used = new Map<string, number>();
		if (earlier !== undefined && handedOverAt !== undefined)
			for (const [messageId, countedAt] of earlier.used) if (countedAt >= handedOverAt) used.set(messageId, countedAt);
		this.deletePath(key);
		this.paths.set(key, {
			responderIdentity: responder.identity,
			senderIdentity: sender.identity,
			senderId: sender.sessionId,
			openedAt: this.now(),
			used,
		});
		index(this.byResponder, responder.identity, key);
		index(this.bySender, sender.identity, key);
		while (this.paths.size > this.maxEntries) {
			const oldest = this.paths.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.deletePath(oldest);
		}
	}

	/** Whether `responder` holds a return path to `sender`, open or closed: such a sender resolves by name. */
	holds(responder: ReturnPathParty, sender: ReturnPathParty): boolean {
		return this.path(responder, sender) !== undefined;
	}

	/** Whether `responder` may send `messageId` to `sender`; an answer already counted is always allowed again. */
	allows(responder: ReturnPathParty, sender: ReturnPathParty, messageId: string): boolean {
		const path = this.path(responder, sender);
		return path !== undefined && this.allowsOn(path, messageId);
	}

	/** Counts `messageId` as an answer to `sender`; false when no open return path allows it. */
	use(responder: ReturnPathParty, sender: ReturnPathParty, messageId: string, countedAt?: number): boolean {
		const path = this.path(responder, sender);
		if (path === undefined || !this.allowsOn(path, messageId)) return false;
		if (!path.used.has(messageId)) path.used.set(messageId, countedAt ?? ++this.handoverSeq);
		return true;
	}

	/**
	 * Records an in-flight delivery from `sender` to `responder` handed over at `handedOverAt` whose return path opens
	 * once its write or settle completes. Calling the returned function (idempotent) ends the hold and wakes any waiting
	 * answers so they are decided again.
	 */
	beginOpening(
		responder: ReturnPathParty,
		sender: ReturnPathParty,
		senderInfo: Pick<SessionInfo, "id" | "name">,
		handedOverAt: number,
	): (() => void) | undefined {
		if (responder.identity === undefined || sender.identity === undefined) return undefined;
		if (responder.identity === sender.identity) return undefined;
		const key = pathKey(responder.identity, sender.identity);
		const opening: PendingReturnPathOpening = {
			responderIdentity: responder.identity,
			senderIdentity: sender.identity,
			senderInfo,
			handedOverAt,
			waiters: new Set(),
		};
		let pair = this.pendingByPair.get(key);
		if (pair === undefined) {
			pair = new Set();
			this.pendingByPair.set(key, pair);
		}
		pair.add(opening);
		let byResponder = this.pendingByResponder.get(responder.identity);
		if (byResponder === undefined) {
			byResponder = new Set();
			this.pendingByResponder.set(responder.identity, byResponder);
		}
		byResponder.add(opening);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const currentPair = this.pendingByPair.get(key);
			currentPair?.delete(opening);
			if (currentPair?.size === 0) this.pendingByPair.delete(key);
			const currentResponder = this.pendingByResponder.get(opening.responderIdentity);
			currentResponder?.delete(opening);
			if (currentResponder?.size === 0) this.pendingByResponder.delete(opening.responderIdentity);
			const waiters = [...opening.waiters];
			opening.waiters.clear();
			for (const wake of waiters) wake();
		};
	}

	/**
	 * When an in-flight delivery from `sender` to `responder` handed over before `beforeSeq` has not settled yet, runs
	 * `decideAgain` once one of those deliveries settles and returns true; otherwise returns false.
	 */
	whenOpening(
		responder: ReturnPathParty,
		sender: ReturnPathParty,
		beforeSeq: number,
		decideAgain: () => void,
	): boolean {
		if (responder.identity === undefined || sender.identity === undefined) return false;
		const openings = this.pendingByPair.get(pathKey(responder.identity, sender.identity));
		if (openings === undefined || openings.size === 0) return false;
		return this.waitOnEligible(openings, beforeSeq, undefined, decideAgain);
	}

	/**
	 * When an in-flight delivery to `responder` handed over before `beforeSeq` matches `matches`, runs `decideAgain` once
	 * one of those matching deliveries settles and returns true; otherwise returns false.
	 */
	whenOpeningForResponder(
		responder: ReturnPathParty,
		beforeSeq: number,
		matches: (opening: PendingReturnPathOpeningInfo) => boolean,
		decideAgain: () => void,
	): boolean {
		if (responder.identity === undefined) return false;
		const openings = this.pendingByResponder.get(responder.identity);
		if (openings === undefined || openings.size === 0) return false;
		return this.waitOnEligible(openings, beforeSeq, matches, decideAgain);
	}

	private waitOnEligible(
		openings: ReadonlySet<PendingReturnPathOpening>,
		beforeSeq: number,
		matches: ((opening: PendingReturnPathOpeningInfo) => boolean) | undefined,
		decideAgain: () => void,
	): boolean {
		const eligible: PendingReturnPathOpening[] = [];
		for (const opening of openings) {
			if (opening.handedOverAt < beforeSeq && (matches === undefined || matches(opening))) eligible.push(opening);
		}
		if (eligible.length === 0) return false;
		let woken = false;
		const wake = (): void => {
			if (woken) return;
			woken = true;
			for (const opening of eligible) opening.waiters.delete(wake);
			decideAgain();
		};
		for (const opening of eligible) opening.waiters.add(wake);
		return true;
	}

	/** Whether `responder` holds a return path to `sender` that has closed: used up, or past its window. */
	closed(responder: ReturnPathParty, sender: ReturnPathParty): boolean {
		const path = this.path(responder, sender);
		return path !== undefined && !this.allowsOn(path, undefined);
	}

	/** The senders `responder` holds return paths to, open or closed: as many as it holds, whatever else the broker keeps. */
	sendersOf(responder: ReturnPathParty): ReturnPathSender[] {
		if (responder.identity === undefined) return [];
		const senders: ReturnPathSender[] = [];
		for (const key of this.byResponder.get(responder.identity) ?? []) {
			const path = this.paths.get(key);
			if (path !== undefined) senders.push({ identity: path.senderIdentity, sessionId: path.senderId });
		}
		return senders;
	}

	/**
	 * Every registration of `identity` ended for good: every return path it opened or holds goes with it, and so does any
	 * message it sent that reaches its recipient later.
	 */
	revoke(identity: string): void {
		for (const key of [...(this.byResponder.get(identity) ?? []), ...(this.bySender.get(identity) ?? [])]) {
			this.deletePath(key);
		}
		this.ended.delete(identity);
		this.ended.set(identity, ++this.ends);
		while (this.ended.size > this.maxEntries) {
			const [oldest, at] = this.ended.entries().next().value as [string, number];
			this.ended.delete(oldest);
			this.endsForgotten = at;
		}
	}

	/** A mark for {@link open}: a message handed over now opens nothing once every registration of its sender ended. */
	mark(): number {
		return this.ends;
	}

	/** The sequence mark for {@link open} of a message handed over now: answers arriving from then on count toward its opening. */
	handOverTime(): number {
		return ++this.handoverSeq;
	}

	private endedSince(identity: string, mark: number): boolean {
		const at = this.ended.get(identity);
		return at === undefined ? mark < this.endsForgotten : at > mark;
	}

	private path(responder: ReturnPathParty, sender: ReturnPathParty): ReturnPath | undefined {
		if (responder.identity === undefined || sender.identity === undefined) return undefined;
		return this.paths.get(pathKey(responder.identity, sender.identity));
	}

	private allowsOn(path: ReturnPath, messageId: string | undefined): boolean {
		if (messageId !== undefined && path.used.has(messageId)) return true;
		const elapsed = this.now() - path.openedAt;
		return elapsed >= 0 && elapsed <= this.windowMs && path.used.size < this.messageLimit;
	}

	private deletePath(key: string): void {
		const path = this.paths.get(key);
		if (path === undefined) return;
		this.paths.delete(key);
		unindex(this.byResponder, path.responderIdentity, key);
		unindex(this.bySender, path.senderIdentity, key);
	}

	private bound<V>(entries: Map<string, V>, limit = this.maxEntries): void {
		while (entries.size > limit) {
			const oldest = entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}
}

function pathKey(responderIdentity: string, senderIdentity: string): string {
	return `${responderIdentity}\0${senderIdentity}`;
}

function index(entries: Map<string, Set<string>>, identity: string, key: string): void {
	const keys = entries.get(identity) ?? new Set<string>();
	keys.add(key);
	entries.set(identity, keys);
}

function unindex(entries: Map<string, Set<string>>, identity: string, key: string): void {
	const keys = entries.get(identity);
	keys?.delete(key);
	if (keys?.size === 0) entries.delete(identity);
}
