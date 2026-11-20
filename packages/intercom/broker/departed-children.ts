import { randomUUID } from "node:crypto";
import { hasGroup, normalizeGroup } from "../group.js";
import type { ReleasedChildRefusal } from "../types.js";
import { intercomMessageBytes } from "../message-size.js";
import type { Message } from "../types.js";
import {
	ENDED_CHILD_OWNER_AWAY_MAX_MS,
	ENDED_CHILD_QUEUE_BYTES_MAX,
	ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX,
	ENDED_CHILD_WAKE_ANSWER_MS,
	ENDED_CHILD_WAKE_START_MAX_MS,
	type EndedChildWakeBudget,
	isMaybeDelivered,
	type EndedChildWakeFailure,
	type EndedChildMessages,
	type EndedChildWakeRequest,
	type EndedChildWaker,
	markQueuedForWake,
	PAUSED_RECIPIENT_TARGET,
	RESUMING_RECIPIENT_TARGET,
	sendWakesEndedRecipient,
} from "./ended-child-wakes.js";
import type { JsonWireValue } from "./framing.js";
import { type HoldSender, holdAdmitsSender } from "./group-membership.js";
import {
	type IntercomRecipientGoneError,
	SUBAGENT_ENDED_OUTCOMES,
	type SubagentEndedOutcome,
	SubagentRecipientDisconnectedError,
	subagentRecipientEnded,
} from "./recipient-gone-errors.js";
import {
	isRestoringRecipientAlias,
	isValidChildName,
	normalizeReservationTarget,
	RELEASED_CHILD_ALIASES_MAX,
	RELEASED_CHILD_FRAME_MAX,
} from "./released-children.js";
import { type HeldSend, RESTORING_RECIPIENT_HOLD_MS } from "./restoring-recipients.js";

/**
 * How long a send waits for a subagent whose session just disconnected: for it to reconnect, or for the session that
 * launched it to say why it ended (#4639). The same bound as a subagent being restored.
 */
export const DEPARTED_CHILD_HOLD_MS = RESTORING_RECIPIENT_HOLD_MS;
/** The most subagents one owner keeps an answer for; the oldest is forgotten first. */
export const DEPARTED_CHILDREN_PER_OWNER_MAX = 1_024;
/**
 * The most subagents kept for owners that disconnected, across the broker; the oldest is forgotten first (#4639). An
 * owner's host session comes back for them.
 */
export const DEPARTED_ORPHANS_MAX = 4_096;
/** The longest delay one `setTimeout` takes (2^31 - 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The most sends held for one subagent; later ones are refused as for a subagent that did not come back. */
const MAX_HELD_SENDS = 256;

/** A subagent whose session just disconnected, as the broker knew it. */
export interface DepartingChild {
	readonly ownerSessionId: string;
	readonly childName: string;
	readonly group: string;
	/** Its Intercom id and Atomic session id, when known. */
	readonly aliases: readonly string[];
	/** Set when the owner's connection is already gone: the owner's host session, whose next session takes the subagent over. */
	readonly ownerHostSession?: string;
}

/** One subagent its owner reports ended, and why (#4639). */
export interface EndedChildMark {
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly outcome: SubagentEndedOutcome;
	readonly childId?: string;
	/**
	 * #5999: what its owner does with a send that asks to wake it: resume it (`wake`, for one that finished on its own),
	 * or keep the message for when it continues it (`hold`, for one stopped on purpose). Absent: refused as before.
	 */
	readonly messages?: EndedChildMessages;
}

/** A held send to refuse, with the typed refusal naming why its subagent is gone. */
export interface HeldSendRefusal {
	readonly held: HeldSend;
	readonly error: IntercomRecipientGoneError;
	/** #5999: the reason to give instead of the error's message, when it says more. */
	readonly reason?: string;
}

export type DepartedChildAdmission =
	| { readonly kind: "none" }
	| { readonly kind: "held"; readonly timeoutMs: number }
	| { readonly kind: "refused"; readonly error: IntercomRecipientGoneError };

/** #5999: what becomes of a send that asks to wake an ended subagent. */
export type EndedChildWakeAdmission =
	/** No subagent its owner resumes for a message answers to the target: decided as before. */
	| { readonly kind: "none" }
	/**
	 * Queued for the child; `target` tells the sender why (`resuming subagent` or `paused subagent`). `wake`, when
	 * present, is the owner's request to resume it, to send now.
	 */
	| {
			readonly kind: "queued";
			readonly target: string;
			readonly wake?: EndedChildWakeRequest;
			/**
			 * Durable wake queue: resolves once the message is kept where it outlives the broker (absent when nothing keeps
			 * it but memory); its sender is answered after that.
			 */
			readonly kept?: Promise<unknown>;
			/** A retry of a message already queued (its `queued` answer was lost): answered again, nothing else. */
			readonly duplicate?: true;
	  }
	/** A wake bound refused it: the child's ended refusal, and `reason` saying why it was not woken. */
	| { readonly kind: "refused"; readonly error: IntercomRecipientGoneError; readonly reason: string };

/** The sender of a send that may wake a subagent: who it is, and the departure key it has as a subagent itself. */
export interface WakeSender extends HoldSender {
	readonly waker: EndedChildWaker;
	/** `<supervisor>\0<registration name>` of a sender that is a subagent: a wake it started is found by it. */
	readonly wakeKey?: string;
}

/** #5999: what the broker does with the sends of a subagent whose verdict changed, beyond refusing and evicting. */
export interface DepartedChildrenWakeHooks {
	/** Queued messages that will not reach their child: each sender is told why. */
	readonly failed: (failures: readonly EndedChildWakeFailure[]) => void;
	readonly budget?: EndedChildWakeBudget;
	/** Whether the owner session is connected here, so it can be asked to wake its child. */
	readonly ownerLive: (ownerSessionId: string) => boolean;
	/** The owner's host session (its return address) while it is connected here. */
	readonly ownerHost?: (ownerSessionId: string) => string | undefined;
	/** Durable wake queue: where queued messages and wakes are written so they outlive the broker. */
	readonly journal?: DepartedChildrenJournal;
	/** Held sends of subagents forgotten to make room while restoring, for ordinary routing. */
	readonly evicted?: (sends: readonly HeldSend[]) => void;
}

/** Durable wake queue: one departure, as its rows name it. */
export interface JournalDeparture {
	readonly ownerSessionId: string;
	readonly ownerHost?: string;
	/** The normalized child name. */
	readonly childKey: string;
	readonly child: {
		readonly childName: string;
		readonly group: string;
		readonly aliases: readonly string[];
		readonly childId?: string;
		readonly outcome: SubagentEndedOutcome;
		readonly messages: EndedChildMessages;
	};
	/** The wake asked of the owner for these messages, if one is. */
	readonly wake?: JournalWake;
}

