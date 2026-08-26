import type { Message, SessionInfo } from "./types.js";

export interface PendingReplyRoute {
	from: string;
	replyTo: string;
	resolve(message: Message): void;
}

type PendingReplyRoutes = PendingReplyRoute | Iterable<PendingReplyRoute> | null | undefined;

function matches(waiter: PendingReplyRoute, from: SessionInfo, message: Message): boolean {
	const senderTarget = from.name || from.id;
	const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
	return fromMatches && message.replyTo === waiter.replyTo;
}

/** Routes only the first exact sender/thread pair to a blocking tool waiter. */
export function routeIncomingReply(waiters: PendingReplyRoutes, from: SessionInfo, message: Message): boolean {
	if (!waiters) return false;
	const candidates = Symbol.iterator in Object(waiters) ? waiters : [waiters];
	for (const waiter of candidates as Iterable<PendingReplyRoute>) {
		if (!matches(waiter, from, message)) continue;
		waiter.resolve(message);
		return true;
	}
	return false;
}
