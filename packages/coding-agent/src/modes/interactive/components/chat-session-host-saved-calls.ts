import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ToolResultMessage } from "@bastani/atomic-ai/compat";
import { bindSavedTaskRowKey, savedTaskRowKey, savedTaskRows } from "../../../core/tasks/transcript-origin.js";
import {
	type ChatMessageEntry,
	callsAwaitingLaterResults,
	endsAwaitedResults,
	isResultWithoutCall,
	settleUnansweredCalls,
	type ToolChatEntry,
} from "./chat-message-renderer.ts";
import { type ChatSessionHostState, countableTranscriptLength } from "./chat-session-host-state.ts";
import type { ChatSessionHostEntry } from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";

/** Reads the saved entries next to a shown page in reading order, the messages of one saved entry per step. */
export type SavedEntryReader = () => AsyncIterator<readonly AgentMessage[]>;

/** What a shown page can read of the saved entries around it, one entry at a time. */
export interface SavedPageNeighbours {
	/** The entries before the page, newest first, replies reduced to their calls. */
	readonly before?: SavedEntryReader;
	/** The entries after the page, oldest first. Present when a later page follows the page. */
	readonly after?: SavedEntryReader;
}

interface HeldCall {
	readonly call: ToolChatEntry;
	/** The call's saved result, and how a card standing in for its result's card is known. */
	result?: { readonly message: ToolResultMessage; readonly bind: (entry: object) => void };
	/** The card shown at the page's end while the result's own card is not shown. */
	provisional?: ToolChatEntry;
}

interface PageCalls<E> {
	readonly page: Set<E>;
	readonly held: Map<string, HeldCall>;
	readonly neighbours: SavedPageNeighbours;
	/** Each edge of a shown page is read once at most. */
	readAfter: boolean;
	readBefore: boolean;
}

function turnEntry(message: AgentMessage): ChatMessageEntry | undefined {
	if (message.role === "assistant") return { role: "assistant", kind: "assistant", message };
	if (message.role === "user") return { role: "user", kind: "user", text: "" };
	return undefined;
}

/**
 * The tool cards a page of saved history cuts at its edges. A call whose result is saved after the page is never
 * drawn as running: the result's card is the one card and takes the call's arguments, from the page before it or
 * from the one saved reply read for it; while that card is not shown, the page shows the finished card itself. A call
 * that never got a result shows as a whole transcript shows it once the entries after it prove that.
 */
export class SavedPageCalls<TExtraEntry extends ChatTranscriptEntryLike> {
	private readonly state: ChatSessionHostState<TExtraEntry>;
	private pages: PageCalls<ChatSessionHostEntry<TExtraEntry>>[] = [];
	private readonly filled = new WeakSet<object>();

	constructor(state: ChatSessionHostState<TExtraEntry>) {
		this.state = state;
	}

	/** The whole conversation was replaced: no page is shown any more. */
	reset(): void {
		this.pages = [];
	}

	/**
	 * `page` was shown. When a later page follows it (`continues`), the calls it ends with wait for the entries after
	 * it; they are taken out of `page`, which is returned.
	 */
	show(
		page: Set<ChatSessionHostEntry<TExtraEntry>>,
		neighbours: SavedPageNeighbours,
		continues: boolean,
	): Set<ChatSessionHostEntry<TExtraEntry>> {
		const { state } = this;
		const calls = continues ? callsAwaitingLaterResults(state.transcript.filter((entry) => page.has(entry))) : [];
		if (calls.length > 0) {
			for (const call of calls) page.delete(call);
			state.liveChat.dropSavedEntries(new Set(calls));
		}
		this.pages.push({
			page,
			held: new Map(calls.map((call) => [call.toolCallId, { call }])),
			neighbours,
			readAfter: false,
			readBefore: false,
		});
		this.settle();
		return page;
	}

	/** `page` is no longer shown. Pages beside it may show finished cards of their own instead of its result cards. */
	discard(page: Set<ChatSessionHostEntry<TExtraEntry>>): void {
		this.pages = this.pages.filter((record) => record.page !== page);
		this.settle();
	}

