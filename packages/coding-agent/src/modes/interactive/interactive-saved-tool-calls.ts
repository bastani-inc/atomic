import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ToolResultMessage } from "@bastani/atomic-ai/compat";
import { type Component, Container } from "@bastani/atomic-tui";
import { chunkedToolResult, chunkedToolResultEntry } from "../../core/storage/session/chunked-tool-result.js";
import type {
	OversizedSessionEntry,
	SessionHistoryPage,
	SessionHistoryReadOptions,
} from "../../core/storage/session/types.js";
import {
	type ChatMessageEntry,
	endsAwaitedResults,
	renderChatMessageEntry,
	settleUnansweredCalls,
	type ToolChatEntry,
} from "./components/chat-message-renderer.ts";
import { disposeRenderer } from "./components/renderer-disposal.js";
import type { SavedRendererInstances } from "./components/saved-renderer-instances.js";
import { isClickExpandableBlock, observeClickExpansion } from "./components/transcript-block-clicks.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** A tool card whose call's arguments can arrive after it is drawn. */
type ArgumentsCard = Component & { updateArgs(args: unknown): void };

function isArgumentsCard(component: Component): component is ArgumentsCard {
	return typeof (component as Partial<ArgumentsCard>).updateArgs === "function";
}

/** The chat the saved pages are drawn in: it says whether a row is laid out in it now. */
type SavedChat = Container & { windowRowSpan?(component: Component): unknown };
type EdgeRead = string | SessionHistoryReadOptions;

/** The saved session the pages are read from. */
interface SavedHistory {
	readHistory(options: SessionHistoryReadOptions): AsyncGenerator<SessionHistoryPage, void>;
	readHistoryChunks(
		reference: OversizedSessionEntry,
		options?: { readonly signal?: AbortSignal },
	): AsyncGenerator<Uint8Array, void>;
}

/** Where to read the original bytes of a saved row too large to show. */
function oversizedNote(item: OversizedSessionEntry): string {
	return `Saved entry ${item.seq} is ${item.bytes} bytes. Read the original bytes with the session history reader or export this session.`;
}

/**
 * The tool result a saved row too large to show holds, read field by field from its stored text without decoding its
 * body, as the entry its card draws; undefined for any other row or when its bytes cannot be read.
 */
