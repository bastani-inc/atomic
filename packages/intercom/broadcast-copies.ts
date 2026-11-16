import type { Message, SessionInfo } from "./types.js";

/** Broadcasts a session remembers; the copies of one arrive within moments of each other. */
const REMEMBERED_BROADCASTS = 1_024;

/**
 * Every copy of one pattern send carries the same `broadcastId`, though each has its own message id. A session can
 * receive several copies: its own, and one from each released workflow stage it hosts, which relays its copy here.
 * The copy that arrives first is the one shown. A message without a `broadcastId`, as an older sender sends, is shown.
 */
export class BroadcastCopies {
	/** The message id of the copy shown, per sender and broadcast. */
	private readonly shown = new Map<string, string>();

	/**
	 * Whether this session shows `message`: it is no broadcast copy, or it is the first copy of its broadcast to arrive
	 * from `from`. The same copy arriving again, as a resent message does, is still the one shown.
	 */
	claim(from: Pick<SessionInfo, "id">, message: Pick<Message, "id" | "broadcastId">): boolean {
		if (message.broadcastId === undefined) return true;
		const key = JSON.stringify([from.id, message.broadcastId]);
		const shown = this.shown.get(key);
		if (shown !== undefined) return shown === message.id;
		this.shown.set(key, message.id);
		if (this.shown.size > REMEMBERED_BROADCASTS) {
			const oldest = this.shown.keys().next().value;
			if (oldest !== undefined) this.shown.delete(oldest);
		}
		return true;
	}
}
