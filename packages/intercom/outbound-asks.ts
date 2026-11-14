import type { SessionEntry } from "@bastani/atomic";
import { isMessage, isSessionInfo } from "./broker/client-message-validation.js";
import { INTERCOM_INBOX_ENTRY } from "./durable-inbox.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { Message, SessionInfo } from "./types.js";

/** #4751: custom session entry recording an `ask` this session sent, so its reply is recognized after a restart. */
export const OUTBOUND_ASK_ENTRY = "intercom_ask";
/** #4751: custom session entry recording how an outbound ask ended: answered, cancelled, or failed. */
export const OUTBOUND_ASK_SETTLED_ENTRY = "intercom_ask_settled";

export interface OutboundAsk {
	readonly askId: string;
	/** The Atomic session that asked; a fork inherits the entry but not the ask. */
	readonly sessionId: string;
	/** The target as the asker wrote it. */
	readonly to: string;
	/** The session the reply is expected from, as far as the asker knows. */
	readonly recipientId: string;
	readonly question: string;
	readonly askedAt: number;
}

export type OutboundAskState = "pending" | "answered" | "cancelled" | "failed";

export interface OutboundAskRecord {
	readonly ask: OutboundAsk;
	readonly state: OutboundAskState;
}

interface OutboundAsksOptions {
	readonly entries: () => Iterable<SessionEntry>;
	readonly append: (customType: string, data: object) => Promise<void>;
	/** The Atomic session these asks belong to. */
	readonly sessionId: () => string | null;
	readonly now?: () => number;
}

function isOutboundAsk(value: unknown): value is OutboundAsk {
	if (typeof value !== "object" || value === null) return false;
	const ask = value as Partial<OutboundAsk>;
	return (
		typeof ask.askId === "string" &&
		typeof ask.sessionId === "string" &&
		typeof ask.to === "string" &&
		typeof ask.recipientId === "string" &&
		typeof ask.question === "string" &&
		typeof ask.askedAt === "number"
	);
}

function isSettledState(value: unknown): value is Exclude<OutboundAskState, "pending"> {
	return value === "answered" || value === "cancelled" || value === "failed";
}

/**
 * #4751: the asks this session sent and how each ended. An ask has no expiry: it stays pending until it is answered,
 * cancelled, or refused, or its recipient session ends. Records live on the session branch, so a restarted asker still
 * recognizes the reply to an ask it sent before the restart; the in-memory copy covers the moment between delivery and
 * the record being saved.
 */
export class OutboundAsks {
	private readonly opened = new Map<string, OutboundAsk>();
	private readonly settled = new Map<string, Exclude<OutboundAskState, "pending">>();

	constructor(private readonly options: OutboundAsksOptions) {}

	/** Know about an ask before it is sent, so a reply racing the saved record is still framed as its reply. */
	open(ask: Omit<OutboundAsk, "askedAt" | "sessionId">): OutboundAsk {
		const opened = { ...ask, sessionId: this.options.sessionId() ?? "", askedAt: this.options.now?.() ?? Date.now() };
		this.opened.set(ask.askId, opened);
		return opened;
	}

	/** Forget an ask that was never delivered. */
	forget(askId: string): void {
		this.opened.delete(askId);
	}

	/** Save a delivered ask with the session. */
	async persist(askId: string): Promise<void> {
		const ask = this.opened.get(askId);
		if (ask === undefined) return;
		await this.options.append(OUTBOUND_ASK_ENTRY, ask);
	}

	find(askId: string): OutboundAskRecord | undefined {
		const records = this.records();
		return records.get(askId);
	}

	/**
	 * The ask a message answers: it names the ask in `replyTo` and comes from the ask's recipient, by the session id the
	 * broker authorized or by the name it was asked under. Another peer cannot answer someone else's ask.
	 */
	answeredBy(from: SessionInfo, message: Message): OutboundAskRecord | undefined {
		if (message.replyTo === undefined || message.expectsReply === true) return undefined;
		const record = this.find(message.replyTo);
		return record !== undefined && answeredByRecipient(record.ask, from) ? record : undefined;
	}

	/** Asks still waiting for their reply, oldest first. */
	pending(): OutboundAsk[] {
		return [...this.records().values()]
			.filter((record) => record.state === "pending")
			.map((record) => record.ask)
			.sort((left, right) => left.askedAt - right.askedAt);
	}

	/** Record how a pending ask ended; an ask that already ended keeps its first outcome. */
	async settle(askId: string, state: Exclude<OutboundAskState, "pending">): Promise<boolean> {
		const record = this.find(askId);
		if (record === undefined || record.state !== "pending") return false;
		this.settled.set(askId, state);
		try {
			await this.options.append(OUTBOUND_ASK_SETTLED_ENTRY, { askId, state });
		} catch {
			// Unsaved, the ask shows as pending again after a restart; its reply is still framed as one.
		}
		return true;
	}

