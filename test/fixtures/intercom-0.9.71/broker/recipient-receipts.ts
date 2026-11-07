import type net from "node:net";
import {
	DELIVERED_MESSAGE_TTL_MS,
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVE_MAX_WAIT_MS,
} from "../retry-policy.js";
import type { BrokerMessage } from "../types.js";

/** #3761: the sender is told this when the recipient did not confirm a save within the sender's wait. */
export const UNCERTAIN_RECEIPT_REASON =
	"The recipient did not confirm that it saved the message in time, so whether it arrived is uncertain: it may still save and show it. Check with the recipient before sending it again, because a new send is a new message.";

export interface ReceiptSender {
	readonly socket: net.Socket;
	readonly attemptId?: string;
}

export interface AwaitedReceipt<Recipient> {
	readonly messageId: string;
	/** Stable recipient authority, so a reconnected recipient can confirm or receive the message again. */
	readonly targetIdentity: string;
	/** The frame written to the recipient, written again when it registers again before confirming. */
	readonly frame: BrokerMessage;
	/** Runs once, on the recipient's confirmation. `sender` is absent once the sender's wait has ended. */
	readonly complete: (recipient: Recipient, sender: ReceiptSender | undefined) => void;
	/** Runs when the sender's wait ends before the recipient confirms. */
	readonly expire: (sender: ReceiptSender) => void;
	/**
	 * Runs when a recipient still saving the message extends the sender's wait: tells the sender to keep waiting
	 * for up to `timeoutMs` more (a `send_held` frame).
	 */
	readonly hold?: (sender: ReceiptSender, timeoutMs: number) => void;
}

interface PendingReceipt<Recipient> extends AwaitedReceipt<Recipient> {
	sender: ReceiptSender | undefined;
	senderTimer: ReturnType<typeof setTimeout> | undefined;
	retentionTimer: ReturnType<typeof setTimeout>;
	/** When the sender started waiting; a save that keeps reporting progress still ends its wait after the cap. */
	readonly waitingSince: number;
}

/**
 * #3761: messages written to a recipient that confirms saves, held until that recipient says it saved them.
 * A message stays held after the sender's wait ends, so a late confirmation still settles it and a
 * re-registered recipient is sent it again; it is forgotten after the delivered-message retention.
 */
export class RecipientReceipts<Recipient> {
	private readonly pending = new Map<string, PendingReceipt<Recipient>>();

	constructor(
		private readonly senderTimeoutMs = RECIPIENT_RECEIPT_TIMEOUT_MS,
		private readonly retentionMs = DELIVERED_MESSAGE_TTL_MS,
	) {}

	await(receipt: AwaitedReceipt<Recipient>, sender: ReceiptSender): void {
		this.drop(receipt.messageId);
		const entry: PendingReceipt<Recipient> = {
			...receipt,
			sender,
			senderTimer: undefined,
			retentionTimer: setTimeout(() => {
				if (this.pending.get(receipt.messageId) === entry) this.drop(receipt.messageId);
			}, this.retentionMs),
			waitingSince: Date.now(),
		};
		entry.retentionTimer.unref?.();
		this.armSenderWait(entry, this.senderTimeoutMs);
		this.pending.set(receipt.messageId, entry);
	}

	private armSenderWait(entry: PendingReceipt<Recipient>, timeoutMs: number): void {
		if (entry.senderTimer !== undefined) clearTimeout(entry.senderTimer);
		entry.senderTimer = setTimeout(() => {
			entry.senderTimer = undefined;
			const waiting = entry.sender;
			entry.sender = undefined;
			if (waiting !== undefined && this.pending.get(entry.messageId) === entry) entry.expire(waiting);
		}, timeoutMs);
	}

	/**
	 * The recipient this message was written to reports it is still saving it (for example a pooled stage whose
	 * journal commit waits behind other writers): the sender keeps waiting another full receipt wait instead of
	 * hearing the outcome is uncertain. A recipient that dies stops reporting, so its wait still ends; and no save
	 * holds a sender past `RECIPIENT_SAVE_MAX_WAIT_MS` (#3983).
	 */
	extend(messageId: string, targetIdentity: string): boolean {
		const entry = this.pending.get(messageId);
		if (entry === undefined || entry.targetIdentity !== targetIdentity || entry.sender === undefined) return false;
		const remaining = entry.waitingSince + RECIPIENT_SAVE_MAX_WAIT_MS - Date.now();
		if (remaining <= 0) return false;
		const timeoutMs = Math.min(this.senderTimeoutMs, remaining);
		this.armSenderWait(entry, timeoutMs);
		entry.hold?.(entry.sender, timeoutMs);
		return true;
	}

	/** Settle a held message when the confirming recipient is the one it was written to. */
	settle(messageId: string, targetIdentity: string, recipient: Recipient): boolean {
		const entry = this.pending.get(messageId);
		if (entry === undefined || entry.targetIdentity !== targetIdentity) return false;
		const sender = entry.sender;
		this.drop(messageId);
		entry.complete(recipient, sender);
		return true;
	}

	/** Frames still waiting for this recipient, in the order they were first written. */
	framesFor(targetIdentity: string): BrokerMessage[] {
		return [...this.pending.values()]
			.filter((entry) => entry.targetIdentity === targetIdentity)
			.map((entry) => entry.frame);
	}

	drop(messageId: string): void {
		const entry = this.pending.get(messageId);
		if (entry === undefined) return;
		this.pending.delete(messageId);
		if (entry.senderTimer !== undefined) clearTimeout(entry.senderTimer);
		clearTimeout(entry.retentionTimer);
	}

	clear(): void {
		for (const messageId of [...this.pending.keys()]) this.drop(messageId);
	}
}
