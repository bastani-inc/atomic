import { redactUrlCredentials } from "../core/error-contract.ts";

const REDACTED = "[redacted]";

/**
 * An ANSI CSI sequence, such as the styling `jq -C` or a terminal-aware CLI puts around a field name, its separator,
 * an authorization scheme or a value. Patterns match text with these removed, and redaction maps back to the text.
 */
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/gu;

const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/\bBearer\s+[\w.~+/-]+=*/giu,
	/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/gu,
	/\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu,
];

/** `pattern` with each ASCII letter matching either case, so the rest of a regular expression can be case-sensitive. */
function caseless(pattern: string): string {
	return pattern.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

/** Field names whose unquoted value may hold spaces, commas or semicolons: it is redacted to the end of its line. */
const PASSWORD_FIELD_NAME = "(?:password|passwd|pwd|passphrase)";
const OTHER_FIELD_NAME =
	"(?:api[-_]?key|apikey|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|session[-_]?key|credentials?|token|secret|key)";
/** Password-like names that also count capitalized after a lower-case letter or digit, as in `dbPassword`. */
const CAMEL_CASE_PASSWORD_NAME = "(?:Password|Passwd|Pwd|Passphrase)";
/**
 * Other names that count capitalized after a lower-case letter or digit, as in `githubToken`, `awsSecret` and
 * `dbCredentials`. Only key names that name a credential count (`openaiApiKey`, `secretAccessKey`, `jwtSigningKey`),
 * so `primaryKey`, `sortKey` or `cacheKey` stay as they are.
 */
const CAMEL_CASE_FIELD_NAME =
	"(?:Token|Secret|Credentials?|Authorization|(?:Api|Access|Secret|Private|Auth|Signing|Encryption|Client|Master|License)Key)";

/**
 * A credential field name. A letter or digit may not come right before it, but `_` or `-` may, so `DB_PASSWORD` and
 * `GITHUB_TOKEN` count while `monkey` does not. A capitalized name also counts after a lower-case letter or digit, so
 * `authToken`, `openaiApiKey` and `dbPassword` count while `tokenizer` and `primaryKey` do not.
 */
function fieldName(names: string, camelCase: string): string {
	return `(?:(?<![A-Za-z0-9])${caseless(`(?:x-)?${names}`)}|(?<=[a-z0-9])${camelCase})`;
}

const CREDENTIAL_AUTH_SCHEME = caseless("(?:bearer|basic|digest|token|apikey|oauth)");
/**
 * A quoted value runs to its closing quote, past backslash escapes and doubled quotes, or to the end of the line when
 * it is cut off. No alternative overlaps another, so a match never backtracks.
 */
const QUOTED_VALUE = String.raw`(["'])(?:\\.|\2\2|(?!\2)[^\\\n])*\2?`;
/**
 * A value quoted with escaped quotes, as in JSON inside a JSON string (`\"value\"`). Its escapes are escaped too: `\\`
 * followed by an escaped quote or backslash, or by another character, is one escape, so `\\\"` does not end it. A
 * value nested deeper runs to the next quote.
 */
const ESCAPED_QUOTED_VALUE = String.raw`\\"(?:\\\\(?:\\["\\]|[^\\\n])|[^"\\\n])*(?:\\")?|\\{2,}"[^"\n]*"?`;
/** A YAML block indicator (`|`, `>-`, `|2+`) that ends its line: the value is the indented block below it. */
const BLOCK_INDICATOR = String.raw`[|>][-+0-9]*[ \t]*(?=\r?\n|$)`;

/**
 * A credential field: its name, quoted (`"token":`, `'password':`, `\"token\":`) or not (`token:`, `API_KEY=`), and
 * its value: a quoted string, or an unquoted run that may follow an authorization scheme. The unquoted value of a
 * password-like field runs to the end of its line, because a password may hold spaces, commas or semicolons.
 */
function credentialField(name: string, unquoted: string): string {
	const quoted = (group: number) => QUOTED_VALUE.replaceAll("\\2", `\\${group}`);
	return String.raw`${name}(\\*["']?)\s*(?::(?![ \t]*${BLOCK_INDICATOR})\s*(?:${quoted(2)}|${ESCAPED_QUOTED_VALUE}|${unquoted.replace("SCHEME", CREDENTIAL_AUTH_SCHEME + String.raw`\s+`)})|=\s*(?:${quoted(3)}|${ESCAPED_QUOTED_VALUE}|${unquoted.replace("SCHEME", "(?!)")}))`;
}

/** A credential field holding a YAML block scalar: its header up to the indicator, then the indented lines. */
function blockField(name: string): RegExp {
	return new RegExp(String.raw`(${name}["']?[ \t]*:[ \t]*${BLOCK_INDICATOR})(?:\r?\n[ \t]+[^\r\n]*)+`, "gu");
}

const PASSWORD_NAME = fieldName(PASSWORD_FIELD_NAME, CAMEL_CASE_PASSWORD_NAME);
const OTHER_NAME = fieldName(OTHER_FIELD_NAME, CAMEL_CASE_FIELD_NAME);

/** A part of a match to replace: from `start` to `end`, offsets in the match, in order and not overlapping. */
interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
}

