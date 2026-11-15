import { redactUrlCredentials } from "../core/error-contract.ts";

const REDACTED = "[redacted]";

/**
 * An ANSI CSI sequence, such as the styling `jq -C` or a terminal-aware CLI puts around a field name, its separator,
 * an authorization scheme or a value, or an OSC sequence such as an OSC 8 hyperlink. Patterns match text with these
 * removed, and redaction maps back to the text.
 */
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;

const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

/** `pattern` with each ASCII letter matching either case, so the rest of a regular expression can be case-sensitive. */
function caseless(pattern: string): string {
	return pattern.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

/** Field names whose unquoted value may hold spaces, commas or semicolons. */
const PASSWORD_FIELD_NAME = "(?:password|passwd|pwd|passphrase)";
const OTHER_FIELD_NAME =
	"(?:api[-_]?key|apikey|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|session[-_]?key|credentials?|token|secret|key)";
/** Password-like names that also count capitalized after a letter or digit, as in `dbPassword` or `SMTPPassword`. */
const CAMEL_CASE_PASSWORD_NAME = "(?:Password|Passwd|Pwd|Passphrase)";
/**
 * Other names that count capitalized after a letter or digit, as in `githubToken`, `JWTSecret` and `dbCredentials`.
 * Only key names that name a credential count (`openaiApiKey`, `secretAccessKey`, `jwtSigningKey`), so `primaryKey`,
 * `sortKey` or `cacheKey` stay as they are; a provider's `openaiKey` counts when its value looks like a secret.
 */
const CAMEL_CASE_FIELD_NAME =
	"(?:Token|Secret|Credentials?|Authorization|(?:Api|Access|Secret|Private|Auth|Signing|Encryption|Client|Master|License)Key)";

/**
 * A credential field name. A letter or digit may not come right before it, but `_` or `-` may, so `DB_PASSWORD` and
 * `GITHUB_TOKEN` count while `monkey` does not. A capitalized name also counts after a letter or digit, so `authToken`,
 * `DBPassword` and `openaiApiKey` count while `tokenizer` and `primaryKey` do not.
 */
function fieldName(names: string, camelCase: string): string {
	return `(?:(?<![A-Za-z0-9])${caseless(`(?:x-)?${names}`)}|(?<=[A-Za-z0-9])${camelCase})`;
}

const CREDENTIAL_AUTH_SCHEME = caseless("(?:bearer|basic|digest|token|apikey|oauth)");
/**
 * A quoted value runs to its closing quote, past backslash escapes and doubled quotes, or to the end of the line when
 * it is cut off. No alternative overlaps another, so a match never backtracks.
 */
const QUOTED_VALUE = String.raw`"(?:\\.|""|[^"\\\n])*"?|'(?:\\.|''|[^'\\\n])*'?`;
/**
 * A value quoted with escaped quotes, as in JSON inside a JSON string (`\"value\"`). Its escapes are escaped too: `\\`
 * followed by an escaped quote or backslash, or by another character, is one escape, so `\\\"` does not end it. A
 * value nested deeper runs to the next quote.
 */
const ESCAPED_QUOTED_VALUE = String.raw`\\"(?:\\\\(?:\\["\\]|[^\\\n])|[^"\\\n])*(?:\\")?|\\{2,}"[^"\n]*"?`;
/** A YAML block indicator (`|`, `>-`, `|2+`) that ends its line: the value is the indented block below it. */
const BLOCK_INDICATOR = String.raw`[|>][-+0-9]*[ \t]*(?=\r?\n|$)`;

/** How the unquoted value of a field runs, by the field's form. */
interface UnquotedValues {
	/** After a quoted name and `:`, as in JSON or a dictionary. */
	readonly json: string;
	/** After a bare name and `:`, as in YAML, an HTTP header or prose. */
	readonly bare: string;
	/** After `=`, as in env-style text. */
	readonly env: string;
}

/**
 * A credential field: its name, quoted (`"token":`, `'password':`, `\"token\":`) or not (`token:`, `API_KEY=`), and
 * its value: a quoted string, or an unquoted run whose extent depends on the field's form.
 */
function credentialField(name: string, unquoted: UnquotedValues): RegExp {
	const value = (run: string) => `(?:${QUOTED_VALUE}|${ESCAPED_QUOTED_VALUE}|${run})`;
	const scheme = String.raw`(?:${CREDENTIAL_AUTH_SCHEME}\s+)?`;
	return new RegExp(
		String.raw`${name}(?:\\*["']\s*:\s*${value(unquoted.json)}|\s*:(?![ \t]*${BLOCK_INDICATOR})\s*${value(scheme + unquoted.bare)}|(?:\\*["'])?\s*=\s*${value(unquoted.env)})`,
		"gu",
	);
}

const PASSWORD_NAME = fieldName(PASSWORD_FIELD_NAME, CAMEL_CASE_PASSWORD_NAME);
const OTHER_NAME = fieldName(OTHER_FIELD_NAME, CAMEL_CASE_FIELD_NAME);

/** A part of a match to replace: from `start` to `end`, offsets in the match, in order and not overlapping. */
interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
}

