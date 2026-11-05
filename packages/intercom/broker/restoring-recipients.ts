import type net from "node:net";
import { hasGroup } from "../group.js";
import type { DeliveryFailureReasonCode, SessionInfo } from "../types.js";
import { sessionGroups } from "./group-membership.js";
import { ReleasedChildReservationError } from "./released-child-errors.js";
import { isReleasedReservationKey, normalizeReservationTarget, releasedReservationKey } from "./released-children.js";

/** How long the broker holds a send for a subagent that is being restored; matches its owner's own wait (#3760). */
export const RESTORING_RECIPIENT_HOLD_MS = 20_000;
/** The most a send can be held in total once its owner confirms it is waking the subagent, counted from the send's admission (#4326). */
export const RESTORING_RECIPIENT_HOLD_MAX_MS = 120_000;
/** A reservation covers the child's name plus its Atomic session id and its pre-restart Intercom id. */
const MAX_RESERVED_TARGETS = 8;
const MAX_HELD_SENDS = 256;

/** A send the broker is holding for a subagent that is being restored. */
export interface HeldSend {
	readonly socket: net.Socket;
	readonly senderId: string;
	readonly messageId: string;
	readonly attemptId?: string;
	/** The original send frame, dispatched again once the hold ends. */
	readonly clientMessage: { readonly type: string; readonly to: string } & Record<string, unknown>;
}

/** The owner to tell that a send now waits for its released child (#4326). */
export interface RestoringRecipientWake {
	readonly ownerSessionId: string;
	readonly childName: string;
	/** Present for a reservation made under a supervisor capability; absent for one made by child name. */
	readonly capability?: string;
}

export type RestoringRecipientAdmission =
	| { readonly kind: "none" }
	| { readonly kind: "held"; readonly timeoutMs: number; readonly wake?: RestoringRecipientWake }
	| { readonly kind: "refused"; readonly reason: string; readonly reasonCode?: DeliveryFailureReasonCode };

/** One reservation as `RestoringRecipients.active` reports it; `gone` is the formatted gone refusal. */
export interface RestoringReservationSnapshot {
	readonly capability: string;
	readonly ownerSessionId: string;
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly dormant: boolean;
	readonly wake: boolean;
	readonly gone?: string;
}

/** A held send whose hold the owner's wake confirmation lengthened, with the time it now has left. */
export interface ExtendedHold {
	readonly held: HeldSend;
	readonly timeoutMs: number;
}

interface HeldEntry {
	timer: ReturnType<typeof setTimeout> | undefined;
	readonly admittedAt: number;
	reservation: Reservation;
}

interface Reservation {
	readonly key: string;
	readonly ownerSessionId: string;
	readonly childName: string;
	group: string;
	/**
	 * Made by a session that is only keeping the child addressable until the session that will really restore it
	 * is back, such as the launching session of an interrupted workflow run. The restoring supervisor of the
	 * same child and group takes it over with its held sends.
	 */
	dormant: boolean;
	/** The child is released, not being restored: the first send held tells its owner to wake it (#4326). */
	wake: boolean;
	/** The owner already confirmed the wake of the sends held now, so their hold was extended once (#4326). */
	extended: boolean;
	readonly targets: Set<string>;
	/** Set once the owner reports the child gone; held and later senders get this refusal. */
	gone?: string;
	readonly held: Map<HeldSend, HeldEntry>;
}

export interface RestoringRecipientSizes {
	readonly reservations: number;
	readonly byTarget: number;
	readonly byTargetMembers: number;
	readonly byChild: number;
	readonly byOwner: number;
	readonly withHeld: number;
	readonly heldSends: number;
	readonly timers: number;
}

export interface ReserveOptions {
	readonly dormant?: boolean;
	readonly wake?: boolean;
	/** The aliases given are all the child has, not additions to those reserved before. */
	readonly replaceAliases?: boolean;
}

const normalizeTarget = normalizeReservationTarget;

