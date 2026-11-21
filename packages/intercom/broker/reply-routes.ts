/**
 * How the broker would take a reply a session sent now to one of the asks it holds: `refused` when it would refuse it as
 * one no pending question authorizes, `deliver` when it would route it, or a reservation or wake of its asker may
 * restore its route, and `unknown` when it cannot tell (a broker without the query, routing across machines, an asker
 * not registered, routes not restored yet). Only `refused` closes an ask; the query routes, holds and changes nothing.
 */
export type ReplyRouteVerdict = "refused" | "deliver" | "unknown";

/** How long a session waits for the broker's answer before it takes every reply as `unknown`. */
export const REPLY_ROUTES_TIMEOUT_MS = 5_000;

/** The most replies one `reply_routes` frame asks about. */
export const REPLY_ROUTES_FRAME_MAX = 256;

export function isReplyRouteVerdict(value: unknown): value is ReplyRouteVerdict {
	return value === "refused" || value === "deliver" || value === "unknown";
}

/** What the broker knows about one reply, read without changing anything. */
export interface ReplyRouteFacts {
	/** Replies are routed across machines: another broker may hold the route. */
	readonly acrossMachines: boolean;
	/** A route kept for an asker that left, owned by a session that reserved it, would take this reply now. */
	readonly keptRouteTakes: boolean;
	/** The session `to` names is connected to this broker. */
	readonly askerConnected: boolean;
	/** A pending question of that session to the replier, under this ask's id, authorizes the reply. */
	readonly correlated: boolean;
	/** The ask is written but not confirmed yet, or the asker's or the replier's routes are still being restored. */
	readonly restoring: boolean;
	/** The asker is a subagent its owner holds a released reservation or a wake for: its route may come back. */
	readonly reservedOrWaking: boolean;
}

/** The verdict for one reply, in the order the send path decides it (send-handler.ts with `requirePendingReply`). */
export function replyRouteVerdict(facts: ReplyRouteFacts): ReplyRouteVerdict {
	if (facts.acrossMachines) return "unknown";
	if (facts.keptRouteTakes) return "deliver";
	if (!facts.askerConnected) return "unknown";
	if (facts.correlated) return "deliver";
	if (facts.restoring) return "unknown";
	if (facts.reservedOrWaking) return "deliver";
	return "refused";
}