/** Durable wake queue: the wake asked of the owner, as kept with the departure's rows. */
export interface JournalWake {
	readonly id: string;
	readonly depth: number;
	/** Wall-clock milliseconds when the owner said it is resuming the child. */
	readonly acceptedAt?: number;
}

/** Durable wake queue: what changes of a departure's queue are written, so a restarted broker takes them up. */
export interface DepartedChildrenJournal {
	/**
	 * A message joined the child's queue; resolves once it is kept, and its sender is answered after that. Undefined when
	 * nothing but memory keeps it.
	 */
	queued(held: HeldSend, departure: JournalDeparture): Promise<unknown> | undefined;
	wake(departure: JournalDeparture, wake: JournalWake | undefined): void;
	ownerAway(departures: readonly JournalDeparture[], since: number | undefined): void;
	rekeyOwner(departure: JournalDeparture, ownerSessionId: string): void;
}

/** Durable wake queue: the messages a restarted broker found kept for one subagent, in the order they were queued. */
export interface RestoredEndedQueue {
	readonly ownerSessionId: string;
	readonly ownerHost: string;
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly childId?: string;
	readonly outcome: SubagentEndedOutcome;
	readonly messages: EndedChildMessages;
	/** Each message with its sender, and its bytes as the store counted them. */
	readonly sends: ReadonlyArray<{ readonly held: HeldSend; readonly sender: WakeSender; readonly bytes?: number }>;
	readonly wake?: JournalWake;
	/** Wall-clock milliseconds since when its owner has been away, as last written. */
	readonly awaySince?: number;
}

/** The longest `childId` a mark may carry: a run id and an index. */
const CHILD_ID_MAX = 256;
const OUTCOMES: ReadonlySet<JsonWireValue | undefined> = new Set(SUBAGENT_ENDED_OUTCOMES);

export type EndedChildrenFrameValidation =
	| { readonly ok: true; readonly children: readonly EndedChildMark[] }
	| { readonly ok: false; readonly refusal: ReleasedChildRefusal };

function refuseMark(code: ReleasedChildRefusal["code"], item?: { readonly [key: string]: JsonWireValue }) {
	const childName = item !== undefined && typeof item.childName === "string" ? item.childName : undefined;
	return { ok: false as const, refusal: childName === undefined ? { code } : { code, childName } };
}

/**
 * Validate one `mark_ended_children` frame as a whole, before anything is marked: the child-name, alias and group
 * rules of a released-child reservation, an outcome the broker knows and a bounded `childId`. A child with no group
 * takes the owner's registration group.
 */
export function validateEndedChildrenFrame(
	children: JsonWireValue | undefined,
	ownerGroup: string | undefined,
): EndedChildrenFrameValidation {
	if (!Array.isArray(children) || children.length === 0 || children.length > RELEASED_CHILD_FRAME_MAX)
		return refuseMark("invalid_frame");
	const parsed: EndedChildMark[] = [];
	for (const item of children) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return refuseMark("invalid_frame");
		if (typeof item.childName !== "string" || !isValidChildName(item.childName))
			return refuseMark("invalid_child_name", item);
		if (!OUTCOMES.has(item.outcome)) return refuseMark("invalid_frame", item);
		if (item.childId !== undefined && (typeof item.childId !== "string" || item.childId.length > CHILD_ID_MAX))
			return refuseMark("invalid_frame", item);
		if (item.group !== undefined && typeof item.group !== "string") return refuseMark("invalid_group", item);
		if (item.messages !== undefined && item.messages !== "wake" && item.messages !== "hold")
			return refuseMark("invalid_frame", item);
		const aliases = item.aliases ?? [];
		if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string"))
			return refuseMark("invalid_alias", item);
		if (aliases.length > RELEASED_CHILD_ALIASES_MAX) return refuseMark("too_many_aliases", item);
		const aliasIds = aliases as string[];
		if (!aliasIds.every(isRestoringRecipientAlias)) return refuseMark("invalid_alias", item);
		parsed.push({
			childName: item.childName.trim(),
			group: normalizeGroup(item.group ?? ownerGroup),
			aliases: aliasIds,
			outcome: item.outcome as SubagentEndedOutcome,
			childId: item.childId,
			...(item.messages !== undefined && item.outcome !== "cancelled"
				? { messages: item.messages as EndedChildMessages }
				: {}),
		});
	}
	return { ok: true, children: parsed };
}

type Verdict =
	| {
			readonly kind: "ended";
			readonly outcome: SubagentEndedOutcome;
			readonly childId?: string;
			readonly messages?: EndedChildMessages;
	  }
	| { readonly kind: "disconnected" };

/** #5999: the owner was asked to resume the child for the messages queued for it. */
interface PendingWake {
	readonly id: string;
	readonly depth: number;
	accepted: boolean;
}

/** The verdict of a subagent nobody said anything about before its wait ended. */
const DISCONNECTED: Verdict = { kind: "disconnected" };

interface Departure {
	key: string;
	ownerSessionId: string;
	readonly childName: string;
	group: string;
	readonly targets: Set<string>;
	verdict?: Verdict;
	/** While no verdict is known: when, by `performance.now()`, the sends held now stop waiting for one. */
	deadline?: number;
	timer?: ReturnType<typeof setTimeout>;
	readonly held: HeldSend[];
	/** #5999: sends answered `queued` that wait for the child's wake, in admission order. */
	readonly queued: HeldSend[];
	/** #5999: the bytes of the messages in `queued`. */
	queuedBytes: number;
	wake?: PendingWake;
	/** #5999: when the messages queued for the child fail if it has not registered by then. */
	queueTimer?: ReturnType<typeof setTimeout>;
	/** Durable wake queue: its owner's host session, as its rows are keyed by. */
	ownerHost?: string;
	/**
	 * Durable wake queue: restored by a broker that does not know the verdict yet. Messages to it are queued, never
	 * waking it, until its owner reports it again; the restored outcome names its refusals meanwhile.
	 */
	restored?: { readonly messages: EndedChildMessages; readonly outcome: SubagentEndedOutcome; readonly childId?: string };
	/** Durable wake queue: while its owner is away, when (wall clock) it left, and when its messages fail if it is not back. */
	awaySince?: number;
	awayTimer?: ReturnType<typeof setTimeout>;
}

const keyOf = (ownerSessionId: string, childName: string): string =>
	`${ownerSessionId}\0${normalizeReservationTarget(childName)}`;

/** #5999: the key a subagent is known by here, from its owner and name; also what the wake bounds count it under. */
export function departureKey(ownerSessionId: string, childName: string): string {
	return keyOf(ownerSessionId, childName);
}

function targetOf(held: HeldSend): string {
	return held.clientMessage.to.trim();
}

