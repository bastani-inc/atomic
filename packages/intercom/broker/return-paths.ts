import { matchStagePathSegments } from "../workflow-stage-path-matching.js";
import { parseWorkflowStageTarget } from "../workflow-stage-target.js";
import { RETURN_PATH_MESSAGE_LIMIT, RETURN_PATH_WINDOW_MS } from "../group.js";

export { RETURN_PATH_MESSAGE_LIMIT, RETURN_PATH_TOOL_NOTE, RETURN_PATH_WINDOW_MS, returnPathClosedReason } from "../group.js";

/** Return paths, and the queued messages still to reach a stage, this broker keeps at once; the oldest goes first. */
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
	/** Answers counted against this opening: distinct message ids, so a retried answer counts once. */
	used: Set<string>;
}

interface QueuedOpening {
	readonly rootRunId: string;
	readonly segments: readonly string[];
	readonly senderIdentity: string;
	readonly senderId: string;
	readonly operationId: string;
	/** The stage identities it already reached: it reaches each once, however often that stage takes its route. */
	readonly reached: Set<string>;
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
	private readonly queued = new Map<string, QueuedOpening>();
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
	 */
	open(responder: ReturnPathParty, sender: ReturnPathParty, operationId: string, since?: number): void {
		if (responder.identity === undefined || sender.identity === undefined) return;
		if (responder.identity === sender.identity) return;
		if (since !== undefined && this.endedSince(sender.identity, since)) return;
		const key = pathKey(responder.identity, sender.identity);
		const opening = `${key}\0${operationId}`;
		if (this.seen.has(opening)) return;
		this.seen.set(opening, true);
		this.bound(this.seen, RETURN_PATH_SEEN_OPENINGS);
		this.deletePath(key);
		this.paths.set(key, {
			responderIdentity: responder.identity,
			senderIdentity: sender.identity,
			senderId: sender.sessionId,
			openedAt: this.now(),
			used: new Set(),
		});
		index(this.byResponder, responder.identity, key);
		index(this.bySender, sender.identity, key);
		while (this.paths.size > this.maxEntries) {
			const oldest = this.paths.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.deletePath(oldest);
		}
	}

	/**
	 * The inbound message `operationId` from `sender` was queued for the workflow stages `target` names. It reaches a
	 * stage when that stage takes its route ({@link stageStarted}); queuing the same message again changes nothing.
	 * `liveRoutes` are the stages that already hold a route when it is queued: a stage that went live while its host was
	 * still answering for this message is handed it now, so it reaches them too.
	 */
	queue(
		target: string,
		sender: ReturnPathParty,
		operationId: string,
		liveRoutes: Iterable<{ readonly stage: ReturnPathParty; readonly target: string }> = [],
		sharesGroup: (stage: ReturnPathParty, sender: ReturnPathSender) => boolean = () => false,
	): void {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || sender.identity === undefined) return;
		const key = `${parsed.rootRunId}\0${parsed.segments.join("/")}\0${sender.identity}\0${operationId}`;
		if (this.queued.has(key)) return;
		const opening: QueuedOpening = {
			rootRunId: parsed.rootRunId,
			segments: parsed.segments,
			senderIdentity: sender.identity,
			senderId: sender.sessionId,
			operationId,
			reached: new Set(),
		};
		this.queued.set(key, opening);
		this.bound(this.queued);
		for (const route of liveRoutes) this.reach(opening, route.stage, route.target, (from) => sharesGroup(route.stage, from));
	}

	/**
	 * `stage` took the route `target`: every message queued for a path that names it reaches it now, and opens its
	 * path back to that message's sender unless `sharesGroup` says the two can already reach each other.
	 */
	stageStarted(stage: ReturnPathParty, target: string, sharesGroup: (sender: ReturnPathSender) => boolean): void {
		for (const opening of this.queued.values()) this.reach(opening, stage, target, sharesGroup);
	}

	/** `opening` reaches `stage`, which holds the route `target`, when the opening addresses it: once per stage. */
	private reach(
		opening: QueuedOpening,
		stage: ReturnPathParty,
		target: string,
		sharesGroup: (sender: ReturnPathSender) => boolean,
	): void {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || stage.identity === undefined) return;
		if (opening.rootRunId !== parsed.rootRunId || !matchStagePathSegments(opening.segments, parsed.segments)) return;
		if (opening.reached.has(stage.identity)) return;
		opening.reached.add(stage.identity);
		const sender = { identity: opening.senderIdentity, sessionId: opening.senderId };
		if (sharesGroup(sender)) return;
		this.open(stage, sender, opening.operationId);
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
	use(responder: ReturnPathParty, sender: ReturnPathParty, messageId: string): boolean {
		const path = this.path(responder, sender);
		if (path === undefined || !this.allowsOn(path, messageId)) return false;
		path.used.add(messageId);
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
		for (const [key, opening] of this.queued) {
			if (opening.senderIdentity === identity) this.queued.delete(key);
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

	private endedSince(identity: string, mark: number): boolean {
		const at = this.ended.get(identity);
		return at === undefined ? mark < this.endsForgotten : at > mark;
	}

	/** A run ended: the messages still queued for its stages never reach them. */
	forgetRun(rootRunId: string): void {
		for (const [key, opening] of this.queued) {
			if (opening.rootRunId === rootRunId) this.queued.delete(key);
		}
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
