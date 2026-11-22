import { redactUrlCredentials } from "../../../../core/error-contract.ts";
import { redactCredentialShapes } from "../../../../utils/credential-redaction.js";

const REDACTED = "[redacted]";
/** Minimum length for unlabelled literal secret scrubbing so 1-3 character strings (e.g. HTTP status codes) are never over-redacted. */
const MIN_LITERAL_SECRET_LENGTH = 4;

export { redactCredentialShapes, redactUrlCredentials };

interface Interval {
	readonly start: number;
	readonly end: number;
}

interface AhoCorasick {
	readonly transitions: Map<number, number>[];
	readonly fail: number[];
	readonly maxLen: number[];
}

function buildAhoCorasick(patterns: readonly string[]): AhoCorasick {
	const transitions: Map<number, number>[] = [new Map()];
	const fail: number[] = [0];
	const maxLen: number[] = [0];

	for (const pattern of patterns) {
		if (pattern.length === 0) continue;
		let state = 0;
		for (let i = 0; i < pattern.length; i++) {
			const code = pattern.charCodeAt(i);
			let next = transitions[state]!.get(code);
			if (next === undefined) {
				next = transitions.length;
				transitions[state]!.set(code, next);
				transitions.push(new Map());
				fail.push(0);
				maxLen.push(0);
			}
			state = next;
		}
		if (pattern.length > maxLen[state]!) maxLen[state] = pattern.length;
	}

	const queue: number[] = [];
	for (const child of transitions[0]!.values()) {
		queue.push(child);
	}
	for (let head = 0; head < queue.length; head++) {
		const state = queue[head]!;
		for (const [code, child] of transitions[state]!.entries()) {
			let fallback = fail[state]!;
			while (fallback !== 0 && !transitions[fallback]!.has(code)) {
				fallback = fail[fallback]!;
			}
			const target = transitions[fallback]!.get(code) ?? 0;
			fail[child] = target;
			if (maxLen[target]! > maxLen[child]!) maxLen[child] = maxLen[target]!;
			queue.push(child);
		}
	}

	return { transitions, fail, maxLen };
}

function scanMaxMatchLengths(text: string, automaton: AhoCorasick): Int32Array {
	const result = new Int32Array(text.length);
	let state = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		while (state !== 0 && !automaton.transitions[state]!.has(code)) {
			state = automaton.fail[state]!;
		}
		state = automaton.transitions[state]!.get(code) ?? 0;
		result[i] = automaton.maxLen[state]!;
	}
	return result;
}

function isHexCharCode(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function upperHexChar(code: number): string {
	return String.fromCharCode(code >= 97 && code <= 102 ? code - 32 : code);
}

/**
 * Length-preserving normalization that uppercases every `%[0-9a-fA-F]{2}` hex pair in place,
 * keeping every UTF-16 index identical to `text` so matches map directly back to `text`.
 */
function normalizePercentHex(text: string): string {
	if (!text.includes("%")) return text;
	let out = "";
	let copied = 0;
	let i = 0;
	while (i < text.length) {
		if (
			text.charCodeAt(i) === 37 &&
			i + 2 < text.length &&
			isHexCharCode(text.charCodeAt(i + 1)) &&
			isHexCharCode(text.charCodeAt(i + 2))
		) {
			const c1 = text.charCodeAt(i + 1);
			const c2 = text.charCodeAt(i + 2);
			if ((c1 >= 97 && c1 <= 102) || (c2 >= 97 && c2 <= 102)) {
				out += text.slice(copied, i + 1) + upperHexChar(c1) + upperHexChar(c2);
				copied = i + 3;
			}
			i += 3;
		} else {
			i += 1;
		}
	}
	return copied === 0 ? text : out + text.slice(copied);
}

function rfc3986Encode(value: string): string {
	const encoded = encodeURIComponent(value);
	let out = "";
	let copied = 0;
	for (let i = 0; i < encoded.length; i++) {
		const ch = encoded[i]!;
		let rep: string | undefined;
		if (ch === "!") rep = "%21";
		else if (ch === "'") rep = "%27";
		else if (ch === "(") rep = "%28";
		else if (ch === ")") rep = "%29";
		else if (ch === "*") rep = "%2A";
		if (rep !== undefined) {
			out += encoded.slice(copied, i) + rep;
			copied = i + 1;
		}
	}
	return copied === 0 ? encoded : out + encoded.slice(copied);
}

function htmlEscape(value: string, quoteEntity: string, aposEntity: string): string {
	let out = "";
	let copied = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!;
		let rep: string | undefined;
		if (ch === "&") rep = "&amp;";
		else if (ch === "<") rep = "&lt;";
		else if (ch === ">") rep = "&gt;";
		else if (ch === '"') rep = quoteEntity;
		else if (ch === "'") rep = aposEntity;
		if (rep !== undefined) {
			out += value.slice(copied, i) + rep;
			copied = i + 1;
		}
	}
	return copied === 0 ? value : out + value.slice(copied);
}