	private settle(): void {
		for (const record of this.pages) {
			this.join(record);
			this.place(record);
			this.readAround(record);
		}
	}

	private isMessageEntry(entry: ChatSessionHostEntry<TExtraEntry>): entry is ChatMessageEntry {
		return !this.state.extraEntries.includes(entry as TExtraEntry) && "kind" in entry && entry.kind !== "task";
	}

	private lastIndexOf(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>): number {
		const { transcript } = this.state;
		for (let index = transcript.length - 1; index >= 0; index--)
			if (record.page.has(transcript[index]!)) return index;
		return -1;
	}

	private fillArgs(entry: ToolChatEntry, args: unknown): void {
		if (this.filled.has(entry)) return;
		this.filled.add(entry);
		entry.args = args;
		const key = savedTaskRowKey(entry);
		const kept = key === undefined ? undefined : this.state.savedRenderers?.get(key)?.[0];
		if (kept && "updateArgs" in kept && typeof kept.updateArgs === "function") kept.updateArgs(args);
		this.state.entryRevisions.set(entry, (this.state.entryRevisions.get(entry) ?? 0) + 1);
	}

	/** Calls still waiting for the entries after their page. */
	private awaiting(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>): HeldCall[] {
		return [...record.held.values()].filter((held) => held.result === undefined);
	}

	/** Shows calls that `turn` proved never got results, at the end of their page, as a whole transcript shows them. */
	private reveal(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>, turn: ChatMessageEntry | undefined): void {
		const shown = this.awaiting(record).map((held) => held.call);
		if (shown.length === 0) return;
		if (turn) settleUnansweredCalls(turn, shown);
		for (const call of shown) {
			record.held.delete(call.toolCallId);
			record.page.add(call);
		}
		const end = this.lastIndexOf(record);
		if (end >= 0) this.state.liveChat.restoreSavedEntries(this.state.transcript[end]!, shown);
	}

	/** Joins the page's calls with the entries shown after it. */
	private join(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>): void {
		if (record.held.size === 0) return;
		const { transcript } = this.state;
		const end = this.lastIndexOf(record);
		if (end < 0) return;
		let first = true;
		for (let index = end + 1; index < transcript.length; index++) {
			const entry = transcript[index]!;
			if (!this.isMessageEntry(entry)) continue;
			const after = first;
			first = false;
			if (entry.kind === "tool") {
				const held = isResultWithoutCall(entry) ? record.held.get(entry.toolCallId) : undefined;
				if (held === undefined || entry.result === undefined) continue;
				const key = savedTaskRowKey(entry);
				held.result ??= {
					message: entry.result as ToolResultMessage,
					bind: (card) => {
						if (key !== undefined) bindSavedTaskRowKey(card, key);
					},
				};
				this.fillArgs(entry, held.call.args);
				continue;
			}
			if (this.awaiting(record).length === 0) return;
			if (!endsAwaitedResults(entry, after)) continue;
			this.reveal(record, entry);
			return;
		}
	}

	/** While a call's result card is not shown, the page shows the finished card at its end; never both. */
	private place(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>): void {
		const { state } = this;
		const missing: ToolChatEntry[] = [];
		for (const held of record.held.values()) {
			if (held.result === undefined) continue;
			const resultShown = state.transcript.some(
				(entry) =>
					entry !== held.provisional &&
					this.isMessageEntry(entry) &&
					entry.kind === "tool" &&
					entry.toolCallId === held.call.toolCallId &&
					isResultWithoutCall(entry),
			);
			if (resultShown && held.provisional) {
				record.page.delete(held.provisional);
				state.liveChat.dropSavedEntries(new Set([held.provisional]));
				held.provisional = undefined;
			} else if (!resultShown && !held.provisional) {
				const card: ToolChatEntry = {
					...held.call,
					result: held.result.message,
					isPartial: false,
					argsComplete: true,
				};
				held.result.bind(card);
				held.provisional = card;
				missing.push(card);
			}
		}
		const end = this.lastIndexOf(record);
		if (missing.length === 0 || end < 0) return;
		for (const card of missing) record.page.add(card);
		state.liveChat.restoreSavedEntries(state.transcript[end]!, missing);
	}

