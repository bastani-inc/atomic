import { randomUUID } from "node:crypto";
import type { Attachment } from "./types.js";

/** Must stay below the broker's ten-minute delivered-message retention window. */
export const RETRY_IDENTITY_TTL_MS = 9 * 60 * 1000;
/** Bounds process-local memory while preserving the most recent recoverable operations. */
export const RETRY_IDENTITY_MAX_ENTRIES = 1_000;
/** Matches the model-visible direction to retry a disconnected call up to three times. */
export const RETRY_IDENTITY_MAX_REUSES = 3;

export type RetryIdentityAction = "send" | "ask" | "reply";

export interface RetryIdentityInput {
	readonly sessionId: string;
	readonly action: RetryIdentityAction;
	readonly target: string;
	readonly text: string;
	readonly attachments?: readonly Attachment[];
	readonly replyTo?: string;
	readonly expectsReply?: boolean;
}

export interface RetryIdentityAttempt {
	readonly key: string;
	readonly messageId: string;
	readonly reuseCount: number;
	readonly expiresAt: number;
}

type ReservationState = "in-flight" | "retained" | "released";

interface RetryIdentityReservation {
	readonly key: string;
	readonly messageId: string;
	readonly expiresAt: number;
	readonly createdOrder: number;
	reuseCount: number;
	state: ReservationState;
}

export interface RetryIdentityReservationsOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	readonly maxReuses?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
}

function operationKey(input: RetryIdentityInput): string {
	return JSON.stringify([
		input.sessionId,
		input.action,
		input.target,
		input.text,
		input.attachments,
		input.replyTo,
		input.expectsReply,
	]);
}

/**
 * Retains operation identities only across typed recoverable-disconnect retries.
 * Each key owns a FIFO of independently failed operations: later retry calls claim
 * them in retention order, and a failed retry returns to the tail so one identity
 * cannot starve its identical peers. The original creation order controls global
 * oldest-first capacity eviction.
 */
export class RetryIdentityReservations {
	private readonly reservations = new Map<string, RetryIdentityReservation[]>();
	private readonly attemptStates = new WeakMap<RetryIdentityAttempt, RetryIdentityReservation>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxReuses: number;
	private readonly now: () => number;
	private readonly createId: () => string;
	private nextCreatedOrder = 0;
	private retainedCount = 0;

	constructor(options: RetryIdentityReservationsOptions = {}) {
		this.ttlMs = options.ttlMs ?? RETRY_IDENTITY_TTL_MS;
		this.maxEntries = options.maxEntries ?? RETRY_IDENTITY_MAX_ENTRIES;
		this.maxReuses = options.maxReuses ?? RETRY_IDENTITY_MAX_REUSES;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
	}

	begin(input: RetryIdentityInput): RetryIdentityAttempt {
		const now = this.now();
		this.prune(now);
		const key = operationKey(input);
		const queue = this.reservations.get(key);
		while (queue !== undefined && queue.length > 0) {
			const reservation = queue.shift();
			if (reservation === undefined) break;
			this.retainedCount -= 1;
			if (queue.length === 0) this.reservations.delete(key);
			if (reservation.state !== "retained") continue;
			if (reservation.reuseCount >= this.maxReuses || reservation.expiresAt <= now) {
				reservation.state = "released";
				continue;
			}
			// Claiming removes this identity from the FIFO while it is in flight, so
			// a concurrent intentional call cannot share its message ID.
			reservation.state = "in-flight";
			reservation.reuseCount += 1;
			return this.attempt(reservation);
		}
		const reservation: RetryIdentityReservation = {
			key,
			messageId: this.createId(),
			expiresAt: now + this.ttlMs,
			createdOrder: this.nextCreatedOrder++,
			reuseCount: 0,
			state: "in-flight",
		};
		return this.attempt(reservation);
	}

	retainAfterRecoverableDisconnect(attempt: RetryIdentityAttempt): void {
		const now = this.now();
		this.prune(now);
		const reservation = this.currentReservation(attempt);
		if (reservation === undefined || reservation.state !== "in-flight") return;
		if (reservation.reuseCount >= this.maxReuses || reservation.expiresAt <= now) {
			reservation.state = "released";
			return;
		}
		// Keep the original attempt's deadline: refreshing here could outlive the
		// broker record whose retained acknowledgement makes the retry safe.
		reservation.state = "retained";
		const queue = this.reservations.get(reservation.key) ?? [];
		queue.push(reservation);
		this.reservations.set(reservation.key, queue);
		this.retainedCount += 1;
		while (this.retainedCount > this.maxEntries) this.evictOldest();
	}

	release(attempt: RetryIdentityAttempt): void {
		const reservation = this.currentReservation(attempt);
		if (reservation === undefined || reservation.state === "released") return;
		if (reservation.state === "retained") this.removeRetained(reservation);
		reservation.state = "released";
	}

	private attempt(reservation: RetryIdentityReservation): RetryIdentityAttempt {
		const attempt = {
			key: reservation.key,
			messageId: reservation.messageId,
			reuseCount: reservation.reuseCount,
			expiresAt: reservation.expiresAt,
		};
		this.attemptStates.set(attempt, reservation);
		return attempt;
	}

	private currentReservation(attempt: RetryIdentityAttempt): RetryIdentityReservation | undefined {
		const reservation = this.attemptStates.get(attempt);
		return reservation?.reuseCount === attempt.reuseCount ? reservation : undefined;
	}

	private removeRetained(reservation: RetryIdentityReservation): void {
		const queue = this.reservations.get(reservation.key);
		const index = queue?.indexOf(reservation) ?? -1;
		if (queue === undefined || index < 0) return;
		queue.splice(index, 1);
		this.retainedCount -= 1;
		if (queue.length === 0) this.reservations.delete(reservation.key);
	}

	private evictOldest(): void {
		let oldest: RetryIdentityReservation | undefined;
		for (const queue of this.reservations.values()) {
			for (const reservation of queue) {
				if (oldest === undefined || reservation.createdOrder < oldest.createdOrder) oldest = reservation;
			}
		}
		if (oldest === undefined) return;
		this.removeRetained(oldest);
		oldest.state = "released";
	}

	private prune(now: number): void {
		for (const [key, queue] of this.reservations) {
			const retained = queue.filter((reservation) => {
				if (reservation.expiresAt > now) return true;
				reservation.state = "released";
				this.retainedCount -= 1;
				return false;
			});
			if (retained.length === 0) this.reservations.delete(key);
			else if (retained.length !== queue.length) this.reservations.set(key, retained);
		}
	}
}
