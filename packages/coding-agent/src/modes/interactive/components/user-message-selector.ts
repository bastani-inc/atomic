import { fuzzyMatch } from "@bastani/atomic-tui";
import { FramedSelector, type SelectorItem } from "./selector.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
	/** `text` is only the start of the message; a search reads the whole message with `readText`. */
	partial?: boolean;
}

export interface UserMessageSelectorOptions {
	/** Reads the whole text of a message listed as `partial`, for one search. */
	readonly readText?: (id: string, signal: AbortSignal) => Promise<string>;
	/** A search that read partial messages changed the rows. */
	readonly onUpdate?: () => void;
	readonly onError?: (error: Error) => void;
}

/** The tokens the picker's search matches, as `fuzzyFilter` splits them. */
function searchTokens(query: string): string[] {
	return query
		.trim()
		.split(/[\s/]+/)
		.filter((token) => token.length > 0);
}

export class UserMessageSelectorComponent extends FramedSelector<string> {
	onSelect: (entryId: string) => void;
	onCancel: () => void;
	private readonly rows: readonly SelectorItem<string>[];
	private readonly partial: ReadonlySet<string>;
	private readonly options: UserMessageSelectorOptions;
	private searching?: AbortController;
	/** The rows are the result of a search that read partial messages, not the whole list. */
	private narrowed = false;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
		options: UserMessageSelectorOptions = {},
	) {
		const items: SelectorItem<string>[] = messages.map((message, index) => {
			const label = message.text.replace(/\s+/g, " ").trim();
			return {
				id: message.id,
				value: message.id,
				label,
				description: `message ${index + 1} of ${messages.length}`,
				searchText: label,
				searchTextMode: "replace",
			};
		});
		const fallback = messages.at(-1)?.id;
		super({
			title: "Fork from message",
			subtitle: "Copies the conversation up to the chosen message into a new session.",
			search: true,
			layout: "two-line",
			items,
			emptyText: "No user messages to fork from",
			confirmLabel: "fork",
			maxVisible: 6,
			...(initialSelectedId !== undefined && messages.some((message) => message.id === initialSelectedId)
				? { initialId: initialSelectedId }
				: fallback !== undefined
					? { initialId: fallback }
					: {}),
			onSelect: (item) => this.onSelect(item.value),
			onCancel: () => this.onCancel(),
		});
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.rows = items;
		this.partial = new Set(messages.filter((message) => message.partial).map((message) => message.id));
		this.options = options;

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => this.onCancel(), 100);
		}
	}

	getMessageList(): this {
		return this;
	}

	override handleInput(data: string): void {
		const before = this.selector.state.getQuery();
		super.handleInput(data);
		const query = this.selector.state.getQuery();
		if (query !== before) this.searchPartialMessages(query);
	}

	/** Stops a search still reading partial messages. */
	dispose(): void {
		this.searching?.abort();
		this.searching = undefined;
	}

	/**
	 * The search box matches each row's label at once. A partial row holds only the start of its label, so a search
	 * then reads each partial message once more and ranks every row as it would with all the text held. Until then
	 * the rows matched by what is held are shown; they are always among the final matches.
	 */
	private searchPartialMessages(query: string): void {
		this.dispose();
		const state = this.selector.state;
		if (this.narrowed) {
			// List every row again under the new query, selected as if the list had never narrowed.
			this.narrowed = false;
			this.selector.setItems(this.rows);
			const index = query ? 0 : state.getSelectedIndex();
			state.select(0);
			state.select(index);
		}
		const tokens = searchTokens(query);
		const readText = this.options.readText;
		if (tokens.length === 0 || this.partial.size === 0 || !readText) return;
		const controller = new AbortController();
		this.searching = controller;
		const shown = this.selector.getSelected()?.id;
		void this.rank(tokens, readText, controller.signal).then(
			(ranked) => {
				if (this.searching !== controller) return;
				this.searching = undefined;
				const moved = this.selector.getSelected()?.id !== shown;
				this.narrowed = true;
				this.selector.setItems(ranked.map((item) => ({ ...item, searchText: query })));
				if (!moved) state.select(0);
				this.options.onUpdate?.();
			},
			(error: unknown) => {
				if (this.searching !== controller) return;
				this.searching = undefined;
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
			},
		);
	}

	/** The rows `fuzzyFilter` would return if every row held its whole label; one partial message is read at a time. */
	private async rank(
		tokens: readonly string[],
		readText: (id: string, signal: AbortSignal) => Promise<string>,
		signal: AbortSignal,
	): Promise<SelectorItem<string>[]> {
		const results: { item: SelectorItem<string>; totalScore: number }[] = [];
		for (const item of this.rows) {
			const text = this.partial.has(item.id)
				? (await readText(item.id, signal)).replace(/\s+/g, " ").trim()
				: (item.searchText ?? "");
			signal.throwIfAborted();
			let totalScore = 0;
			let allMatch = true;
			for (const token of tokens) {
				const match = fuzzyMatch(token, text);
				if (!match.matches) {
					allMatch = false;
					break;
				}
				totalScore += match.score;
			}
			if (allMatch) results.push({ item, totalScore });
		}
		results.sort((a, b) => a.totalScore - b.totalScore);
		return results.map((result) => result.item);
	}
}