/** How a match is redacted: the parts of it to replace. */
type Redaction = (match: RegExpExecArray) => readonly Replacement[];

const WHOLE: Redaction = (match) => [{ start: 0, end: match[0].length, replacement: REDACTED }];
const AFTER_SEPARATOR: Redaction = (match) => [
	{ start: /[:=]/u.exec(match[0])!.index + 1, end: match[0].length, replacement: ` ${REDACTED}` },
];
const BLOCK: Redaction = (match) => [{ start: match[1]!.length, end: match[0].length, replacement: `\n  ${REDACTED}` }];

/** A `Cookie` or `Set-Cookie` header, in any case, to the end of its line. */
const COOKIE_HEADER = /(?<![A-Za-z0-9-])(set-)?cookie[ \t]*:[^\r\n]*/giu;

/**
 * The values of a cookie header's `name=value` pairs: every pair of a `Cookie` header, and only the first pair of a
 * `Set-Cookie` header, whose other pairs are attributes such as `Path` and `Max-Age`. Names stay visible.
 */
const COOKIE_VALUES: Redaction = (match) => {
	const header = match[0];
	const replacements: Replacement[] = [];
	let pairStart = header.indexOf(":") + 1;
	for (;;) {
		const semicolon = header.indexOf(";", pairStart);
		const pairEnd = semicolon === -1 ? header.length : semicolon;
		const equals = header.indexOf("=", pairStart);
		if (equals !== -1 && equals < pairEnd) {
			const value = header.slice(equals + 1, pairEnd).trimEnd();
			if (value.trim() !== "")
				replacements.push({ start: equals + 1, end: equals + 1 + value.length, replacement: REDACTED });
		}
		if (match[1] !== undefined || semicolon === -1) return replacements;
		pairStart = semicolon + 1;
	}
};

/**
 * Each pattern, in order, with how its matches are redacted. Blocks and password-like fields come first, so a later
 * field on the same line does not end a password's value early.
 */
const STEPS: readonly (readonly [RegExp, Redaction])[] = [
	[PRIVATE_KEY_BLOCK, WHOLE],
	[COOKIE_HEADER, COOKIE_VALUES],
	[blockField(PASSWORD_NAME), BLOCK],
	[blockField(OTHER_NAME), BLOCK],
	[new RegExp(credentialField(PASSWORD_NAME, String.raw`(?:SCHEME)?[^\r\n]+`), "gu"), AFTER_SEPARATOR],
	[new RegExp(credentialField(OTHER_NAME, String.raw`(?:SCHEME)?[^\s,;}"'&]+`), "gu"), AFTER_SEPARATOR],
	...CREDENTIAL_SHAPES.map((shape) => [shape, WHOLE] as const),
];

/** `text` without ANSI sequences, and for each of its characters the index it has in `text`, plus `text`'s length. */
function withoutAnsi(text: string): { readonly plain: string; readonly origin: readonly number[] | undefined } {
	if (!text.includes("\x1b")) return { plain: text, origin: undefined };
	let plain = "";
	const origin: number[] = [];
	let copied = 0;
	const keep = (end: number) => {
		for (let index = copied; index < end; index++) origin.push(index);
		plain += text.slice(copied, end);
	};
	for (const sequence of text.matchAll(ANSI_SEQUENCE)) {
		keep(sequence.index);
		copied = sequence.index + sequence[0].length;
	}
	keep(text.length);
	origin.push(text.length);
	return { plain, origin };
}

/** `text` with each match of `pattern`, found with ANSI sequences ignored, redacted as `redaction` says. */
function redactMatches(text: string, pattern: RegExp, redaction: Redaction): string {
	const { plain, origin } = withoutAnsi(text);
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let redacted = "";
	let copied = 0;
	for (const match of plain.matchAll(pattern)) {
		for (const { start, end, replacement } of redaction(match)) {
			if (end <= start) continue;
			redacted += text.slice(copied, at(match.index + start)) + replacement;
			copied = at(match.index + end - 1) + 1;
		}
	}
	return redacted + text.slice(copied);
}

/**
 * Redact what looks like a credential in `text`: user info in URLs (up to the last `@` of the authority), private key
 * blocks (PEM, OpenSSH and PGP), the value of a credential field in JSON (also JSON inside a JSON string), YAML (also a
 * block scalar), HTTP-header or env-style text, cookie values in `Cookie` and `Set-Cookie` headers, and well-known token
 * shapes. An unquoted password-like value
 * (`password`, `passwd`, `pwd`, `passphrase`, also `dbPassword`) is redacted to the end of its line. ANSI styling
 * anywhere in a field or token does not hide it. Every pattern is linear in the length of `text`.
 */
export function redactCredentialShapes(text: string): string {
	return STEPS.reduce(
		(masked, [pattern, redaction]) => redactMatches(masked, pattern, redaction),
		redactUrlCredentials(text),
	);
}
