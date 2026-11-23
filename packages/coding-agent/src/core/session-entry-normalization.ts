import { normalizeMessageContent } from "./messages.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/**
 * Build a safe derived path for replay/analysis without rewriting durable
 * session entries. Only lax message entries whose content is null are cloned.
 */
export function normalizeDerivedSessionEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	let normalized: SessionEntry[] | undefined;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message") {
			if (normalized) normalized.push(entry);
			continue;
		}
		const message = normalizeMessageContent(entry.message);
		if (message !== entry.message) {
			if (!normalized) normalized = entries.slice(0, i);
			normalized.push({ ...entry, message });
		} else if (normalized) {
			normalized.push(entry);
		}
	}
	return normalized ?? entries.slice();
}