function goJsonEscape(innerJson: string, upperHex: boolean, escapeSlash: boolean): string {
	let out = "";
	let copied = 0;
	const lt = upperHex ? "\\u003C" : "\\u003c";
	const gt = upperHex ? "\\u003E" : "\\u003e";
	for (let i = 0; i < innerJson.length; i++) {
		const ch = innerJson[i]!;
		let rep: string | undefined;
		if (ch === "&") rep = "\\u0026";
		else if (ch === "<") rep = lt;
		else if (ch === ">") rep = gt;
		else if (escapeSlash && ch === "/") rep = "\\/";
		if (rep !== undefined) {
			out += innerJson.slice(copied, i) + rep;
			copied = i + 1;
		}
	}
	return copied === 0 ? innerJson : out + innerJson.slice(copied);
}

function expandSecretVariants(secret: string, rawOut: Set<string>, pctOut: Set<string>): void {
	rawOut.add(secret);

	const jsonInner = JSON.stringify(secret).slice(1, -1);
	if (jsonInner !== secret) rawOut.add(jsonInner);
	if (jsonInner.includes("&") || jsonInner.includes("<") || jsonInner.includes(">") || jsonInner.includes("/")) {
		rawOut.add(goJsonEscape(jsonInner, false, false));
		rawOut.add(goJsonEscape(jsonInner, true, false));
		if (jsonInner.includes("/")) {
			rawOut.add(goJsonEscape(jsonInner, false, true));
			rawOut.add(goJsonEscape(jsonInner, true, true));
		}
	}

	if (
		secret.includes("&") ||
		secret.includes("<") ||
		secret.includes(">") ||
		secret.includes('"') ||
		secret.includes("'")
	) {
		rawOut.add(htmlEscape(secret, "&quot;", "&#39;"));
		if (secret.includes("'")) {
			rawOut.add(htmlEscape(secret, "&quot;", "&apos;"));
			rawOut.add(htmlEscape(secret, "&quot;", "&#x27;"));
			rawOut.add(htmlEscape(secret, "&quot;", "&#x27;".toUpperCase()));
		}
		if (secret.includes('"')) {
			rawOut.add(htmlEscape(secret, "&#34;", "&#39;"));
			rawOut.add(htmlEscape(secret, "&#x22;", "&#x27;"));
		}
	}

	try {
		const uriEncoded = encodeURIComponent(secret);
		pctOut.add(uriEncoded);
		const rfc = rfc3986Encode(secret);
		pctOut.add(rfc);
		if (rfc.includes("%20")) pctOut.add(rfc.replaceAll("%20", "+"));
		const formEncoded = new URLSearchParams([["v", secret]]).toString().slice(2);
		pctOut.add(formEncoded);
		if (uriEncoded !== secret) {
			pctOut.add(encodeURIComponent(uriEncoded));
			pctOut.add(rfc3986Encode(rfc));
		}
	} catch {}
}

