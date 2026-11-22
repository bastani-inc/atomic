import { redactUrlCredentials } from "../../../../core/error-contract.ts";
import { redactCredentialShapes } from "../../../../utils/credential-redaction.js";

const REDACTED = "[redacted]";

export { redactCredentialShapes, redactUrlCredentials };

/** Replace every literal occurrence of `needle` in `text` without regular expressions. */
function replaceLiteral(text: string, needle: string, replacement: string): string {
	if (!needle) return text;
	let index = text.indexOf(needle);
	if (index === -1) return text;
	let result = "";
	let cursor = 0;
	while (index !== -1) {
		result += text.slice(cursor, index) + replacement;
		cursor = index + needle.length;
		index = text.indexOf(needle, cursor);
	}
	return result + text.slice(cursor);
}

/**
 * Extract the full header value and its credential payload (after a scheme such as `Basic` or `Bearer`)
 * so both the whole header and the bare token are scrubbed when echoed.
 */
export function extractAuthorizationSecrets(headerValue: string | null | undefined): string[] {
	if (!headerValue) return [];
	const trimmed = headerValue.trim();
	if (!trimmed) return [];
	const results = [trimmed];
	const space = trimmed.indexOf(" ");
	if (space > 0) {
		const credential = trimmed.slice(space + 1).trim();
		if (credential) results.push(credential);
	}
	return results;
}

/**
 * Scrub every known secret value (raw, percent-encoded, form-urlencoded, and JSON-escaped) from `text`,
 * longest-first so a shorter secret substring cannot split a longer secret before it is matched whole.
 */
export function redactSecretValues(text: string, secrets: Iterable<string | undefined>): string {
	if (!text) return text;
	const candidates = new Set<string>();
	for (const secret of secrets) {
		if (!secret?.trim()) continue;
		candidates.add(secret);
		try {
			candidates.add(encodeURIComponent(secret));
		} catch {}
		candidates.add(new URLSearchParams([["v", secret]]).toString().slice(2));
		candidates.add(JSON.stringify(secret).slice(1, -1));
	}
	if (candidates.size === 0) return text;
	const ordered = [...candidates].sort((a, b) => b.length - a.length);
	let scrubbed = text;
	for (const candidate of ordered) {
		scrubbed = replaceLiteral(scrubbed, candidate, REDACTED);
	}
	return scrubbed;
}

/** Scrub known active secret values and recognized credential/URL patterns from untrusted error text. */
export function redactOAuthErrorText(text: string, secrets: Iterable<string | undefined> = []): string {
	return redactCredentialShapes(redactSecretValues(text, secrets));
}
