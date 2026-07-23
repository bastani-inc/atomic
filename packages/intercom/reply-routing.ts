import type { Message, SessionInfo } from "./types.js";

export interface PendingReplyRoute {
	from: string;
	replyTo: string;
	resolve(message: Message): void;
}

/** Routes only the exact sender/thread pair to a blocking tool waiter. */
export function routeIncomingReply(waiter: PendingReplyRoute | null | undefined, from: SessionInfo, message: Message): boolean {
	if (!waiter) return false;
	const senderTarget = from.name || from.id;
	const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
	if (!fromMatches || message.replyTo !== waiter.replyTo) return false;
	waiter.resolve(message);
	return true;
}
