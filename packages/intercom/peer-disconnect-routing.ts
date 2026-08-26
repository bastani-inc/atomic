export interface PeerDisconnectWaiter {
	from: string;
	replyTo: string;
	reject(error: Error): void;
}

export interface PeerDisconnectNotice {
	replyTo: string;
	peerSessionId: string;
	peerName?: string;
}

type PeerDisconnectWaiters = PeerDisconnectWaiter | Iterable<PeerDisconnectWaiter> | null | undefined;

function matches(waiter: PeerDisconnectWaiter, notice: PeerDisconnectNotice): boolean {
	const peerTarget = notice.peerName || notice.peerSessionId;
	const peerMatches = peerTarget.toLowerCase() === waiter.from.toLowerCase() || notice.peerSessionId === waiter.from;
	return peerMatches && notice.replyTo === waiter.replyTo;
}

/** Rejects only the first exact departed-peer/thread pair for a blocking tool waiter. */
export function routePeerDisconnect(waiters: PeerDisconnectWaiters, notice: PeerDisconnectNotice): boolean {
	if (!waiters) return false;
	const candidates = Symbol.iterator in Object(waiters) ? waiters : [waiters];
	for (const waiter of candidates as Iterable<PeerDisconnectWaiter>) {
		if (!matches(waiter, notice)) continue;
		waiter.reject(new Error(`Session "${notice.peerName ?? notice.peerSessionId}" disconnected before replying`));
		return true;
	}
	return false;
}
