import { type HeldSend, RESTORING_RECIPIENT_HOLD_MS } from "./restoring-recipients.js";

/**
 * #5999: a send or ask to a subagent that finished on its own (it completed or failed) wakes it through the session
 * that launched it. The broker queues the message, answers its sender at once with a `queued` frame naming this
 * target, asks the owner to resume the child, and hands the message to the child, as an ordinary Intercom message,
 * when the resumed child registers again.
 */
export const RESUMING_RECIPIENT_TARGET = "resuming subagent";
/**
 * #5999: a send or ask to a subagent that was stopped on purpose (paused, quit, or interrupted with its parent) does not
 * wake it: the broker queues the message, answers its sender at once with a `queued` frame naming this target, and hands
 * it to the child, after whatever the child is continued with, when its launching session continues it.
 */
export const PAUSED_RECIPIENT_TARGET = "paused subagent";

/**
 * #5999: the `queued` target for a message a live subagent saved while its user had paused its turn: it reaches the
 * subagent's model when the subagent is continued. Unlike {@link PAUSED_RECIPIENT_TARGET}, the subagent keeps it, not the
 * broker.
 */
export const PAUSED_LIVE_RECIPIENT_TARGET = "paused subagent (saved)";

/** #5999: what a subagent's launching session does with a message sent to it once it ended (`EndedChildFrame.messages`). */
export type EndedChildMessages = "wake" | "hold";

/** How long the owner has to say it is resuming the child before the messages queued for it fail. */
export const ENDED_CHILD_WAKE_ANSWER_MS = 20_000;
/** How long, once its owner said it is resuming it, the child has to register before its queued messages fail. */
export const ENDED_CHILD_WAKE_START_MAX_MS = 60 * 60_000;
/**
 * How long a message kept for a paused subagent outlives the connection of the session that launched it: as long as
 * a send to a released subagent waits for that session to come back. A message for a paused subagent otherwise waits,
 * with no time limit, until that session continues it.
 */
export const ENDED_CHILD_OWNER_RETURN_MS = RESTORING_RECIPIENT_HOLD_MS;
/**
 * How long messages queued for subagents wait for the session that launched them to come back once it is away: it
 * disconnected without ending for good, or the broker restarted. The same as the retention of asks kept for an away
 * session (`AWAY_ASK_RETENTION_MS`) and of messages queued for a session on another machine
 * (`KNOWN_SESSION_RETENTION_MS`): 7 days. While the session is connected they wait with no time limit.
 */
export const ENDED_CHILD_OWNER_AWAY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** The most bytes of messages queued for one subagent that ended; a message beyond it is refused. */
export const ENDED_CHILD_QUEUE_BYTES_MAX = 32 * 1024 * 1024;
/** The most bytes of messages queued for subagents that ended, across the broker. */
export const ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX = 256 * 1024 * 1024;
/** The window the wake bounds count in. */
export const ENDED_CHILD_WAKE_WINDOW_MS = 10 * 60_000;
/** The most times one child is woken by messages within {@link ENDED_CHILD_WAKE_WINDOW_MS}. */
export const ENDED_CHILD_WAKES_PER_WINDOW = 6;
/**
 * The longest chain of wakes: a child woken by a message from a session that a wake itself started (within the
 * window) is one wake further down the chain. Two agents waking each other in turn reach it after this many wakes.
 */
export const ENDED_CHILD_WAKE_CHAIN_MAX = 4;
/** The most children the wake bounds remember; the oldest is forgotten first. */
const WAKE_BUDGET_KEYS_MAX = 4_096;

/** Who sent the message that wakes a child, as the child's owner is told. */
export interface EndedChildWaker {
	readonly id: string;
	readonly name?: string;
}

/** The broker asks the owner to resume this child for messages now queued for it. */
export interface EndedChildWakeRequest {
	readonly ownerSessionId: string;
	readonly childName: string;
	readonly childId?: string;
	/** Names this wake; the owner's answer must carry it. */
	readonly wakeId: string;
	readonly waker: EndedChildWaker;
	/** How far down a chain of wakes this one is (1: its sender was not itself woken). */
	readonly depth: number;
}

/** A queued message that will not reach its child, and why; told to its sender as a delivery failure. */
export interface EndedChildWakeFailure {
	readonly held: HeldSend;
	readonly childName: string;
	readonly reason: string;
}

const queuedForWake = new WeakSet<HeldSend>();
const heldWhilePaused = new WeakSet<HeldSend>();

/** Whether this held send was answered `queued` and waits for its child to be resumed, rather than holding its sender. */
export function isQueuedForWake(held: HeldSend): boolean {
	return queuedForWake.has(held);
}

/** Whether this queued send waits for a paused child to be continued, so it reaches the child after what continues it. */
export function isHeldWhilePaused(held: HeldSend): boolean {
	return heldWhilePaused.has(held);
}

export function markQueuedForWake(held: HeldSend, messages: EndedChildMessages): void {
	queuedForWake.add(held);
	if (messages === "hold") heldWhilePaused.add(held);
	else heldWhilePaused.delete(held);
}

/** Whether a send asks to wake an ended recipient: the sender opted in, and it is not one copy of a pattern send. */
export function sendWakesEndedRecipient(clientMessage: Readonly<Record<string, unknown>>): boolean {
	if (clientMessage.type !== "send" || clientMessage.wakeEndedRecipient !== true) return false;
	const message = clientMessage.message as { readonly broadcastId?: unknown; readonly replyTo?: unknown } | undefined;
	return message?.broadcastId === undefined;
}

export type WakeBudgetVerdict =
	| { readonly ok: true; readonly depth: number }
	| { readonly ok: false; readonly why: string };

