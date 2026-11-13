import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";

const AT_MENTION_PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastAtMentionDelimiter(text: string): number {
	for (let index = text.length - 1; index >= 0; index -= 1) {
		if (AT_MENTION_PATH_DELIMITERS.has(text[index] ?? "")) return index;
	}
	return -1;
}

function isAtMentionTokenStart(text: string, index: number): boolean {
	return index === 0 || AT_MENTION_PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedAtMentionQuoteStart(text: string): number | null {
	let quoteStart = -1;
	let inQuotes = false;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = index;
		}
	}
	return inQuotes ? quoteStart : null;
}

function extractAtMentionPrefix(textBeforeCursor: string): string | null {
	const quoteStart = findUnclosedAtMentionQuoteStart(textBeforeCursor);
	if (quoteStart !== null && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
		return isAtMentionTokenStart(textBeforeCursor, quoteStart - 1) ? textBeforeCursor.slice(quoteStart - 1) : null;
	}
	const lastDelimiterIndex = findLastAtMentionDelimiter(textBeforeCursor);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	return textBeforeCursor[tokenStart] === "@" ? textBeforeCursor.slice(tokenStart) : null;
}

function atMentionPrefixToPathPrefix(atPrefix: string): string {
	return atPrefix.startsWith('@"') ? `"${atPrefix.slice(2)}` : atPrefix.slice(1);
}

function toAtMentionCompletion(item: AutocompleteItem): AutocompleteItem {
	return {
		...item,
		value: item.value.startsWith("@") ? item.value : `@${item.value}`,
	};
}

class AtMentionFallbackAutocompleteProvider implements AutocompleteProvider {
	private readonly primary: AutocompleteProvider;
	private readonly pathFallback: AutocompleteProvider;

	constructor(primary: AutocompleteProvider, pathFallback: AutocompleteProvider) {
		this.primary = primary;
		this.pathFallback = pathFallback;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const primarySuggestions = await this.primary.getSuggestions(lines, cursorLine, cursorCol, options);
		if (primarySuggestions || options.signal.aborted) return primarySuggestions;

		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const atPrefix = extractAtMentionPrefix(textBeforeCursor);
		if (!atPrefix) return null;

		const pathPrefix = atMentionPrefixToPathPrefix(atPrefix);
		const prefixStart = cursorCol - atPrefix.length;
		const fallbackLines = [...lines];
		fallbackLines[cursorLine] = `${currentLine.slice(0, prefixStart)}${pathPrefix}${currentLine.slice(cursorCol)}`;
		const fallbackSuggestions = await this.pathFallback.getSuggestions(
			fallbackLines,
			cursorLine,
			prefixStart + pathPrefix.length,
			{ ...options, force: true },
		);
		if (!fallbackSuggestions) return null;

		return {
			prefix: atPrefix,
			items: fallbackSuggestions.items.map(toAtMentionCompletion),
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		return this.primary.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.primary.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}

/**
 * The composer completion every chat shares: `commands` after `/`, `@` file mentions and Tab paths under `cwd`.
 * Without `fdPath`, an `@` mention completes the paths under `cwd` the way Tab does instead of searching for them.
 */
export function createChatAutocompleteProvider(
	commands: readonly SlashCommand[],
	cwd: string,
	fdPath: string | null | undefined,
): AutocompleteProvider {
	return new AtMentionFallbackAutocompleteProvider(
		new CombinedAutocompleteProvider([...commands], cwd, fdPath ?? null),
		new CombinedAutocompleteProvider([...commands], cwd, null),
	);
}
