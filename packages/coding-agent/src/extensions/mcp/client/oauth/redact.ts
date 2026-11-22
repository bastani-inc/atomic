import { randomBytes } from "node:crypto";
import { redactUrlCredentials } from "../../../../core/error-contract.ts";
import { redactCredentialShapes } from "../../../../utils/credential-redaction.js";

const REDACTED = "[redacted]";
/** Minimum length for unlabelled literal secret scrubbing so 1-3 character strings (e.g. HTTP status codes) are never over-redacted. */
const MIN_LITERAL_SECRET_LENGTH = 4;

export { redactCredentialShapes, redactUrlCredentials };

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

function stripTrailingEquals(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 61) end--;
	return value.slice(0, end);
}

function escapeNonAsciiJson(innerJson: string, upperHex: boolean): string {
	let out = "";
	let copied = 0;
	for (let i = 0; i < innerJson.length; i++) {
		const code = innerJson.charCodeAt(i);
		if (code > 0x7f) {
			const hex = code.toString(16).padStart(4, "0");
			out += `${innerJson.slice(copied, i)}\\u${upperHex ? hex.toUpperCase() : hex}`;
			copied = i + 1;
		}
	}
	return copied === 0 ? innerJson : out + innerJson.slice(copied);
}

function addSingleSecretVariants(secret: string, rawOut: Set<string>, pctOut: Set<string>): void {
	rawOut.add(secret);

	const jsonInner = JSON.stringify(secret).slice(1, -1);
	if (jsonInner !== secret) {
		rawOut.add(jsonInner);
		// Double JSON-escaped inner string (e.g. JSON embedded inside a JSON string).
		const doubleJsonInner = JSON.stringify(jsonInner).slice(1, -1);
		if (doubleJsonInner !== jsonInner) rawOut.add(doubleJsonInner);
	}
	if (jsonInner.includes("&") || jsonInner.includes("<") || jsonInner.includes(">") || jsonInner.includes("/")) {
		rawOut.add(goJsonEscape(jsonInner, false, false));
		rawOut.add(goJsonEscape(jsonInner, true, false));
		if (jsonInner.includes("/")) {
			rawOut.add(goJsonEscape(jsonInner, false, true));
			rawOut.add(goJsonEscape(jsonInner, true, true));
		}
	}
	// ASCII-only JSON escaping (e.g. Python `json.dumps(..., ensure_ascii=True)` -> `\u00e9` / `\u00E9`).
	const asciiJsonLower = escapeNonAsciiJson(jsonInner, false);
	if (asciiJsonLower !== jsonInner) {
		rawOut.add(asciiJsonLower);
		rawOut.add(escapeNonAsciiJson(jsonInner, true));
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

	// Base64 of the bare secret (standard, unpadded, and base64url).
	const b64 = Buffer.from(secret, "utf8").toString("base64");
	if (b64.length >= MIN_LITERAL_SECRET_LENGTH) {
		rawOut.add(b64);
		const unpadded = stripTrailingEquals(b64);
		if (unpadded.length >= MIN_LITERAL_SECRET_LENGTH) rawOut.add(unpadded);
		const b64url = Buffer.from(secret, "utf8").toString("base64url");
		if (b64url.length >= MIN_LITERAL_SECRET_LENGTH) rawOut.add(b64url);
	}

	try {
		const uriEncoded = encodeURIComponent(secret);
		pctOut.add(uriEncoded);
		const rfc = rfc3986Encode(secret);
		pctOut.add(rfc);
		if (rfc.includes("%20")) pctOut.add(rfc.replaceAll("%20", "+"));
		const formEncoded = new URLSearchParams([["v", secret]]).toString().slice(2);
		pctOut.add(formEncoded);
		// Gate each double-encoding independently so `!`-prefixed secrets (where encodeURIComponent === secret) still register `%2521...`.
		if (uriEncoded !== secret) pctOut.add(encodeURIComponent(uriEncoded));
		if (rfc !== secret) pctOut.add(rfc3986Encode(rfc));
		if (formEncoded !== secret) pctOut.add(encodeURIComponent(formEncoded));
	} catch {}
}

function expandSecretVariants(secret: string, rawOut: Set<string>, pctOut: Set<string>): void {
	addSingleSecretVariants(secret, rawOut, pctOut);
	let hasNonAscii = false;
	for (let i = 0; i < secret.length; i++) {
		if (secret.charCodeAt(i) > 0x7f) {
			hasNonAscii = true;
			break;
		}
	}
	if (hasNonAscii) {
		const nfc = secret.normalize("NFC");
		if (nfc !== secret) addSingleSecretVariants(nfc, rawOut, pctOut);
		const nfd = secret.normalize("NFD");
		if (nfd !== secret && nfd !== nfc) addSingleSecretVariants(nfd, rawOut, pctOut);
	}
}

function mergeEndSortedIntervals(maxLengths: Int32Array): { start: number; end: number }[] {
	const merged: { start: number; end: number }[] = [];
	for (let i = 0; i < maxLengths.length; i++) {
		const len = maxLengths[i]!;
		if (len <= 0) continue;
		const end = i + 1;
		let start = end - len;
		while (merged.length > 0 && start <= merged[merged.length - 1]!.end) {
			const prev = merged.pop()!;
			if (prev.start < start) start = prev.start;
		}
		merged.push({ start, end });
	}
	return merged;
}

function combinedMatchLengths(
	segment: string,
	rawAc: AhoCorasick | undefined,
	pctAc: AhoCorasick | undefined,
): Int32Array {
	const rawLens = rawAc ? scanMaxMatchLengths(segment, rawAc) : undefined;
	if (!pctAc) return rawLens!;
	const pctLens = scanMaxMatchLengths(normalizePercentHex(segment), pctAc);
	if (!rawLens) return pctLens;
	for (let i = 0; i < segment.length; i++) {
		if (pctLens[i]! > rawLens[i]!) rawLens[i] = pctLens[i]!;
	}
	return rawLens;
}

function maskSegment(segment: string, rawAc: AhoCorasick | undefined, pctAc: AhoCorasick | undefined): string {
	if (!segment) return segment;
	const merged = mergeEndSortedIntervals(combinedMatchLengths(segment, rawAc, pctAc));
	if (merged.length === 0) return segment;
	const parts: string[] = [];
	let cursor = 0;
	for (const interval of merged) {
		if (interval.start > cursor) parts.push(segment.slice(cursor, interval.start));
		parts.push(REDACTED);
		cursor = interval.end;
	}
	if (cursor < segment.length) parts.push(segment.slice(cursor));
	return parts.join("");
}

/**
 * Mask a segment across its full lookahead while returning the exact prefix boundary in the masked output
 * corresponding to original index `cap` (including any `[redacted]` token of a match starting `< cap` that straddles `cap`).
 */
function maskSegmentWithCapInfo(
	segment: string,
	rawAc: AhoCorasick | undefined,
	pctAc: AhoCorasick | undefined,
	cap: number,
): { readonly full: string; readonly prefixEnd: number } {
	const limit = Math.min(Math.max(0, cap), segment.length);
	if (!segment) return { full: "", prefixEnd: 0 };
	const merged = mergeEndSortedIntervals(combinedMatchLengths(segment, rawAc, pctAc));
	if (merged.length === 0) return { full: segment, prefixEnd: limit };
	const parts: string[] = [];
	let cursor = 0;
	let outLen = 0;
	let prefixEnd = -1;
	for (const interval of merged) {
		if (prefixEnd === -1 && interval.start >= limit) {
			prefixEnd = outLen + (limit - cursor);
		}
		if (interval.start > cursor) {
			const chunk = segment.slice(cursor, interval.start);
			parts.push(chunk);
			outLen += chunk.length;
		}
		parts.push(REDACTED);
		outLen += REDACTED.length;
		if (prefixEnd === -1 && interval.end >= limit) {
			prefixEnd = outLen;
		}
		cursor = interval.end;
	}
	if (prefixEnd === -1) {
		prefixEnd = outLen + Math.max(0, limit - cursor);
	}
	if (cursor < segment.length) parts.push(segment.slice(cursor));
	return { full: parts.join(""), prefixEnd };
}

/**
 * Per-connection/flow secret registry (analogous to secret-masking registries in CI and audit loggers).
 * Registers every known secret plus all encodings it can appear in, then masks any sink in a single
 * linear Aho-Corasick pass over disjoint non-`[redacted]` segments (strictly O(N+M) and unconditionally idempotent).
 */
export class SecretMaskRegistry {
	private readonly rawSet = new Set<string>();
	private readonly pctSet = new Set<string>();
	private rawAc: AhoCorasick | undefined;
	private pctAc: AhoCorasick | undefined;
	private dirty = false;

	constructor(secrets: Iterable<string | undefined> = []) {
		this.addAll(secrets);
	}

	add(secret: string | undefined): void {
		if (!secret) return;
		const trimmed = secret.trim();
		if (trimmed.length < MIN_LITERAL_SECRET_LENGTH) return;
		const prevRaw = this.rawSet.size;
		const prevPct = this.pctSet.size;
		expandSecretVariants(secret, this.rawSet, this.pctSet);
		if (trimmed !== secret) expandSecretVariants(trimmed, this.rawSet, this.pctSet);
		if (this.rawSet.size !== prevRaw || this.pctSet.size !== prevPct) {
			this.dirty = true;
		}
	}

	addAll(secrets: Iterable<string | undefined>): void {
		for (const secret of secrets) this.add(secret);
	}

	get empty(): boolean {
		return this.rawSet.size === 0 && this.pctSet.size === 0;
	}

	private ensureCompiled(): void {
		if (!this.dirty) return;
		this.rawAc = this.rawSet.size > 0 ? buildAhoCorasick([...this.rawSet]) : undefined;
		this.pctAc = this.pctSet.size > 0 ? buildAhoCorasick([...this.pctSet]) : undefined;
		this.dirty = false;
	}

	/** Mask every occurrence of every registered secret across all disjoint non-`[redacted]` segments. */
	mask(text: string): string {
		if (!text || this.empty) return text;
		this.ensureCompiled();
		if (!text.includes(REDACTED)) {
			return maskSegment(text, this.rawAc, this.pctAc);
		}
		const segments = text.split(REDACTED);
		for (let i = 0; i < segments.length; i++) {
			segments[i] = maskSegment(segments[i]!, this.rawAc, this.pctAc);
		}
		return segments.join(REDACTED);
	}

	/**
	 * Mask `text` across its full lookahead while returning `{ full, prefixEnd }` where `prefixEnd`
	 * is the exact index in `full` corresponding to original index `maxOriginalChars`.
	 */
	maskWithOriginalCapInfo(
		text: string,
		maxOriginalChars: number,
	): { readonly full: string; readonly prefixEnd: number } {
		const limit = Math.min(Math.max(0, maxOriginalChars), text.length);
		if (!text || limit === 0) return { full: text, prefixEnd: 0 };
		if (this.empty) return { full: text, prefixEnd: limit };
		this.ensureCompiled();
		if (!text.includes(REDACTED)) {
			return maskSegmentWithCapInfo(text, this.rawAc, this.pctAc, limit);
		}
		const parts: string[] = [];
		let origOffset = 0;
		let outLen = 0;
		let prefixEnd = -1;
		const segments = text.split(REDACTED);
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!;
			if (prefixEnd === -1 && origOffset + segment.length >= limit) {
				const { full, prefixEnd: segPrefixEnd } = maskSegmentWithCapInfo(
					segment,
					this.rawAc,
					this.pctAc,
					limit - origOffset,
				);
				prefixEnd = outLen + segPrefixEnd;
				parts.push(full);
				outLen += full.length;
			} else {
				const masked = maskSegment(segment, this.rawAc, this.pctAc);
				parts.push(masked);
				outLen += masked.length;
			}
			origOffset += segment.length;
			if (i + 1 < segments.length) {
				if (prefixEnd === -1 && origOffset >= limit) prefixEnd = outLen;
				parts.push(REDACTED);
				outLen += REDACTED.length;
				origOffset += REDACTED.length;
				if (prefixEnd === -1 && origOffset >= limit) prefixEnd = outLen;
			}
		}
		if (prefixEnd === -1) prefixEnd = outLen;
		return { full: parts.join(""), prefixEnd };
	}

	/**
	 * Mask `text` (read with lookahead past `maxOriginalChars`) while emitting NO raw characters whose
	 * original index is `>= maxOriginalChars` (eliminating lookahead-shrinkage tail-prefix leaks).
	 */
	maskWithOriginalCap(text: string, maxOriginalChars: number): string {
		const { full, prefixEnd } = this.maskWithOriginalCapInfo(text, maxOriginalChars);
		return full.slice(0, prefixEnd);
	}
}