function findProtectedSentinels(text: string): Interval[] {
	const spans: Interval[] = [];
	let index = text.indexOf(REDACTED);
	while (index !== -1) {
		spans.push({ start: index, end: index + REDACTED.length });
		index = text.indexOf(REDACTED, index + REDACTED.length);
	}
	return spans;
}

function insideProtectedSentinel(start: number, end: number, sentinels: readonly Interval[]): boolean {
	for (const sentinel of sentinels) {
		if (sentinel.end <= start) continue;
		if (sentinel.start >= end) return false;
		if (start >= sentinel.start && end <= sentinel.end) return true;
	}
	return false;
}

function mergeAndEmitIntervals(text: string, maxLengths: Int32Array, sentinels: readonly Interval[]): string {
	const merged: { start: number; end: number }[] = [];
	for (let i = 0; i < text.length; i++) {
		const len = maxLengths[i]!;
		if (len <= 0) continue;
		const end = i + 1;
		let start = end - len;
		if (insideProtectedSentinel(start, end, sentinels)) continue;
		while (merged.length > 0 && start <= merged[merged.length - 1]!.end) {
			const prev = merged.pop()!;
			if (prev.start < start) start = prev.start;
		}
		merged.push({ start, end });
	}
	if (merged.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const interval of merged) {
		if (interval.start > cursor) parts.push(text.slice(cursor, interval.start));
		parts.push(REDACTED);
		cursor = interval.end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts.join("");
}

/**
 * Scrub every known secret value (raw, upper/lower/mixed percent-encoded, RFC 3986, form-urlencoded,
 * double-encoded, HTML-escaped, and JSON-escaped) from `text` in a single linear pass over the original
 * text so the `[redacted]` sentinel is never rescanned or corrupted.
 */
export function redactSecretValues(text: string, secrets: Iterable<string | undefined>): string {
	if (!text) return text;
	const rawSet = new Set<string>();
	const pctSet = new Set<string>();
	for (const secret of secrets) {
		if (!secret) continue;
		const trimmed = secret.trim();
		if (trimmed.length < MIN_LITERAL_SECRET_LENGTH) continue;
		expandSecretVariants(secret, rawSet, pctSet);
		if (trimmed !== secret) expandSecretVariants(trimmed, rawSet, pctSet);
	}
	if (rawSet.size === 0 && pctSet.size === 0) return text;

	const rawLens = rawSet.size > 0 ? scanMaxMatchLengths(text, buildAhoCorasick([...rawSet])) : undefined;
	let combinedLens: Int32Array;
	if (pctSet.size > 0) {
		const pctText = normalizePercentHex(text);
		const pctLens = scanMaxMatchLengths(pctText, buildAhoCorasick([...pctSet]));
		if (rawLens) {
			combinedLens = rawLens;
			for (let i = 0; i < text.length; i++) {
				if (pctLens[i]! > combinedLens[i]!) combinedLens[i] = pctLens[i]!;
			}
		} else {
			combinedLens = pctLens;
		}
	} else {
		combinedLens = rawLens!;
	}

	const sentinels = findProtectedSentinels(text);
	return mergeAndEmitIntervals(text, combinedLens, sentinels);
}

/**
 * Extract the full header value, its credential payload (after a scheme separated by space or tab),
 * and for `Basic` credentials the Base64-decoded `user:pass` and password parts.
 */
export function extractAuthorizationSecrets(headerValue: string | null | undefined): string[] {
	if (!headerValue) return [];
	const trimmed = headerValue.trim();
	if (!trimmed) return [];
	const results = [trimmed];
	let sep = -1;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed.charCodeAt(i);
		if (ch === 32 || ch === 9) {
			sep = i;
			break;
		}
	}
	if (sep > 0) {
		const scheme = trimmed.slice(0, sep).toLowerCase();
		const credential = trimmed.slice(sep + 1).trim();
		if (credential) {
			results.push(credential);
			if (scheme === "basic") {
				try {
					const decoded = Buffer.from(credential, "base64").toString("utf8");
					if (decoded && !decoded.includes("\ufffd")) {
						results.push(decoded);
						const colon = decoded.indexOf(":");
						if (colon >= 0) {
							const password = decoded.slice(colon + 1);
							if (password) results.push(password);
						}
					}
				} catch {}
			}
		}
	}
	return results;
}