/**
 * #4639: what the broker still knows of subagents whose session is gone, so a send to one is neither lost nor answered
 * with a bare `Session not found`.
 *
 * When a subagent's session disconnects and it is not released (a released one is reserved before), sends to its
 * name, Intercom id or Atomic session id wait up to {@link DEPARTED_CHILD_HOLD_MS}: the subagent reconnecting takes
 * them, once each and in order; the session that launched it reporting it ended refuses them with a
 * {@link SubagentRecipientEndedError} naming why; a released reservation of it takes them over; and without either they
 * are refused with a retryable {@link SubagentRecipientDisconnectedError}. What the owner reported answers later sends
 * at once, until the subagent registers again or its owner disconnects. Only senders in the subagent's group, and its
 * owner, are held or told anything; everyone else finds nothing, as before.
 */
export class DepartedChildren {
	private readonly byKey = new Map<string, Departure>();
	private readonly byTarget = new Map<string, Set<Departure>>();
	private readonly byOwner = new Map<string, Map<string, Departure>>();
	/** Subagents whose owner's connection closed, oldest first, each with the owner's host session. */
	private readonly orphans = new Map<Departure, string>();
	private heldTotal = 0;
	private liveTimers = 0;
	/** #5999: the bytes of every message queued for a subagent's wake, across the broker. */
	private queuedBytesTotal = 0;
	/** #5999: who sent each held send that asks to wake its subagent, for when the owner's verdict lets it. */
	private readonly wakeSenders = new WeakMap<HeldSend, WakeSender>();
	/** Durable wake queue: the departure each queued message waits in, by message id, so a retry finds it. */
	private readonly queuedIds = new Map<string, Departure>();

	/**
	 * `onExpired` refuses the sends whose wait for a verdict ended without one. Without `wakes` no subagent is woken
	 * for a message: every send is decided as before #5999.
	 */
	constructor(
		private readonly onExpired: (refusals: readonly HeldSendRefusal[]) => void,
		private readonly holdMs = DEPARTED_CHILD_HOLD_MS,
		private readonly perOwnerMax = DEPARTED_CHILDREN_PER_OWNER_MAX,
		private readonly orphansMax = DEPARTED_ORPHANS_MAX,
		private readonly wakes?: DepartedChildrenWakeHooks,
	) {}

	/** Subagents kept for owners that disconnected. */
	get orphanCount(): number {
		return this.orphans.size;
	}

	/** Subagents known, with or without a verdict. */
	get size(): number {
		return this.byKey.size;
	}

	/** Sends held now. */
	get heldSendCount(): number {
		return this.heldTotal;
	}

	/** #5999: the bytes of the messages queued for subagents that ended, to reach them when they are resumed. */
	get queuedBytes(): number {
		return this.queuedBytesTotal;
	}

	/** What it holds now, index by index; counted by tests, which check that nothing is left behind. */
	sizes(): {
		readonly departures: number;
		readonly byTarget: number;
		readonly byOwner: number;
		readonly heldSends: number;
		readonly timers: number;
	} {
		return {
			departures: this.byKey.size,
			byTarget: this.byTarget.size,
			byOwner: this.byOwner.size,
			heldSends: this.heldTotal,
			timers: this.liveTimers,
		};
	}

	/**
	 * A subagent's session disconnected: hold sends to it until it is back or its owner says why it ended. An owner that
	 * already said so, before the disconnect reached the broker, is believed at once.
	 */
	depart(child: DepartingChild): HeldSend[] {
		const { departure, evicted } = this.entry(child.ownerSessionId, child.childName, child.group, child.aliases);
		if (child.ownerHostSession !== undefined) this.orphans.set(departure, child.ownerHostSession);
		if (departure.verdict?.kind !== "ended") {
			departure.verdict = undefined;
			this.disarm(departure);
			departure.deadline = performance.now() + this.holdMs;
			const timer = setTimeout(() => this.expire(departure), this.holdMs);
			timer.unref();
			departure.timer = timer;
			this.liveTimers += 1;
		}
		return [...evicted, ...this.trimOrphans()];
	}

	/**
	 * The owner reports these subagents ended. Returns the sends held for them, each with its refusal, and the sends
	 * of any subagent forgotten to make room, for ordinary routing.
	 */
	mark(ownerSessionId: string, children: readonly EndedChildMark[]): {
		readonly refused: HeldSendRefusal[];
		readonly evicted: HeldSend[];
		/** #5999: held sends that asked to wake their subagent and are now queued for it; each sender is told why. */
		readonly queued: Array<{ readonly held: HeldSend; readonly target: string; readonly kept?: Promise<unknown> }>;
		/** #5999: wakes to ask the owner for. */
		readonly wakes: EndedChildWakeRequest[];
	} {
		const refused: HeldSendRefusal[] = [];
		const evicted: HeldSend[] = [];
		const queued: Array<{ readonly held: HeldSend; readonly target: string; readonly kept?: Promise<unknown> }> = [];
		const wakes: EndedChildWakeRequest[] = [];
		for (const child of children) {
			const entry = this.entry(ownerSessionId, child.childName, child.group, child.aliases);
			evicted.push(...entry.evicted);
			const departure = entry.departure;
			this.disarm(departure);
			departure.verdict = {
				kind: "ended",
				outcome: child.outcome,
				childId: child.childId,
				// A child cancelled for good is never resumed, whatever its report says.
				...(child.messages !== undefined && child.outcome !== "cancelled" && this.wakes !== undefined
					? { messages: child.messages }
					: {}),
			};
			const restored = departure.restored;
			departure.restored = undefined;
			// #5999: messages queued for a resume its owner no longer offers fail with the new verdict.
			if (departure.verdict.messages === undefined) this.failQueued(departure, (target) => this.errorFor(departure, departure.verdict as Verdict, target).message);
			else if (departure.queued.length > 0) {
				// Durable wake queue: what its owner does with the child now decides, also for what waited from before
				// (restored, or kept while the owner was away): a paused child's messages follow what continues it, and a
				// child that finished gets one wake for them, within the wake bounds, unless one is pending already.
				const messages = departure.verdict.messages;
				for (const held of departure.queued) markQueuedForWake(held, messages);
				if (restored !== undefined && restored.messages !== messages) this.journalAll(departure);
				if (messages === "wake" && departure.wake === undefined) {
					const first = this.firstWaker(departure);
					const started = first === undefined ? undefined : this.startWake(departure, first);
					if (started?.ok === false)
						this.failQueued(departure, () => notResumedReason(departure.childName, started.why));
					else if (started !== undefined) wakes.push(started.wake);
				}
			}
			const waiting = departure.held.splice(0);
			this.heldTotal -= waiting.length;
			const notWoken: HeldSend[] = [];
			for (const held of waiting) {
				const wakeSender = this.wakeSenders.get(held);
				const admission = wakeSender === undefined ? undefined : this.admitWakeFor(departure, wakeSender, held);
				if (admission === undefined || admission.kind === "none") notWoken.push(held);
				else if (admission.kind === "refused") refused.push({ held, error: admission.error, reason: admission.reason });
				else {
					queued.push({ held, target: admission.target, ...(admission.kept === undefined ? {} : { kept: admission.kept }) });
					if (admission.wake !== undefined) wakes.push(admission.wake);
				}
			}
			departure.held.push(...notWoken);
			this.heldTotal += notWoken.length;
			refused.push(...this.refuseHeld(departure, departure.verdict));
		}
		return { refused, evicted, queued, wakes };
	}