/**
 * Scrub every known secret value (raw, upper/lower/mixed percent-encoded, RFC 3986, form-urlencoded,
 * double-encoded, base64/base64url, HTML-escaped, and JSON-escaped) from `text` in a single linear pass
 * over disjoint non-`[redacted]` segments so `[redacted]` is never rescanned or corrupted.
 */
export function redactSecretValues(text: string, secrets: Iterable<string | undefined>): string {
	if (!text) return text;
	const registry = new SecretMaskRegistry(secrets);
	return registry.mask(text);
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

/** Whether a header or env var name explicitly indicates credential/session material. */
export function isSensitiveKeyName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === "authorization" ||
		lower === "proxy-authorization" ||
		lower === "cookie" ||
		lower.includes("token") ||
		lower.includes("secret") ||
		lower.includes("key") ||
		lower.includes("auth") ||
		lower.includes("pass") ||
		lower.includes("pwd") ||
		lower.includes("cred") ||
		lower.includes("session") ||
		lower.includes("sid") ||
		lower.includes("sign") ||
		lower.includes("pat") ||
		lower.includes("jwt") ||
		lower.includes("bearer") ||
		lower.includes("private") ||
		lower.includes("cert")
	);
}

function shannonEntropy(value: string): number {
	if (value.length === 0) return 0;
	const counts = new Map<number, number>();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/**
 * Whether an unlabelled value looks like a high-entropy opaque credential/token rather than a benign
 * identifier such as `us-east-1`, `acme-corp`, `2025-11-25`, `my_project`, `AcmeCorp`, or `${TENANT_ID}`.
 */
export function looksLikeSecretValue(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 8) return false;
	if (matchesAsciiInsensitive(trimmed, 0, "bearer ") || matchesAsciiInsensitive(trimmed, 0, "bearer\t")) return true;
	if (matchesAsciiInsensitive(trimmed, 0, "basic ") || matchesAsciiInsensitive(trimmed, 0, "basic\t")) return true;
	if (trimmed.startsWith("${") && trimmed.endsWith("}")) return false;
	if (matchesAsciiInsensitive(trimmed, 0, "$env:")) return false;
	if (trimmed.includes(" ") || trimmed.includes("\n")) return false;
	if (trimmed.length < 16) return false;
	let hasUpper = false;
	let hasLower = false;
	let hasDigit = false;
	let hasOther = false;
	for (let i = 0; i < trimmed.length; i++) {
		const c = trimmed.charCodeAt(i);
		if (c >= 65 && c <= 90) hasUpper = true;
		else if (c >= 97 && c <= 122) hasLower = true;
		else if (c >= 48 && c <= 57) hasDigit = true;
		else hasOther = true;
	}
	const classes = (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0) + (hasOther ? 1 : 0);
	if (classes < 2) return false;
	// Lowercase hyphen/underscore slugs without digits or uppercase (e.g. `my-long-workspace-name`) are not secrets.
	if (!hasUpper && !hasDigit) return false;
	return shannonEntropy(trimmed) >= 3.3;
}

