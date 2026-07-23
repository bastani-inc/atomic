import { normalizeMessageContent } from "./messages.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/**
 * Build a safe derived path for replay/analysis without rewriting durable
 * session entries. Only lax message entries whose content is null are cloned.
 */
export function normalizeDerivedSessionEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map((entry) => {
		if (entry.type !== "message") return entry;
		const message = normalizeMessageContent(entry.message);
		return message === entry.message ? entry : { ...entry, message };
	});
}
