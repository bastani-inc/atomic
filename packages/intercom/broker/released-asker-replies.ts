import { ASK_REPLY_TIMEOUT_MS } from "../retry-policy.js";
import type { SessionInfo } from "../types.js";
import type { PendingQuestion, PendingQuestionIndex } from "./pending-question-index.js";
import { normalizeReservationTarget } from "./released-children.js";

const DEFAULT_MAX_ROUTES = 10_000;

/** #4996: why a released subagent's ask failed when the broker had no room left to route its reply. */
export const RELEASED_REPLY_ROUTES_FULL_REASON = `The Intercom broker's released-subagent reply routes are full (limit ${DEFAULT_MAX_ROUTES}); this ask can no longer receive its reply`;

export interface ReleasedAskerReplyRoute {
	readonly questionId: string;
	readonly askerSessionId: string;
	readonly childName: string;
	readonly replierSessionId: string;
	readonly ownerSessionId: string;
	readonly expiresAt: number;
}

export interface ReleasedAskerReplySizes {
	readonly routes: number;
	readonly questions: number;
	readonly children: number;
	readonly owners: number;
}

interface Entry {
	readonly questionId: string;
	readonly askerSessionId: string;
	readonly childName: string;
	readonly childKey: string;
	readonly replierSessionId: string;
	readonly expiresAt: number;
	ownerSessionId: string | undefined;
}

/** #4996: a route refused at capacity, whose asker must be told its ask can no longer be answered. */
export interface RefusedReleasedAskerRoute {
	readonly questionId: string;
	readonly askerSessionId: string;
	readonly childName: string;
	readonly replierSessionId: string;
	readonly ownerSessionId: string | undefined;
}

/** #4829: what keeps a released asker's routes durably. */
export interface ReleasedAskerReplyStore {
	kept(question: PendingQuestion): void;
	removed(question: PendingQuestion): void;
}

const questionOf = (entry: Entry): PendingQuestion => ({
	messageId: entry.questionId,
	senderSessionId: entry.askerSessionId,
	targetSessionId: entry.replierSessionId,
});

const addTo = <Key>(index: Map<Key, Set<Entry>>, key: Key, entry: Entry): void => {
	const members = index.get(key);
	if (members === undefined) index.set(key, new Set([entry]));
	else members.add(entry);
};

const removeFrom = <Key>(index: Map<Key, Set<Entry>>, key: Key, entry: Entry): void => {
	const members = index.get(key);
	if (members === undefined) return;
	members.delete(entry);
	if (members.size === 0) index.delete(key);
};