/** Extract individual cookie values from a `Cookie` header (`a=v1; b="v2"`). */
export function extractCookieSecrets(headerValue: string | null | undefined): string[] {
	if (!headerValue) return [];
	const results: string[] = [];
	for (const part of headerValue.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		let value = part.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		if (value) results.push(value);
	}
	return results;
}

/** Extract secret values from an HTTP request header according to its header name. */
export function extractHeaderSecrets(name: string, value: string | null | undefined): string[] {
	if (!value) return [];
	if (name.toLowerCase() === "cookie") {
		return [...extractCookieSecrets(value), value.trim()].filter(Boolean);
	}
	return extractAuthorizationSecrets(value);
}

/** Allowlist of public OAuth authorization URL parameters that may be shown to the user. */
const ALLOWED_AUTHORIZATION_URL_PARAMS = new Set([
	"response_type",
	"client_id",
	"code_challenge",
	"code_challenge_method",
	"redirect_uri",
	"state",
	"scope",
	"prompt",
	"resource",
]);

/**
 * Format a URL for display or error messages using an allowlist: only `origin` + `pathname`
 * (no userinfo, no query string, no fragment).
 */
export function redactUrlForDisplay(rawUrl: string): string {
	if (URL.canParse(rawUrl)) {
		const parsed = new URL(rawUrl);
		if (parsed.origin && parsed.origin !== "null") {
			return `${parsed.origin}${parsed.pathname}`;
		}
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.href;
	}
	let safe = redactUrlCredentials(rawUrl, "text");
	const q = safe.indexOf("?");
	if (q >= 0) safe = safe.slice(0, q);
	const h = safe.indexOf("#");
	if (h >= 0) safe = safe.slice(0, h);
	return safe;
}

/**
 * Build a displayable OAuth authorization URL from allowlisted public parts only:
 * `origin` + `pathname` (no userinfo) and only allowlisted public OAuth parameters,
 * with URL-valued parameters (`resource`, `redirect_uri`) stripped of userinfo/query/fragment.
 */
export function redactAuthorizationUrlForDisplay(input: string | URL): string {
	const raw = typeof input === "string" ? input : input.href;
	if (!URL.canParse(raw)) return redactUrlForDisplay(raw);
	const source = new URL(raw);
	const clean = new URL(`${source.origin}${source.pathname}`);
	for (const [key, value] of source.searchParams.entries()) {
		if (!ALLOWED_AUTHORIZATION_URL_PARAMS.has(key)) continue;
		if (key === "resource" || key === "redirect_uri") {
			clean.searchParams.append(key, redactUrlForDisplay(value));
		} else {
			clean.searchParams.append(key, value);
		}
	}
	return clean.href;
}

function isAsciiAlphaNumOrUnderscore(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isTokenStopChar(code: number): boolean {
	return (
		code <= 32 ||
		code === 34 || // "
		code === 39 || // '
		code === 44 || // ,
		code === 59 || // ;
		code === 60 || // <
		code === 62 || // >
		code === 96 || // `
		code === 41 || // )
		code === 125 || // }
		code === 93 // ]
	);
}

function isBase64CredentialChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 43 || // +
		code === 47 || // /
		code === 61 || // =
		code === 95 || // _
		code === 45 // -
	);
}