	/** Decide a send that found no live recipient. `canHold` is false for a client that cannot wait for a verdict. */
	admit(
		target: string,
		sender: HoldSender,
		held: HeldSend,
		canHold: boolean,
		/** #5999: given for a send that asks to wake its subagent, so the owner's verdict can still let it. */
		wakeSender?: WakeSender,
	): DepartedChildAdmission {
		const departure = this.visible(target, sender);
		// Durable wake queue: one a restarted broker restored, whose owner has not reported it again, answers only sends
		// that ask to wake it; any other send gets the answer it got before the restart.
		if (departure === undefined || (departure.verdict === undefined && departure.restored !== undefined))
			return { kind: "none" };
		if (departure.verdict !== undefined)
			return { kind: "refused", error: this.errorFor(departure, departure.verdict, target) };
		if (!canHold || departure.held.length >= MAX_HELD_SENDS)
			return { kind: "refused", error: this.disconnectedError(departure, target) };
		departure.held.push(held);
		this.heldTotal += 1;
		if (wakeSender !== undefined) this.wakeSenders.set(held, wakeSender);
		return { kind: "held", timeoutMs: Math.max(1, (departure.deadline ?? performance.now()) - performance.now()) };
	}

	/**
	 * #5999: a send that asks to wake its subagent, decided before anything else holds it. A subagent whose owner,
	 * connected here, resumes it for a message or keeps messages for it takes it into its queue; for one that finished
	 * on its own the first message queued asks the owner to resume it, within the wake bounds. Anything else is `none`:
	 * decided as it was before.
	 */
	admitWake(target: string, sender: WakeSender, held: HeldSend, ownerHolds = false): EndedChildWakeAdmission {
		if (this.wakes === undefined || !sendWakesEndedRecipient(held.clientMessage)) return { kind: "none" };
		const departure = this.visible(target, sender);
		if (departure === undefined) return { kind: "none" };
		return this.admitWakeFor(departure, sender, held, ownerHolds);
	}

	/**
	 * #5999: the owner ended its hold of a subagent it was restoring or resuming: as gone (`gone`, the refusal), or
	 * because its start failed (`refusal`). What was queued for it fails with that reason, and a gone one is forgotten,
	 * so later senders get the gone refusal. A hold that ended otherwise (a quit of a paused child) changes nothing.
	 */
	holdEnded(ownerSessionId: string, childName: string, outcome: { readonly gone?: string; readonly refusal?: string }): void {
		const departure = this.byKey.get(keyOf(ownerSessionId, childName));
		const reason = outcome.gone ?? outcome.refusal;
		if (departure === undefined || reason === undefined) return;
		this.failQueued(departure, () => reason);
		if (outcome.gone !== undefined) this.forget(departure);
	}

	/**
	 * #5999: the owner answers a wake. Accepted, the queued messages wait for the child to register, up to
	 * {@link ENDED_CHILD_WAKE_START_MAX_MS}; declined, they fail with the owner's reason. An answer to another wake is
	 * ignored. False when no such wake is pending.
	 */
	answerWake(ownerSessionId: string, childName: string, wakeId: string, accepted: boolean, reason?: string): boolean {
		const departure = this.byKey.get(keyOf(ownerSessionId, childName));
		const wake = departure?.wake;
		if (departure === undefined || wake === undefined || wake.id !== wakeId) return false;
		if (!accepted) {
			const why = reason?.trim() ? reason.trim() : "its launching session did not resume it";
			this.failQueued(departure, () => notResumedReason(departure.childName, why));
			return true;
		}
		if (wake.accepted) return true;
		wake.accepted = true;
		this.armQueueTimer(departure, ENDED_CHILD_WAKE_START_MAX_MS, "it did not start in time");
		this.wakes?.journal?.wake(this.journalDeparture(departure), { id: wake.id, depth: wake.depth, acceptedAt: Date.now() });
		return true;
	}

	/** The subagent registered again under its owner's authorization: forget it and return its held sends, in order. */
	registered(childName: string, groups: ReadonlySet<string>, authorizedBy: string): HeldSend[] {
		// #5999: queued sends come first, each retargeted by the broker to the registered session before it is sent.
		const departure = this.byKey.get(keyOf(authorizedBy, childName));
		if (departure === undefined || !hasGroup(groups, departure.group)) return [];
		// #5999: a child back from a wake is that far down its chain; one its owner resumed starts none.
		if (departure.wake !== undefined) this.wakes?.budget?.awoke(departure.key, departure.wake.depth);
		else this.wakes?.budget?.resumedByOwner(departure.key);
		const queued = this.takeQueued(departure);
		return [...queued, ...this.forget(departure)];
	}

	/**
	 * The owner now reserves the subagent itself (it was released): forget it and return its held sends, in order.
	 * #5999: `restoring`: the owner holds sends to it while it restores or resumes it; one it resumes for a message keeps
	 * its verdict and the messages queued for it, which reach it when it registers.
	 */
	supersede(ownerSessionId: string, childName: string, restoring = false): HeldSend[] {
		const departure = this.byKey.get(keyOf(ownerSessionId, childName));
		if (departure === undefined) return [];
		const resumable =
			(departure.verdict?.kind === "ended" && departure.verdict.messages !== undefined) ||
			(departure.verdict === undefined && departure.restored !== undefined);
		if (restoring && resumable) {
			const held = departure.held.splice(0);
			this.heldTotal -= held.length;
			return held;
		}
		return this.forget(departure);
	}