/**
 * Durable wake queue: where the wake bounds write what they count, so a restart does not reset them. Times are wall
 * clock (`Date.now()`); the bounds count in `performance.now()`, which is per process.
 */
export interface EndedChildWakeBudgetJournal {
	wake(childKey: string, at: number, depth: number): void;
	awake(childKey: string, depth: number, at: number): void;
}

/** A wake the bounds counted, or a child back from one, as the journal recorded it. */
export interface EndedChildWakeBudgetEvent {
	readonly childKey: string;
	readonly kind: "wake" | "awake";
	readonly at: number;
	readonly depth: number;
}

/**
 * #5999: the bounds on message wakes, so agents cannot wake each other without end. Each child is woken at most
 * {@link ENDED_CHILD_WAKES_PER_WINDOW} times per {@link ENDED_CHILD_WAKE_WINDOW_MS}, and a chain of wakes, each started
 * by a message from a session the previous wake resumed, is at most {@link ENDED_CHILD_WAKE_CHAIN_MAX} long. A wake
 * whose sender was woken by this very child counts as one more link of that chain. Keys are the broker's
 * `<owner session>\0<child name>` departure keys; everything is in memory, as the departures themselves are.
 */
export class EndedChildWakeBudget {
	private readonly wakes = new Map<string, number[]>();
	private readonly awake = new Map<string, { readonly depth: number; readonly at: number }>();
	/** Durable wake queue: where wakes and chain depths are written, so they outlive the broker. */
	journal: EndedChildWakeBudgetJournal | undefined;

	constructor(
		private readonly now: () => number = () => performance.now(),
		private readonly windowMs = ENDED_CHILD_WAKE_WINDOW_MS,
		private readonly perWindow = ENDED_CHILD_WAKES_PER_WINDOW,
		private readonly chainMax = ENDED_CHILD_WAKE_CHAIN_MAX,
		private readonly wallNow: () => number = Date.now,
	) {}

	/**
	 * Durable wake queue: count again what an earlier broker counted. A wall-clock time is placed as far back on this
	 * process's clock as it is in the past, and never in the future: after the wall clock stepped back, a wake counts as
	 * just now and is forgotten one window later, so the bounds are never stricter for longer than a window.
	 */
	restore(events: readonly EndedChildWakeBudgetEvent[]): void {
		const now = this.now();
		const wallNow = this.wallNow();
		for (const event of events) {
			const at = now - Math.max(0, wallNow - event.at);
			if (now - at >= this.windowMs) continue;
			if (event.kind === "wake") {
				const recent = this.wakes.get(event.childKey) ?? [];
				recent.push(at);
				recent.sort((left, right) => left - right);
				this.wakes.set(event.childKey, recent);
				this.trim(this.wakes);
			} else {
				const known = this.awake.get(event.childKey);
				if (known !== undefined && known.at > at) continue;
				this.awake.delete(event.childKey);
				this.awake.set(event.childKey, { depth: event.depth, at });
				this.trim(this.awake);
			}
		}
	}

	/** Whether `childKey` may be woken by a message from the session `senderKey` names (a subagent), and how deep. */
	check(childKey: string, senderKey: string | undefined): WakeBudgetVerdict {
		const now = this.now();
		const recent = this.recentWakes(childKey, now);
		if (recent.length >= this.perWindow)
			return {
				ok: false,
				why: `it was already woken by messages ${recent.length} times in the last ${minutes(this.windowMs)}; try again later`,
			};
		const depth = this.depthOf(senderKey, now) + 1;
		if (depth > this.chainMax)
			return {
				ok: false,
				why: `the message came from a chain of ${depth - 1} subagents each woken by the one before, and wakes stop at ${this.chainMax} in a row so agents cannot wake each other without end`,
			};
		return { ok: true, depth };
	}

	/** Count a wake of `childKey`, `depth` down its chain. */
	commit(childKey: string, depth = 1): void {
		const now = this.now();
		const recent = this.recentWakes(childKey, now);
		recent.push(now);
		this.wakes.delete(childKey);
		this.wakes.set(childKey, recent);
		this.trim(this.wakes);
		this.journal?.wake(childKey, this.wallNow(), depth);
	}

	/** The child registered again from a wake `depth` down its chain: messages it sends wake one further down. */
	awoke(childKey: string, depth: number): void {
		this.awake.delete(childKey);
		this.awake.set(childKey, { depth, at: this.now() });
		this.trim(this.awake);
		this.journal?.awake(childKey, depth, this.wallNow());
	}

	/** The child registered again without a wake (its owner resumed it): it starts no chain. */
	resumedByOwner(childKey: string): void {
		if (!this.awake.delete(childKey)) return;
		this.journal?.awake(childKey, 0, this.wallNow());
	}

	sizes(): { readonly wakes: number; readonly awake: number } {
		return { wakes: this.wakes.size, awake: this.awake.size };
	}

	private depthOf(senderKey: string | undefined, now: number): number {
		if (senderKey === undefined) return 0;
		const awake = this.awake.get(senderKey);
		if (awake === undefined) return 0;
		if (now - awake.at > this.windowMs) {
			this.awake.delete(senderKey);
			return 0;
		}
		return awake.depth;
	}

	private recentWakes(childKey: string, now: number): number[] {
		const recent = (this.wakes.get(childKey) ?? []).filter((at) => now - at < this.windowMs);
		if (recent.length === 0) this.wakes.delete(childKey);
		return recent;
	}

	private trim<Value>(map: Map<string, Value>): void {
		while (map.size > WAKE_BUDGET_KEYS_MAX) map.delete(map.keys().next().value as string);
	}
}

function minutes(ms: number): string {
	const whole = Math.round(ms / 60_000);
	return whole === 1 ? "minute" : `${whole} minutes`;
}
