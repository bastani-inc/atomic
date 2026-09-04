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

interface RetryIdentityReservation {
	readonly expiresAt: number;
	readonly messageId: string;
	reuseCount: number;
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
 * Retains an operation identity only across typed recoverable-disconnect retries.
 * A tool registration owns one instance, and the session id remains in every key so
 * a reconnect or registration replacement cannot make identities cross sessions.
 */
export class RetryIdentityReservations {
	private readonly reservations = new Map<string, RetryIdentityReservation>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxReuses: number;
	private readonly now: () => number;
	private readonly createId: () => string;

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
		const reservation = this.reservations.get(key);
		// A retry claims the retained identity while it is in flight. Leaving it in
		// the map would let a concurrent intentional call reuse the same message ID.
		if (reservation !== undefined && reservation.reuseCount < this.maxReuses) {
			this.reservations.delete(key);
			reservation.reuseCount += 1;
			return {
				key,
				messageId: reservation.messageId,
				reuseCount: reservation.reuseCount,
				expiresAt: reservation.expiresAt,
			};
		}
		if (reservation !== undefined) this.reservations.delete(key);
		return { key, messageId: this.createId(), reuseCount: 0, expiresAt: now + this.ttlMs };
	}

	retainAfterRecoverableDisconnect(attempt: RetryIdentityAttempt): void {
		const now = this.now();
		this.prune(now);
		if (attempt.reuseCount >= this.maxReuses || attempt.expiresAt <= now) {
			this.release(attempt);
			return;
		}
		const current = this.reservations.get(attempt.key);
		if (current?.messageId === attempt.messageId) return;
		// Keep the original attempt's deadline: refreshing here could outlive the
		// broker record whose retained acknowledgement makes the retry safe.
		this.reservations.set(attempt.key, {
			messageId: attempt.messageId,
			expiresAt: attempt.expiresAt,
			reuseCount: attempt.reuseCount,
		});
		while (this.reservations.size > this.maxEntries) {
			const oldest = this.reservations.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.reservations.delete(oldest);
		}
	}

	release(attempt: RetryIdentityAttempt): void {
		const current = this.reservations.get(attempt.key);
		if (current?.messageId === attempt.messageId) this.reservations.delete(attempt.key);
	}

	private prune(now: number): void {
		for (const [key, reservation] of this.reservations) {
			if (reservation.expiresAt > now) continue;
			this.reservations.delete(key);
		}
	}
}