/** How a match is redacted: the parts of it to replace, none to keep it. */
type Redaction = (match: RegExpExecArray) => readonly Replacement[];

const WHOLE: Redaction = (match) => [{ start: 0, end: match[0].length, replacement: REDACTED }];

/** Values that name no secret: literals, and TypeScript's primitive types. */
const LITERAL =
	/^(?:null|true|false|undefined|none|nil|string|number|boolean|bigint|symbol|object|unknown|any|never|void)$/iu;
/** A code identifier rather than a secret: a type name of capitalized words, or a member access such as `this.token` or `process.env.TOKEN`. */
const CODE_IDENTIFIER =
	/^(?:(?:[A-Z][a-z]+)+|(?:this|self|process|window|globalThis|options|opts|config|props|state|params|args|ctx|context|req|request|res|response|input|data|env)(?:\.[A-Za-z_$][\w$]*)+)$/u;
/** First words of camelCase names that name a flag, a type or a pagination cursor rather than a secret. */
const ORDINARY_CAMEL_CASE_PREFIX =
	/^(?:next|cancel|cancellation|continuation|page|pagination|cursor|has|is|show|hide|use|with|include|requires?|enable|disable|allow|toggle|max|min|num|count|should|can|on|get|set|parse|validate|check|forgot)$/u;

/** The first word of the camelCase identifier whose credential name starts at `index` of `input`, or "". */
function camelCasePrefix(input: string, index: number): string {
	let start = index;
	while (start > 0 && index - start < 64 && /[A-Za-z0-9_$]/u.test(input[start - 1]!)) start--;
	return /^[a-z]+/u.exec(input.slice(start, index))?.[0] ?? "";
}

/**
 * Whether `value`, a field's value after its separator, holds a secret: a quoted or escaped value always does; an
 * unquoted one unless it is a literal, a number after a quoted name, or (for names other than passwords) a code
 * identifier, followed by nothing but closing punctuation.
 */
function holdsSecret(value: string, quotedName: boolean, password: boolean): boolean {
	if (/^["'\\]/u.test(value)) return true;
	const first = /^[^\s,;)}\]]*/u.exec(value)![0];
	const rest = value.slice(first.length).trim();
	if (!/^[,;)}\]]*$/u.test(rest)) return true;
	if (LITERAL.test(first)) return false;
	if (quotedName && /^-?\d+(?:\.\d+)?$/u.test(first)) return false;
	return password || !CODE_IDENTIFIER.test(first);
}