	/**
	 * The owner disconnected. With its host session, its subagents are kept, answers and held sends included, until a
	 * session of that host session takes them over ({@link adoptOrphans}), or they
	 * are forgotten as the oldest beyond {@link DEPARTED_ORPHANS_MAX}. Without one nobody can say why they ended: they
	 * are forgotten, and their held sends returned for ordinary routing.
	 *
	 * #5999 (durable wake queue): an owner that ended for good (`ended`), or has no host session to come back as, can
	 * continue none of them: what was queued for them fails now. One that only went away (it may come back, as
	 * `atomic -c` brings it back) is waited for, for {@link ENDED_CHILD_OWNER_AWAY_MAX_MS} away without a break, as after a
	 * broker restart: its subagents' messages stay queued, a pending wake is asked again when it is back, and a resume it
	 * accepted keeps its start bound.
	 */
	dropOwner(ownerSessionId: string, hostSession?: string, ended = false): HeldSend[] {
		const owned = [...(this.byOwner.get(ownerSessionId)?.values() ?? [])];
		const away: Departure[] = [];
		for (const departure of owned) {
			const verdict = departure.verdict;
			const kept = verdict?.kind === "ended" && verdict.messages === "hold";
			if (departure.queued.length > 0 && hostSession !== undefined && !ended) {
				if (departure.wake !== undefined && !departure.wake.accepted) {
					departure.wake = undefined;
					this.disarmQueueTimer(departure);
				}
				this.leaveAway(departure, Date.now());
				away.push(departure);
				continue;
			}
			this.failQueued(departure, () =>
				kept
					? pausedOwnerGoneReason(departure.childName)
					: notResumedReason(departure.childName, "the session that launched it ended before it was resumed"),
			);
		}
		if (away.length > 0) this.wakes?.journal?.ownerAway(away.map((departure) => this.journalDeparture(departure)), Date.now());
		if (hostSession === undefined) return owned.flatMap((departure) => this.forget(departure));
		for (const departure of owned) this.orphans.set(departure, hostSession);
		return this.trimOrphans();
	}

	/**
	 * A session of `hostSession` is back as `ownerSessionId`: it owns the subagents its earlier connection kept. Returns
	 * the sends held for any the owner already knows by name, which keeps its own answer, for ordinary routing.
	 */
	adoptOrphans(ownerSessionId: string, hostSession: string | undefined): HeldSend[] {
		const released: HeldSend[] = [];
		for (const [departure, host] of [...this.orphans]) {
			if (host !== hostSession) continue;
			this.orphans.delete(departure);
			// #5999: its launching session is back: what was kept for its subagents waits for it again, untimed.
			if (departure.awaySince !== undefined) {
				this.disarmAway(departure);
				this.wakes?.journal?.ownerAway([this.journalDeparture(departure)], undefined);
			}
			if (departure.ownerSessionId === ownerSessionId) continue;
			const key = keyOf(ownerSessionId, departure.childName);
			const known = this.byKey.get(key);
			if (known !== undefined) {
				// The session already reported it again: the messages kept for it stay queued, in order, ahead of later ones.
				const kept = this.takeQueued(departure);
				if (kept.length > 0 && known.verdict?.kind === "ended" && known.verdict.messages !== undefined) {
					known.queued.unshift(...kept);
					const bytes = kept.reduce((sum, held) => sum + queuedMessageBytes(held), 0);
					known.queuedBytes += bytes;
					this.queuedBytesTotal += bytes;
					this.heldTotal += kept.length;
				} else if (kept.length > 0)
					this.wakes?.failed(
						kept.map((held) => ({
							held,
							childName: departure.childName,
							reason: notResumedReason(departure.childName, "Intercom stopped keeping it to resume before it was back"),
						})),
					);
				released.push(...this.forget(departure));
				continue;
			}
			if (departure.queued.length > 0) this.wakes?.journal?.rekeyOwner(this.journalDeparture(departure), ownerSessionId);
			const previous = this.byOwner.get(departure.ownerSessionId) as Map<string, Departure>;
			previous.delete(departure.key);
			if (previous.size === 0) this.byOwner.delete(departure.ownerSessionId);
			this.byKey.delete(departure.key);
			departure.key = key;
			departure.ownerSessionId = ownerSessionId;
			this.byKey.set(key, departure);
			const owned = this.byOwner.get(ownerSessionId) ?? new Map<string, Departure>();
			owned.set(key, departure);
			this.byOwner.set(ownerSessionId, owned);
		}
		const owned = this.byOwner.get(ownerSessionId);
		while (owned !== undefined && owned.size > this.perOwnerMax)
			released.push(...this.forget(owned.values().next().value as Departure));
		return released;
	}

	/** A sender disconnected: nobody waits for its held sends any more. */
	dropSender(senderId: string): void {
		for (const departure of this.byKey.values()) {
			for (let index = departure.held.length - 1; index >= 0; index--) {
				if (departure.held[index]!.senderId !== senderId) continue;
				departure.held.splice(index, 1);
				this.heldTotal -= 1;
			}
		}
	}

	clear(): void {
		for (const departure of [...this.byKey.values()]) {
			this.takeQueued(departure);
			this.forget(departure);
		}
	}

	/**
	 * `ownerHolds`: the owner already holds sends to the child, restoring, resuming or pausing it: the message is queued
	 * for its registration without asking the owner for anything.
	 *
	 * Durable wake queue: an owner that is away (disconnected, or not back since a restart) is waited for: the message
	 * joins the queue, and its owner is asked to resume the child when it is back. A child restored without a verdict
	 * yet takes it the same way. A retry of a message already queued is answered again, and nothing else happens.
	 */
	private admitWakeFor(
		departure: Departure,
		sender: WakeSender,
		held: HeldSend,
		ownerHolds = false,
	): EndedChildWakeAdmission {
		const hooks = this.wakes;
		const verdict = departure.verdict;
		const restored = verdict === undefined ? departure.restored : undefined;
		const messages = verdict?.kind === "ended" ? verdict.messages : restored?.messages;
		if (hooks === undefined || messages === undefined) return { kind: "none" };
		const ended: Verdict = verdict ?? { kind: "ended", outcome: (restored as NonNullable<typeof restored>).outcome, childId: restored?.childId };
		const queue = messages === "wake" ? RESUMING_RECIPIENT_TARGET : PAUSED_RECIPIENT_TARGET;
		if (this.queuedIds.has(held.messageId)) return { kind: "queued", target: queue, duplicate: true };
		const ownerHere = !this.orphans.has(departure) && hooks.ownerLive(departure.ownerSessionId);
		const target = targetOf(held);
		// Nobody waits on a queued message any more, so the queue is bounded by count and bytes, per child and in all.
		const bytes = queuedMessageBytes(held);
		const full =
			departure.queued.length >= MAX_HELD_SENDS
				? `${MAX_HELD_SENDS} messages already wait for it`
				: departure.queuedBytes + bytes > ENDED_CHILD_QUEUE_BYTES_MAX
					? `${mebibytes(departure.queuedBytes)} of messages already wait for it`
					: this.queuedBytesTotal + bytes > ENDED_CHILD_QUEUE_BYTES_TOTAL_MAX
						? `Intercom already keeps ${mebibytes(this.queuedBytesTotal)} of messages for subagents that ended`
						: undefined;
		if (full !== undefined) {
			const error = this.errorFor(departure, ended, target);
			return { kind: "refused", error, reason: `${error.message} The message was not queued for it: ${full}.` };
		}
		let wake: EndedChildWakeRequest | undefined;
		// A child stopped on purpose is not woken: the message waits for its owner to continue it. Nor is one whose owner is
		// away, or has not reported it since a restart: its owner is asked once it is back and has.
		if (messages === "wake" && verdict !== undefined && ownerHere && departure.wake === undefined && !ownerHolds) {
			const started = this.startWake(departure, sender);
			if (!started.ok) {
				const error = this.errorFor(departure, ended, target);
				return { kind: "refused", error, reason: `${error.message} It was not resumed for this message: ${started.why}.` };
			}
			wake = started.wake;
		}
		// A paused child's messages wait, with no time limit, for its owner to continue it. Those of a child its owner is
		// already starting again wait for that start, within its bound; those of an owner that is away, for it.
		if (messages === "wake" && ownerHere && departure.queueTimer === undefined)
			this.armQueueTimer(departure, ENDED_CHILD_WAKE_START_MAX_MS, "it did not start in time");
		this.enqueue(departure, held, sender, messages);
		if (departure.ownerHost === undefined) departure.ownerHost = hooks.ownerHost?.(departure.ownerSessionId);
		const kept = hooks.journal?.queued(held, this.journalDeparture(departure));
		return { kind: "queued", target: queue, ...(wake === undefined ? {} : { wake }), ...(kept === undefined ? {} : { kept }) };
	}

