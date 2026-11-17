import { matchStagePathSegments } from "../workflow-stage-path-matching.js";
import { parseWorkflowStageTarget } from "../workflow-stage-target.js";

/**
 * How long a return path stays open after the message that opened it reached the recipient. A message queued for a
 * workflow stage reaches it when the stage starts.
 */
export const RETURN_PATH_WINDOW_MS = 30 * 60_000;
/** Messages a recipient may send back after the latest message that reached it: an answer, a correction and a final result. */
export const RETURN_PATH_MESSAGE_LIMIT = 3;
/** Return paths, and answer counts, this broker keeps at once; the oldest is dropped first. */
export const RETURN_PATH_MAX_ENTRIES = 10_000;

/** How the intercom tool tells the model about return paths, after "cross-group sends are rejected by the broker". */
export const RETURN_PATH_TOOL_NOTE = `except an answer to a sender outside your groups whose message reached you (up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${Math.round(RETURN_PATH_WINDOW_MS / 60_000)} minutes of its latest one)`;

/** Why a send to a sender whose return path has closed is refused. */
export function returnPathClosedReason(sender: string): string {
	const minutes = Math.round(RETURN_PATH_WINDOW_MS / 60_000);
	return `${sender} is outside your intercom groups and its return path has closed: a session outside your groups can be answered with up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${minutes} minutes of its latest message to you. It reopens when ${sender} writes to you again.`;
}

/** The session sending back, and the workflow stage routes it holds. */
export interface ReturnPathResponder {
	readonly sessionId: string;
	/** Each live workflow stage route this session holds, and when this session first took it. */
	readonly stageRoutes: readonly { readonly target: string; readonly registeredAt: number }[];
}

type ReturnPath =
	| { readonly kind: "session"; readonly responderId: string; readonly senderId: string; readonly openedAt: number }
	| {
			readonly kind: "stage";
			readonly rootRunId: string;
			readonly segments: readonly string[];
			readonly senderId: string;
			readonly openedAt: number;
	  };

/** Answers one responder sent one sender since the message that reached it at `openedAt`. */
interface AnswerCount {
	readonly openedAt: number;
	/** Distinct message ids: a retried message is counted once. */
	readonly messageIds: Set<string>;
}

/**
 * Response permissions across intercom groups, after NATS `allow_responses`: a session that received a message from
 * a sender outside its groups may send back to that sender, and only to it, with at most
 * {@link RETURN_PATH_MESSAGE_LIMIT} messages within {@link RETURN_PATH_WINDOW_MS} of the latest message from that
 * sender that reached it. Group membership, listing and pattern sends are unchanged; nothing here lets a recipient
 * reach a third session.
 */
export class ReturnPaths {
	private readonly paths = new Map<string, ReturnPath>();
	/** The keys of the paths back to each sender. */
	private readonly bySender = new Map<string, Set<string>>();
	private readonly answers = new Map<string, AnswerCount>();

	constructor(
		private readonly windowMs = RETURN_PATH_WINDOW_MS,
		private readonly messageLimit = RETURN_PATH_MESSAGE_LIMIT,
		private readonly maxEntries = RETURN_PATH_MAX_ENTRIES,
	) {}

	/** A message from `senderId` reached `responderId`, which shares none of its groups. */
	openForSession(responderId: string, senderId: string, at = Date.now()): void {
		if (responderId === senderId) return;
		this.set(`session\0${responderId}\0${senderId}`, { kind: "session", responderId, senderId, openedAt: at });
	}

