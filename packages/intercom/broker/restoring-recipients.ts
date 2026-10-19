import type net from "node:net";
import { hasGroup } from "../group.js";
import type { SessionInfo } from "../types.js";
import { sessionGroups } from "./group-membership.js";

/** How long the broker holds a send for a subagent that is being restored; matches its owner's own wait (#3760). */
export const RESTORING_RECIPIENT_HOLD_MS = 20_000;
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

export type RestoringRecipientAdmission =
	| { readonly kind: "none" }
	| { readonly kind: "held"; readonly timeoutMs: number }
	| { readonly kind: "refused"; readonly reason: string };

interface Reservation {
	readonly ownerSessionId: string;
	readonly childName: string;
	group: string;
	readonly targets: Set<string>;
	/** Set once the owner reports the child gone; held and later senders get this refusal. */
	gone?: string;
	readonly held: Map<HeldSend, ReturnType<typeof setTimeout>>;
}

const normalizeTarget = (target: string): string => target.trim().toLowerCase();

export function restoringRecipientRetryReason(childName: string): string {
	return `Subagent \`${childName}\` is still being restored after the restart. The message was not sent; try again shortly.`;
}

export function goneRecipientReason(childName: string, reason: string): string {
	return `Subagent \`${childName}\` did not survive the restart and is gone${reason.trim() ? `: ${reason.trim()}` : ""}. The message was not sent; launch a fresh subagent if its work is still needed.`;
}

/**
 * Broker-side holds for background subagents that their owner is restoring after a restart (#3760).
 *
 * The owner reserves the child's targets (its name, Atomic session id and pre-restart Intercom id) under the
 * supervisor capability it was issued for that child; only that capability names the child, and the extra
 * targets are ids, never names. While a send by any sender in the child's group finds no
 * live session, it is held instead of failing with `Session not found`. A hold ends in exactly one way: the
 * child registers with that capability and every held send is dispatched again, once and in order; the owner
 * reports the child gone and held and later senders get the gone refusal; or the hold times out and the sender
 * is told to try again. Reservations end when their owner disconnects.
 */
export class RestoringRecipients {
	private readonly reservations = new Map<string, Reservation>();

	constructor(private readonly onExpired: (held: HeldSend, reason: string) => void) {}

	/** Reserve, or add targets to, the reservation for the child this capability authorizes. */
	reserve(
		capability: string,
		ownerSessionId: string,
		childName: string,
		group: string,
		aliases: readonly string[],
	): void {
		let reservation = this.reservations.get(capability);
		if (reservation === undefined) {
			reservation = { ownerSessionId, childName, group, targets: new Set([normalizeTarget(childName)]), held: new Map() };
			// A newer restoration of the same child replaces the owner's earlier reservation, gone marker included.
			for (const [other, previous] of this.reservations) {
				if (previous.ownerSessionId !== ownerSessionId || normalizeTarget(previous.childName) !== normalizeTarget(childName))
					continue;
				this.reservations.delete(other);
				for (const target of previous.targets) reservation.targets.add(target);
				for (const [held, timer] of previous.held) reservation.held.set(held, timer);
			}
			this.reservations.set(capability, reservation);
		}
		reservation.group = group;
		for (const alias of aliases) {
			const target = normalizeTarget(alias);
			if (target && reservation.targets.size < MAX_RESERVED_TARGETS) reservation.targets.add(target);
		}
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
		const normalized = normalizeTarget(target);
		const reservation = [...this.reservations.values()].find(
			(candidate) =>
				candidate.targets.has(normalized) &&
				(candidate.ownerSessionId === sender.id || hasGroup(sessionGroups(sender.info), candidate.group)),
		);
		if (reservation === undefined) return { kind: "none" };
		if (reservation.gone !== undefined) return { kind: "refused", reason: reservation.gone };
		if (!canHold || reservation.held.size >= MAX_HELD_SENDS)
			return { kind: "refused", reason: restoringRecipientRetryReason(reservation.childName) };
		const timer = setTimeout(() => {
			for (const candidate of this.reservations.values()) {
				if (!candidate.held.delete(held)) continue;
				this.onExpired(held, restoringRecipientRetryReason(candidate.childName));
				return;
			}
		}, RESTORING_RECIPIENT_HOLD_MS);
		timer.unref?.();
		reservation.held.set(held, timer);
		return { kind: "held", timeoutMs: RESTORING_RECIPIENT_HOLD_MS };
	}

	/**
	 * The child registered under this capability: end its reservation and return the sends held for it, in the
	 * order they arrived. Each is routed again as it was addressed, so it reaches the child only through a name or
	 * id the child really registered with, never merely because the owner listed it as an alias.
	 */
	consume(capability: string): HeldSend[] {
		const reservation = this.reservations.get(capability);
		if (reservation === undefined || reservation.gone !== undefined) return [];
		this.reservations.delete(capability);
		return this.take(reservation);
	}

	/**
	 * The owner ended its reservation. With `goneReason` the reservation stays as a gone marker and the held
	 * sends are returned with the gone refusal; without it the reservation ends and the held sends are returned
	 * for ordinary routing. Undefined when this owner holds no such reservation.
	 */
	release(
		capability: string,
		ownerSessionId: string,
		goneReason: string | undefined,
	): { readonly held: HeldSend[]; readonly gone?: string } | undefined {
		const reservation = this.reservations.get(capability);
		if (reservation === undefined || reservation.ownerSessionId !== ownerSessionId) return undefined;
		const held = this.take(reservation);
		if (goneReason === undefined) {
			this.reservations.delete(capability);
			return { held };
		}
		reservation.gone = goneRecipientReason(reservation.childName, goneReason);
		return { held, gone: reservation.gone };
	}

	/** The owner disconnected: end its reservations and return their held sends for ordinary routing. */
	dropOwner(ownerSessionId: string): HeldSend[] {
		const released: HeldSend[] = [];
		for (const [capability, reservation] of this.reservations) {
			if (reservation.ownerSessionId !== ownerSessionId) continue;
			this.reservations.delete(capability);
			released.push(...this.take(reservation));
		}
		return released;
	}

	/** A sender disconnected: nobody is waiting for its held sends any more. */
	dropSender(senderId: string): void {
		for (const reservation of this.reservations.values()) {
			for (const [held, timer] of reservation.held) {
				if (held.senderId !== senderId) continue;
				clearTimeout(timer);
				reservation.held.delete(held);
			}
		}
	}

	clear(): void {
		for (const reservation of this.reservations.values()) this.take(reservation);
		this.reservations.clear();
	}

	private take(reservation: Reservation): HeldSend[] {
		const held = [...reservation.held.keys()];
		for (const timer of reservation.held.values()) clearTimeout(timer);
		reservation.held.clear();
		return held;
	}
}