	/** Durable wake queue: put `held` at the end of the child's queue, counted and findable by its message id. */
	private enqueue(departure: Departure, held: HeldSend, sender: WakeSender, messages: EndedChildMessages): void {
		markQueuedForWake(held, messages);
		this.wakeSenders.set(held, sender);
		departure.queued.push(held);
		const bytes = queuedMessageBytes(held);
		departure.queuedBytes += bytes;
		this.queuedBytesTotal += bytes;
		this.heldTotal += 1;
		this.queuedIds.set(held.messageId, departure);
	}

	/**
	 * Ask the owner to resume the child for its queue, within the wake bounds; the answer timer starts. Also used again
	 * for a queue that waited for its owner to be back, or was restored: that wake counts against the bounds again.
	 */
	private startWake(
		departure: Departure,
		sender: WakeSender,
	): { readonly ok: true; readonly wake: EndedChildWakeRequest } | { readonly ok: false; readonly why: string } {
		const budget = this.wakes?.budget?.check(departure.key, sender.wakeKey) ?? { ok: true as const, depth: 1 };
		if (!budget.ok) return budget;
		this.wakes?.budget?.commit(departure.key, budget.depth);
		const id = randomUUID();
		departure.wake = { id, depth: budget.depth, accepted: false };
		this.armQueueTimer(departure, ENDED_CHILD_WAKE_ANSWER_MS, "its launching session did not answer");
		this.wakes?.journal?.wake(this.journalDeparture(departure), { id, depth: budget.depth });
		const childId = departure.verdict?.kind === "ended" ? departure.verdict.childId : departure.restored?.childId;
		return {
			ok: true,
			wake: {
				ownerSessionId: departure.ownerSessionId,
				childName: departure.childName,
				...(childId === undefined ? {} : { childId }),
				wakeId: id,
				waker: sender.waker,
				depth: budget.depth,
			},
		};
	}

	/**
	 * Durable wake queue: the messages a restarted broker found kept, taken up again, each departure in the order its
	 * messages were queued. A departure whose owner is connected now is its own again (its report, before or after this,
	 * decides what happens to its messages: see {@link mark}); one whose owner is not waits for it, as an away owner's
	 * does, for what is left of {@link ENDED_CHILD_OWNER_AWAY_MAX_MS}. A wake the owner had accepted keeps what is left of
	 * its start bound; one it had not answered is asked again once the owner reports the child. Returns the wakes to ask
	 * for now (the owner already reported the child).
	 */
	restore(
		queues: readonly RestoredEndedQueue[],
		liveOwner: (ownerHost: string) => string | undefined,
		now = Date.now(),
	): EndedChildWakeRequest[] {
		const wakes: EndedChildWakeRequest[] = [];
		if (this.wakes === undefined) return wakes;
		for (const restored of queues) {
			const live = liveOwner(restored.ownerHost);
			const ownerSessionId = live ?? restored.ownerSessionId;
			const { departure, evicted } = this.entry(ownerSessionId, restored.childName, restored.group, restored.aliases);
			this.dispatchEvicted(evicted);
			departure.ownerHost = restored.ownerHost;
			if (departure.verdict === undefined)
				departure.restored = { messages: restored.messages, outcome: restored.outcome, childId: restored.childId };
			const messages =
				departure.verdict?.kind === "ended" && departure.verdict.messages !== undefined
					? departure.verdict.messages
					: restored.messages;
			const later = departure.queued.splice(0);
			for (const held of later) this.unqueueCounted(departure, held);
			for (const { held, sender, bytes } of restored.sends) {
				if (this.queuedIds.has(held.messageId)) continue;
				if (bytes !== undefined) queuedBytesOf.set(held, bytes);
				this.enqueue(departure, held, sender, messages);
			}
			for (const held of later) this.enqueue(departure, held, this.wakeSenders.get(held) as WakeSender, messages);
			if (live !== undefined && live !== restored.ownerSessionId)
				this.wakes.journal?.rekeyOwner(this.journalDeparture({ ...departure, ownerSessionId: restored.ownerSessionId }), live);
			const accepted = restored.wake?.acceptedAt;
			// A resume its owner had accepted is waited for, within what is left of its start bound, unless every message
			// was already handed over: nothing then waits on that start.
			if (
				departure.wake === undefined &&
				restored.wake !== undefined &&
				accepted !== undefined &&
				this.firstWaker(departure) !== undefined
			) {
				departure.wake = { id: restored.wake.id, depth: restored.wake.depth, accepted: true };
				this.armQueueTimer(
					departure,
					Math.max(1, ENDED_CHILD_WAKE_START_MAX_MS - Math.max(0, now - accepted)),
					"it did not start in time",
				);
			}
			if (live === undefined) {
				this.orphans.set(departure, restored.ownerHost);
				this.leaveAway(departure, Math.min(restored.awaySince ?? now, now), now);
				this.wakes.journal?.ownerAway([this.journalDeparture(departure)], departure.awaySince);
			} else if (departure.verdict?.kind === "ended" && departure.verdict.messages === "wake" && departure.wake === undefined) {
				const first = this.firstWaker(departure);
				const started = first === undefined ? undefined : this.startWake(departure, first);
				if (started?.ok === false) this.failQueued(departure, () => notResumedReason(departure.childName, started.why));
				else if (started !== undefined) wakes.push(started.wake);
			}
		}
		this.dispatchEvicted(this.trimOrphans());
		return wakes;
	}

