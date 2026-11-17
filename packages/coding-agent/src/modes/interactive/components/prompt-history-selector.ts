import { FramedSelector, type SelectorItem } from "./selector.ts";

export interface PromptHistoryEntry {
	readonly text: string;
	readonly sentAt?: number;
}

export interface SessionPrompt {
	readonly text: string;
	readonly expandedText?: string;
	readonly sentAt?: number;
}

const promptKey = (text: string): string => text.trim();

interface PromptEntryLike {
	readonly type: string;
	readonly timestamp?: string;
	readonly message?: { readonly role?: string; readonly content?: unknown; readonly rawText?: unknown };
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: unknown; text?: unknown }) =>
			part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

export function sessionPromptsFromEntries(entries: readonly PromptEntryLike[]): SessionPrompt[] {
	const prompts: SessionPrompt[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const rawText = typeof entry.message.rawText === "string" ? entry.message.rawText : undefined;
		const expandedText = promptText(entry.message.content);
		const text = rawText?.trim() ? rawText : expandedText;
		if (!text.trim()) continue;
		const sentAt = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp);
		prompts.push({
			text,
			...(text !== expandedText && expandedText.trim() ? { expandedText } : {}),
			...(Number.isFinite(sentAt) ? { sentAt } : {}),
		});
	}
	return prompts;
}

export function promptHistoryEntries(
	history: readonly string[],
	sessionPrompts: readonly SessionPrompt[],
): PromptHistoryEntry[] {
	const sentAt = new Map<string, number>();
	const typedKeys = new Set(sessionPrompts.map((prompt) => promptKey(prompt.text)));
	const expandedKeys = new Map<string, string>();
	for (const prompt of sessionPrompts) {
		const key = promptKey(prompt.text);
		if (key && prompt.expandedText) expandedKeys.set(promptKey(prompt.expandedText), key);
		if (!key || prompt.sentAt === undefined) continue;
		sentAt.set(key, Math.max(sentAt.get(key) ?? 0, prompt.sentAt));
	}
	const seen = new Set<string>();
	const entries: PromptHistoryEntry[] = [];
	const add = (text: string, time: number | undefined) => {
		const key = promptKey(text);
		if (!key || seen.has(key)) return;
		seen.add(key);
		entries.push(time === undefined ? { text: key } : { text: key, sentAt: time });
	};
	for (const text of history) {
		const key = promptKey(text);
		const typed = typedKeys.has(key) ? key : (expandedKeys.get(key) ?? key);
		add(typed, sentAt.get(typed));
	}
	const older = [...sessionPrompts]
		.map((prompt, order) => ({ prompt, order }))
		.sort((a, b) => (b.prompt.sentAt ?? 0) - (a.prompt.sentAt ?? 0) || b.order - a.order);
	for (const { prompt } of older) add(prompt.text, sentAt.get(promptKey(prompt.text)));
	return entries;
}

export interface PromptHistorySelectorOptions {
	readonly onSelect: (text: string) => void;
	readonly onCancel: () => void;
	readonly now?: () => number;
}

export class PromptHistorySelectorComponent extends FramedSelector<string> {
	constructor(entries: readonly PromptHistoryEntry[], options: PromptHistorySelectorOptions) {
		const now = options.now ?? Date.now;
		const items: SelectorItem<string>[] = entries.map((entry, index) => ({
			id: String(index),
			value: entry.text,
			label: entry.text.replace(/\s+/g, " "),
			...(entry.sentAt === undefined ? {} : { tag: promptAge(now() - entry.sentAt), tagTone: "muted" as const }),
			searchText: entry.text,
			searchTextMode: "replace" as const,
		}));
		super({
			title: "Search prompts",
			search: true,
			searchPlaceholder: "Filter prompts…",
			items,
			maxVisible: 8,
			emptyText: "No prompts yet",
			confirmLabel: "use",
			rightConfirms: false,
			onSelect: (item) => options.onSelect(item.value),
			onCancel: options.onCancel,
		});
	}
}

export function promptAge(elapsedMs: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}