export class ReleasedAskerReplies {
	/** Routes in deadline order: expiry stops at the first route that has not expired. */
	private entries = new Set<Entry>();
	private latestExpiresAt = 0;
	private readonly byQuestion = new Map<string, Set<Entry>>();
	private readonly byChild = new Map<string, Set<Entry>>();
	private readonly byOwner = new Map<string, Set<Entry>>();
	/** #4829: where each route is written while it is kept, so it outlives this broker (see {@link persistWith}). */
	private durable: ReleasedAskerReplyStore | undefined;
	/** Routes refused because the broker's capacity was full, since this broker started. */
	droppedRoutes = 0;

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = ASK_REPLY_TIMEOUT_MS,
		private readonly maxRoutes: number = DEFAULT_MAX_ROUTES,
		private readonly onFirstOverflow: () => void = () => {},
	) {}

	/**
	 * #4829: write each route while it is kept, and forget it once it is taken or dropped, so a broker that shuts down or
	 * crashes leaves its released subagents' asks behind for the next one. {@link clear} forgets nothing.
	 */
	persistWith(store: ReleasedAskerReplyStore): void {
		this.durable = store;
	}

	/** #4996: told of each route refused at capacity, so its asker is failed rather than left waiting. */
	private refused: (route: RefusedReleasedAskerRoute) => void = () => {};

	refuseWith(handler: (route: RefusedReleasedAskerRoute) => void): void {
		this.refused = handler;
	}

	keep(
		asker: { readonly sessionId: string; readonly childName: string },
		questions: readonly PendingQuestion[],
		ownerSessionId: string | undefined,
	): number {
		this.expire();
		const childKey = normalizeReservationTarget(asker.childName);
		let kept = 0;
		for (const question of questions) {
			if (question.senderSessionId !== asker.sessionId) continue;
			// #4765: an ask kept both live and for an away recipient, or kept again, has one route.
			const existing = [...(this.byQuestion.get(question.messageId) ?? [])].find(
				(entry) =>
					entry.askerSessionId === question.senderSessionId && entry.replierSessionId === question.targetSessionId,
			);
			if (existing !== undefined) {
				if (existing.ownerSessionId === undefined && ownerSessionId !== undefined) {
					existing.ownerSessionId = ownerSessionId;
					addTo(this.byOwner, ownerSessionId, existing);
				}
				continue;
			}
			if (this.entries.size >= this.maxRoutes) {
				this.recordOverflow({
					questionId: question.messageId,
					askerSessionId: asker.sessionId,
					childName: asker.childName,
					replierSessionId: question.targetSessionId,
					ownerSessionId,
				});
				continue;
			}
			const entry: Entry = {
				questionId: question.messageId,
				askerSessionId: asker.sessionId,
				childName: asker.childName,
				childKey,
				replierSessionId: question.targetSessionId,
				expiresAt: this.now() + this.ttlMs,
				ownerSessionId,
			};
			this.add(entry);
			addTo(this.byQuestion, entry.questionId, entry);
			addTo(this.byChild, childKey, entry);
			if (ownerSessionId !== undefined) addTo(this.byOwner, ownerSessionId, entry);
			kept += 1;
		}
		return kept;
	}

	attach(childName: string, ownerSessionId: string): number {
		this.expire();
		let attached = 0;
		for (const entry of this.byChild.get(normalizeReservationTarget(childName)) ?? []) {
			if (entry.ownerSessionId !== undefined) continue;
			entry.ownerSessionId = ownerSessionId;
			addTo(this.byOwner, ownerSessionId, entry);
			attached += 1;
		}
		return attached;
	}

	take(
		questionId: string,
		replierSessionId: string,
		target: string,
		expectedRecipientId?: string,
	): ReleasedAskerReplyRoute | undefined {
		this.expire();
		const addressed = target.trim();
		for (const entry of this.byQuestion.get(questionId) ?? []) {
			if (entry.ownerSessionId === undefined || entry.replierSessionId !== replierSessionId) continue;
			if (expectedRecipientId !== undefined && expectedRecipientId !== entry.askerSessionId) continue;
			if (addressed !== entry.askerSessionId && normalizeReservationTarget(addressed) !== entry.childKey) continue;
			const route: ReleasedAskerReplyRoute = {
				questionId: entry.questionId,
				askerSessionId: entry.askerSessionId,
				childName: entry.childName,
				replierSessionId: entry.replierSessionId,
				ownerSessionId: entry.ownerSessionId,
				expiresAt: entry.expiresAt,
			};
			this.remove(entry);
			return route;
		}
		return undefined;
	}

	/** Read-only: whether {@link take} would take a route for this reply now. */
	wouldTake(questionId: string, replierSessionId: string, target: string): boolean {
		const addressed = target.trim();
		const now = this.now();
		return [...(this.byQuestion.get(questionId) ?? [])].some(
			(entry) =>
				entry.expiresAt > now &&
				entry.ownerSessionId !== undefined &&
				entry.replierSessionId === replierSessionId &&
				(addressed === entry.askerSessionId || normalizeReservationTarget(addressed) === entry.childKey),
		);
	}

	/** #4765: whether an owner holds the route for this question, so the owner is handed its reply or failure. */
	hasOwnedRoute(question: PendingQuestion): boolean {
		this.expire();
		return [...(this.byQuestion.get(question.messageId) ?? [])].some(
			(entry) =>
				entry.ownerSessionId !== undefined &&
				entry.askerSessionId === question.senderSessionId &&
				entry.replierSessionId === question.targetSessionId,
		);
	}

	/** Whether a route is kept for this question, owned or not: its durable record is this table's to forget. */
	holds(question: PendingQuestion): boolean {
		return [...(this.byQuestion.get(question.messageId) ?? [])].some(
			(entry) =>
				entry.askerSessionId === question.senderSessionId && entry.replierSessionId === question.targetSessionId,
		);
	}

	/** A definitely refused handoff may be tried again; it keeps its original deadline. */
	restore(route: ReleasedAskerReplyRoute, ownerSessionId: string | undefined): void {
		this.expire();
		if (route.expiresAt <= this.now()) return;
		if (this.entries.size >= this.maxRoutes) {
			this.recordOverflow({ ...route, ownerSessionId });
			return;
		}
		const entry: Entry = { ...route, ownerSessionId, childKey: normalizeReservationTarget(route.childName) };
		this.add(entry);
		addTo(this.byQuestion, entry.questionId, entry);
		addTo(this.byChild, entry.childKey, entry);
		if (ownerSessionId !== undefined) addTo(this.byOwner, ownerSessionId, entry);
	}

	/**
	 * #4751: the child is back under its owner's authorization: its kept asks leave this table and take the ordinary
	 * reply routes of a live asker again, so a later reply reaches the child itself.
	 */
	takeChild(childName: string, ownerSessionId: string): ReleasedAskerReplyRoute[] {
		const taken: ReleasedAskerReplyRoute[] = [];
		for (const entry of [...(this.byChild.get(normalizeReservationTarget(childName)) ?? [])]) {
			if (entry.ownerSessionId !== ownerSessionId) continue;
			taken.push({
				questionId: entry.questionId,
				askerSessionId: entry.askerSessionId,
				childName: entry.childName,
				replierSessionId: entry.replierSessionId,
				ownerSessionId,
				expiresAt: entry.expiresAt,
			});
			this.remove(entry);
		}
		return taken;
	}

	/** #4751: the replier ended or can no longer answer: its owned routes leave this table, to be failed. */
	takeForReplier(replierSessionId: string): ReleasedAskerReplyRoute[] {
		const taken: ReleasedAskerReplyRoute[] = [];
		for (const entry of [...this.entries]) {
			if (entry.replierSessionId !== replierSessionId || entry.ownerSessionId === undefined) continue;
			taken.push({
				questionId: entry.questionId,
				askerSessionId: entry.askerSessionId,
				childName: entry.childName,
				replierSessionId: entry.replierSessionId,
				ownerSessionId: entry.ownerSessionId,
				expiresAt: entry.expiresAt,
			});
			this.remove(entry);
		}
		return taken;
	}

	dropChild(childName: string, ownerSessionId: string): number {
		let dropped = 0;
		for (const entry of [...(this.byChild.get(normalizeReservationTarget(childName)) ?? [])]) {
			if (entry.ownerSessionId !== undefined && entry.ownerSessionId !== ownerSessionId) continue;
			this.remove(entry);
			dropped += 1;
		}
		return dropped;
	}

	dropOwner(ownerSessionId: string): number {
		const owned = [...(this.byOwner.get(ownerSessionId) ?? [])];
		for (const entry of owned) {
			removeFrom(this.byOwner, ownerSessionId, entry);
			entry.ownerSessionId = undefined;
		}
		return owned.length;
	}

	sizes(): ReleasedAskerReplySizes {
		return {
			routes: this.entries.size,
			questions: this.byQuestion.size,
			children: this.byChild.size,
			owners: this.byOwner.size,
		};
	}

	clear(): void {
		this.entries.clear();
		this.latestExpiresAt = 0;
		this.byQuestion.clear();
		this.byChild.clear();
		this.byOwner.clear();
	}

	private recordOverflow(route: RefusedReleasedAskerRoute): void {
		this.droppedRoutes += 1;
		if (this.droppedRoutes === 1) this.onFirstOverflow();
		this.refused(route);
	}

	private add(entry: Entry): void {
		this.durable?.kept(questionOf(entry));
		if (entry.expiresAt >= this.latestExpiresAt) {
			this.entries.add(entry);
			this.latestExpiresAt = entry.expiresAt;
			return;
		}
		const ordered = [...this.entries];
		const position = ordered.findIndex((existing) => existing.expiresAt > entry.expiresAt);
		ordered.splice(position, 0, entry);
		this.entries = new Set(ordered);
	}

	private expire(): void {
		const now = this.now();
		for (const entry of this.entries) {
			if (entry.expiresAt > now) return;
			this.remove(entry);
		}
	}

	private remove(entry: Entry): void {
		this.durable?.removed(questionOf(entry));
		this.entries.delete(entry);
		removeFrom(this.byQuestion, entry.questionId, entry);
		removeFrom(this.byChild, entry.childKey, entry);
		if (entry.ownerSessionId !== undefined) removeFrom(this.byOwner, entry.ownerSessionId, entry);
	}
}

