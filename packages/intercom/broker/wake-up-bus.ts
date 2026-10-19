/**
 * Wake-up bus seam (specs/2026-10-19-intercom-multi-node.md). A wake-up is only a hint that tells one broker to
 * read the shared store; it never carries a message. Hints may be delayed, coalesced, duplicated or lost, so a
 * broker never depends on them: it scans the store on every `resync` event and on its backup poll.
 */

/** `outbox`: rows may be waiting for the broker's recipients. `outcome`: rows its senders wait on may have settled. */
export type WakeUpReason = "outbox" | "outcome";

export interface WakeUpHint {
	/** The broker that should read the store. */
	readonly brokerId: string;
	readonly reason: WakeUpReason;
	/** The outbox `sequence` that prompted the hint. Receivers may use it to skip a scan, never to read a message. */
	readonly version: number;
}

export type WakeUpEvent =
	| { readonly kind: "hint"; readonly hint: WakeUpHint }
	/** Hints may have been missed: on subscribe and after every reconnect, so the broker runs a catch-up scan. */
	| { readonly kind: "resync"; readonly cause: "subscribed" | "reconnected" };

export type WakeUpListener = (event: WakeUpEvent) => void;

export interface InvalidWakeUpInput {
	readonly status: "invalid";
	readonly reason: "empty-broker-id";
}

export interface WakeUpSubscription {
	readonly brokerId: string;
	/** Stop delivering events to this listener; idempotent. */
	close(): Promise<void>;
}

export type WakeUpPublishResult =
	| { readonly status: "published" }
	/** The bus is unreachable; the hint is dropped and the backup poll covers it. */
	| { readonly status: "unavailable" }
	| InvalidWakeUpInput;

export type WakeUpSubscribeResult =
	| { readonly status: "subscribed"; readonly subscription: WakeUpSubscription }
	| InvalidWakeUpInput;

/** S4: one broker's connection to the wake-up bus shared by every broker using the same storage. */
export interface WakeUpBus {
	/** Best effort; never throws for a transport failure. With no subscriber it is a no-op; after `close` it reports `unavailable`. */
	publish(hint: WakeUpHint): Promise<WakeUpPublishResult>;
	/** Deliver hints addressed to `brokerId`, preceded by a `subscribed` resync. */
	subscribe(brokerId: string, listener: WakeUpListener): Promise<WakeUpSubscribeResult>;
	/** Close this connection and its subscriptions; idempotent. */
	close(): Promise<void>;
}