async function oversizedToolResult(
	history: SavedHistory,
	item: OversizedSessionEntry,
	signal?: AbortSignal,
): Promise<SessionHistoryPage["items"][number] | undefined> {
	try {
		const result = await chunkedToolResult(history.readHistoryChunks(item, signal ? { signal } : {}));
		return (
			result && {
				seq: item.seq,
				entry: chunkedToolResultEntry(result, `oversized-${item.seq}`, oversizedNote(item)),
			}
		);
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

/**
 * `page` with each tool result too large to show read as its card needs it, so its call shows finished or failed as a
 * whole read shows it; other oversized rows stay as they were read.
 */
export async function withOversizedToolResults(
	history: SavedHistory,
	page: SessionHistoryPage,
	signal?: AbortSignal,
): Promise<SessionHistoryPage> {
	if (page.items.every((item) => "entry" in item)) return page;
	const items: SessionHistoryPage["items"][number][] = [];
	for (const item of page.items)
		items.push(("entry" in item ? undefined : await oversizedToolResult(history, item, signal)) ?? item);
	return { ...page, items };
}

/** The saved result of a held call, the row it is saved as, and its card on the page after, when one was drawn. */
interface HeldAnswer {
	readonly message: ToolResultMessage;
	readonly key: string;
	card?: Component;
}

/**
 * Where a call a page ends with is drawn by that page: nothing while the page after it shows the call's result card;
 * the finished card while that page is not shown; or, when the entries after it prove no result was saved, the call
 * as a whole transcript draws it.
 */
class HeldCallSlot extends Container {
	answer?: HeldAnswer;
	private revealed = false;
	private readonly chat: SavedChat;
	private readonly draw: (entry: ToolChatEntry, key: string, own: boolean) => Component[];
	private readonly scope: SavedRendererInstances;
	/** Drawn for a copy: it keeps no instance and releases only what no saved page keeps. */
	private readonly transient: boolean;
	readonly entry: ToolChatEntry;
	readonly key: string | undefined;

	constructor(
		entry: ToolChatEntry,
		key: string | undefined,
		chat: SavedChat,
		scope: SavedRendererInstances,
		draw: (entry: ToolChatEntry, key: string, own: boolean) => Component[],
		transient = false,
	) {
		super();
		this.entry = entry;
		this.key = key;
		this.chat = chat;
		this.scope = scope;
		this.draw = draw;
		this.transient = transient;
	}

	get waiting(): boolean {
		return !this.revealed && this.answer === undefined;
	}

	/** No result was saved for the call: it shows as `turn`, the turn after it, leaves it. */
	reveal(turn: ChatMessageEntry | undefined): void {
		if (!this.waiting) return;
		this.revealed = true;
		if (turn) settleUnansweredCalls(turn, [this.entry]);
		this.children.push(...this.draw(this.entry, this.key ?? "", true));
	}

	override render(width: number): string[] {
		const answer = this.answer;
		if (answer !== undefined && !this.revealed) {
			const resultShown = answer.card !== undefined && this.chat.windowRowSpan?.(answer.card) !== undefined;
			if (resultShown) {
				this.release();
				return [];
			}
			if (this.children.length === 0)
				this.children.push(
					...this.draw(
						{ ...this.entry, result: answer.message, isPartial: false, argsComplete: true },
						answer.key,
						false,
					),
				);
		}
		return super.render(width);
	}

	private release(): void {
		for (const child of this.children.splice(0))
			if (this.transient ? !this.scope.keeps(child) : !this.scope.protect(child)) disposeRenderer(child);
	}

	dispose(): void {
		this.release();
	}
}

/** What a drawn saved page shares with the pages drawn beside it. */
interface SavedPageCalls {
	readonly first: number;
	readonly last: number;
	readonly scope: SavedRendererInstances;
	/** Calls the page ends with whose results may start the page after it. */
	readonly held: Map<string, HeldCallSlot>;
	/** Results drawn alone, whose calls may end the page before it: their entries, cards and saved rows. */
	readonly results: Map<
		string,
		{
			readonly entry: ToolChatEntry;
			readonly card: ArgumentsCard | undefined;
			readonly key: string;
			filled: boolean;
			readonly matched?: () => void;
		}
	>;
	/** The page's first prompt or reply: a later result answers no call made before the page. */
	turn?: ChatMessageEntry;
}

/** A drawn page's calls, kept on an empty row at its start: they are released with the page's rows. */
const pageCalls = new WeakMap<Component, SavedPageCalls>();

/**
 * Expansions a click chose for saved rows, by their row in the saved session, kept while their page is released and
 * drawn again. Ctrl+O and another session forget them; only rows a click changed from the chat's setting are kept.
 */
const chosenExpansions = new WeakMap<
	InteractiveModeBase,
	{ readonly scope: SavedRendererInstances; readonly chosen: Map<string, boolean> }
>();

function chosenFor(mode: InteractiveModeBase, scope: SavedRendererInstances): Map<string, boolean> {
	let choices = chosenExpansions.get(mode);
	if (choices?.scope !== scope) {
		choices = { scope, chosen: new Map() };
		chosenExpansions.set(mode, choices);
	}
	return choices.chosen;
}

/** Ctrl+O sets every block: the expansions clicks chose for saved rows no longer apply. */
export function forgetChosenSavedExpansions(mode: InteractiveModeBase): void {
	chosenExpansions.delete(mode);
}

/** Draws `components`, the row `key` of a saved page, as a click last chose, and keeps each later click's choice. */
export function followChosenExpansion(
	mode: InteractiveModeBase,
	scope: SavedRendererInstances,
	key: string,
	components: readonly Component[],
): void {
	const chosen = chosenFor(mode, scope);
	const expanded = chosen.get(key);
	for (const component of components) {
		if (!isClickExpandableBlock(component)) continue;
		if (expanded !== undefined) component.setExpanded(expanded);
		observeClickExpansion(component, (choice) => {
			// A row of a session the chat no longer shows keeps no choice for the one it shows now.
			const shown = chosenExpansions.get(mode);
			if (shown !== undefined && shown.scope !== scope) return;
			const current = chosenFor(mode, scope);
			if (choice === mode.toolOutputExpanded) current.delete(key);
			else current.set(key, choice);
		});
	}
}

/** A saved prompt or reply, as the entry that decides whether the calls before it were answered. */
function turnEntry(message: AgentMessage): ChatMessageEntry | undefined {
	if (message.role === "assistant") return { role: "assistant", kind: "assistant", message };
	if (message.role === "user") return { role: "user", kind: "user", text: "" };
	return undefined;
}

/** A saved page under construction: what it holds back and draws from results alone. */
export class SavedPageCallsBuilder {
	private readonly calls: SavedPageCalls;
	private readonly mode: InteractiveModeBase;
	private readonly chat: SavedChat;
	/** The page is drawn for a copy: it keeps no renderer instance and joins no mounted page. */
	private readonly transient: boolean;
	constructor(
		mode: InteractiveModeBase,
		chat: Container,
		seqs: readonly number[],
		scope: SavedRendererInstances,
		transient = false,
	) {
		this.mode = mode;
		this.chat = chat;
		this.transient = transient;
		this.calls = {
			first: seqs[0] ?? 0,
			last: seqs.at(-1) ?? 0,
			scope,
			held: new Map(),
			results: new Map(),
		};
	}

	/** Holds `entry` back: its slot draws nothing until the entries after the page show what became of it. */
	hold(entry: ToolChatEntry, key: string | undefined): Component {
		const { mode } = this;
		const transient = this.transient;
		const scope = this.calls.scope;
		const slot = new HeldCallSlot(
			entry,
			key,
			this.chat,
			scope,
			(card, row, own) => {
				const kept = row ? (transient ? scope.peek(row) : scope.get(row)) : undefined;
				const components = kept ?? [renderChatMessageEntry(card, mode.chatMessageRenderOptions())];
				// The finished card stands in for the result's own card, which keeps any renderer state; the call's own
				// card is this page's row.
				if (!kept && own && row && !transient) {
					const [seq, block] = row.split(":");
					scope.remember(row, components, { seq: Number(seq), block: Number(block) });
				}
				if (row) followChosenExpansion(mode, scope, row, components);
				return [...components];
			},
			transient,
		);
		this.calls.held.set(entry.toolCallId, slot);
		return slot;
	}

	/** `components` draw a result whose call is not on this page; `key` is its saved row. */
	drewResult(entry: ToolChatEntry, components: readonly Component[], key: string, matched?: () => void): void {
		if (this.transient && this.calls.turn) return;
		this.calls.results.set(entry.toolCallId, {
			entry,
			card: components.find(isArgumentsCard),
			key,
			filled: false,
			matched,
		});
	}

	/** `entry` was drawn: the next prompt or reply ends what can answer a call of the page before. */
	drew(entry: ChatMessageEntry): void {
		// A page never ends inside a saved entry here, so the entry after it is never the rest of a cut reply.
		if (this.calls.turn === undefined && endsAwaitedResults(entry, false)) this.calls.turn = entry;
	}

	/**
	 * Joins the page's calls with the pages drawn beside it in the chat, and reads, one saved entry at a time, what its
	 * edge cards need from pages that are not drawn: a result's card shows its call's arguments, and a held call shows
	 * as its saved result or, when none was saved, as a whole transcript shows it. Returns the row that keeps the
	 * page's calls, to draw first.
	 */
	finish(
		manager: SavedHistory,
		adjacent: { readonly older?: string; readonly newer?: string } | undefined,
	): Component {
		const page = this.calls;
		const head = new Container();
		pageCalls.set(head, page);
		let before: SavedPageCalls | undefined;
		let after: SavedPageCalls | undefined;
		for (const child of this.chat.children) {
			const other = pageCalls.get(child);
			if (other === undefined || other === page || other.scope !== page.scope) continue;
			if (other.last < page.first && (before === undefined || other.last > before.last)) before = other;
			if (other.first > page.last && (after === undefined || other.first < after.first)) after = other;
		}
		if (before) joinPages(before, page);
		if (after) joinPages(page, after);
		const alive = () => this.mode.sessionManager === manager && this.chat.children.includes(head);
		if (!after && adjacent?.newer && [...page.held.values()].some((slot) => slot.waiting))
			void readAfter(this.mode, manager, page, adjacent.newer, alive);
		const needing = [...page.results.values()].filter((result) => !result.filled);
		if (!before && adjacent?.older && needing.length > 0)
			void readBefore(this.mode, manager, needing, adjacent.older, alive);
		return head;
	}

	/**
	 * For a copy: reads what the edge cards of a page drawn alone need, as `finish` does when no neighbouring page is
	 * drawn, and joins no mounted page. Rejects when a read fails or `alive` turns false first, so a copy never shows a
	 * held call as still running.
	 */
	async settle(
		manager: SavedHistory,
		adjacent: { readonly older?: EdgeRead; readonly newer?: EdgeRead } | undefined,
		alive: () => boolean,
	): Promise<void> {
		const page = this.calls;
		if (adjacent?.newer && [...page.held.values()].some((slot) => slot.waiting))
			await readAfter(this.mode, manager, page, adjacent.newer, alive, true);
		const needing = [...page.results.values()].filter((result) => !result.filled);
		if (adjacent?.older && needing.length > 0)
			await readBefore(this.mode, manager, needing, adjacent.older, alive, true);
	}
}

function joinPages(older: SavedPageCalls, newer: SavedPageCalls): void {
	for (const [id, slot] of older.held) {
		const result = newer.results.get(id);
		if (result) {
			if (!result.filled) {
				result.filled = true;
				result.card?.updateArgs(slot.entry.args);
			}
			if (result.entry.result !== undefined)
				slot.answer = { message: result.entry.result as ToolResultMessage, key: result.key, card: result.card };
			continue;
		}
		if (newer.turn !== undefined) slot.reveal(newer.turn);
	}
}

/** The one saved entry a single-entry read from `cursor` returns, with the cursors next to it. */
async function readOneEntry(manager: SavedHistory, edge: EdgeRead, signal?: AbortSignal) {
	const reader = manager.readHistory({
		...(typeof edge === "string" ? { cursor: edge } : edge),
		adjacent: true,
		limit: 1,
		signal,
	});
	let page: SessionHistoryPage;
	try {
		const next = await reader.next();
		if (next.done) return undefined;
		page = next.value;
	} finally {
		await reader.return();
	}
	const [item] = (await withOversizedToolResults(manager, page, signal)).items;
	return { entry: item && "entry" in item ? item.entry : undefined, seq: item?.seq, adjacent: page.adjacent };
}

/** Reads the entries after a page one at a time until its held calls' results, or the turn that ends them, show. */
async function readAfter(
	mode: InteractiveModeBase,
	manager: SavedHistory,
	page: SavedPageCalls,
	cursor: EdgeRead,
	alive: () => boolean,
	strict = false,
): Promise<void> {
	const waiting = () => [...page.held.values()].filter((slot) => slot.waiting);
	const signal = typeof cursor === "string" ? undefined : cursor.signal;
	let next: EdgeRead | undefined = cursor;
	try {
		// No cap: entries are read one at a time, bounded each, until the result or a real turn boundary decides.
		while (next !== undefined && waiting().length > 0) {
			const read = await readOneEntry(manager, next, signal);
			if (!alive()) {
				if (strict) throw new Error("The saved history closed while it was read");
				return;
			}
			next = read?.adjacent?.newer;
			const entry = read?.entry;
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message.role === "toolResult") {
				const slot = page.held.get(message.toolCallId);
				if (slot?.waiting) slot.answer = { message, key: `${read!.seq}:0` };
				continue;
			}
			const turn = turnEntry(message);
			if (turn && endsAwaitedResults(turn, false)) for (const slot of waiting()) slot.reveal(turn);
		}
		// Nothing more is saved: as at the end of a whole transcript, the calls show as they were saved.
		if (next === undefined && alive()) for (const slot of waiting()) slot.reveal(undefined);
	} catch (error) {
		// A failed read leaves the calls held: nothing shown claims they are running. A copy fails instead.
		if (strict) throw error;
	}
	mode.ui.requestRender();
}

/** Reads the entries before a page one at a time back to the reply whose calls its first result cards answer. */
async function readBefore(
	mode: InteractiveModeBase,
	manager: SavedHistory,
	needing: readonly {
		readonly entry: ToolChatEntry;
		readonly card: ArgumentsCard | undefined;
		filled: boolean;
		readonly matched?: () => void;
	}[],
	cursor: EdgeRead,
	alive: () => boolean,
	strict = false,
): Promise<void> {
	const signal = typeof cursor === "string" ? undefined : cursor.signal;
	let next: EdgeRead | undefined = cursor;
	try {
		while (next !== undefined) {
			const read = await readOneEntry(manager, next, signal);
			if (!alive()) {
				if (strict) throw new Error("The saved history closed while it was read");
				return;
			}
			next = read?.adjacent?.older;
			const entry = read?.entry;
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") return;
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result = needing.find((candidate) => candidate.entry.toolCallId === block.id);
				if (result === undefined || result.filled) continue;
				result.filled = true;
				if (result.matched) result.matched();
				else result.card?.updateArgs(block.arguments);
			}
			mode.ui.requestRender();
			return;
		}
	} catch (error) {
		// A failed read leaves the cards as their results alone show them. A copy fails instead.
		if (strict) throw error;
	}
}