/** The value of a credential field: from its separator to its end, unless it holds no secret or names a flag. */
function fieldValue(password: boolean): Redaction {
	return (match) => {
		const text = match[0];
		const separator = /[:=]/u.exec(text)!.index;
		const name = text.slice(0, separator);
		const value = text.slice(separator + 1).trimStart();
		// A value redacted already stays as it is, unless it sits on the next line, as a key block under `key:` does.
		if (value.startsWith(REDACTED) && !text.slice(separator + 1, text.length - value.length).includes("\n"))
			return [];
		if (!holdsSecret(value, /["']/u.test(name), password)) return [];
		const camelCase = match.index > 0 && /[A-Za-z0-9]/u.test(match.input[match.index - 1]!);
		if (camelCase && ORDINARY_CAMEL_CASE_PREFIX.test(camelCasePrefix(match.input, match.index))) return [];
		return [{ start: separator + 1, end: text.trimEnd().length, replacement: ` ${REDACTED}` }];
	};
}

/** First words of `<word>Key` names that name a lookup key rather than a secret. */
const ORDINARY_KEY_PREFIX =
	/^(?:primary|sort|cache|foreign|idempotency|partition|row|hash|lookup|map|index|unique|composite|natural|surrogate|hot|short|shortcut|cursor|group|dedup|dedupe|routing|shard|object|storage|message|event|item|entry|list|translation|i18n|public|query|search|react|license|registry|cache|dict|primary|join|sorting|order|range)$/u;

/** A provider's `<word>Key` field (`openaiKey`, `stripeKey`): redacted when its value looks like a secret. */
const PROVIDER_KEY_FIELD = new RegExp(
	String.raw`(?<![A-Za-z0-9])([a-z][a-z0-9]*)Key(?:\\*["'])?\s*[:=]\s*(?:${QUOTED_VALUE}|[^\s,;}"'&]+)`,
	"gu",
);

/** Whether `value`, unquoted, looks like a secret: eight characters or more with a digit or a symbol, and no space. */
function looksSecret(value: string): boolean {
	const bare = value.replace(/^["']|["']$/gu, "");
	return bare.length >= 8 && /[\d_\-+/=]/u.test(bare) && !/\s/u.test(bare) && !bare.startsWith(REDACTED);
}

const PROVIDER_KEY_VALUE: Redaction = (match) => {
	if (ORDINARY_KEY_PREFIX.test(match[1]!)) return [];
	const separator = /[:=]/u.exec(match[0])!.index;
	if (!looksSecret(match[0].slice(separator + 1).trim())) return [];
	return [{ start: separator + 1, end: match[0].length, replacement: ` ${REDACTED}` }];
};

/**
 * The header of a credential field holding a YAML block scalar. Its block, the lines below it indented deeper than the
 * key, blank lines included, is redacted by {@link BLOCK}.
 */
function blockField(name: string): RegExp {
	return new RegExp(String.raw`${name}["']?[ \t]*:[ \t]*${BLOCK_INDICATOR}`, "gu");
}

/** Width of the leading spaces and tabs of `line`. */
function indentation(line: string): number {
	return line.length - line.trimStart().length;
}

const BLOCK: Redaction = (match) => {
	const input = match.input;
	const lineStart = input.lastIndexOf("\n", match.index) + 1;
	const prefix = input.slice(lineStart, match.index);
	// The key's own column: after the indentation and any YAML list markers (`- password: |`).
	const keyIndent = /^[ \t-]*$/u.test(prefix) ? prefix.length : indentation(prefix);
	const headerEnd = match.index + match[0].length;
	let end = headerEnd;
	for (let lineBreak = input.indexOf("\n", headerEnd); lineBreak !== -1; ) {
		const next = input.indexOf("\n", lineBreak + 1);
		const lineEnd = next === -1 ? input.length : next;
		const line = input.slice(lineBreak + 1, lineEnd).replace(/\r$/u, "");
		if (line.trim() !== "") {
			if (indentation(line) <= keyIndent) break;
			end = lineBreak + 1 + line.length;
		}
		lineBreak = next;
	}
	if (end === headerEnd) return [];
	const indent = " ".repeat(keyIndent + 2);
	return [{ start: match[0].length, end: end - match.index, replacement: `\n${indent}${REDACTED}` }];
};

/** A `Cookie` or `Set-Cookie` header or field name, quoted or not, in any case, and its separator. */
const COOKIE_HEADER = /(?<![A-Za-z0-9-])(set-)?cookie(["']?)[ \t]*:[ \t]*/giu;

/**
 * Whether a bare cookie header at `index` of `input` starts a header: at the start of its line, after a `>` or `<`
 * of `curl -v`, or right after a quote, as in `-H 'Cookie: …'`. The quote, when there is one, ends the header.
 */
function headerQuote(input: string, index: number): string | undefined {
	const before = input.slice(Math.max(0, index - 40), index);
	const quote = /["'`]$/u.exec(before)?.[0];
	if (quote !== undefined) return quote;
	const lineBreak = before.lastIndexOf("\n");
	if (lineBreak === -1 && index > before.length) return undefined;
	return /^[ \t]*(?:[<>*][ \t]*)?$/u.test(before.slice(lineBreak + 1)) ? "" : undefined;
}

/**
 * The values of the cookie pairs in `input` from `from` to `end`, in one pass: every pair of a `Cookie` header, and the
 * first pair of each cookie of a `Set-Cookie` header, where a `,` followed by `name=` starts another cookie (as fetch's
 * `Headers.get` joins them) and the other pairs are attributes such as `Path` and `Expires`. A quoted value ends at its
 * closing quote.
 */
function cookieValues(input: string, from: number, end: number, setCookie: boolean): [number, number][] {
	const values: [number, number][] = [];
	let position = from;
	let first = true;
	while (position < end) {
		let nameEnd = position;
		while (nameEnd < end && !";,=".includes(input[nameEnd]!)) nameEnd++;
		position = nameEnd;
		if (nameEnd < end && input[nameEnd] === "=") {
			let valueEnd = nameEnd + 1;
			if (input[valueEnd] === '"') {
				const closing = input.slice(valueEnd + 1, end).indexOf('"');
				valueEnd = closing === -1 ? end : valueEnd + 1 + closing;
				if (first || !setCookie) values.push([nameEnd + 2, valueEnd]);
				if (valueEnd < end) valueEnd++;
			} else {
				while (valueEnd < end && input[valueEnd] !== ";" && !(setCookie && input[valueEnd] === ",")) valueEnd++;
				const valueStart = nameEnd + 1;
				const trimmed = valueStart + input.slice(valueStart, valueEnd).trimEnd().length;
				if ((first || !setCookie) && trimmed > valueStart && input.slice(valueStart, trimmed).trim() !== "")
					values.push([valueStart, trimmed]);
			}
			position = valueEnd;
		}
		while (position < end && !";,".includes(input[position]!)) position++;
		if (position >= end) break;
		const delimiter = input[position];
		position++;
		first = false;
		if (setCookie && delimiter === ",") {
			let tokenStart = position;
			while (tokenStart < end && input[tokenStart] === " ") tokenStart++;
			let tokenEnd = tokenStart;
			while (tokenEnd < end && !";,= ".includes(input[tokenEnd]!)) tokenEnd++;
			first = tokenEnd > tokenStart && input[tokenEnd] === "=";
		}
	}
	return values;
}

/**
 * The cookie values of a `Cookie` or `Set-Cookie` header, or of a quoted `cookie` field (`{"cookie":"sid=…"}`), with
 * cookie names and attributes kept. A bare header counts only where a header starts, so prose and code stay.
 */
const COOKIE_VALUES: Redaction = (match) => {
	const input = match.input;
	const headerEnd = match.index + match[0].length;
	let quote: string | undefined;
	let from = headerEnd;
	if (match[2] !== "") {
		quote = input[headerEnd];
		if (quote !== '"' && quote !== "'") return [];
		from++;
	} else quote = headerQuote(input, match.index);
	if (quote === undefined) return [];
	const lineEnd = input.indexOf("\n", from);
	let end = lineEnd === -1 ? input.length : lineEnd;
	if (quote !== "") {
		const closing = input.slice(from, end).indexOf(quote);
		if (closing !== -1) end = from + closing;
	}
	return cookieValues(input, from, end, match[1] !== undefined).map(([start, valueEnd]) => ({
		start: start - match.index,
		end: valueEnd - match.index,
		replacement: REDACTED,
	}));
};

/** Option names whose value is a credential, as in `--password X`, `--db-password=X` or `--api-key X`. */
const CREDENTIAL_OPTION = new RegExp(
	String.raw`(?<![\w-])--?(?:[a-z0-9]+-)*(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|client-secret|private-key|auth-token)(?:=|[ \t]+)(?![-<>|])(?:${QUOTED_VALUE}|[^\s"'<>|]+)`,
	"giu",
);
/** A MySQL-style password joined to `-p`: quoted, or unquoted and holding a digit or a symbol. */
const JOINED_PASSWORD_OPTION = new RegExp(String.raw`(?<!\S)-p(?:${QUOTED_VALUE}|[^\s'"]{6,})`, "gu");
/** `curl -u user:password` and `--user user:password`. */
const USER_OPTION = /(?<![\w-])(?:-u|--user)(?:=|[ \t]+)["']?[^\s:"']+:[^\s"']+/gu;
/** A netrc entry: `login user password secret`, on one line or several. */
const NETRC_PASSWORD = /(?<![\w-])login\s+\S+\s+password\s+\S+/gu;

/** The value after an option's last separator, keeping its quotes. */
function valueAfter(start: number, text: string): Replacement[] {
	const quoted = /^["']/u.test(text.slice(start));
	const end = quoted && text.length - start > 1 && text.endsWith(text[start]!) ? text.length - 1 : text.length;
	return [{ start: quoted ? start + 1 : start, end, replacement: REDACTED }];
}

const OPTION_VALUE: Redaction = (match) => {
	const text = match[0];
	const separator = /=|[ \t]+/u.exec(text.slice(2))!;
	return valueAfter(2 + separator.index + separator[0].length, text);
};
const JOINED_PASSWORD: Redaction = (match) => {
	const value = match[0].slice(2);
	if (!/^["']/u.test(value) && !/[^A-Za-z]/u.test(value)) return [];
	return valueAfter(2, match[0]);
};
const USER_PASSWORD: Redaction = (match) => {
	const text = match[0];
	const colon = text.indexOf(":", text.search(/[=\s]/u));
	return [{ start: colon + 1, end: text.length, replacement: REDACTED }];
};
const LAST_WORD: Redaction = (match) => [
	{ start: match[0].search(/\S+$/u), end: match[0].length, replacement: REDACTED },
];

/**
 * A token with a well-known prefix, such as `sk-…` or `token_…`. A snake_case or kebab-case name of three or more short
 * words without a digit, such as `key_value_store_backend_config`, is an identifier and stays.
 */
const PREFIXED_TOKEN = /\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu;
const IDENTIFIER_NAME = /^[a-z]{1,12}(?:[-_][a-z]{1,12}){2,}$/iu;
const PREFIXED_TOKEN_VALUE: Redaction = (match) => (IDENTIFIER_NAME.test(match[0]) ? [] : WHOLE(match));

const CREDENTIAL_SHAPES: readonly (readonly [RegExp, Redaction])[] = [
	[/\bBearer\s+[\w.~+/-]+=*/giu, WHOLE],
	[/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu, WHOLE],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/gu, WHOLE],
	[PREFIXED_TOKEN, PREFIXED_TOKEN_VALUE],
];

/** How far the unquoted value of a password-like field runs. */
const PASSWORD_VALUES: UnquotedValues = {
	json: String.raw`[^\s,;}\]]+`,
	bare: String.raw`[^\r\n]+`,
	env: String.raw`[^\s]+(?:[ \t]+(?![A-Za-z_][\w.-]*=)[^\s]+)*`,
};
const OTHER_RUN = String.raw`[^\s,;}"'&]+`;
const OTHER_VALUES: UnquotedValues = { json: OTHER_RUN, bare: OTHER_RUN, env: OTHER_RUN };

/**
 * Each pattern, in order, with how its matches are redacted. Blocks, cookies and command-line credentials come first,
 * then password-like fields, so a later field on the same line does not end a password's value early.
 */
const STEPS: readonly (readonly [RegExp, Redaction])[] = [
	[PRIVATE_KEY_BLOCK, WHOLE],
	[COOKIE_HEADER, COOKIE_VALUES],
	[CREDENTIAL_OPTION, OPTION_VALUE],
	[JOINED_PASSWORD_OPTION, JOINED_PASSWORD],
	[USER_OPTION, USER_PASSWORD],
	[NETRC_PASSWORD, LAST_WORD],
	[blockField(PASSWORD_NAME), BLOCK],
	[blockField(OTHER_NAME), BLOCK],
	[credentialField(PASSWORD_NAME, PASSWORD_VALUES), fieldValue(true)],
	[credentialField(OTHER_NAME, OTHER_VALUES), fieldValue(false)],
	[PROVIDER_KEY_FIELD, PROVIDER_KEY_VALUE],
	...CREDENTIAL_SHAPES,
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

/**
 * `text` with each match of `pattern`, found with ANSI sequences ignored, redacted as `redaction` says. A replacement
 * that would start inside one already made, as a YAML block's can, is skipped.
 */
function redactMatches(text: string, pattern: RegExp, redaction: Redaction): string {
	const { plain, origin } = withoutAnsi(text);
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let redacted = "";
	let copied = 0;
	let plainCopied = 0;
	for (const match of plain.matchAll(pattern)) {
		for (const { start, end, replacement } of redaction(match)) {
			const from = match.index + start;
			const to = match.index + end;
			if (to <= from || from < plainCopied) continue;
			redacted += text.slice(copied, at(from)) + replacement;
			copied = at(to - 1) + 1;
			plainCopied = to;
		}
	}
	return redacted + text.slice(copied);
}

/**
 * Redact what looks like a credential in `text`: user info in URLs (up to the last `@` of the authority), private key
 * blocks (PEM, OpenSSH and PGP), cookie values in `Cookie` and `Set-Cookie` headers and `cookie` fields, credentials
 * on a command line (`--password X`, `-p'X'`, `-u user:X`) or in a netrc entry, the value of a credential field in
 * JSON (also JSON inside a JSON string), YAML (also a block scalar), HTTP-header or env-style text, and well-known token
 * shapes. A password-like value runs to the end of its own value: its closing quote, the `,` or `}` after a JSON
 * literal, the next `NAME=` of env-style text, or the end of its line after a bare `password:`. Literals, types and
 * code identifiers are left as they are. ANSI styling anywhere does not hide a credential. Every pattern is linear in
 * the length of `text`.
 */
export function redactCredentialShapes(text: string): string {
	return STEPS.reduce(
		(masked, [pattern, redaction]) => redactMatches(masked, pattern, redaction),
		redactUrlCredentials(text),
	);
}