function looksLikeBase64Credential(value: string): boolean {
	if (value.length < 4) return false;
	let hasUpper = false;
	let hasLower = false;
	let hasDigit = false;
	let hasSymbol = false;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 65 && c <= 90) hasUpper = true;
		else if (c >= 97 && c <= 122) hasLower = true;
		else if (c >= 48 && c <= 57) hasDigit = true;
		else hasSymbol = true;
	}
	if (hasSymbol) return true;
	if (value.length >= 8 && ((hasUpper && hasLower) || hasDigit)) return true;
	return false;
}

function isSignedInteger(value: string): boolean {
	if (value.length === 0) return false;
	let i = value.charCodeAt(0) === 45 ? 1 : 0;
	if (i === value.length) return false;
	for (; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

function matchesAsciiInsensitive(text: string, offset: number, lowerKeyword: string): boolean {
	if (offset < 0 || offset + lowerKeyword.length > text.length) return false;
	for (let i = 0; i < lowerKeyword.length; i++) {
		let c = text.charCodeAt(offset + i);
		if (c >= 65 && c <= 90) c += 32;
		if (c !== lowerKeyword.charCodeAt(i)) return false;
	}
	return true;
}

function skipHorizontalWs(text: string, pos: number): number {
	while (pos < text.length && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
	return pos;
}

function scanQuotedOrTokenValueEnd(text: string, start: number): number {
	if (start >= text.length) return start;
	const first = text.charCodeAt(start);
	if (first === 34 || first === 39) {
		// Quoted string value: consume through closing quote (or line end).
		let i = start + 1;
		while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) {
			const c = text.charCodeAt(i);
			if (c === 92 && i + 1 < text.length) {
				i += 2;
				continue;
			}
			if (c === first) return i + 1;
			i++;
		}
		return i;
	}
	let i = start;
	while (i < text.length && !isTokenStopChar(text.charCodeAt(i)) && text.charCodeAt(i) !== 38) {
		i++;
	}
	return i;
}

const SENSITIVE_QUERY_PARAM_NAMES = new Set([
	"api_key",
	"apikey",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"client_secret",
	"secret",
	"password",
	"passwd",
	"pwd",
	"auth",
	"authorization",
	"key",
	"sig",
	"signature",
	"code",
	"code_verifier",
	"session",
	"session_id",
	"sid",
	"credential",
	"credentials",
	"bearer",
	"jwt",
	"pat",
]);

const WWW_AUTHENTICATE_CHALLENGE_PARAMS = new Set([
	"realm",
	"resource_metadata",
	"scope",
	"error",
	"error_description",
	"error_uri",
	"charset",
	"as_uri",
	"algs",
]);

function isWwwAuthenticateChallengeParam(text: string, start: number): boolean {
	let eq = start;
	while (eq < text.length && isAsciiAlphaNumOrUnderscore(text.charCodeAt(eq))) eq++;
	if (eq <= start || eq >= text.length || text.charCodeAt(eq) !== 61) return false;
	return WWW_AUTHENTICATE_CHALLENGE_PARAMS.has(text.slice(start, eq).toLowerCase());
}

/**
 * Single-pass linear-time scanner for OAuth/HTTP credential forms not covered by `redactCredentialShapes`:
 * - `Bearer <token>` (SP or HTAB, arbitrary opaque token chars including `!`, `$`, `%`, `:`)
 * - standalone or assigned `Basic <base64>` (SP or HTAB)
 * - `code_verifier` / `code-verifier` / `codeVerifier` values (form, JSON, YAML)
 * - `code=<non-integer>` (query/form OAuth authorization codes)
 * - sensitive URL query parameter values (`?api_key=...`, `&token=...`, etc.)
 * Skips existing `[redacted]` sentinels for idempotence.
 */
function redactOAuthStructuredCredentials(text: string): string {
	if (!text) return text;
	const parts: string[] = [];
	let copied = 0;
	let i = 0;

	const emitReplacement = (from: number, to: number) => {
		if (to <= from) return;
		if (text.slice(from, to) === REDACTED) return;
		parts.push(text.slice(copied, from), REDACTED);
		copied = to;
	};

	while (i < text.length) {
		// Skip existing `[redacted]` sentinel intact.
		if (text.charCodeAt(i) === 91 && text.startsWith(REDACTED, i)) {
			i += REDACTED.length;
			continue;
		}

		const prevWord = i > 0 && isAsciiAlphaNumOrUnderscore(text.charCodeAt(i - 1));

		// 1. `Bearer[ \t]+<token>` (excluding RFC 6750/9728 `WWW-Authenticate` challenge params like `Bearer resource_metadata="..."`)
		if (!prevWord && matchesAsciiInsensitive(text, i, "bearer")) {
			const afterKw = i + 6;
			const valStart = skipHorizontalWs(text, afterKw);
			if (valStart > afterKw && valStart < text.length && !isWwwAuthenticateChallengeParam(text, valStart)) {
				if (text.startsWith(REDACTED, valStart)) {
					i = valStart + REDACTED.length;
					continue;
				}
				let valEnd = valStart;
				while (valEnd < text.length && !isTokenStopChar(text.charCodeAt(valEnd))) {
					valEnd++;
				}
				// Trim trailing sentence period when followed by whitespace or end.
				while (
					valEnd > valStart &&
					text.charCodeAt(valEnd - 1) === 46 &&
					(valEnd === text.length || text.charCodeAt(valEnd) <= 32)
				) {
					valEnd--;
				}
				if (valEnd > valStart) {
					emitReplacement(i, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 2. `Basic[ \t]+<base64>`
		if (!prevWord && matchesAsciiInsensitive(text, i, "basic")) {
			const afterKw = i + 5;
			const valStart = skipHorizontalWs(text, afterKw);
			if (valStart > afterKw && valStart < text.length) {
				if (text.startsWith(REDACTED, valStart)) {
					i = valStart + REDACTED.length;
					continue;
				}
				let valEnd = valStart;
				while (valEnd < text.length && isBase64CredentialChar(text.charCodeAt(valEnd))) {
					valEnd++;
				}
				const candidate = text.slice(valStart, valEnd);
				// Only redact if the token ends at a non-word boundary and looks like a credential.
				const nextOk = valEnd === text.length || !isAsciiAlphaNumOrUnderscore(text.charCodeAt(valEnd));
				if (nextOk && looksLikeBase64Credential(candidate)) {
					emitReplacement(i, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 3. `code_verifier` / `code-verifier` / `codeVerifier`
		if (!prevWord) {
			let kvLen = 0;
			if (matchesAsciiInsensitive(text, i, "code_verifier") || matchesAsciiInsensitive(text, i, "code-verifier")) {
				kvLen = 13;
			} else if (matchesAsciiInsensitive(text, i, "codeverifier")) {
				kvLen = 12;
			}
			if (kvLen > 0) {
				let pos = i + kvLen;
				// Optional closing quote on JSON key (`"code_verifier":`).
				if (pos < text.length && (text.charCodeAt(pos) === 34 || text.charCodeAt(pos) === 39)) pos++;
				pos = skipHorizontalWs(text, pos);
				if (pos < text.length && (text.charCodeAt(pos) === 61 || text.charCodeAt(pos) === 58)) {
					pos = skipHorizontalWs(text, pos + 1);
					if (pos < text.length && !text.startsWith(REDACTED, pos)) {
						const valEnd = scanQuotedOrTokenValueEnd(text, pos);
						if (valEnd > pos) {
							emitReplacement(pos, valEnd);
							i = valEnd;
							continue;
						}
					}
				}
			}
		}

		// 4. `code=<non-integer>` (OAuth authorization code in query/form/error text)
		if (
			!prevWord &&
			!(i > 0 && text.charCodeAt(i - 1) === 45) &&
			matchesAsciiInsensitive(text, i, "code") &&
			i + 4 < text.length &&
			text.charCodeAt(i + 4) === 61
		) {
			const valStart = i + 5;
			if (valStart < text.length && !text.startsWith(REDACTED, valStart)) {
				const valEnd = scanQuotedOrTokenValueEnd(text, valStart);
				const val = text.slice(valStart, valEnd);
				if (val.length > 0 && !isSignedInteger(val)) {
					emitReplacement(valStart, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 5. Sensitive URL query parameters (`?name=value` or `&name=value`)
		if (text.charCodeAt(i) === 63 || text.charCodeAt(i) === 38) {
			let nameEnd = i + 1;
			while (
				nameEnd < text.length &&
				(isAsciiAlphaNumOrUnderscore(text.charCodeAt(nameEnd)) || text.charCodeAt(nameEnd) === 45)
			) {
				nameEnd++;
			}
			if (nameEnd > i + 1 && nameEnd < text.length && text.charCodeAt(nameEnd) === 61) {
				const paramName = text.slice(i + 1, nameEnd).toLowerCase();
				if (SENSITIVE_QUERY_PARAM_NAMES.has(paramName)) {
					const valStart = nameEnd + 1;
					if (valStart < text.length && !text.startsWith(REDACTED, valStart)) {
						let valEnd = valStart;
						while (
							valEnd < text.length &&
							!isTokenStopChar(text.charCodeAt(valEnd)) &&
							text.charCodeAt(valEnd) !== 38 &&
							text.charCodeAt(valEnd) !== 35
						) {
							valEnd++;
						}
						const val = text.slice(valStart, valEnd);
						if (val.length > 0 && !(paramName === "code" && isSignedInteger(val))) {
							emitReplacement(valStart, valEnd);
							i = valEnd;
							continue;
						}
					}
				}
			}
		}

		i++;
	}

	if (copied === 0) return text;
	parts.push(text.slice(copied));
	return parts.join("");
}

/**
 * Redact secrets and URL credentials from a `WWW-Authenticate` challenge header without
 * clobbering RFC 6750/9728 challenge syntax such as `Bearer resource_metadata="https://..."`.
 */
export function redactWwwAuthenticateHeader(header: string, secrets: Iterable<string | undefined> = []): string {
	const trimmedStart = header.length - header.trimStart().length;
	const leading = header.slice(0, trimmedStart);
	const body = header.slice(trimmedStart);
	if (matchesAsciiInsensitive(body, 0, "bearer")) {
		const afterScheme = skipHorizontalWs(body, 6);
		if (afterScheme > 6 && isWwwAuthenticateChallengeParam(body, afterScheme)) {
			return leading + body.slice(0, afterScheme) + redactOAuthErrorText(body.slice(afterScheme), secrets);
		}
	}
	return redactOAuthErrorText(header, secrets);
}

/**
 * Scrub known active secret values, OAuth/HTTP credential forms, URL credentials/query secrets,
 * and recognized credential shapes from untrusted error or log text.
 */
export function redactOAuthErrorText(text: string, secrets: Iterable<string | undefined> = []): string {
	if (!text) return text;
	const afterValues = redactSecretValues(text, secrets);
	const afterOAuth = redactOAuthStructuredCredentials(afterValues);
	return redactCredentialShapes(afterOAuth);
}

/** Recursively scrub string values inside structured error data (bounded depth). */
export function scrubUnknownErrorData(value: unknown, secrets: readonly string[], depth = 0): unknown {
	if (depth > 6 || value === null || value === undefined) return value;
	if (typeof value === "string") return redactOAuthErrorText(value, secrets);
	if (Array.isArray(value)) return value.map((item) => scrubUnknownErrorData(item, secrets, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = scrubUnknownErrorData(v, secrets, depth + 1);
		}
		return out;
	}
	return value;
}
