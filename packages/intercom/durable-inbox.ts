import type { SessionEntry } from "@bastani/atomic";
import { isMessage, isSessionInfo } from "./broker/client-message-validation.js";
import type { RestoredIntercomPeer } from "./session-recovery.js";
import type { Message, SessionInfo } from "./types.js";

/** #3761: custom session entry saving an Intercom message when it arrives, before the broker reports it delivered. */
export const INTERCOM_INBOX_ENTRY = "intercom_inbox";

/**
 * #3761: custom session entry recording that a saved message was handled without an `intercom_message` card
 * (refused while busy, or dropped as a closed stage's retired child traffic), so resume does not show it.
 */
export const INTERCOM_INBOX_HANDLED_ENTRY = "intercom_inbox_handled";

/**
 * #3761: the lightweight extension asks the loaded runtime to replay a resumed session's unshown saved messages.
 * They pass the same sender-liveness decision as #3760's interrupted Intercom cards, so the request carries what
 * that decision needs; `completion` resolves the notices for the one session recovery notice.
 */
export const INTERCOM_INBOX_REPLAY_EVENT = "intercom:inbox-replay";

export interface IntercomInboxReplayRequest {
	/** The peers connected after the restart; undefined when Intercom could not be reached. */
	readonly peers: readonly SessionInfo[] | undefined;
	/** Children relaunched in this recovery that have not registered with Intercom yet. */
	readonly restored: readonly RestoredIntercomPeer[];
	completion?: Promise<readonly string[]>;
}

export interface IntercomInboxRecord {
	readonly message: Message;
	readonly from: SessionInfo;
	readonly receivedAt: number;
	readonly channel?: "supervisor";
}

function inboxRecord(entry: SessionEntry): IntercomInboxRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== INTERCOM_INBOX_ENTRY) return undefined;
	const data = entry.data as Partial<IntercomInboxRecord> | undefined;
	if (!isMessage(data?.message) || !isSessionInfo(data.from) || typeof data.receivedAt !== "number") return undefined;
	return {
		message: data.message,
		from: data.from,
		receivedAt: data.receivedAt,
		...(data.channel === "supervisor" ? { channel: "supervisor" as const } : {}),
	};
}

/** Ids of the Intercom messages already written to the session as `intercom_message` cards: the one consume rule. */
export function consumedIntercomMessageIds(entries: Iterable<SessionEntry>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== "intercom_message") continue;
		const id = (entry.details as { message?: { id?: string } } | undefined)?.message?.id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

/** Ids of saved messages handled without a card: a reply recorded by its waiting ask, or an explicit handled record. */
function handledIntercomMessageIds(entries: Iterable<SessionEntry>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== "intercom_received" && entry.customType !== INTERCOM_INBOX_HANDLED_ENTRY) continue;
		const id = (entry.data as { messageId?: unknown } | undefined)?.messageId;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

export function savedIntercomMessageIds(entries: Iterable<SessionEntry>): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const record = inboxRecord(entry);
		if (record !== undefined) ids.add(record.message.id);
	}
	return ids;
}

/**
 * Saved messages that never became an `intercom_message` card and were not otherwise handled, once each, in the
 * order they arrived.
 */
export function unconsumedIntercomInbox(entries: Iterable<SessionEntry>): IntercomInboxRecord[] {
	const branch = [...entries];
	const consumed = consumedIntercomMessageIds(branch);
	for (const id of handledIntercomMessageIds(branch)) consumed.add(id);
	const records = new Map<string, IntercomInboxRecord>();
	for (const entry of branch) {
		const record = inboxRecord(entry);
		if (record === undefined || consumed.has(record.message.id) || records.has(record.message.id)) continue;
		records.set(record.message.id, record);
	}
	return [...records.values()].sort((left, right) => left.receivedAt - right.receivedAt);
}

export interface DurableInboxOptions {
	/** False for a session that is not saved (`--no-session`): messages are confirmed without saving them. */
	readonly durable: () => boolean;
	readonly entries: () => Iterable<SessionEntry>;
	readonly append: (record: IntercomInboxRecord) => Promise<void>;
	readonly appendHandled: (messageId: string) => Promise<void>;
	readonly now?: () => number;
}

/** `fresh`: saved now, show it. `redelivered`: already saved, only confirmed again. `unsaved`: not confirmed. */
export type DurableInboxArrival = "fresh" | "redelivered" | "unsaved";

/**
 * #3761: save each arriving Intercom message, then confirm it to the broker, before it is queued to be shown.
 * Arrivals are handled one at a time so they are shown in the order they arrived.
 */
export class DurableInbox {
	private readonly saved = new Set<string>();
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly options: DurableInboxOptions) {}

	receive(
		from: SessionInfo,
		message: Message,
		channel: "supervisor" | undefined,
		acknowledge: () => void,
	): Promise<DurableInboxArrival> {
		const arrival = this.tail.then(() => this.save(from, message, channel, acknowledge));
		this.tail = arrival.then(
			() => {},
			() => {},
		);
		return arrival;
	}

	/** Record that a saved message was handled without a card, so resume does not show it. */
	async handledWithoutCard(messageId: string): Promise<void> {
		if (!this.options.durable()) return;
		if (!this.saved.has(messageId) && !savedIntercomMessageIds(this.options.entries()).has(messageId)) return;
		try {
			await this.options.appendHandled(messageId);
		} catch {
			// Unrecorded, the message is shown again on resume rather than lost.
		}
	}

	private async save(
		from: SessionInfo,
		message: Message,
		channel: "supervisor" | undefined,
		acknowledge: () => void,
	): Promise<DurableInboxArrival> {
		const confirm = (): void => {
			try {
				acknowledge();
			} catch {
				// The broker sends the saved message again after a reconnect; that copy is confirmed instead.
			}
		};
		if (!this.options.durable()) {
			confirm();
			return "fresh";
		}
		if (this.saved.has(message.id) || savedIntercomMessageIds(this.options.entries()).has(message.id)) {
			this.saved.add(message.id);
			confirm();
			return "redelivered";
		}
		try {
			await this.options.append({
				message,
				from,
				receivedAt: this.options.now?.() ?? Date.now(),
				...(channel === undefined ? {} : { channel }),
			});
		} catch {
			return "unsaved";
		}
		this.saved.add(message.id);
		confirm();
		return "fresh";
	}
}
