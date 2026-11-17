import { FramedSelector, type SelectorItem } from "./selector.ts";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

export class UserMessageSelectorComponent extends FramedSelector<string> {
	onSelect: (entryId: string) => void;
	onCancel: () => void;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
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

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => this.onCancel(), 100);
		}
	}

	getMessageList(): this {
		return this;
	}
}