export function restoringRecipientRetryReason(childName: string): string {
	return `Subagent \`${childName}\` is still being restored after the restart. The message was not sent; try again shortly.`;
}

export function goneRecipientReason(childName: string, reason: string): string {
	return `Subagent \`${childName}\` did not survive the restart and is gone${reason.trim() ? `: ${reason.trim()}` : ""}. The message was not sent; launch a fresh subagent if its work is still needed.`;
}

/** Why a send held for a reservation was refused or timed out: a parked released child is never woken for it. */
export function unrestoredReasonCode(reservationKey: string, wake: boolean): DeliveryFailureReasonCode {
	return isReleasedReservationKey(reservationKey) && !wake ? "recipient_parked" : "recipient_not_restored";
}

const addToIndex = <Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void => {
	const members = index.get(key);
	if (members === undefined) index.set(key, new Set([value]));
	else members.add(value);
};

const removeFromIndex = <Key, Value>(index: Map<Key, Set<Value>>, key: Key, value: Value): void => {
	const members = index.get(key);
	if (members === undefined) return;
	members.delete(value);
	if (members.size === 0) index.delete(key);
};

/**
 * Broker-side holds for background subagents that their owner is restoring after a restart (#3760).
 *
 * The owner reserves the child's targets (its name, Atomic session id and pre-restart Intercom id) under the
 * supervisor capability it was issued for that child, or, for a released child, under its name for the whole
 * connection; only that names the child, and the extra targets are ids, never names. While a send by any sender
 * in the child's group finds no live session, it is held instead of failing with `Session not found`. A hold ends
 * in exactly one way: the child registers and every held send is dispatched again, once and in order; the owner
 * reports the child gone and held and later senders get the gone refusal; or the hold times out and the sender
 * is told to try again. Reservations end when their owner disconnects.
 *
 * A reservation can start before the restore does: a resumed session reserves its recorded children at session
 * start, and the launching session of an interrupted workflow run reserves the children of the run's stages while
 * the run waits for `/workflow resume`. The restoring supervisor's own reservation of the same child then takes
 * the earlier one over, so a send is held from the first moment until the child is back, without a gap.
 *
 * Targets, child names and owners are indexed, so admitting a send, reserving and dropping an owner cost what
 * they touch, not the number of reservations.
 */
export class RestoringRecipients {
	private readonly reservations = new Map<string, Reservation>();
	private readonly byTarget = new Map<string, Set<Reservation>>();
	private readonly byChild = new Map<string, Set<Reservation>>();
	private readonly byOwner = new Map<string, Set<Reservation>>();
	private readonly withHeld = new Set<Reservation>();
	private heldTotal = 0;
	private liveTimers = 0;

	constructor(private readonly onExpired: (held: HeldSend, reason: string, reasonCode: DeliveryFailureReasonCode) => void) {}

	/** Reservations in force, including gone markers. */
	get size(): number {
		return this.reservations.size;
	}

	/** Sends held now, across every reservation. */
	get heldSendCount(): number {
		return this.heldTotal;
	}

	sizes(): RestoringRecipientSizes {
		let byTargetMembers = 0;
		for (const members of this.byTarget.values()) byTargetMembers += members.size;
		return {
			reservations: this.reservations.size,
			byTarget: this.byTarget.size,
			byTargetMembers,
			byChild: this.byChild.size,
			byOwner: this.byOwner.size,
			withHeld: this.withHeld.size,
			heldSends: this.heldTotal,
			timers: this.liveTimers,
		};
	}

	releasedOwner(childName: string): string | undefined {
		return this.reservations.get(releasedReservationKey(childName))?.ownerSessionId;
	}

