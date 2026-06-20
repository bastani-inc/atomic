/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const prefix = '<skill name="';
	if (!text.startsWith(prefix)) return null;

	const nameEnd = text.indexOf('" location="', prefix.length);
	if (nameEnd === -1) return null;
	const name = text.slice(prefix.length, nameEnd);
	if (!name) return null;

	const locationStart = nameEnd + '" location="'.length;
	const locationEnd = text.indexOf('">\n', locationStart);
	if (locationEnd === -1) return null;
	const location = text.slice(locationStart, locationEnd);
	if (!location) return null;

	const contentStart = locationEnd + '">\n'.length;
	const closing = "\n</skill>";
	const contentEnd = text.indexOf(closing, contentStart);
	if (contentEnd === -1) return null;

	const afterClosing = text.slice(contentEnd + closing.length);
	if (afterClosing !== "" && !afterClosing.startsWith("\n\n")) return null;

	return {
		name,
		location,
		content: text.slice(contentStart, contentEnd),
		userMessage: afterClosing ? afterClosing.slice(2).trim() || undefined : undefined,
	};
}