/**
 * Strip only `username`, `password`, and `hash` from a URL while preserving wire query parameters
 * (such as RFC 8707 `resource` parameters like `?tenant=acme`).
 */
export function stripUrlUserinfoAndHash(rawUrl: string): string {
	if (!URL.canParse(rawUrl)) return redactUrlCredentials(rawUrl, "text");
	const parsed = new URL(rawUrl);
	parsed.username = "";
	parsed.password = "";
	parsed.hash = "";
	return parsed.href;
}

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

const PUBLIC_OAUTH_AUTHORIZATION_PARAMS = new Set([
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
 * Format a server URL for transport display (`atomic mcp list`, `/mcp`):
 * strip userinfo and fragment, preserve benign query parameters (such as `?region=us-east-1`,
 * `?tenant=acme-corp`, `?version=2025-11-25`, `?workspace=my_project`, `?org=AcmeCorp`, `?tenant=${TENANT_ID}`),
 * and omit only query parameters with sensitive names, registered secrets, or high-entropy credential-like values.
 */
export function redactUrlForTransportDisplay(rawUrl: string, secrets: Iterable<string | undefined> = []): string {
	if (!URL.canParse(rawUrl)) return redactUrlForDisplay(rawUrl);
	const parsed = new URL(rawUrl);
	const registry = new SecretMaskRegistry(secrets);
	let changed = false;
	if (parsed.username || parsed.password) {
		parsed.username = "";
		parsed.password = "";
		changed = true;
	}
	if (parsed.hash) {
		parsed.hash = "";
		changed = true;
	}
	const keysToDelete: string[] = [];
	for (const [key, value] of parsed.searchParams.entries()) {
		if (
			SENSITIVE_QUERY_PARAM_NAMES.has(key.toLowerCase()) ||
			isSensitiveKeyName(key) ||
			(!registry.empty && registry.mask(value) !== value) ||
			looksLikeSecretValue(value)
		) {
			keysToDelete.push(key);
		}
	}
	if (keysToDelete.length > 0) {
		for (const key of keysToDelete) parsed.searchParams.delete(key);
		changed = true;
	}
	return changed ? parsed.href : rawUrl;
}

/**
 * Prepare an OAuth authorization URL for display, copy, or browser open:
 * keep the full query intact (so PKCE/OAuth sign-in always works) while stripping URL userinfo
 * (including single- or double-encoded nested userinfo inside query params), any `client_secret` /
 * sensitive non-public query parameter, and any query parameter whose value contains a registered secret.
 */
export function redactAuthorizationUrlForDisplay(
	input: string | URL,
	secrets: Iterable<string | undefined> = [],
): string {
	const raw = typeof input === "string" ? input : input.href;
	if (!URL.canParse(raw)) return redactOAuthErrorText(raw, secrets);
	const url = new URL(raw);
	const registry = new SecretMaskRegistry(secrets);
	let changed = false;
	if (url.username || url.password) {
		url.username = "";
		url.password = "";
		changed = true;
	}
	const keysToDelete: string[] = [];
	const updates: [string, string][] = [];
	for (const [key, value] of url.searchParams.entries()) {
		const lowerKey = key.toLowerCase();
		const isSecretParamName =
			!PUBLIC_OAUTH_AUTHORIZATION_PARAMS.has(lowerKey) &&
			(lowerKey === "client_secret" ||
				lowerKey === "client-secret" ||
				lowerKey === "clientsecret" ||
				isSensitiveKeyName(lowerKey));
		if (isSecretParamName || (!registry.empty && registry.mask(value) !== value)) {
			keysToDelete.push(key);
			continue;
		}
		// Strip raw, single-encoded (`%3A%2F%2F...%40`), and double-encoded (`%253A%252F%252F...%2540`) nested URL userinfo.
		const stripped = redactUrlCredentials(value, "text");
		if (stripped !== value) updates.push([key, stripped]);
	}
	if (keysToDelete.length > 0 || updates.length > 0) {
		for (const key of keysToDelete) url.searchParams.delete(key);
		for (const [key, value] of updates) url.searchParams.set(key, value);
		changed = true;
	}
	return changed ? url.href : raw;
}

function isAsciiAlphaNumOrUnderscore(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isTokenStopChar(code: number): boolean {
	return (
		code <= 32 ||
		code === 34 || // "
		code === 39 || // '
		code === 40 || // (
		code === 41 || // )
		code === 44 || // ,
		code === 59 || // ;
		code === 60 || // <
		code === 62 || // >
		code === 96 || // `
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

function isValidStandardBase64(value: string): boolean {
	if (value.length < 4 || value.length % 4 !== 0) return false;
	let pad = 0;
	for (let i = value.length - 1; i >= 0 && value.charCodeAt(i) === 61; i--) pad++;
	if (pad > 2) return false;
	const end = value.length - pad;
	for (let i = 0; i < end; i++) {
		const c = value.charCodeAt(i);
		const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
		if (!ok) return false;
	}
	return true;
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

/**
 * Unbounded one-sided check for RFC 7617 `Basic <base64(id:secret)>`:
 * every valid RFC 7617 `Basic` credential has length >= 4, multiple of 4, valid Base64, and decodes to bytes
 * containing `:` (0x3a). Falls back to `looksLikeBase64Credential` for non-colon opaque tokens.
 * Leaves ordinary prose ("Basic auth", "Basic mode", "Basic text") untouched.
 */
function isBasicAuthPayload(value: string): boolean {
	if (value.length < 4) return false;
	if (isValidStandardBase64(value) && Buffer.from(value, "base64").includes(0x3a)) {
		return true;
	}
	return looksLikeBase64Credential(value);
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

function isPosixOrSystemErrorCode(value: string): boolean {
	if (value.length < 2) return false;
	if (value === "E2BIG") return true;
	if (
		value.startsWith("ERR_") ||
		value.startsWith("UND_ERR_") ||
		value.startsWith("SQLITE_") ||
		value.startsWith("HTTP_")
	) {
		for (let i = 0; i < value.length; i++) {
			const c = value.charCodeAt(i);
			if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) return false;
		}
		return true;
	}
	// POSIX errnos: `E` followed by 2..20 ASCII uppercase letters (no digits, so hex OAuth codes like `E7F9A3...` stay redacted).
	if (value.charCodeAt(0) === 69 && value.length >= 3 && value.length <= 21) {
		for (let i = 1; i < value.length; i++) {
			const c = value.charCodeAt(i);
			if (c < 65 || c > 90) return false;
		}
		return true;
	}
	return false;
}

const KNOWN_OAUTH_ERROR_CODES = new Set([
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"invalid_scope",
	"invalid_token",
	"insufficient_scope",
	"access_denied",
	"unsupported_response_type",
	"server_error",
	"temporarily_unavailable",
	"slow_down",
	"authorization_pending",
	"expired_token",
	"login_required",
	"consent_required",
	"interaction_required",
]);

/** Lowercase English words that commonly follow `bearer` in prose rather than being a Bearer token. */
const BEARER_PROSE_WORDS = new Set([
	"token",
	"tokens",
	"authentication",
	"auth",
	"authorization",
	"header",
	"headers",
	"scheme",
	"credential",
	"credentials",
	"challenge",
	"challenges",
	"format",
	"missing",
	"required",
	"invalid",
	"expired",
	"rejected",
	"failed",
	"error",
	"only",
	"mode",
	"type",
	"access",
	"refresh",
	"client",
	"server",
	"grant",
	"flow",
]);

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

function isAuthorizationPrefixContext(text: string, kwStart: number): boolean {
	let pos = kwStart;
	while (pos > 0 && (text.charCodeAt(pos - 1) === 32 || text.charCodeAt(pos - 1) === 9)) pos--;
	if (pos === 0) return false;
	const sep = text.charCodeAt(pos - 1);
	if (sep !== 58 && sep !== 61) return false; // ':' or '='
	pos--;
	while (pos > 0 && (text.charCodeAt(pos - 1) === 32 || text.charCodeAt(pos - 1) === 9)) pos--;
	if (pos > 0 && (text.charCodeAt(pos - 1) === 34 || text.charCodeAt(pos - 1) === 39)) pos--;
	if (pos >= 13 && matchesAsciiInsensitive(text, pos - 13, "authorization")) return true;
	if (pos >= 4 && matchesAsciiInsensitive(text, pos - 4, "auth")) return true;
	return false;
}

function scanQuotedOrTokenValueEnd(text: string, start: number): number {
	if (start >= text.length) return start;
	const first = text.charCodeAt(start);
	// Escaped JSON string value (`\"...\"`).
	if (first === 92 && start + 1 < text.length && text.charCodeAt(start + 1) === 34) {
		let i = start + 2;
		while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) {
			if (text.charCodeAt(i) === 92 && i + 1 < text.length) {
				if (text.charCodeAt(i + 1) === 34) return i + 2;
				i += 2;
				continue;
			}
			i++;
		}
		return i;
	}
	if (first === 34 || first === 39) {
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

/** Sensitive URL query parameter names whose values are scrubbed from logs/errors and active URLs. */
export const SENSITIVE_QUERY_PARAM_NAMES = new Set([
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

const KNOWN_CHALLENGE_PARAMS = new Set([
	"realm",
	"resource_metadata",
	"authorization_uri",
	"scope",
	"error",
	"error_description",
	"error_uri",
	"charset",
	"as_uri",
	"algs",
	"max_age",
]);

/**
 * Whether `text` at `start` begins an RFC 7235/6750/9728 `WWW-Authenticate` challenge parameter
 * (`param="value"`, or a known challenge parameter `name=value`), as opposed to a Bearer token.
 */
function isWwwAuthenticateChallengeParam(text: string, start: number): boolean {
	if (start >= text.length) return false;
	const first = text.charCodeAt(start);
	const startsLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
	if (!startsLetter) return false;
	let eq = start;
	let allLowerIdent = true;
	while (eq < text.length) {
		const c = text.charCodeAt(eq);
		if (c >= 97 && c <= 122) eq++;
		else if (c === 95 || c === 45) eq++;
		else if (c >= 65 && c <= 90) {
			allLowerIdent = false;
			eq++;
		} else if (c >= 48 && c <= 57) eq++;
		else break;
	}
	if (eq - start < 2 || eq >= text.length || text.charCodeAt(eq) !== 61) return false;
	const afterEq = eq + 1;
	if (afterEq >= text.length) return false;
	// Quoted challenge param (`authorization_uri="..."`, `resource_metadata="..."`, `realm="..."`)
	if (allLowerIdent && text.charCodeAt(afterEq) === 34) return true;
	return KNOWN_CHALLENGE_PARAMS.has(text.slice(start, eq).toLowerCase());
}

/**
 * Strip ANSI CSI/OSC sequences into `plain`, recording for each index of `plain` its index in `text`
 * (plus `text.length` sentinel at the end). Chunked linear single pass, zero regular expressions.
 */
function stripAnsiWithOrigin(text: string): {
	readonly plain: string;
	readonly origin: Int32Array | undefined;
} {
	if (!text.includes("\x1b")) return { plain: text, origin: undefined };
	const chunks: string[] = [];
	const origin = new Int32Array(text.length + 1);
	let plainLen = 0;
	let copied = 0;
	let i = 0;

	const flush = (end: number) => {
		if (end <= copied) return;
		chunks.push(text.slice(copied, end));
		for (let k = copied; k < end; k++) origin[plainLen++] = k;
		copied = end;
	};

	while (i < text.length) {
		const esc = text.indexOf("\x1b", i);
		if (esc === -1) {
			flush(text.length);
			break;
		}
		if (esc + 1 < text.length) {
			const next = text.charCodeAt(esc + 1);
			if (next === 0x5b) {
				// CSI: ESC [ [0-?]* [ -/]* [@-~]
				let j = esc + 2;
				while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
				while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
				if (j < text.length && text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e) {
					flush(esc);
					copied = j + 1;
					i = j + 1;
					continue;
				}
			} else if (next === 0x5d) {
				// OSC: ESC ] [^\x07\x1b]* (BEL | ESC \) — break on any ESC so unterminated OSC stays O(n).
				let j = esc + 2;
				let matched = false;
				while (j < text.length) {
					const c = text.charCodeAt(j);
					if (c === 0x07) {
						flush(esc);
						copied = j + 1;
						i = j + 1;
						matched = true;
						break;
					}
					if (c === 0x1b) {
						if (j + 1 < text.length && text.charCodeAt(j + 1) === 0x5c) {
							flush(esc);
							copied = j + 2;
							i = j + 2;
							matched = true;
						}
						break;
					}
					j++;
				}
				if (matched) continue;
			}
		}
		i = esc + 1;
	}
	if (copied < text.length) flush(text.length);
	origin[plainLen] = text.length;
	return { plain: chunks.join(""), origin };
}

/**
 * Single-pass linear-time secondary net for OAuth/HTTP credential shapes:
 * - `Bearer <token>` (SP/HTAB, arbitrary opaque token chars incl. `!`, `$`, `%`, `:`; preserves prose & WWW-Authenticate challenges)
 * - standalone or assigned `Basic <base64>` (SP/HTAB; unbounded RFC 7617 `:` check + Base64 fallback)
 * - `code_verifier` / `code-verifier` / `codeVerifier` (form, JSON, escaped `\"...\"`, ANSI-styled)
 * - `code=<secret>` (excluding integers, POSIX/Node `E...` error codes, and standard OAuth error codes)
 * - sensitive URL query parameter values (`?api_key=...`, `&token=...`, etc.)
 * - long-line `password=<token>` linear fallback (covers >2KB lines where regex engines may abort)
 */
function redactOAuthStructuredCredentials(text: string): string {
	if (!text) return text;
	const { plain, origin } = stripAnsiWithOrigin(text);
	const mapStart = (index: number) => (origin === undefined ? index : origin[index]!);
	const mapEnd = (index: number) => (origin === undefined ? index : origin[index - 1]! + 1);

	const parts: string[] = [];
	let copied = 0;
	let i = 0;
	const longInput = plain.length > 2048;

	const emitReplacement = (plainFrom: number, plainTo: number) => {
		if (plainTo <= plainFrom) return;
		const origFrom = mapStart(plainFrom);
		const origTo = mapEnd(plainTo);
		if (origFrom < copied) return;
		if (plain.slice(plainFrom, plainTo) === REDACTED) return;
		parts.push(text.slice(copied, origFrom), REDACTED);
		copied = origTo;
	};

	while (i < plain.length) {
		if (plain.charCodeAt(i) === 91 && plain.startsWith(REDACTED, i)) {
			i += REDACTED.length;
			continue;
		}

		const prevWord = i > 0 && isAsciiAlphaNumOrUnderscore(plain.charCodeAt(i - 1));

		// 1. `Bearer[ \t]+<token>` (preserves prose like "Invalid bearer token format" & WWW-Authenticate challenge params)
		if (!prevWord && matchesAsciiInsensitive(plain, i, "bearer")) {
			const afterKw = i + 6;
			const valStart = skipHorizontalWs(plain, afterKw);
			if (valStart > afterKw && valStart < plain.length && !isWwwAuthenticateChallengeParam(plain, valStart)) {
				if (plain.startsWith(REDACTED, valStart)) {
					i = valStart + REDACTED.length;
					continue;
				}
				let valEnd = valStart;
				while (valEnd < plain.length && !isTokenStopChar(plain.charCodeAt(valEnd))) {
					valEnd++;
				}
				while (
					valEnd > valStart &&
					plain.charCodeAt(valEnd - 1) === 46 &&
					(valEnd === plain.length || plain.charCodeAt(valEnd) <= 32)
				) {
					valEnd--;
				}
				const candidate = plain.slice(valStart, valEnd);
				const isPlainProse =
					!isAuthorizationPrefixContext(plain, i) && BEARER_PROSE_WORDS.has(candidate.toLowerCase());
				if (valEnd > valStart && !isPlainProse) {
					emitReplacement(i, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 2. `Basic[ \t]+<base64>`
		if (!prevWord && matchesAsciiInsensitive(plain, i, "basic")) {
			const afterKw = i + 5;
			const valStart = skipHorizontalWs(plain, afterKw);
			if (valStart > afterKw && valStart < plain.length) {
				if (plain.startsWith(REDACTED, valStart)) {
					i = valStart + REDACTED.length;
					continue;
				}
				let valEnd = valStart;
				while (valEnd < plain.length && isBase64CredentialChar(plain.charCodeAt(valEnd))) {
					valEnd++;
				}
				const candidate = plain.slice(valStart, valEnd);
				const nextOk = valEnd === plain.length || !isAsciiAlphaNumOrUnderscore(plain.charCodeAt(valEnd));
				if (nextOk && isBasicAuthPayload(candidate)) {
					emitReplacement(i, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 3. `code_verifier` / `code-verifier` / `codeVerifier` (including escaped JSON `\"code_verifier\":\"...\"`)
		if (!prevWord) {
			let kvLen = 0;
			if (matchesAsciiInsensitive(plain, i, "code_verifier") || matchesAsciiInsensitive(plain, i, "code-verifier")) {
				kvLen = 13;
			} else if (matchesAsciiInsensitive(plain, i, "codeverifier")) {
				kvLen = 12;
			}
			if (kvLen > 0) {
				let pos = i + kvLen;
				while (pos < plain.length && plain.charCodeAt(pos) === 92) pos++;
				if (pos < plain.length && (plain.charCodeAt(pos) === 34 || plain.charCodeAt(pos) === 39)) pos++;
				pos = skipHorizontalWs(plain, pos);
				if (pos < plain.length && (plain.charCodeAt(pos) === 61 || plain.charCodeAt(pos) === 58)) {
					pos = skipHorizontalWs(plain, pos + 1);
					if (pos < plain.length && !plain.startsWith(REDACTED, pos)) {
						const valEnd = scanQuotedOrTokenValueEnd(plain, pos);
						if (valEnd > pos) {
							emitReplacement(pos, valEnd);
							i = valEnd;
							continue;
						}
					}
				}
			}
		}

		// 4. `code=<secret>` (skipping integers, POSIX/Node error codes like ENOENT/ECONNREFUSED, and OAuth error codes)
		if (
			!prevWord &&
			!(i > 0 && plain.charCodeAt(i - 1) === 45) &&
			matchesAsciiInsensitive(plain, i, "code") &&
			i + 4 < plain.length &&
			plain.charCodeAt(i + 4) === 61
		) {
			const valStart = i + 5;
			if (valStart < plain.length && !plain.startsWith(REDACTED, valStart)) {
				const valEnd = scanQuotedOrTokenValueEnd(plain, valStart);
				const val = plain.slice(valStart, valEnd);
				if (
					val.length > 0 &&
					!isSignedInteger(val) &&
					!isPosixOrSystemErrorCode(val) &&
					!KNOWN_OAUTH_ERROR_CODES.has(val.toLowerCase())
				) {
					emitReplacement(valStart, valEnd);
					i = valEnd;
					continue;
				}
			}
		}

		// 5. Sensitive URL query parameters (`?name=value` or `&name=value`)
		if (plain.charCodeAt(i) === 63 || plain.charCodeAt(i) === 38) {
			let nameEnd = i + 1;
			while (
				nameEnd < plain.length &&
				(isAsciiAlphaNumOrUnderscore(plain.charCodeAt(nameEnd)) || plain.charCodeAt(nameEnd) === 45)
			) {
				nameEnd++;
			}
			if (nameEnd > i + 1 && nameEnd < plain.length && plain.charCodeAt(nameEnd) === 61) {
				const paramName = plain.slice(i + 1, nameEnd).toLowerCase();
				if (SENSITIVE_QUERY_PARAM_NAMES.has(paramName)) {
					const valStart = nameEnd + 1;
					if (valStart < plain.length && !plain.startsWith(REDACTED, valStart)) {
						let valEnd = valStart;
						while (
							valEnd < plain.length &&
							!isTokenStopChar(plain.charCodeAt(valEnd)) &&
							plain.charCodeAt(valEnd) !== 38 &&
							plain.charCodeAt(valEnd) !== 35
						) {
							valEnd++;
						}
						const val = plain.slice(valStart, valEnd);
						if (
							val.length > 0 &&
							!(
								paramName === "code" &&
								(isSignedInteger(val) ||
									isPosixOrSystemErrorCode(val) ||
									KNOWN_OAUTH_ERROR_CODES.has(val.toLowerCase()))
							)
						) {
							emitReplacement(valStart, valEnd);
							i = valEnd;
							continue;
						}
					}
				}
			}
		}

		// 6. Long-line linear fallback for `password=<val>` / `passwd=<val>` / `pwd=<val>` (avoids regex match-limit bypass on >2KB lines)
		if (longInput && !prevWord) {
			let pwdLen = 0;
			if (matchesAsciiInsensitive(plain, i, "password")) pwdLen = 8;
			else if (matchesAsciiInsensitive(plain, i, "passwd")) pwdLen = 6;
			else if (matchesAsciiInsensitive(plain, i, "pwd")) pwdLen = 3;
			if (pwdLen > 0 && i + pwdLen < plain.length && plain.charCodeAt(i + pwdLen) === 61) {
				const valStart = i + pwdLen + 1;
				if (valStart < plain.length && !plain.startsWith(REDACTED, valStart)) {
					const valEnd = scanQuotedOrTokenValueEnd(plain, valStart);
					if (valEnd > valStart) {
						emitReplacement(valStart, valEnd);
						i = valEnd;
						continue;
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

function chooseFreshPlaceholderPrefix(text: string): string {
	for (;;) {
		const prefix = `ATOMICPRX${randomBytes(8).toString("hex").toUpperCase()}P`;
		if (!text.includes(prefix)) return prefix;
	}
}

/**
 * Run `redactCredentialShapes` ONCE over the intact text while protecting non-secret `bearer <prose>`
 * phrases and RFC 7235/6750/9728 `Bearer` challenge prefixes via fresh, same-line, delimiter-free,
 * non-credential placeholders. Because the text is never split, enclosing JSON quotes, Cookie headers,
 * PEM blocks, and bare `password:` lines are redacted whole, and any placeholder consumed inside a wider
 * redaction is never restored.
 */
function redactRemainingCredentialShapes(text: string): string {
	const protectedSpans: { start: number; end: number; original: string }[] = [];
	let i = 0;
	while (i < text.length) {
		const prevWord = i > 0 && isAsciiAlphaNumOrUnderscore(text.charCodeAt(i - 1));
		if (!prevWord && matchesAsciiInsensitive(text, i, "bearer")) {
			const afterKw = i + 6;
			const valStart = skipHorizontalWs(text, afterKw);
			if (valStart > afterKw && valStart < text.length) {
				if (isWwwAuthenticateChallengeParam(text, valStart)) {
					// Protect only the `Bearer` scheme word (keeping the whitespace after it intact).
					protectedSpans.push({ start: i, end: afterKw, original: text.slice(i, afterKw) });
					i = valStart;
					continue;
				}
				let valEnd = valStart;
				while (valEnd < text.length && !isTokenStopChar(text.charCodeAt(valEnd))) valEnd++;
				const word = text.slice(valStart, valEnd);
				if (!isAuthorizationPrefixContext(text, i) && BEARER_PROSE_WORDS.has(word.toLowerCase())) {
					protectedSpans.push({ start: i, end: valEnd, original: text.slice(i, valEnd) });
					i = valEnd;
					continue;
				}
			}
		}
		i++;
	}
	if (protectedSpans.length === 0) return redactCredentialShapes(text);

	const prefix = chooseFreshPlaceholderPrefix(text);
	const substitutedParts: string[] = [];
	let cursor = 0;
	for (let idx = 0; idx < protectedSpans.length; idx++) {
		const span = protectedSpans[idx]!;
		if (span.start > cursor) substitutedParts.push(text.slice(cursor, span.start));
		substitutedParts.push(`${prefix}${idx}X`);
		cursor = span.end;
	}
	if (cursor < text.length) substitutedParts.push(text.slice(cursor));

	const redacted = redactCredentialShapes(substitutedParts.join(""));
	if (!redacted.includes(prefix)) return redacted;

	// Restore only placeholders that survived outside wider redactions, in a single linear pass.
	const restoredParts: string[] = [];
	let copyFrom = 0;
	let pos = redacted.indexOf(prefix, 0);
	while (pos !== -1) {
		const numStart = pos + prefix.length;
		let numEnd = numStart;
		while (numEnd < redacted.length && redacted.charCodeAt(numEnd) >= 48 && redacted.charCodeAt(numEnd) <= 57) {
			numEnd++;
		}
		if (numEnd > numStart && numEnd < redacted.length && redacted.charCodeAt(numEnd) === 88) {
			const idx = Number(redacted.slice(numStart, numEnd));
			const span = protectedSpans[idx];
			if (span !== undefined) {
				if (pos > copyFrom) restoredParts.push(redacted.slice(copyFrom, pos));
				restoredParts.push(span.original);
				copyFrom = numEnd + 1;
				pos = redacted.indexOf(prefix, copyFrom);
				continue;
			}
		}
		pos = redacted.indexOf(prefix, pos + prefix.length);
	}
	if (copyFrom === 0) return redacted;
	if (copyFrom < redacted.length) restoredParts.push(redacted.slice(copyFrom));
	return restoredParts.join("");
}

/**
 * Redact secrets and URL credentials from a `WWW-Authenticate` challenge header without
 * clobbering RFC 6750/9728 challenge syntax such as `Bearer resource_metadata="https://..."`
 * or `Bearer authorization_uri="https://..."`.
 */
export function redactWwwAuthenticateHeader(header: string, secrets: Iterable<string | undefined> = []): string {
	return redactOAuthErrorText(header, secrets);
}

/**
 * Scrub known active secret values (primary exact-value masking), OAuth/HTTP credential forms,
 * URL credentials/query secrets, and remaining credential shapes from untrusted error or log text.
 */
export function redactOAuthErrorText(text: string, secrets: Iterable<string | undefined> = []): string {
	if (!text) return text;
	const afterValues = redactSecretValues(text, secrets);
	const afterOAuth = redactOAuthStructuredCredentials(afterValues);
	return redactRemainingCredentialShapes(afterOAuth);
}

function clipRedactedPrefix(redactedHead: string, redactedFull: string): string {
	if (redactedFull.startsWith(redactedHead)) return redactedHead;
	let lcp = 0;
	const minLen = Math.min(redactedHead.length, redactedFull.length);
	while (lcp < minLen && redactedHead.charCodeAt(lcp) === redactedFull.charCodeAt(lcp)) {
		lcp++;
	}
	// If a shape match (e.g. an unknown JWT) started at `s <= lcp` before the cap and extended into lookahead,
	// `redactedFull` emitted `[redacted]` covering `lcp`. Clip right after that sentinel so zero lookahead bytes
	// and zero partial secret prefix survive.
	const searchStart = Math.max(0, lcp - REDACTED.length + 1);
	for (let j = searchStart; j <= lcp; j++) {
		if (redactedFull.startsWith(REDACTED, j)) {
			return redactedFull.slice(0, j + REDACTED.length);
		}
	}
	return redactedHead;
}

/**
 * Mask a response body read with lookahead past `maxOriginalChars`, guaranteeing NO raw characters
 * from indices `>= maxOriginalChars` are ever emitted even if earlier redactions shrink the output,
 * AND catching unknown shape matches (such as server-minted JWTs) straddling `maxOriginalChars`.
 */
export function redactOAuthErrorTextCapped(
	rawBody: string,
	secrets: Iterable<string | undefined>,
	maxOriginalChars: number,
): string {
	if (!rawBody || maxOriginalChars <= 0) return "";
	if (rawBody.length <= maxOriginalChars) {
		return redactOAuthErrorText(rawBody, secrets);
	}
	const registry = new SecretMaskRegistry(secrets);
	const { full: exactFull, prefixEnd } = registry.maskWithOriginalCapInfo(rawBody, maxOriginalChars);
	const exactHead = exactFull.slice(0, prefixEnd);
	const shapeHead = redactRemainingCredentialShapes(redactOAuthStructuredCredentials(exactHead));
	const shapeFull = redactRemainingCredentialShapes(redactOAuthStructuredCredentials(exactFull));
	return clipRedactedPrefix(shapeHead, shapeFull);
}

/** Scrub a `fetch` rejection while preserving `TypeError`, `DOMException`, and error `.code` without retaining raw `.cause`. */
export function scrubFetchError(error: unknown, secrets: Iterable<string | undefined> = []): Error {
	const message = redactOAuthErrorText(error instanceof Error ? error.message : String(error), secrets);
	if (error instanceof TypeError) return new TypeError(message);
	if (error instanceof DOMException) return new DOMException(message, error.name);
	const scrubbed = new Error(message);
	const code = (error as { code?: unknown } | undefined)?.code;
	if (typeof code === "string") Object.assign(scrubbed, { code });
	return scrubbed;
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