	/**
	 * Reserve, or add targets to, the reservation for the child this capability authorizes. `group` is normalized.
	 * A `dormant` reservation may be taken over by the supervisor that restores the child. Returns the wake to ask
	 * of the owner when this makes sends that were already held wakeable.
	 */
	reserve(
		key: string,
		ownerSessionId: string,
		childName: string,
		group: string,
		aliases: readonly string[],
		options: ReserveOptions = {},
	): RestoringRecipientWake | undefined {
		const dormant = options.dormant === true;
		const wake = options.wake === true;
		const childTarget = normalizeTarget(childName);
		const existing = this.reservations.get(key);
		const displaced = existing !== undefined && existing.ownerSessionId !== ownerSessionId ? existing : undefined;
		if (displaced !== undefined && isReleasedReservationKey(key)) {
			throw new ReleasedChildReservationError({ code: "not_owner", childName });
		}
		const kept = displaced === undefined ? existing : undefined;
		const wasWakeable = kept?.wake === true;
		let reservation = kept;
		if (reservation === undefined) {
			const created: Reservation = {
				key,
				ownerSessionId,
				childName,
				group,
				dormant,
				wake,
				extended: false,
				targets: new Set([childTarget]),
				held: new Map(),
			};
			reservation = created;
			// A newer restoration of the same child replaces its owner's earlier reservation, gone marker included,
			// and a dormant owner's reservation of that child and group, whoever restores it.
			for (const previous of [...(this.byChild.get(childTarget) ?? [])]) {
				if (previous !== displaced && previous.ownerSessionId !== ownerSessionId && !(previous.dormant && previous.group === group))
					continue;
				this.forget(previous);
				for (const target of previous.targets) created.targets.add(target);
				for (const [held, entry] of previous.held) {
					entry.reservation = created;
					created.held.set(held, entry);
				}
				created.extended = created.extended || previous.extended;
				if (previous.held.size > 0) this.withHeld.delete(previous);
			}
			if (created.held.size > 0) this.withHeld.add(created);
			this.reservations.set(key, created);
			addToIndex(this.byChild, childTarget, created);
			addToIndex(this.byOwner, ownerSessionId, created);
			for (const target of created.targets) addToIndex(this.byTarget, target, created);
		}
		reservation.group = group;
		reservation.dormant = dormant;
		reservation.wake = wake;
		if (options.replaceAliases === true && kept !== undefined) this.dropAliases(reservation, childTarget);
		for (const alias of aliases) {
			const target = normalizeTarget(alias);
			if (target && reservation.targets.size < MAX_RESERVED_TARGETS && !reservation.targets.has(target)) {
				reservation.targets.add(target);
				addToIndex(this.byTarget, target, reservation);
			}
		}
		if (!wake || wasWakeable || reservation.held.size === 0) return undefined;
		reservation.extended = false;
		return this.wakeOf(reservation);
	}

	/**
	 * Decide a send that found no live recipient. `canHold` is false for clients that cannot wait past their
	 * ordinary acknowledgement timeout; they are told to try again instead of being held.
	 */
	admit(
		target: string,
		sender: { readonly id: string; readonly info: SessionInfo },
		held: HeldSend,
		canHold: boolean,
	): RestoringRecipientAdmission {
		const candidates = this.byTarget.get(normalizeTarget(target));
		if (candidates === undefined) return { kind: "none" };
		let senderGroups: ReadonlySet<string> | undefined;
		let reservation: Reservation | undefined;
		for (const candidate of candidates) {
			if (candidate.ownerSessionId !== sender.id) {
				senderGroups ??= sessionGroups(sender.info);
				if (!hasGroup(senderGroups, candidate.group)) continue;
			}
			reservation = candidate;
			break;
		}
		if (reservation === undefined) return { kind: "none" };
		if (reservation.gone !== undefined) return { kind: "refused", reason: reservation.gone };
		if (!canHold || reservation.held.size >= MAX_HELD_SENDS) {
			return {
				kind: "refused",
				reason: restoringRecipientRetryReason(reservation.childName),
				reasonCode: unrestoredReasonCode(reservation.key, reservation.wake),
			};
		}
		const wake = reservation.wake && reservation.held.size === 0 ? this.wakeOf(reservation) : undefined;
		if (reservation.held.size === 0) reservation.extended = false;
		const entry: HeldEntry = { timer: undefined, admittedAt: Date.now(), reservation };
		this.arm(held, entry, RESTORING_RECIPIENT_HOLD_MS);
		reservation.held.set(held, entry);
		this.withHeld.add(reservation);
		this.heldTotal += 1;
		return { kind: "held", timeoutMs: RESTORING_RECIPIENT_HOLD_MS, ...(wake === undefined ? {} : { wake }) };
	}

