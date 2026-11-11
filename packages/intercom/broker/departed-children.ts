import { hasGroup, normalizeGroup } from "../group.js";
import type { ReleasedChildRefusal, SessionInfo } from "../types.js";
import type { JsonWireValue } from "./framing.js";
import { sessionGroups } from "./group-membership.js";
import {
	type IntercomRecipientGoneError,
	SUBAGENT_ENDED_OUTCOMES,
	type SubagentEndedOutcome,
	StageRecipientReleasedError,
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
 * owner's host session, a workflow stage's, comes back for them.
 */
export const DEPARTED_ORPHANS_MAX = 4_096;
/** The most sends held for one subagent; later ones are refused as for a subagent that did not come back. */
const MAX_HELD_SENDS = 256;

/** A subagent whose session just disconnected, as the broker knew it. */
export interface DepartingChild {
	readonly ownerSessionId: string;
	readonly childName: string;
	readonly group: string;
	/** Its Intercom id and Atomic session id, when known. */
	readonly aliases: readonly string[];
	/**
	 * Set when the owner's connection is already gone: the owner's host session, whose next session takes the subagent
	 * over, as a reopened workflow stage's does.
	 */
	readonly ownerHostSession?: string;
}

/** One subagent its owner reports ended, and why (#4639). */
export interface EndedChildMark {
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly outcome: SubagentEndedOutcome;
	readonly childId?: string;
}

/** A held send to refuse, with the typed refusal naming why its subagent is gone. */
export interface HeldSendRefusal {
	readonly held: HeldSend;
	readonly error: IntercomRecipientGoneError;
}

export type DepartedChildAdmission =
	| { readonly kind: "none" }
	| { readonly kind: "held"; readonly timeoutMs: number }
	| { readonly kind: "refused"; readonly error: IntercomRecipientGoneError };

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
		});
	}
	return { ok: true, children: parsed };
}

type Verdict =
	| { readonly kind: "ended"; readonly outcome: SubagentEndedOutcome; readonly childId?: string }
	| { readonly kind: "stage_released" }
	| { readonly kind: "disconnected" };

/** The verdict of a subagent nobody said anything about before its wait ended. */
const DISCONNECTED: Verdict = { kind: "disconnected" };

interface Departure {
	key: string;
	ownerSessionId: string;
	readonly childName: string;
	group: string;
	readonly targets: Set<string>;
	verdict?: Verdict;
	/** While no verdict is known: when the sends held now stop waiting for one. */
	deadline?: number;
	timer?: ReturnType<typeof setTimeout>;
	readonly held: HeldSend[];
}

