import type { ReplyWaiterRecord } from "./reply-waiter.js";
import { routeIncomingReply } from "./reply-routing.js";
import type { Message, SessionInfo } from "./types.js";

export const RELEASED_REPLY_MAILBOX_MAX_ENTRIES = 1_024;

export class ReleasedReplyMailbox {
	private readonly waiters = new Map<string, ReplyWaiterRecord>();

	constructor(private readonly maxEntries: number = RELEASED_REPLY_MAILBOX_MAX_ENTRIES) {}

	get size(): number {
		return this.waiters.size;
	}

	adopt(waiter: ReplyWaiterRecord): boolean {
		if (this.waiters.size >= this.maxEntries || this.waiters.has(waiter.replyTo)) return false;
		this.waiters.set(waiter.replyTo, waiter);
		return true;
	}

	forget(waiter: ReplyWaiterRecord): void {
		if (this.waiters.get(waiter.replyTo) === waiter) this.waiters.delete(waiter.replyTo);
	}

	deliver(from: SessionInfo, message: Message): boolean {
		const waiter = message.replyTo === undefined ? undefined : this.waiters.get(message.replyTo);
		return waiter !== undefined && routeIncomingReply(waiter, from, message);
	}
}

const MAILBOX: unique symbol = Symbol.for("@bastani/intercom/released-reply-mailbox");

type MailboxHolder = typeof globalThis & { [MAILBOX]?: ReleasedReplyMailbox };

export function releasedReplyMailbox(): ReleasedReplyMailbox {
	const holder = globalThis as MailboxHolder;
	holder[MAILBOX] ??= new ReleasedReplyMailbox();
	return holder[MAILBOX];
}

export interface ReleasedChildReplyNotice {
	readonly from: SessionInfo;
	readonly message: Message;
}

export interface ReleasedChildReplySource {
	on(event: "released_child_reply", listener: (notice: ReleasedChildReplyNotice) => void): unknown;
	acknowledgeReleasedChildReply(messageId: string, accepted: boolean): boolean;
}

export function answerReleasedChildReplies(
	client: ReleasedChildReplySource,
	mailbox: ReleasedReplyMailbox = releasedReplyMailbox(),
): void {
	client.on("released_child_reply", (notice) => {
		client.acknowledgeReleasedChildReply(notice.message.id, mailbox.deliver(notice.from, notice.message));
	});
}