	/** A message from `senderId` was queued for the workflow stages `target` names; it reaches each when it starts. */
	openForStageTarget(target: string, senderId: string, at = Date.now()): void {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined) return;
		this.set(`stage\0${parsed.rootRunId}\0${parsed.segments.join("/")}\0${senderId}`, {
			kind: "stage",
			rootRunId: parsed.rootRunId,
			segments: parsed.segments,
			senderId,
			openedAt: at,
		});
	}

	/** Whether any return path leads back to `senderId`, for whichever responder. */
	leadsTo(senderId: string): boolean {
		return this.bySender.has(senderId);
	}

	/** Whether `responder` may send `messageId` to `senderId`; a message already counted is always allowed again. */
	allows(responder: ReturnPathResponder, senderId: string, messageId: string, at = Date.now()): boolean {
		return this.open(responder, senderId, messageId, at) !== undefined;
	}

	/** Counts `messageId` as an answer to `senderId`; false when no open return path allows it. */
	use(responder: ReturnPathResponder, senderId: string, messageId: string, at = Date.now()): boolean {
		const count = this.open(responder, senderId, messageId, at);
		if (count === undefined) return false;
		count.messageIds.add(messageId);
		const key = answerKey(responder.sessionId, senderId);
		this.answers.delete(key);
		this.answers.set(key, count);
		while (this.answers.size > this.maxEntries) {
			const oldest = this.answers.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.answers.delete(oldest);
		}
		return true;
	}

	/** Whether `responder` had a return path to `senderId` that has closed: used up, or past its window. */
	closed(responder: ReturnPathResponder, senderId: string, at = Date.now()): boolean {
		const openedAt = this.latestOpening(responder, senderId);
		return openedAt !== undefined && this.open(responder, senderId, undefined, at) === undefined;
	}

	/** A run ended: its stage return paths go with it. */
	forgetRun(rootRunId: string): void {
		for (const [key, path] of this.paths) {
			if (path.kind === "stage" && path.rootRunId === rootRunId) this.delete(key);
		}
	}

	/**
	 * The answer count to add `messageId` to, when the latest message from `senderId` that reached `responder` still
	 * allows it. Only that message counts: an older one's path never adds answers.
	 */
	private open(
		responder: ReturnPathResponder,
		senderId: string,
		messageId: string | undefined,
		at: number,
	): AnswerCount | undefined {
		const openedAt = this.latestOpening(responder, senderId);
		if (openedAt === undefined) return undefined;
		const counted = this.answers.get(answerKey(responder.sessionId, senderId));
		const count =
			counted !== undefined && counted.openedAt === openedAt ? counted : { openedAt, messageIds: new Set<string>() };
		if (messageId !== undefined && count.messageIds.has(messageId)) return count;
		if (at - openedAt > this.windowMs || count.messageIds.size >= this.messageLimit) return undefined;
		return count;
	}

	/** When the latest message from `senderId` reached `responder`, or undefined when none did. */
	private latestOpening(responder: ReturnPathResponder, senderId: string): number | undefined {
		let latest: number | undefined;
		for (const key of this.bySender.get(senderId) ?? []) {
			const path = this.paths.get(key);
			const opened = path === undefined ? undefined : openingFor(path, responder);
			if (opened !== undefined && (latest === undefined || opened > latest)) latest = opened;
		}
		return latest;
	}

	private set(key: string, path: ReturnPath): void {
		this.delete(key);
		this.paths.set(key, path);
		const keys = this.bySender.get(path.senderId) ?? new Set<string>();
		keys.add(key);
		this.bySender.set(path.senderId, keys);
		while (this.paths.size > this.maxEntries) {
			const oldest = this.paths.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
	}

	private delete(key: string): void {
		const path = this.paths.get(key);
		if (path === undefined) return;
		this.paths.delete(key);
		const keys = this.bySender.get(path.senderId);
		keys?.delete(key);
		if (keys?.size === 0) this.bySender.delete(path.senderId);
	}
}

function answerKey(responderId: string, senderId: string): string {
	return `${responderId}\0${senderId}`;
}

/** When `path`'s message reached `responder`, or undefined when it did not reach it. */
function openingFor(path: ReturnPath, responder: ReturnPathResponder): number | undefined {
	if (path.kind === "session") return path.responderId === responder.sessionId ? path.openedAt : undefined;
	let opened: number | undefined;
	for (const route of responder.stageRoutes) {
		const parsed = parseWorkflowStageTarget(route.target);
		if (parsed === undefined || parsed.rootRunId !== path.rootRunId) continue;
		if (!matchStagePathSegments(path.segments, parsed.segments)) continue;
		// A message queued before the stage started reaches it as it starts.
		const reached = Math.max(path.openedAt, route.registeredAt);
		opened = opened === undefined ? reached : Math.max(opened, reached);
	}
	return opened;
}
