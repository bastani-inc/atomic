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
 * Maximum time an answer waits for a matching in-flight return-path opening to settle before returning the normal
 * refusal. Bounded strictly below the client's 10 s send timeout and 8 s receipt wait so a stalled write or database
 * settle never hangs the sender.
 */
export const RETURN_PATH_OPENING_WAIT_MS = 5_000;

/** Outcome of waiting on a pending return-path opening. */
export type ReturnPathOpeningWaitOutcome = "settled" | "expired";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
	readonly targetKeys: readonly string[];
	readonly waiters: Set<() => void>;
	finish: () => void;
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
	/** In-flight deliveries whose return-path opening settles on confirmation, indexed by pair, responder, sender, and target. */
	private readonly pendingByPair = new Map<string, Set<PendingReturnPathOpening>>();
	private readonly pendingByResponder = new Map<string, Set<PendingReturnPathOpening>>();
	private readonly pendingBySender = new Map<string, Set<PendingReturnPathOpening>>();
	private readonly pendingByResponderTarget = new Map<string, Set<PendingReturnPathOpening>>();

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly windowMs = RETURN_PATH_WINDOW_MS,
		private readonly messageLimit = RETURN_PATH_MESSAGE_LIMIT,
		private readonly maxEntries = RETURN_PATH_MAX_ENTRIES,
		private readonly openingWaitMs = RETURN_PATH_OPENING_WAIT_MS,
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
		if (since !== undefined && (this.endedSince(sender.identity, since) || this.endedSince(responder.identity, since)))
			return;
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
	 * Monotonic deadline for a send's total wait across pending return-path openings, clamped to `maxMs` when supplied so
	 * a wait never outlasts the sender's remaining deadline.
	 */
	openingWaitDeadline(maxMs?: number): number {
		const bound = maxMs === undefined ? this.openingWaitMs : Math.min(this.openingWaitMs, Math.max(0, maxMs));
		return this.now() + bound;
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
		senderReturnAddress?: string,
	): (() => void) | undefined {
		if (responder.identity === undefined || sender.identity === undefined) return undefined;
		if (responder.identity === sender.identity) return undefined;
		const responderIdentity = responder.identity;
		const senderIdentity = sender.identity;
		const key = pathKey(responderIdentity, senderIdentity);
		const targetKeys = targetIndexKeys(responderIdentity, senderInfo, senderReturnAddress);
		const opening: PendingReturnPathOpening = {
			responderIdentity,
			senderIdentity,
			senderInfo,
			handedOverAt,
			targetKeys,
			waiters: new Set(),
			finish: () => {},
		};
		addToSetMap(this.pendingByPair, key, opening);
		addToSetMap(this.pendingByResponder, responderIdentity, opening);
		addToSetMap(this.pendingBySender, senderIdentity, opening);
		for (const targetKey of targetKeys) addToSetMap(this.pendingByResponderTarget, targetKey, opening);
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			removeFromSetMap(this.pendingByPair, key, opening);
			removeFromSetMap(this.pendingByResponder, responderIdentity, opening);
			removeFromSetMap(this.pendingBySender, senderIdentity, opening);
			for (const targetKey of targetKeys) removeFromSetMap(this.pendingByResponderTarget, targetKey, opening);
			const waiters = [...opening.waiters];
			opening.waiters.clear();
			for (const wake of waiters) wake();
		};
		opening.finish = finish;
		return finish;
	}

	/** Whether an in-flight delivery from `sender` to `responder` handed over before `beforeSeq` is still pending. */
	hasPendingOpening(responder: ReturnPathParty, sender: ReturnPathParty, beforeSeq: number): boolean {
		if (responder.identity === undefined || sender.identity === undefined) return false;
		const openings = this.pendingByPair.get(pathKey(responder.identity, sender.identity));
		if (openings === undefined || openings.size === 0) return false;
		for (const opening of openings) {
			if (opening.handedOverAt < beforeSeq) return true;
		}
		return false;
	}

	/**
	 * O(1) lookup of sender identities whose in-flight delivery to `responder` (handed over before `beforeSeq`) matches
	 * `target` by id, name, 8-hex UUID prefix, or return address. Returns `undefined` when none match.
	 */
	pendingSendersForTarget(
		responder: ReturnPathParty,
		target: string,
		beforeSeq: number,
	): ReadonlySet<string> | undefined {
		const matched = this.lookupTargetOpenings(responder, target);
		if (matched === undefined) return undefined;
		let senders: Set<string> | undefined;
		for (const opening of matched) {
			if (opening.handedOverAt >= beforeSeq) continue;
			senders ??= new Set();
			senders.add(opening.senderIdentity);
		}
		return senders;
	}

	/**
	 * When an in-flight delivery from `sender` to `responder` handed over before `beforeSeq` has not settled yet and
	 * `deadlineAt` has not elapsed, runs `onDone` once one settles or the bound expires, and returns true; otherwise
	 * returns false synchronously.
	 */
	whenOpening(
		responder: ReturnPathParty,
		sender: ReturnPathParty,
		beforeSeq: number,
		deadlineAt: number,
		onDone: (outcome: ReturnPathOpeningWaitOutcome) => void,
	): boolean {
		if (responder.identity === undefined || sender.identity === undefined) return false;
		const openings = this.pendingByPair.get(pathKey(responder.identity, sender.identity));
		if (openings === undefined || openings.size === 0) return false;
		return this.waitOnEligible(openings, beforeSeq, deadlineAt, onDone);
	}

	/**
	 * O(1) indexed lookup: when an in-flight delivery to `responder` handed over before `beforeSeq` matches `target` and
	 * `deadlineAt` has not elapsed, runs `onDone` once one settles or the bound expires, and returns true; otherwise
	 * returns false synchronously.
	 */
	whenOpeningForTarget(
		responder: ReturnPathParty,
		target: string,
		beforeSeq: number,
		deadlineAt: number,
		onDone: (outcome: ReturnPathOpeningWaitOutcome) => void,
	): boolean {
		const matched = this.lookupTargetOpenings(responder, target);
		if (matched === undefined) return false;
		return this.waitOnEligible(matched, beforeSeq, deadlineAt, onDone);
	}

	/** Releases every pending opening and wakes any waiting answers (used on broker shutdown). */
	clearPending(): void {
		const all: PendingReturnPathOpening[] = [];
		for (const set of this.pendingByResponder.values()) {
			for (const opening of set) all.push(opening);
		}
		for (const opening of all) opening.finish();
	}

	private lookupTargetOpenings(
		responder: ReturnPathParty,
		target: string,
	): Iterable<PendingReturnPathOpening> | undefined {
		if (responder.identity === undefined) return undefined;
		if (!this.pendingByResponder.has(responder.identity)) return undefined;
		const responderIdentity = responder.identity;
		const lower = target.toLowerCase();
		const byId = this.pendingByResponderTarget.get(`${responderIdentity}\0id:${target}`);
		const byName = this.pendingByResponderTarget.get(`${responderIdentity}\0name:${lower}`);
		const byPrefix =
			target.length === 8 ? this.pendingByResponderTarget.get(`${responderIdentity}\0prefix:${lower}`) : undefined;
		const byAddr = this.pendingByResponderTarget.get(`${responderIdentity}\0addr:${target}`);
		// Fast path: 0 or 1 matching bucket avoids allocating a merged Set.
		let single: Set<PendingReturnPathOpening> | undefined;
		let merged: Set<PendingReturnPathOpening> | undefined;
		for (const bucket of [byId, byName, byPrefix, byAddr]) {
			if (bucket === undefined || bucket.size === 0) continue;
			if (single === undefined) {
				single = bucket;
			} else {
				if (merged === undefined) merged = new Set(single);
				for (const opening of bucket) merged.add(opening);
			}
		}
		return merged ?? single;
	}

	private waitOnEligible(
		openings: Iterable<PendingReturnPathOpening>,
		beforeSeq: number,
		deadlineAt: number,
		onDone: (outcome: ReturnPathOpeningWaitOutcome) => void,
	): boolean {
		const remainingMs = deadlineAt - this.now();
		if (remainingMs <= 0) return false;
		const eligible: PendingReturnPathOpening[] = [];
		for (const opening of openings) {
			if (opening.handedOverAt < beforeSeq) eligible.push(opening);
		}
		if (eligible.length === 0) return false;
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const complete = (outcome: ReturnPathOpeningWaitOutcome): void => {
			if (finished) return;
			finished = true;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			for (const opening of eligible) opening.waiters.delete(onSettled);
			onDone(outcome);
		};
		const onSettled = (): void => complete("settled");
		for (const opening of eligible) opening.waiters.add(onSettled);
		timer = setTimeout(() => complete("expired"), remainingMs);
		timer.unref?.();
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
		const pendingToRelease = [
			...(this.pendingByResponder.get(identity) ?? []),
			...(this.pendingBySender.get(identity) ?? []),
		];
		for (const opening of pendingToRelease) opening.finish();
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

function addToSetMap<V>(map: Map<string, Set<V>>, key: string, value: V): void {
	let set = map.get(key);
	if (set === undefined) {
		set = new Set();
		map.set(key, set);
	}
	set.add(value);
}

function removeFromSetMap<V>(map: Map<string, Set<V>>, key: string, value: V): void {
	const set = map.get(key);
	set?.delete(value);
	if (set?.size === 0) map.delete(key);
}

function targetIndexKeys(
	responderIdentity: string,
	senderInfo: Pick<SessionInfo, "id" | "name">,
	senderReturnAddress: string | undefined,
): string[] {
	const keys: string[] = [`${responderIdentity}\0id:${senderInfo.id}`];
	if (senderInfo.name !== undefined) keys.push(`${responderIdentity}\0name:${senderInfo.name.toLowerCase()}`);
	if (UUID_PATTERN.test(senderInfo.id)) keys.push(`${responderIdentity}\0prefix:${senderInfo.id.slice(0, 8).toLowerCase()}`);
	if (senderReturnAddress !== undefined) keys.push(`${responderIdentity}\0addr:${senderReturnAddress}`);
	return keys;
}