	/**
	 * The owner confirms it is waking this released child: every send held for it now may wait until
	 * `RESTORING_RECIPIENT_HOLD_MAX_MS` after its admission, once per wake. Undefined when this owner holds no
	 * reservation for the child; empty when this wake was already confirmed.
	 */
	extendHolds(childName: string, ownerSessionId: string): ExtendedHold[] | undefined {
		const reservation = this.reservations.get(releasedReservationKey(childName));
		if (reservation === undefined || reservation.ownerSessionId !== ownerSessionId) return undefined;
		if (reservation.extended || reservation.held.size === 0) return [];
		reservation.extended = true;
		const now = Date.now();
		const extended: ExtendedHold[] = [];
		for (const [held, entry] of reservation.held) {
			const remaining = Math.max(0, entry.admittedAt + RESTORING_RECIPIENT_HOLD_MAX_MS - now);
			this.disarm(entry);
			this.arm(held, entry, remaining);
			extended.push({ held, timeoutMs: remaining });
		}
		return extended;
	}

	/**
	 * A child registered: end the reservation `capability` names, when given, and return the sends held for it, in
	 * the order they arrived. Each is routed again as it was addressed, so it reaches the child only through a name
	 * or id the child really registered with, never merely because the owner listed it as an alias.
	 *
	 * `registered` names the child that registered. A dormant reservation of that child and group that no
	 * restoring supervisor took over (it restored the child without reserving first) ends with it too, as does a
	 * released child's reservation.
	 */
	consume(
		capability: string | undefined,
		registered?: { readonly childName: string; readonly groups: ReadonlySet<string> },
	): HeldSend[] {
		const held: HeldSend[] = [];
		const reservation = capability === undefined ? undefined : this.reservations.get(capability);
		if (reservation !== undefined && reservation.gone === undefined) {
			this.forget(reservation);
			held.push(...this.take(reservation));
		}
		if (registered === undefined) return held;
		const name = normalizeTarget(registered.childName);
		for (const orphan of [...(this.byChild.get(name) ?? [])]) {
			if (!((orphan.dormant && capability !== undefined) || isReleasedReservationKey(orphan.key)) || orphan.gone !== undefined)
				continue;
			if (!hasGroup(registered.groups, orphan.group)) continue;
			this.forget(orphan);
			held.push(...this.take(orphan));
		}
		return held;
	}

	/**
	 * The owner ended its reservation. With `goneReason` the reservation stays as a gone marker and the held
	 * sends are returned with the gone refusal. Without it the reservation ends: the held sends are returned with
	 * the owner's `refusal` when it gave one (the child is coming back elsewhere), otherwise for ordinary routing.
	 * Undefined when this owner holds no such reservation.
	 */
	release(
		key: string,
		ownerSessionId: string,
		goneReason: string | undefined,
		refusal?: string,
	): { readonly held: HeldSend[]; readonly gone?: string; readonly refusal?: string } | undefined {
		const reservation = this.reservations.get(key);
		if (reservation === undefined || reservation.ownerSessionId !== ownerSessionId) return undefined;
		const held = this.take(reservation);
		if (goneReason === undefined) {
			this.forget(reservation);
			return refusal === undefined ? { held } : { held, refusal };
		}
		reservation.gone = goneRecipientReason(reservation.childName, goneReason);
		return { held, gone: reservation.gone };
	}

