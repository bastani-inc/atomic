/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	candidateId?: string;
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
	const locationEnd = text.indexOf('"', locationStart);
	if (locationEnd === -1) return null;
	const location = text.slice(locationStart, locationEnd);
	if (!location) return null;

	let tagEnd = locationEnd + 1;
	let candidateId: string | undefined;
	const candidatePrefix = ' candidate="';
	if (text.startsWith(candidatePrefix, tagEnd)) {
		const candidateStart = tagEnd + candidatePrefix.length;
		const candidateEnd = text.indexOf('"', candidateStart);
		if (candidateEnd === -1) return null;
		candidateId = text.slice(candidateStart, candidateEnd);
		if (!candidateId) return null;
		tagEnd = candidateEnd + 1;
	}
	if (!text.startsWith(">\n", tagEnd)) return null;

	const contentStart = tagEnd + ">\n".length;
	const closing = "\n</skill>";
	const contentEnd = text.indexOf(closing, contentStart);
	if (contentEnd === -1) return null;

	const afterClosing = text.slice(contentEnd + closing.length);
	if (afterClosing !== "" && !afterClosing.startsWith("\n\n")) return null;

	return {
		name,
		location,
		...(candidateId ? { candidateId } : {}),
		content: text.slice(contentStart, contentEnd),
		userMessage: afterClosing ? afterClosing.slice(2).trim() || undefined : undefined,
	};
}
