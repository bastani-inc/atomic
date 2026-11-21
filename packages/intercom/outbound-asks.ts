import type { ExtensionAPI, SessionEntry } from "@bastani/atomic";
import { isMessage, isSessionInfo } from "./broker/client-message-validation.js";
import { consumedIntercomMessageIds, INTERCOM_INBOX_ENTRY, INTERCOM_INBOX_HANDLED_ENTRY } from "./durable-inbox.js";
import type { InboundMessageEntry } from "./intercom-utils.js";
import type { Message, SessionInfo } from "./types.js";

/** #4751: custom session entry recording an `ask` this session sent, so its reply is recognized after a restart. */
export const OUTBOUND_ASK_ENTRY = "intercom_ask";
/**
 * #4751: custom session entry recording how an outbound ask ended: answered, cancelled, or failed. `{ askId, state }`
 * records one ask; `{ askIds, state: "answered" }` records several answered asks at once. A reopened session keeps
 * neither the ask nor the messages that answered it once its outcome is recorded.
 */
export const OUTBOUND_ASK_SETTLED_ENTRY = "intercom_ask_settled";

/** The most asks one record of answered asks names, so the record stays small. */
export const SETTLED_ASKS_PER_RECORD = 500;

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

interface HeldAskRecord extends OutboundAskRecord {
	/** Whether the session holds a record of how it ended, rather than only the messages saved for it. */
	readonly recorded: boolean;
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

	/**
	 * Record that a reply answered `askId`, once the session has saved that it took it: a reopened session then keeps
	 * neither the ask nor its reply. Only an answer is recorded this way: after it, the broker routes no other reply and
	 * the session shows no failure for the ask, so nothing that arrives later needs the ask. A record that is not saved
	 * is written at a later resume.
	 */
	async recordAnswered(askId: string): Promise<void> {
		const record = this.records().get(askId);
		if (record?.state !== "answered" || record.recorded) return;
		try {
			await this.options.append(OUTBOUND_ASK_SETTLED_ENTRY, { askId, state: "answered" });
		} catch {
			// Unsaved, the ask and its reply stay in a reopened session, which records the answer then.
		}
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

	private records(entries: readonly SessionEntry[] = this.branch()): Map<string, HeldAskRecord> {
		const asks = new Map<string, OutboundAsk>();
		const states = new Map<string, Exclude<OutboundAskState, "pending">>();
		const owner = this.options.sessionId();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === OUTBOUND_ASK_ENTRY && isOutboundAsk(entry.data) && entry.data.sessionId === owner)
				asks.set(entry.data.askId, entry.data);
			if (entry.customType === OUTBOUND_ASK_SETTLED_ENTRY)
				for (const [askId, state] of settledOutcomes(entry.data)) if (!states.has(askId)) states.set(askId, state);
		}
		const recorded = new Set(states.keys());
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
		const records = new Map<string, HeldAskRecord>();
		for (const [askId, ask] of asks)
			records.set(askId, { ask, state: states.get(askId) ?? "pending", recorded: recorded.has(askId) });
		return records;
	}

	/**
	 * After a restart, record in one entry the asks whose answer this session took without recording it: a reply taken
	 * in a call, as earlier versions saved them, or shown as a message. A later reopened session then keeps neither those
	 * asks nor their replies. `taken` names the messages the session took in entries a resumed window left out (#6168).
	 * An ask is recorded only once every message saved for it was taken, so a reply still to be shown keeps its ask. A
	 * message naming an ask this session does not hold, such as the supervisor's reply to a subagent's question, is
	 * recorded the same way. Nothing is written when there are none; a record not saved is tried at the next restart.
	 */
	async recordTakenAnswers(taken: Iterable<string> = []): Promise<void> {
		const askIds = this.answeredUnrecorded(taken).slice(0, SETTLED_ASKS_PER_RECORD);
		if (askIds.length === 0) return;
		try {
			await this.options.append(OUTBOUND_ASK_SETTLED_ENTRY, { askIds, state: "answered" });
		} catch {
			// Unsaved, the asks and their replies stay in a reopened session, which records them then.
		}
	}

	private branch(): SessionEntry[] {
		try {
			return [...this.options.entries()];
		} catch {
			return [];
		}
	}

	private answeredUnrecorded(taken: Iterable<string>): string[] {
		const entries = this.branch();
		const records = this.records(entries);
		const takenIds = new Set(taken);
		for (const id of consumedIntercomMessageIds(entries)) takenIds.add(id);
		const recordedIds = new Set<string>();
		const replies = new Map<string, boolean>();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === OUTBOUND_ASK_SETTLED_ENTRY)
				for (const [askId] of settledOutcomes(entry.data)) recordedIds.add(askId);
			if (entry.type === "custom" && (entry.customType === "intercom_received" || entry.customType === INTERCOM_INBOX_HANDLED_ENTRY)) {
				const id = (entry.data as { messageId?: unknown } | undefined)?.messageId;
				if (typeof id === "string") takenIds.add(id);
			}
		}
		for (const { message } of savedArrivals(entries)) {
			if (message.replyTo === undefined || message.expectsReply === true) continue;
			replies.set(message.replyTo, (replies.get(message.replyTo) ?? true) && takenIds.has(message.id));
		}
		const answered: string[] = [];
		for (const [askId, allTaken] of replies) {
			if (!allTaken || recordedIds.has(askId)) continue;
			const record = records.get(askId);
			if (record !== undefined && (record.state !== "answered" || record.recorded)) continue;
			answered.push(askId);
		}
		return answered;
	}
}

/** The outcomes an `intercom_ask_settled` entry records: one ask's, or several answered asks'. */
function* settledOutcomes(value: unknown): Generator<[string, Exclude<OutboundAskState, "pending">]> {
	const data = value as { askId?: unknown; askIds?: unknown; state?: unknown } | undefined;
	if (!isSettledState(data?.state)) return;
	if (typeof data.askId === "string") yield [data.askId, data.state];
	if (data.state === "answered" && Array.isArray(data.askIds))
		for (const askId of data.askIds) if (typeof askId === "string") yield [askId, "answered"];
}

/**
 * Record that a question this session asked without an outbound ask record, such as a subagent's question to its
 * supervisor, was answered, once the reply is saved as taken: a reopened session then keeps none of its replies.
 */
export async function recordAnsweredQuestion(
	pi: Pick<ExtensionAPI, "appendEntry">,
	questionId: string,
): Promise<void> {
	try {
		await pi.appendEntry(OUTBOUND_ASK_SETTLED_ENTRY, { askId: questionId, state: "answered" });
	} catch {
		// Unsaved, the reply stays in a reopened session, which records the answer then.
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
