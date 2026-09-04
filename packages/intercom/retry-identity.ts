import { randomUUID } from "node:crypto";
import {
	ASK_REPLY_TIMEOUT_MS,
	RETRY_IDENTITY_RETRY_OPPORTUNITY_MS,
	RETRY_IDENTITY_TTL_MS,
} from "./retry-policy.js";
import { canonicalizeAttachmentsForSendSignature } from "./broker/send-signature.js";
import type { Attachment } from "./types.js";

export { ASK_REPLY_TIMEOUT_MS, RETRY_IDENTITY_RETRY_OPPORTUNITY_MS, RETRY_IDENTITY_TTL_MS };
/** Bounds process-local memory while preserving recoverable operations until pressure is reached. */
export const RETRY_IDENTITY_MAX_ENTRIES = 1_000;
/** Matches the model-visible direction to retry a disconnected call up to three times. */
export const RETRY_IDENTITY_MAX_REUSES = 3;

export type RetryIdentityAction = "send" | "ask" | "reply";

export interface RetryIdentityInput {
	readonly sessionId: string;
	readonly action: RetryIdentityAction;
	readonly target?: string;
	readonly text: string;
	readonly attachments?: readonly Attachment[];
	readonly replyTo?: string;
	readonly expectsReply?: boolean;
}

export interface RetryIdentityReplyRoute {
	readonly senderId: string;
	readonly senderName?: string;
	readonly messageId: string;
	readonly expectsReply: boolean;
}

export interface RetryIdentityAttempt {
	readonly key: string;
	readonly messageId: string;
	readonly reuseCount: number;
	readonly expiresAt: number;
	/** Present only when this attempt explicitly claimed a retained operation. */
	readonly retryToken?: string;
}

type ReservationState = "fresh-in-flight" | "retained" | "retry-in-flight" | "settled" | "exhausted" | "released";

interface RetryIdentityReservation {
	readonly key: string;
	readonly messageId: string;
	readonly sessionId: string;
	readonly action: RetryIdentityAction;
	readonly expiresAt: number;
	replyRoute?: RetryIdentityReplyRoute;
	retryToken?: string;
	reuseCount: number;
	state: ReservationState;
}

export interface RetryIdentityReservationsOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	readonly maxReuses?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly createToken?: () => string;
}

export class RetryIdentityCapacityError extends Error {
	constructor() {
		super("Intercom retry identity capacity is exhausted; refusing delivery until an in-flight or retained identity is released or expires");
		this.name = "RetryIdentityCapacityError";
	}
}

export type RetryTokenErrorCode = "invalid" | "expired" | "mismatch" | "in_flight" | "settled" | "exhausted";

export class RetryTokenError extends Error {
	constructor(readonly code: RetryTokenErrorCode) {
		const reason = {
			invalid: "is invalid or belongs to another Intercom tool session",
			expired: "has expired",
			mismatch: "does not match this Intercom operation",
			in_flight: "is already claimed by an in-flight retry",
			settled: "belongs to an operation that is already settled",
			exhausted: `has exhausted its ${RETRY_IDENTITY_MAX_REUSES} retry attempts`,
		}[code];
		super(`Intercom retry token ${reason}; refusing delivery`);
		this.name = "RetryTokenError";
	}
}

function operationKey(input: RetryIdentityInput): string {
	return JSON.stringify([
		input.sessionId,
		input.action,
		input.target,
		input.text,
		canonicalizeAttachmentsForSendSignature(input.attachments),
		input.replyTo,
		input.expectsReply,
	]);
}

/**
 * Retains message identities only after a typed recoverable disconnect. A fresh
 * call never consults retained operations: retry reuse requires the opaque token
 * returned for that exact operation. Tokens and their mappings are process-local,
 * registration-scoped, bounded, and expire at the original operation deadline.
 */
export class RetryIdentityReservations {
	private readonly tokenReservations = new Map<string, RetryIdentityReservation>();
	private readonly attemptStates = new WeakMap<RetryIdentityAttempt, RetryIdentityReservation>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxReuses: number;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly createToken: () => string;
	private freshInFlightCount = 0;

