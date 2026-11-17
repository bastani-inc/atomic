import { FramedSelector, type SelectorItem } from "./selector.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * The fork picker: the session's user messages as two-line rows (the message, then its place in the history), newest
 * selected, with type-to-search. Enter forks from the chosen message.
 */
export class UserMessageSelectorComponent extends FramedSelector<string> {
	readonly onSelect: (entryId: string) => void;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		const items: SelectorItem<string>[] = messages.map((message, index) => ({
			id: message.id,
			value: message.id,
			label: message.text.replace(/\s+/g, " ").trim(),
			description: `message ${index + 1} of ${messages.length}`,
		}));
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
			onSelect: (item) => onSelect(item.value),
			onCancel,
		});
		this.onSelect = onSelect;

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): this {
		return this;
	}
}