	private records(): Map<string, OutboundAskRecord> {
		const asks = new Map<string, OutboundAsk>();
		const states = new Map<string, Exclude<OutboundAskState, "pending">>();
		let entries: SessionEntry[] = [];
		try {
			entries = [...this.options.entries()];
		} catch {
			entries = [];
		}
		const owner = this.options.sessionId();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === OUTBOUND_ASK_ENTRY && isOutboundAsk(entry.data) && entry.data.sessionId === owner)
				asks.set(entry.data.askId, entry.data);
			if (entry.customType === OUTBOUND_ASK_SETTLED_ENTRY) {
				const data = entry.data as { askId?: unknown; state?: unknown } | undefined;
				if (typeof data?.askId === "string" && isSettledState(data.state) && !states.has(data.askId)) {
					states.set(data.askId, data.state);
				}
			}
		}
		for (const [askId, ask] of this.opened) if (!asks.has(askId)) asks.set(askId, ask);
		for (const [askId, state] of this.settled) if (!states.has(askId)) states.set(askId, state);
		// A saved reply or failed-ask message settles its ask even when the settle record was never written (a crash
		// between the two): the ask's state always agrees with the messages saved for it.
		for (const { from, message } of savedArrivals(entries)) {
			if (message.replyTo === undefined || message.expectsReply === true || states.has(message.replyTo)) continue;
			const ask = asks.get(message.replyTo);
			if (ask === undefined || !answeredByRecipient(ask, from)) continue;
			states.set(ask.askId, message.replyError === undefined ? "answered" : "failed");
		}
		const records = new Map<string, OutboundAskRecord>();
		for (const [askId, ask] of asks) records.set(askId, { ask, state: states.get(askId) ?? "pending" });
		return records;
	}
}

/** Whether `from` is the ask's recipient: the session the broker authorized, or the name it was asked under. */
function answeredByRecipient(ask: OutboundAsk, from: SessionInfo): boolean {
	const named = from.name !== undefined && from.name.toLowerCase() === ask.to.trim().toLowerCase();
	return from.id === ask.recipientId || named;
}

/** Messages this session saved as they arrived, or showed as cards. */
function* savedArrivals(entries: readonly SessionEntry[]): Generator<{ from: SessionInfo; message: Message }> {
	for (const entry of entries) {
		const data =
			entry.type === "custom" && entry.customType === INTERCOM_INBOX_ENTRY
				? (entry.data as { from?: unknown; message?: unknown } | undefined)
				: entry.type === "custom_message" && entry.customType === "intercom_message"
					? (entry.details as { from?: unknown; message?: unknown } | undefined)
					: undefined;
		if (isSessionInfo(data?.from) && isMessage(data.message)) yield { from: data.from, message: data.message };
	}
}

function quote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

/**
 * #4751: frame a reply (or a refusal) to one of this session's asks as a message on its own thread: "Reply to your ask
 * <id> from <name>", with the question quoted. A reply to a cancelled ask is marked late.
 */
export function frameOutboundAskReply(
	entry: InboundMessageEntry,
	record: OutboundAskRecord,
): InboundMessageEntry {
	const sender = entry.from.name || entry.from.id;
	const { ask } = record;
	if (entry.message.replyError !== undefined) {
		return {
			...entry,
			replyCommand: undefined,
			heading: `Your ask ${ask.askId} to ${sender} failed`,
			bodyText: `Question:\n${quote(ask.question)}\n\nReason: ${entry.message.replyError}`,
		};
	}
	const late = record.state === "cancelled" ? " (late: you cancelled this ask)" : "";
	return {
		...entry,
		heading: `Reply to your ask ${ask.askId} from ${sender}${late}`,
		bodyText: `Question:\n${quote(ask.question)}\n\nReply:\n${entry.bodyText}`,
	};
}

/** #4751: a failed-ask message for an ask whose recipient session ended before it replied. */
export function recipientClosedAskEntry(
	ask: OutboundAsk,
	peer: { readonly sessionId: string; readonly name?: string },
	now = Date.now(),
): InboundMessageEntry {
	const reason = `Session "${peer.name ?? peer.sessionId}" ended before replying`;
	const from: SessionInfo = {
		id: peer.sessionId,
		...(peer.name === undefined ? {} : { name: peer.name }),
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: now,
	};
	const message: Message = {
		id: `${ask.askId}:recipient-closed`,
		timestamp: now,
		replyTo: ask.askId,
		replyError: reason,
		content: { text: reason },
	};
	return {
		from,
		message,
		heading: `Your ask ${ask.askId} to ${peer.name ?? peer.sessionId} failed`,
		bodyText: `Question:\n${quote(ask.question)}\n\nReason: ${reason}`,
	};
}
