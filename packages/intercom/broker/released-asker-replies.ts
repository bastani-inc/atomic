import { ASK_REPLY_TIMEOUT_MS } from "../retry-policy.js";
import type { PendingQuestion } from "./pending-question-index.js";
import { normalizeReservationTarget } from "./released-children.js";

const DEFAULT_MAX_ROUTES = 10_000;

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
	private readonly entries = new Set<Entry>();
	private readonly byQuestion = new Map<string, Set<Entry>>();
	private readonly byChild = new Map<string, Set<Entry>>();
	private readonly byOwner = new Map<string, Set<Entry>>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = ASK_REPLY_TIMEOUT_MS,
		private readonly maxRoutes: number = DEFAULT_MAX_ROUTES,
	) {}

	keep(
		asker: { readonly sessionId: string; readonly childName: string },
		questions: readonly PendingQuestion[],
		ownerSessionId: string | undefined,
	): number {
		this.expire();
		const childKey = normalizeReservationTarget(asker.childName);
		let kept = 0;
		for (const question of questions) {
			if (question.senderSessionId !== asker.sessionId || this.entries.size >= this.maxRoutes) continue;
			const entry: Entry = {
				questionId: question.messageId,
				askerSessionId: asker.sessionId,
				childName: asker.childName,
				childKey,
				replierSessionId: question.targetSessionId,
				expiresAt: this.now() + this.ttlMs,
				ownerSessionId,
			};
			this.entries.add(entry);
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

	/** A definitely refused handoff may be tried again; it keeps its original deadline. */
	restore(route: ReleasedAskerReplyRoute, ownerSessionId: string | undefined): void {
		this.expire();
		if (route.expiresAt <= this.now() || this.entries.size >= this.maxRoutes) return;
		const entry: Entry = { ...route, ownerSessionId, childKey: normalizeReservationTarget(route.childName) };
		this.entries.add(entry);
		addTo(this.byQuestion, entry.questionId, entry);
		addTo(this.byChild, entry.childKey, entry);
		if (ownerSessionId !== undefined) addTo(this.byOwner, ownerSessionId, entry);
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
		this.byQuestion.clear();
		this.byChild.clear();
		this.byOwner.clear();
	}

	private expire(): void {
		const now = this.now();
		for (const entry of this.entries) {
			if (entry.expiresAt > now) return;
			this.remove(entry);
		}
	}

	private remove(entry: Entry): void {
		this.entries.delete(entry);
		removeFrom(this.byQuestion, entry.questionId, entry);
		removeFrom(this.byChild, entry.childKey, entry);
		if (entry.ownerSessionId !== undefined) removeFrom(this.byOwner, entry.ownerSessionId, entry);
	}
}