/**
 * #4996: a released subagent's ask whose reply route the broker had no room for fails to the subagent, once: through its
 * owner, which is woken for it, or, with no owner yet, held for it under its own return address.
 */
export function failRefusedReleasedAsk(
	route: RefusedReleasedAskerRoute,
	broker: {
		readonly pendingQuestions: PendingQuestionIndex;
		readonly replier: SessionInfo | undefined;
		readonly askerReturnAddress: string | undefined;
		readonly wake: (wake: { readonly ownerSessionId: string; readonly childName: string }) => void;
	},
	now = Date.now(),
): void {
	const question = {
		messageId: route.questionId,
		senderSessionId: route.askerSessionId,
		targetSessionId: route.replierSessionId,
	};
	// Kept for an away recipient too, it would otherwise be answered or failed a second time.
	broker.pendingQuestions.forgetDormant(question);
	const from: SessionInfo = broker.replier ?? {
		id: route.replierSessionId,
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: now,
	};
	const message = {
		id: `released-routes-full:${route.questionId}`,
		timestamp: now,
		replyTo: route.questionId,
		replyError: RELEASED_REPLY_ROUTES_FULL_REASON,
		content: { text: RELEASED_REPLY_ROUTES_FULL_REASON },
	};
	if (route.ownerSessionId !== undefined) {
		broker.pendingQuestions.holdForReleasedChild(route.childName, route.ownerSessionId, {
			askerSessionId: route.askerSessionId,
			from,
			message,
		});
		broker.wake({ ownerSessionId: route.ownerSessionId, childName: route.childName });
		return;
	}
	if (broker.askerReturnAddress === undefined || broker.askerReturnAddress === "") {
		console.error(
			`Intercom broker could not tell released subagent "${route.childName}" that its ask ${route.questionId} failed: ${RELEASED_REPLY_ROUTES_FULL_REASON}`,
		);
		return;
	}
	broker.pendingQuestions.holdForAwayAsker(
		{ ...question, senderReturnAddress: broker.askerReturnAddress },
		from,
		message,
	);
}