	constructor(options: RetryIdentityReservationsOptions = {}) {
		this.ttlMs = options.ttlMs ?? RETRY_IDENTITY_TTL_MS;
		this.maxEntries = options.maxEntries ?? RETRY_IDENTITY_MAX_ENTRIES;
		this.maxReuses = options.maxReuses ?? RETRY_IDENTITY_MAX_REUSES;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.createToken = options.createToken ?? randomUUID;
	}

	begin(input: RetryIdentityInput, retryToken?: string): RetryIdentityAttempt {
		const now = this.now();
		const key = operationKey(input);
		// A claim must inspect its own retained record before general pruning so an
		// expired token is distinguishable from a token that never belonged here.
		if (retryToken !== undefined) return this.claimRetry(key, retryToken, now);
		this.prune(now);
		this.discardSettledTombstonesForCapacity();
		if (this.tokenReservations.size + this.freshInFlightCount >= this.maxEntries) {
			throw new RetryIdentityCapacityError();
		}
		const reservation: RetryIdentityReservation = {
			key,
			messageId: this.createId(),
			expiresAt: now + this.ttlMs,
			sessionId: input.sessionId,
			action: input.action,
			reuseCount: 0,
			state: "fresh-in-flight",
		};
		this.freshInFlightCount += 1;
		return this.attempt(reservation);
	}

	/** Validate token ownership/state before any target resolution without consuming a retry. */
	validateRetryToken(retryToken: string, sessionId: string, action: RetryIdentityAction): number {
		const reservation = this.tokenReservation(retryToken, this.now());
		if (reservation.sessionId !== sessionId || reservation.action !== action) {
			throw new RetryTokenError("mismatch");
		}
		this.requireClaimable(reservation);
		return Math.max(0, this.maxReuses - reservation.reuseCount);
	}

	/** Bind the mutable reply tracker result to a fresh operation before it can be retained. */
	bindReplyRoute(attempt: RetryIdentityAttempt, route: RetryIdentityReplyRoute): void {
		const reservation = this.currentReservation(attempt);
		if (
			reservation === undefined ||
			reservation.action !== "reply" ||
			reservation.state !== "fresh-in-flight" ||
			reservation.replyRoute !== undefined ||
			route.senderId.length === 0 ||
			route.messageId.length === 0
		) {
			throw new RetryTokenError("invalid");
		}
		reservation.replyRoute = { ...route };
	}

	replyRoute(attempt: RetryIdentityAttempt): RetryIdentityReplyRoute | undefined {
		const route = this.currentReservation(attempt)?.replyRoute;
		return route === undefined ? undefined : { ...route };
	}

	/** Retain a fresh or claimed attempt after the typed recoverable disconnect. */
	retainAfterRecoverableDisconnect(attempt: RetryIdentityAttempt): string | undefined {
		return this.retain(attempt, true);
	}

	/** Preserve only an explicitly claimed retry after a resolved but inconclusive result. */
	retainAfterInconclusiveRetry(attempt: RetryIdentityAttempt): string | undefined {
		return this.retain(attempt, false);
	}

	release(attempt: RetryIdentityAttempt): void {
		const reservation = this.currentReservation(attempt);
		if (reservation === undefined || reservation.state === "released" || reservation.state === "settled") return;
		if (reservation.retryToken === undefined) {
			this.releaseFreshCapacity(reservation);
			reservation.state = "released";
			return;
		}
		this.finishRetained(reservation, "settled");
	}

	remainingRetries(attempt: RetryIdentityAttempt): number {
		const reservation = this.currentReservation(attempt);
		return reservation === undefined ? 0 : Math.max(0, this.maxReuses - reservation.reuseCount);
	}

	private claimRetry(key: string, retryToken: string, now: number): RetryIdentityAttempt {
		const reservation = this.tokenReservation(retryToken, now);
		if (reservation.key !== key) throw new RetryTokenError("mismatch");
		this.requireClaimable(reservation);
		reservation.state = "retry-in-flight";
		reservation.reuseCount += 1;
		return this.attempt(reservation);
	}