const keyOf = (ownerSessionId: string, childName: string): string =>
	`${ownerSessionId}\0${normalizeReservationTarget(childName)}`;

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

	/** `onExpired` refuses the sends whose wait for a verdict ended without one. */
	constructor(
		private readonly onExpired: (refusals: readonly HeldSendRefusal[]) => void,
		private readonly holdMs = DEPARTED_CHILD_HOLD_MS,
		private readonly perOwnerMax = DEPARTED_CHILDREN_PER_OWNER_MAX,
		private readonly orphansMax = DEPARTED_ORPHANS_MAX,
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
			departure.deadline = Date.now() + this.holdMs;
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
	} {
		const refused: HeldSendRefusal[] = [];
		const evicted: HeldSend[] = [];
		for (const child of children) {
			const entry = this.entry(ownerSessionId, child.childName, child.group, child.aliases);
			evicted.push(...entry.evicted);
			const departure = entry.departure;
			this.disarm(departure);
			departure.verdict = { kind: "ended", outcome: child.outcome, childId: child.childId };
			refused.push(...this.refuseHeld(departure, departure.verdict));
		}
		return { refused, evicted };
	}

	/**
	 * #4642: a released workflow stage's hosted peer left: its host connection removed it or closed. Sends to its name,
	 * id or return address are refused at once with a {@link StageRecipientReleasedError}, until it is hosted again.
	 */
	markStageReleased(ownerSessionId: string, child: Omit<EndedChildMark, "outcome" | "childId">): HeldSend[] {
		const entry = this.entry(ownerSessionId, child.childName, child.group, child.aliases);
		this.disarm(entry.departure);
		entry.departure.verdict = { kind: "stage_released" };
		return entry.evicted;
	}

	/** Decide a send that found no live recipient. `canHold` is false for a client that cannot wait for a verdict. */
	admit(
		target: string,
		sender: { readonly id: string; readonly info: SessionInfo },
		held: HeldSend,
		canHold: boolean,
	): DepartedChildAdmission {
		const departure = this.visible(target, sender);
		if (departure === undefined) return { kind: "none" };
		if (departure.verdict !== undefined)
			return { kind: "refused", error: this.errorFor(departure, departure.verdict, target) };
		if (!canHold || departure.held.length >= MAX_HELD_SENDS)
			return { kind: "refused", error: this.disconnectedError(departure, target) };
		departure.held.push(held);
		this.heldTotal += 1;
		return { kind: "held", timeoutMs: Math.max(1, (departure.deadline ?? Date.now()) - Date.now()) };
	}

	/** The subagent registered again under its owner's authorization: forget it and return its held sends, in order. */
	registered(childName: string, groups: ReadonlySet<string>, authorizedBy: string): HeldSend[] {
		const departure = this.byKey.get(keyOf(authorizedBy, childName));
		if (departure === undefined || !hasGroup(groups, departure.group)) return [];
		return this.forget(departure);
	}

	/** The owner now reserves the subagent itself (it was released): forget it and return its held sends, in order. */
	supersede(ownerSessionId: string, childName: string): HeldSend[] {
		const departure = this.byKey.get(keyOf(ownerSessionId, childName));
		return departure === undefined ? [] : this.forget(departure);
	}

	/**
	 * The owner disconnected. With its host session, its subagents are kept, answers and held sends included, until a
	 * session of that host session takes them over ({@link adoptOrphans}), as a reopened workflow stage does, or they
	 * are forgotten as the oldest beyond {@link DEPARTED_ORPHANS_MAX}. Without one nobody can say why they ended: they
	 * are forgotten, and their held sends returned for ordinary routing.
	 */
	dropOwner(ownerSessionId: string, hostSession?: string): HeldSend[] {
		const owned = [...(this.byOwner.get(ownerSessionId)?.values() ?? [])];
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
			if (departure.ownerSessionId === ownerSessionId) continue;
			const key = keyOf(ownerSessionId, departure.childName);
			if (this.byKey.has(key)) {
				released.push(...this.forget(departure));
				continue;
			}
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

	/** The run whose stages kept these subagents ended: forget those in a group `inGroup` accepts; returns their held sends. */
	dropOrphans(inGroup: (group: string) => boolean): HeldSend[] {
		const released: HeldSend[] = [];
		for (const departure of [...this.orphans.keys()]) {
			if (inGroup(departure.group)) released.push(...this.forget(departure));
		}
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
		for (const departure of [...this.byKey.values()]) this.forget(departure);
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

	private visible(target: string, sender: { readonly id: string; readonly info: SessionInfo }): Departure | undefined {
		const candidates = this.byTarget.get(normalizeReservationTarget(target));
		if (candidates === undefined) return undefined;
		let senderGroups: ReadonlySet<string> | undefined;
		for (const candidate of candidates) {
			if (candidate.ownerSessionId === sender.id) return candidate;
			senderGroups ??= sessionGroups(sender.info);
			if (hasGroup(senderGroups, candidate.group)) return candidate;
		}
		return undefined;
	}

	private errorFor(departure: Departure, verdict: Verdict, target: string): IntercomRecipientGoneError {
		if (verdict.kind === "stage_released")
			return new StageRecipientReleasedError({ target, childName: departure.childName });
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
		this.disarm(departure);
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
