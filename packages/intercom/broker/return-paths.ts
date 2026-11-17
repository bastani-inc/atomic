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
	/** The broker session id that sender last wrote from. */
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
	private readonly queued = new Map<string, QueuedOpening>();
	/** The inbound messages that opened a path, per path: kept when the path itself is dropped. */
	private readonly seen = new Map<string, true>();

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly windowMs = RETURN_PATH_WINDOW_MS,
		private readonly messageLimit = RETURN_PATH_MESSAGE_LIMIT,
		private readonly maxEntries = RETURN_PATH_MAX_ENTRIES,
	) {}

	/**
	 * The inbound message `operationId` from `sender` reached `responder`, which shares none of its groups. The same
	 * message reaching it again (a retry, a replay, a re-forward) changes nothing.
	 */
	open(responder: ReturnPathParty, sender: ReturnPathParty, operationId: string): void {
		if (responder.identity === undefined || sender.identity === undefined) return;
		if (responder.identity === sender.identity) return;
		const key = pathKey(responder.identity, sender.identity);
		const opening = `${key}\0${operationId}`;
		if (this.seen.has(opening)) return;
		this.seen.set(opening, true);
		this.bound(this.seen, RETURN_PATH_SEEN_OPENINGS);
		this.paths.delete(key);
		this.paths.set(key, {
			responderIdentity: responder.identity,
			senderIdentity: sender.identity,
			senderId: sender.sessionId,
			openedAt: this.now(),
			used: new Set(),
		});
		this.bound(this.paths);
	}

	/**
	 * The inbound message `operationId` from `sender` was queued for the workflow stages `target` names. It reaches a
	 * stage when that stage takes its route ({@link stageStarted}); queuing the same message again changes nothing.
	 */
	queue(target: string, sender: ReturnPathParty, operationId: string): void {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || sender.identity === undefined) return;
		const key = `${parsed.rootRunId}\0${parsed.segments.join("/")}\0${sender.identity}\0${operationId}`;
		if (this.queued.has(key)) return;
		this.queued.set(key, {
			rootRunId: parsed.rootRunId,
			segments: parsed.segments,
			senderIdentity: sender.identity,
			senderId: sender.sessionId,
			operationId,
			reached: new Set(),
		});
		this.bound(this.queued);
	}

	/**
	 * `stage` took the route `target`: every message queued for a path that names it reaches it now, and opens its
	 * path back to that message's sender unless `sharesGroup` says the two can already reach each other.
	 */
	stageStarted(stage: ReturnPathParty, target: string, sharesGroup: (sender: ReturnPathSender) => boolean): void {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined || stage.identity === undefined) return;
		for (const opening of this.queued.values()) {
			if (opening.rootRunId !== parsed.rootRunId || !matchStagePathSegments(opening.segments, parsed.segments)) continue;
			if (opening.reached.has(stage.identity)) continue;
			opening.reached.add(stage.identity);
			const sender = { identity: opening.senderIdentity, sessionId: opening.senderId };
			if (sharesGroup(sender)) continue;
			this.open(stage, sender, opening.operationId);
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

	/** The senders `responder` holds return paths to, open or closed. */
	sendersOf(responder: ReturnPathParty): ReturnPathSender[] {
		if (responder.identity === undefined) return [];
		const senders: ReturnPathSender[] = [];
		for (const path of this.paths.values()) {
			if (path.responderIdentity === responder.identity) {
				senders.push({ identity: path.senderIdentity, sessionId: path.senderId });
			}
		}
		return senders;
	}

	/** A registration ended for good: every return path it opened or holds goes with it. */
	revoke(identity: string): void {
		for (const [key, path] of this.paths) {
			if (path.responderIdentity === identity || path.senderIdentity === identity) this.paths.delete(key);
		}
		for (const [key, opening] of this.queued) {
			if (opening.senderIdentity === identity) this.queued.delete(key);
		}
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