	private tokenReservation(retryToken: string, now: number): RetryIdentityReservation {
		const reservation = this.tokenReservations.get(retryToken);
		if (reservation === undefined) throw new RetryTokenError("invalid");
		if (reservation.expiresAt <= now) {
			this.expire(reservation);
			throw new RetryTokenError("expired");
		}
		return reservation;
	}

	private requireClaimable(reservation: RetryIdentityReservation): void {
		if (reservation.state === "settled") throw new RetryTokenError("settled");
		if (reservation.state === "exhausted" || reservation.reuseCount >= this.maxReuses) {
			reservation.state = "exhausted";
			throw new RetryTokenError("exhausted");
		}
		if (reservation.state === "retry-in-flight") throw new RetryTokenError("in_flight");
		if (reservation.state !== "retained") throw new RetryTokenError("invalid");
	}
	private retain(attempt: RetryIdentityAttempt, allowFresh: boolean): string | undefined {
		const now = this.now();
		this.prune(now);
		const reservation = this.currentReservation(attempt);
		if (reservation === undefined) return undefined;
		const fresh = reservation.state === "fresh-in-flight";
		if (!fresh && reservation.state !== "retry-in-flight") return undefined;
		if (fresh && !allowFresh) {
			this.releaseFreshCapacity(reservation);
			reservation.state = "released";
			return undefined;
		}
		if (reservation.expiresAt <= now) {
			if (reservation.retryToken === undefined) {
				this.releaseFreshCapacity(reservation);
				reservation.state = "released";
			} else this.expire(reservation);
			return undefined;
		}
		if (reservation.reuseCount >= this.maxReuses) {
			if (reservation.retryToken === undefined) {
				this.releaseFreshCapacity(reservation);
				reservation.state = "released";
			} else reservation.state = "exhausted";
			return undefined;
		}
		if (fresh) {
			reservation.retryToken = this.uniqueToken();
			this.tokenReservations.set(reservation.retryToken, reservation);
			this.releaseFreshCapacity(reservation);
		}
		reservation.state = "retained";
		return reservation.retryToken;
	}

	private discardSettledTombstonesForCapacity(): void {
		if (this.tokenReservations.size + this.freshInFlightCount < this.maxEntries) return;
		for (const [token, reservation] of this.tokenReservations) {
			if (reservation.state !== "settled") continue;
			this.tokenReservations.delete(token);
			if (this.tokenReservations.size + this.freshInFlightCount < this.maxEntries) return;
		}
	}

	private uniqueToken(): string {
		for (;;) {
			const token = this.createToken();
			if (token.length > 0 && !this.tokenReservations.has(token)) return token;
		}
	}

	private attempt(reservation: RetryIdentityReservation): RetryIdentityAttempt {
		const attempt: RetryIdentityAttempt = {
			key: reservation.key,
			messageId: reservation.messageId,
			reuseCount: reservation.reuseCount,
			expiresAt: reservation.expiresAt,
			...(reservation.state === "retry-in-flight" && reservation.retryToken !== undefined
				? { retryToken: reservation.retryToken }
				: {}),
		};
		this.attemptStates.set(attempt, reservation);
		return attempt;
	}

	private currentReservation(attempt: RetryIdentityAttempt): RetryIdentityReservation | undefined {
		const reservation = this.attemptStates.get(attempt);
		return reservation?.reuseCount === attempt.reuseCount ? reservation : undefined;
	}

	private releaseFreshCapacity(reservation: RetryIdentityReservation): void {
		if (reservation.state !== "fresh-in-flight") return;
		this.freshInFlightCount = Math.max(0, this.freshInFlightCount - 1);
	}
	private finishRetained(reservation: RetryIdentityReservation, state: "settled" | "released"): void {
		reservation.state = state;
	}

	private expire(reservation: RetryIdentityReservation): void {
		if (reservation.retryToken !== undefined) this.tokenReservations.delete(reservation.retryToken);
		this.finishRetained(reservation, "released");
	}

	private prune(now: number): void {
		for (const reservation of this.tokenReservations.values()) {
			if (reservation.expiresAt <= now) this.expire(reservation);
		}
	}
}