	/** The owner disconnected: end its reservations and return their held sends for ordinary routing. */
	dropOwner(ownerSessionId: string): HeldSend[] {
		const released: HeldSend[] = [];
		for (const reservation of [...(this.byOwner.get(ownerSessionId) ?? [])]) {
			this.forget(reservation);
			released.push(...this.take(reservation));
		}
		return released;
	}

	/** A sender disconnected: nobody is waiting for its held sends any more. */
	dropSender(senderId: string): void {
		for (const reservation of [...this.withHeld]) {
			for (const held of [...reservation.held.keys()]) {
				if (held.senderId === senderId) this.detach(reservation, held);
			}
		}
	}

	/**
	 * The reservations in force now, as their owners made them: the child's name, its other targets, and the gone
	 * marker its owner left. Multi-node routing that starts after they were acknowledged mirrors them from here.
	 */
	active(): RestoringReservationSnapshot[] {
		return [...this.reservations.values()].map((reservation) => {
			const childTarget = normalizeTarget(reservation.childName);
			return {
				capability: reservation.key,
				ownerSessionId: reservation.ownerSessionId,
				childName: reservation.childName,
				group: reservation.group,
				aliases: [...reservation.targets].filter((target) => target !== childTarget),
				dormant: reservation.dormant,
				wake: reservation.wake,
				...(reservation.gone === undefined ? {} : { gone: reservation.gone }),
			};
		});
	}

	clear(): void {
		for (const reservation of this.reservations.values()) this.take(reservation);
		this.reservations.clear();
		this.byTarget.clear();
		this.byChild.clear();
		this.byOwner.clear();
		this.withHeld.clear();
	}

	private wakeOf(reservation: Reservation): RestoringRecipientWake {
		return {
			ownerSessionId: reservation.ownerSessionId,
			childName: reservation.childName,
			...(isReleasedReservationKey(reservation.key) ? {} : { capability: reservation.key }),
		};
	}

	private arm(held: HeldSend, entry: HeldEntry, delayMs: number): void {
		const timer = setTimeout(() => {
			entry.timer = undefined;
			this.liveTimers -= 1;
			this.expire(held, entry);
		}, delayMs);
		timer.unref?.();
		entry.timer = timer;
		this.liveTimers += 1;
	}

	private disarm(entry: HeldEntry): void {
		if (entry.timer === undefined) return;
		clearTimeout(entry.timer);
		entry.timer = undefined;
		this.liveTimers -= 1;
	}

	private expire(held: HeldSend, entry: HeldEntry): void {
		const reservation = entry.reservation;
		if (reservation.held.get(held) !== entry) return;
		this.detach(reservation, held);
		this.onExpired(
			held,
			restoringRecipientRetryReason(reservation.childName),
			unrestoredReasonCode(reservation.key, reservation.wake),
		);
	}

	private detach(reservation: Reservation, held: HeldSend): void {
		const entry = reservation.held.get(held);
		if (entry === undefined) return;
		this.disarm(entry);
		reservation.held.delete(held);
		this.heldTotal -= 1;
		if (reservation.held.size > 0) return;
		reservation.extended = false;
		this.withHeld.delete(reservation);
	}

	private dropAliases(reservation: Reservation, childTarget: string): void {
		for (const target of [...reservation.targets]) {
			if (target === childTarget) continue;
			reservation.targets.delete(target);
			removeFromIndex(this.byTarget, target, reservation);
		}
	}

	private forget(reservation: Reservation): void {
		this.reservations.delete(reservation.key);
		removeFromIndex(this.byChild, normalizeTarget(reservation.childName), reservation);
		removeFromIndex(this.byOwner, reservation.ownerSessionId, reservation);
		for (const target of reservation.targets) removeFromIndex(this.byTarget, target, reservation);
	}

	private take(reservation: Reservation): HeldSend[] {
		const held = [...reservation.held.keys()];
		for (const entry of reservation.held.values()) this.disarm(entry);
		this.heldTotal -= reservation.held.size;
		reservation.held.clear();
		reservation.extended = false;
		this.withHeld.delete(reservation);
		return held;
	}
}