	/** Reads, one saved entry at a time, what the page's edge cards need and no page around it shows. */
	private readAround(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>): void {
		const { transcript } = this.state;
		const shown = transcript.filter((entry) => this.isMessageEntry(entry));
		const first = shown.findIndex((entry) => record.page.has(entry));
		let last = -1;
		for (let index = shown.length - 1; index >= 0 && last < 0; index--)
			if (record.page.has(shown[index]!)) last = index;
		if (first < 0) return;
		const after = record.neighbours.after;
		if (after && !record.readAfter && last === shown.length - 1 && this.awaiting(record).length > 0) {
			record.readAfter = true;
			void this.readEntriesAfter(record, after);
		}
		const before = record.neighbours.before;
		if (before && !record.readBefore && first === 0) {
			const needing = new Map<string, ToolChatEntry>();
			for (const entry of record.page)
				if (
					this.isMessageEntry(entry) &&
					entry.kind === "tool" &&
					isResultWithoutCall(entry) &&
					!this.filled.has(entry)
				)
					needing.set(entry.toolCallId, entry);
			if (needing.size > 0) {
				record.readBefore = true;
				void this.readReplyBefore(record, before, needing);
			}
		}
	}

	private async finishRead(record: PageCalls<ChatSessionHostEntry<TExtraEntry>>, apply: () => void): Promise<void> {
		if (!this.pages.includes(record)) return;
		const count = countableTranscriptLength(this.state);
		apply();
		this.settle();
		this.state.newMessages.historyPrepended(countableTranscriptLength(this.state) - count);
		this.state.requestRender?.();
	}

	/** The entries after the page: the held calls' results, or the turn that shows they never came. */
	private async readEntriesAfter(
		record: PageCalls<ChatSessionHostEntry<TExtraEntry>>,
		read: SavedEntryReader,
	): Promise<void> {
		const entries = read();
		let first = true;
		try {
			// No cap: one saved entry per step, until the result or a real turn boundary decides.
			for (;;) {
				const next = await entries.next();
				if (!this.pages.includes(record)) return;
				// Nothing is saved after the page: as at the end of a whole transcript, the calls stay as they were saved.
				if (next.done) return void (await this.finishRead(record, () => this.reveal(record, undefined)));
				const messages = next.value;
				let turn: ChatMessageEntry | undefined;
				for (const message of messages) {
					const after = first;
					first = false;
					if (message.role === "toolResult") {
						const held = record.held.get(message.toolCallId);
						if (held && held.result === undefined)
							held.result = { message, bind: (card) => savedTaskRows(messages)?.(card, message, 0) };
						continue;
					}
					const entry = turnEntry(message);
					if (entry && endsAwaitedResults(entry, after)) {
						turn = entry;
						break;
					}
				}
				if (turn) return void (await this.finishRead(record, () => this.reveal(record, turn)));
				if (this.awaiting(record).length === 0) return void (await this.finishRead(record, () => {}));
			}
		} catch {
			// A failed read leaves the calls held: nothing shown claims they are running.
		} finally {
			void entries.return?.();
		}
	}

	/** The reply before the page whose calls its first result cards answer: only their arguments are kept. */
	private async readReplyBefore(
		record: PageCalls<ChatSessionHostEntry<TExtraEntry>>,
		read: SavedEntryReader,
		needing: ReadonlyMap<string, ToolChatEntry>,
	): Promise<void> {
		const entries = read();
		try {
			for (;;) {
				const next = await entries.next();
				if (!this.pages.includes(record) || next.done) return;
				// Read newest first: a reply is the first prompt or reply before its results.
				const reply = [...next.value]
					.reverse()
					.find((message) => message.role === "assistant" || message.role === "user");
				if (reply === undefined) continue;
				if (reply.role === "assistant")
					await this.finishRead(record, () => {
						for (const block of reply.content) {
							if (block.type !== "toolCall") continue;
							const card = needing.get(block.id);
							if (card) this.fillArgs(card, block.arguments);
						}
					});
				return;
			}
		} catch {
			// A failed read leaves the cards as their results alone show them.
		} finally {
			void entries.return?.();
		}
	}
}