	/**
	 * Who to name as waking the child for its queue: the sender of its first message never handed over to it. Undefined
	 * when every message may already have reached it (an earlier broker handed them over): those wake nobody.
	 */
	private firstWaker(departure: Departure): WakeSender | undefined {
		const first = departure.queued.find((held) => !isMaybeDelivered(held));
		return first === undefined ? undefined : this.wakeSenders.get(first);
	}

	/**
	 * Durable wake queue: drop the queued messages with these ids that `own` says are their sender's, untold (their sender
	 * was told they were lost). Returns the ids dropped.
	 */
	dropQueued(messageIds: readonly string[], own: (held: HeldSend) => boolean): string[] {
		const dropped: string[] = [];
		for (const messageId of messageIds) {
			const departure = this.queuedIds.get(messageId);
			const held = departure?.queued.find((queued) => queued.messageId === messageId);
			if (held === undefined || !own(held) || !this.unqueue(held)) continue;
			dropped.push(messageId);
		}
		return dropped;
	}

	/** Durable wake queue: whether a message with this id waits in a queue here. */
	isQueued(messageId: string): boolean {
		return this.queuedIds.has(messageId);
	}

	/**
	 * Durable wake queue: take a queued message out of its queue, as never queued: it could not be kept. False when it is
	 * not queued any more (it reached its child, or failed).
	 */
	unqueue(held: HeldSend): boolean {
		const departure = this.queuedIds.get(held.messageId);
		if (departure === undefined) return false;
		const index = departure.queued.indexOf(held);
		if (index < 0) return false;
		departure.queued.splice(index, 1);
		this.unqueueCounted(departure, held);
		if (departure.queued.length === 0) {
			this.disarmQueueTimer(departure);
			departure.wake = undefined;
		}
		return true;
	}

	private unqueueCounted(departure: Departure, held: HeldSend): void {
		const bytes = queuedMessageBytes(held);
		departure.queuedBytes -= bytes;
		this.queuedBytesTotal -= bytes;
		this.heldTotal -= 1;
		if (this.queuedIds.get(held.messageId) === departure) this.queuedIds.delete(held.messageId);
	}

	/** The broker gets sends forgotten to make room through `onEvicted`; restored departures make room like any. */
	private dispatchEvicted(evicted: readonly HeldSend[]): void {
		if (evicted.length > 0) this.wakes?.evicted?.(evicted);
	}

	/** Durable wake queue: its owner is away from `since`: its messages fail if it is not back within the retention. */
	private leaveAway(departure: Departure, since: number, now = Date.now()): void {
		this.disarmAway(departure);
		departure.awaySince = since;
		// Counted on this process's clock from here: a wall-clock step does not shorten or stretch it.
		const due = performance.now() + Math.max(1, ENDED_CHILD_OWNER_AWAY_MAX_MS - Math.max(0, now - since));
		this.liveTimers += 1;
		// A timer runs at most about 24 days; a longer wait is armed again as each one ends.
		const arm = (): void => {
			const timer = setTimeout(() => {
				if (departure.awayTimer !== timer) return;
				if (performance.now() < due) {
					arm();
					return;
				}
				departure.awayTimer = undefined;
				this.liveTimers -= 1;
				this.failQueued(departure, () => ownerAwayReason(departure.childName));
				this.forget(departure);
			}, Math.min(Math.max(1, due - performance.now()), MAX_TIMER_MS));
			timer.unref();
			departure.awayTimer = timer;
		};
		arm();
	}

	private disarmAway(departure: Departure): void {
		departure.awaySince = undefined;
		if (departure.awayTimer === undefined) return;
		clearTimeout(departure.awayTimer);
		this.liveTimers -= 1;
		departure.awayTimer = undefined;
	}

	/** Durable wake queue: the departure as its rows name it. */
	private journalDeparture(
		departure: Pick<
			Departure,
			"ownerSessionId" | "ownerHost" | "childName" | "group" | "targets" | "verdict" | "restored" | "wake"
		>,
	): JournalDeparture {
		const verdict = departure.verdict?.kind === "ended" ? departure.verdict : undefined;
		const childKey = normalizeReservationTarget(departure.childName);
		const outcome = verdict?.outcome ?? departure.restored?.outcome ?? "completed";
		const childId = verdict?.childId ?? departure.restored?.childId;
		return {
			ownerSessionId: departure.ownerSessionId,
			...(departure.ownerHost === undefined ? {} : { ownerHost: departure.ownerHost }),
			childKey,
			child: {
				childName: departure.childName,
				group: departure.group,
				aliases: [...departure.targets].filter((target) => target !== childKey),
				...(childId === undefined ? {} : { childId }),
				outcome,
				messages: verdict?.messages ?? departure.restored?.messages ?? "wake",
			},
			...(departure.wake === undefined ? {} : { wake: { id: departure.wake.id, depth: departure.wake.depth } }),
		};
	}

	/** Durable wake queue: the departure's wake, or none, written with its rows. */
	private journalAll(departure: Departure): void {
		const wake = departure.wake;
		this.wakes?.journal?.wake(this.journalDeparture(departure), wake === undefined ? undefined : { id: wake.id, depth: wake.depth });
	}

	/**
	 * Fail what is queued for the child, for `why` (the whole reason when `whole`), unless it registers within `ms`;
	 * replaces any earlier deadline.
	 */
	private armQueueTimer(departure: Departure, ms: number, why: string, whole = false): void {
		this.disarmQueueTimer(departure);
		const timer = setTimeout(() => {
			if (departure.queueTimer !== timer) return;
			this.failQueued(departure, () => (whole ? why : notResumedReason(departure.childName, why)));
		}, ms);
		timer.unref();
		this.liveTimers += 1;
		departure.queueTimer = timer;
	}

	private disarmQueueTimer(departure: Departure): void {
		if (departure.queueTimer === undefined) return;
		clearTimeout(departure.queueTimer);
		this.liveTimers -= 1;
		departure.queueTimer = undefined;
	}

	/** End the departure's wake and take its queued messages, in order, for delivery or failure. */
	private takeQueued(departure: Departure): HeldSend[] {
		this.disarmQueueTimer(departure);
		departure.wake = undefined;
		const queued = departure.queued.splice(0);
		this.heldTotal -= queued.length;
		this.queuedBytesTotal -= departure.queuedBytes;
		departure.queuedBytes = 0;
		for (const held of queued) if (this.queuedIds.get(held.messageId) === departure) this.queuedIds.delete(held.messageId);
		return queued;
	}

