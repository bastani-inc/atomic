import { type Component, Container } from "@bastani/atomic-tui";
import {
	type ChatMessageEntry,
	endsAwaitedResults,
	renderChatMessageEntry,
	settleUnansweredCalls,
	type ToolChatEntry,
} from "./components/chat-message-renderer.ts";
import type { SavedRendererInstances } from "./components/saved-renderer-instances.js";
import { isClickExpandableBlock, observeClickExpansion } from "./components/transcript-block-clicks.ts";
import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** A tool card whose call's arguments can arrive after it is drawn. */
type ArgumentsCard = Component & { updateArgs(args: unknown): void };

function isArgumentsCard(component: Component): component is ArgumentsCard {
	return typeof (component as Partial<ArgumentsCard>).updateArgs === "function";
}

/** A saved call held back from its page, keyed by its row in the saved session. */
interface HeldCall {
	readonly entry: ToolChatEntry;
	/** Where the call shows if the next page proves its result was never saved. Draws nothing until then. */
	readonly slot: Container;
	readonly key: string | undefined;
}

/** What a drawn saved page shares with the pages drawn beside it. */
interface SavedPageCalls {
	readonly first: number;
	readonly last: number;
	readonly scope: SavedRendererInstances;
	/** Calls the page ends with whose results may start the page after it. */
	readonly held: Map<string, HeldCall>;
	/** Results drawn alone, whose calls may end the page before it: their cards, and whether they have the arguments. */
	readonly results: Map<string, { readonly card: ArgumentsCard | undefined; filled: boolean }>;
	/** The page's first prompt or reply that shows results of the page before it ended: a later result answers none. */
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

/** A saved page under construction: what it holds back and draws from results alone. */
export class SavedPageCallsBuilder {
	private readonly calls: SavedPageCalls;
	private drewAny = false;
	constructor(seqs: readonly number[], scope: SavedRendererInstances) {
		this.calls = {
			first: seqs[0] ?? 0,
			last: seqs.at(-1) ?? 0,
			scope,
			held: new Map(),
			results: new Map(),
		};
	}

	/** Holds `entry` back: the slot draws nothing until the next page shows it was never answered. */
	hold(entry: ToolChatEntry, key: string | undefined): Component {
		const slot = new Container();
		this.calls.held.set(entry.toolCallId, { entry, slot, key });
		return slot;
	}

	/** `components` draw a result whose call is not on this page. */
	drewResult(entry: ToolChatEntry, components: readonly Component[]): void {
		this.calls.results.set(entry.toolCallId, { card: components.find(isArgumentsCard), filled: false });
	}

	/** `entry` was drawn: the next prompt or reply ends what can answer a call of the page before. */
	drew(entry: ChatMessageEntry): void {
		const first = !this.drewAny;
		this.drewAny = true;
		if (this.calls.turn === undefined && endsAwaitedResults(entry, first)) this.calls.turn = entry;
	}

	/**
	 * Joins the page's calls with the pages drawn beside it in `chat`: a result's card takes the arguments of its
	 * call; a held call whose next page starts another turn without its result shows as a whole transcript shows it.
	 * Returns the row that keeps the page's calls, to draw first.
	 */
	finish(mode: InteractiveModeBase, chat: Container): Component {
		const page = this.calls;
		const head = new Container();
		pageCalls.set(head, page);
		let before: SavedPageCalls | undefined;
		let after: SavedPageCalls | undefined;
		for (const child of chat.children) {
			const other = pageCalls.get(child);
			if (other === undefined || other === page || other.scope !== page.scope) continue;
			if (other.last < page.first && (before === undefined || other.last > before.last)) before = other;
			if (other.first > page.last && (after === undefined || other.first < after.first)) after = other;
		}
		if (before) joinPages(mode, before, page);
		if (after) joinPages(mode, page, after);
		return head;
	}
}

function joinPages(mode: InteractiveModeBase, older: SavedPageCalls, newer: SavedPageCalls): void {
	for (const [id, held] of older.held) {
		const result = newer.results.get(id);
		if (result) {
			if (!result.filled) {
				result.filled = true;
				result.card?.updateArgs(held.entry.args);
			}
			continue;
		}
		if (newer.turn === undefined) continue;
		older.held.delete(id);
		settleUnansweredCalls(newer.turn, [held.entry]);
		const kept = held.key === undefined ? undefined : older.scope.get(held.key);
		const components = kept ?? [renderChatMessageEntry(held.entry, mode.chatMessageRenderOptions())];
		if (!kept && held.key !== undefined) {
			const [seq, block] = held.key.split(":");
			older.scope.remember(held.key, components, { seq: Number(seq), block: Number(block) });
		}
		if (held.key !== undefined) followChosenExpansion(mode, older.scope, held.key, components);
		for (const component of components) held.slot.addChild(component);
		mode.ui.requestRender();
	}
}