	/** #5999: the messages queued for the child fail, each with `reasonFor` its target; the next send may wake it again. */
	private failQueued(departure: Departure, reasonFor: (target: string) => string): void {
		const queued = this.takeQueued(departure);
		if (queued.length === 0) return;
		this.wakes?.failed(
			queued.map((held) => ({ held, childName: departure.childName, reason: reasonFor(targetOf(held)) })),
		);
	}

	private entry(
		ownerSessionId: string,
		childName: string,
		group: string,
		aliases: readonly string[],
	): { readonly departure: Departure; readonly evicted: HeldSend[] } {
		const key = keyOf(ownerSessionId, childName);
		let owned = this.byOwner.get(ownerSessionId);
		const evicted: HeldSend[] = [];
		let departure = this.byKey.get(key);
		if (departure === undefined) {
			if (owned !== undefined && owned.size >= this.perOwnerMax) {
				const oldest = owned.values().next().value as Departure;
				evicted.push(...this.forget(oldest));
				owned = this.byOwner.get(ownerSessionId);
			}
			departure = {
				key,
				ownerSessionId,
				childName: childName.trim(),
				group,
				targets: new Set([normalizeReservationTarget(childName)]),
				held: [],
				queued: [],
				queuedBytes: 0,
			};
			this.byKey.set(key, departure);
			if (owned === undefined) {
				owned = new Map();
				this.byOwner.set(ownerSessionId, owned);
			}
			owned.set(key, departure);
			this.index(departure, normalizeReservationTarget(childName));
		}
		departure.group = group;
		for (const alias of aliases) {
			const target = normalizeReservationTarget(alias);
			if (target.length === 0 || departure.targets.has(target)) continue;
			departure.targets.add(target);
			this.index(departure, target);
		}
		return { departure, evicted };
	}

	private index(departure: Departure, target: string): void {
		const members = this.byTarget.get(target);
		if (members === undefined) this.byTarget.set(target, new Set([departure]));
		else members.add(departure);
	}

	private visible(target: string, sender: HoldSender): Departure | undefined {
		const candidates = this.byTarget.get(normalizeReservationTarget(target));
		if (candidates === undefined) return undefined;
		for (const candidate of candidates) {
			if (candidate.ownerSessionId === sender.id || holdAdmitsSender(sender, candidate.group)) return candidate;
		}
		return undefined;
	}

	private errorFor(departure: Departure, verdict: Verdict, target: string): IntercomRecipientGoneError {
		if (verdict.kind !== "ended") return this.disconnectedError(departure, target);
		return subagentRecipientEnded(verdict.outcome, {
			target,
			childName: departure.childName,
			childId: verdict.childId,
		});
	}

	private disconnectedError(departure: Departure, target: string): IntercomRecipientGoneError {
		return new SubagentRecipientDisconnectedError({ target, childName: departure.childName });
	}

	private refuseHeld(departure: Departure, verdict: Verdict): HeldSendRefusal[] {
		const refused = departure.held.map((held) => ({ held, error: this.errorFor(departure, verdict, targetOf(held)) }));
		this.heldTotal -= departure.held.length;
		departure.held.length = 0;
		return refused;
	}

	/** The wait for a verdict ended without one. Every path that gives a verdict or forgets the subagent disarms it. */
	private expire(departure: Departure): void {
		this.liveTimers -= 1;
		departure.timer = undefined;
		departure.deadline = undefined;
		departure.verdict = DISCONNECTED;
		const refused = this.refuseHeld(departure, DISCONNECTED);
		if (refused.length > 0) this.onExpired(refused);
	}

	private disarm(departure: Departure): void {
		if (departure.timer === undefined) return;
		clearTimeout(departure.timer);
		this.liveTimers -= 1;
		departure.timer = undefined;
		departure.deadline = undefined;
	}

	private trimOrphans(): HeldSend[] {
		const released: HeldSend[] = [];
		while (this.orphans.size > this.orphansMax)
			released.push(...this.forget(this.orphans.keys().next().value as Departure));
		return released;
	}

	private forget(departure: Departure): HeldSend[] {
		this.failQueued(departure, () =>
			notResumedReason(departure.childName, "Intercom stopped keeping it to resume before it was back"),
		);
		this.disarm(departure);
		this.disarmAway(departure);
		this.orphans.delete(departure);
		this.byKey.delete(departure.key);
		// A subagent kept is indexed under its owner and each of its targets.
		const owned = this.byOwner.get(departure.ownerSessionId) as Map<string, Departure>;
		owned.delete(departure.key);
		if (owned.size === 0) this.byOwner.delete(departure.ownerSessionId);
		for (const target of departure.targets) {
			const members = this.byTarget.get(target) as Set<Departure>;
			members.delete(departure);
			if (members.size === 0) this.byTarget.delete(target);
		}
		const held = [...departure.held];
		this.heldTotal -= held.length;
		departure.held.length = 0;
		return held;
	}
}

/** #5999: why a message queued for a subagent that was to be resumed for it did not reach it. */
export function notResumedReason(childName: string, why: string): string {
	return `Subagent ${JSON.stringify(childName)} was not resumed for this message: ${why}. The message was not delivered.`;
}

/** The bytes of each queued message, counted once (a restarted broker takes them from the store). */
const queuedBytesOf = new WeakMap<HeldSend, number>();

function queuedMessageBytes(held: HeldSend): number {
	const known = queuedBytesOf.get(held);
	if (known !== undefined) return known;
	const message = held.clientMessage.message as Message | undefined;
	const bytes = message === undefined ? 0 : intercomMessageBytes(message.content);
	queuedBytesOf.set(held, bytes);
	return bytes;
}

function mebibytes(bytes: number): string {
	return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

/**
 * #5999: why a message kept for a paused subagent did not reach it: the session that launched it, the only one that can
 * continue it, ended.
 */
function pausedOwnerGoneReason(childName: string): string {
	return `Subagent ${JSON.stringify(childName)} is paused and the session that launched it ended, so nothing can continue it now. The message was not delivered; send it again if it is still needed.`;
}

/**
 * Durable wake queue: the failure of a message an earlier broker had already handed to its subagent, which did not
 * confirm it before that broker was gone: it may have reached it, so the failure does not say it was not delivered.
 */
export function mayHaveReachedReason(childName: string, reason: string): string {
	const why = reason.replace(/\s*The message was not delivered[^.]*\.?/, "").trim();
	return `Subagent ${JSON.stringify(childName)} may already have this message: Intercom handed it over before it restarted, and the subagent had not confirmed it. It was not handed over again. ${why}`;
}

/** Durable wake queue: why a message queued for a subagent failed: its launching session stayed away too long. */
export function ownerAwayReason(childName: string): string {
	return `Subagent ${JSON.stringify(childName)} was not continued for this message: the session that launched it has not been back for ${Math.round(ENDED_CHILD_OWNER_AWAY_MAX_MS / 86_400_000)} days. The message was not delivered; send it again if it is still needed.`;
}
