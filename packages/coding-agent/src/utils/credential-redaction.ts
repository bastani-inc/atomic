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
/**
 * Password-like names that also count capitalized after a letter or digit, as in `dbPassword` or `SMTPPassword`, or
 * upper-case after one, as in `PGPASSWORD`.
 */
const CAMEL_CASE_PASSWORD_NAME = "(?:Password|Passwd|Pwd|Passphrase|PASSWORD|PASSWD|PASSPHRASE)";
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

/** Values that name no secret: literals, and builtin type names of TypeScript and Python. */
const LITERAL =
	/^(?:null|true|false|undefined|none|nil|string|number|boolean|bigint|symbol|object|unknown|any|never|void|str|int|float|bytes|bool|dict|list)$/iu;
/** A generic type such as `Optional[str]`, `Record<string, string>` or `Promise<Token>`. */
const GENERIC_TYPE =
	/^(?:Optional|Union|Record|Array|ReadonlyArray|Promise|List|Dict|Set|Map|Partial|Readonly|Tuple|Sequence|Mapping)[<[]/u;
/** A member access such as `this.token` or `process.env.TOKEN`: code, not a secret. */
const MEMBER_ACCESS =
	/^(?:this|self|process|window|globalThis|options|opts|config|props|state|params|args|ctx|context|req|request|res|response|input|data|env)(?:\.[A-Za-z_$][\w$]*)+$/u;
/** A PascalCase type name, as in `SecretRef` or `AccessToken`. */
const TYPE_NAME = /^(?:[A-Z][a-z]+)+$/u;
/**
 * Type syntax right after a type name: a union, a spaced intersection (a bare `&` joins query parameters), type
 * arguments, an array, an optional, an arrow.
 */
const TYPE_SYNTAX = /^(?:[ \t]*(?:[|<[?]|=>)|[ \t]+&[ \t])/u;
/** Another `name: Type` pair of the same parameter list, before or after a field. */
const OTHER_PARAMETER = /[(,][ \t]*[A-Za-z_$][\w$]*\??[ \t]*:[ \t]*[A-Za-z_$]/u;

/**
 * Whether the PascalCase value of a field that `match` found is a type annotation: type syntax follows it, or
 * it sits in a parameter list (an open `(` on its line before it) that has another `name: Type` pair. It looks at most
 * 120 characters around the field.
 */
function annotatesType(match: RegExpExecArray): boolean {
	const input = match.input;
	const valueEnd = match.index + match[0].length;
	const after = input.slice(valueEnd, valueEnd + 120).split("\n", 1)[0]!;
	if (TYPE_SYNTAX.test(after)) return true;
	const before = input
		.slice(Math.max(0, match.index - 120), match.index)
		.split("\n")
		.at(-1)!;
	const open = before.lastIndexOf("(");
	if (open === -1 || before.indexOf(")", open) !== -1) return false;
	const list = `${before.slice(open)}${after.split(")", 1)[0]}`;
	return OTHER_PARAMETER.test(list);
}

/** Ends of names that always name a credential, whatever word comes before them, as in `nextAuthSecret`. */
const CREDENTIAL_NAME_END =
	/(?:AccessToken|RefreshToken|AuthSecret|ClientSecret|ApiKey|Secret|Password|Passwd|Pwd|Passphrase)$/u;
/** First words of camelCase names that name a flag, a type or a pagination cursor rather than a secret. */
const ORDINARY_CAMEL_CASE_PREFIX =
	/^(?:next|cancel|cancellation|continuation|page|pagination|cursor|has|is|show|hide|use|with|include|requires?|enable|disable|allow|toggle|max|min|num|count|should|can|on|get|set|parse|validate|check|forgot)$/u;

/**
 * Whether the camelCase identifier whose credential name `name` starts at `index` of `input` names a flag, a type or
 * a cursor, as `nextToken` or `hasToken` do: its first word is an ordinary one, and it does not end in a name that
 * always names a credential. It looks at most 64 characters back.
 */
function ordinaryCamelCase(input: string, index: number, name: string): boolean {
	const before = /[A-Za-z0-9]*$/u.exec(input.slice(Math.max(0, index - 64), index))![0];
	const identifier = before + /^[A-Za-z0-9]*/u.exec(name)![0];
	return ORDINARY_CAMEL_CASE_PREFIX.test(/^[a-z]*/u.exec(before)![0]) && !CREDENTIAL_NAME_END.test(identifier);
}

/**
 * Whether `value`, a field's value after its separator, holds a secret: a quoted or escaped value always does; an
 * unquoted one unless it is a builtin type or literal, a generic type, a number after a quoted name, or (for names
 * other than passwords) a member access or a PascalCase type annotation, followed by nothing but closing punctuation.
 * A lone capitalised word, as in `token: CorrectHorse`, is a secret.
 */
function holdsSecret(match: RegExpExecArray, value: string, quotedName: boolean, password: boolean): boolean {
	if (GENERIC_TYPE.test(value)) return false;
	const first = /[^\s,;)}\]]*/u.exec(value)![0];
	const rest = value.slice(first.length).trim();
	if (!/^[,;)}\]]*$/u.test(rest)) return true;
	if (LITERAL.test(first)) return false;
	if (quotedName && /^-?\d+(?:\.\d+)?$/u.test(first)) return false;
	if (password) return true;
	if (MEMBER_ACCESS.test(first)) return false;
	// An array type, `TokenSet[]`, ends its first word at `[`.
	if (first.endsWith("[") && TYPE_NAME.test(first.slice(0, -1))) return false;
	return !(TYPE_NAME.test(first) && annotatesType(match));
}

/** The value of a credential field: from its separator to its end, unless it holds no secret or names a flag. */
function fieldValue(password: boolean): Redaction {
	return (match) => {
		const text = match[0];
		const separator = /[:=]/u.exec(text)!.index;
		const name = text.slice(0, separator);
		const value = text.slice(separator + 1).trimStart();
		// A value redacted already stays as it is, unless it sits on the next line, as a key block under `key:` does.
		if (value.startsWith(REDACTED) && !text.includes("\n")) return [];
		if (!holdsSecret(match, value, /["']/u.test(name), password)) return [];
		if (ordinaryCamelCase(match.input, match.index, name)) return [];
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

/**
 * Whether `value`, unquoted, looks like a secret: eight characters or more with a digit or a symbol, and no space. A
 * path to a file (`uploads/2024/report.pdf`) does not.
 */
function looksSecret(value: string): boolean {
	const bare = value.replace(/^["']|["']$/gu, "");
	if (bare.includes("/") && /\.[A-Za-z0-9]{1,5}$/u.test(bare)) return false;
	return bare.length >= 8 && /[\d_\-+/=]/u.test(bare) && !/\s/u.test(bare);
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

/**
 * A `Cookie` or `Set-Cookie` header or field name, in any case, bare, quoted or escape-quoted (`\"cookie\"`), and its
 * separator: `:`, or `=` / `=>` before a quoted value (logfmt `cookie="…"`, PHP `'Cookie' => '…'`).
 */
const COOKIE_HEADER = /(?<![A-Za-z0-9-])(set-)?cookie(\\*["']?)[ \t]*(:|=>?)[ \t]*/giu;
/** The opening quote of a quoted value, escaped or not. */
const OPENING_QUOTE = /\\*["']/uy;
/** Where the text of a cookie header ends at the latest: its line break or the next cookie header. */
const COOKIE_SEGMENT_END = /\n|(?<![A-Za-z0-9-])(?:set-)?cookie\\*["']?[ \t]*(?::|=>?)/giu;
/** One quoted element of an array of cookies, as in `[ 'sid=…; Path=/', "b=…" ]`, and the `,` after it. */
const ARRAY_ELEMENT = /[ \t]*(?:"([^"\n]*)"|'([^'\n]*)')[ \t]*,?/duy;

/**
 * What may come right before a lower-case `cookie:` header: the start of its line (the text before it starts with a
 * line break), a log prefix ending in `]`, or `>`, `<` or `*` of `curl -v`, `-H`, `headers:` or `{`.
 */
const COOKIE_HEADER_CONTEXT = /(?:\n[ \t]*|\][ \t]*|\s[<>*][ \t]*|\s-H[ \t]*|headers?[ \t]*:[ \t]*|\{[ \t]*)$/iu;

/**
 * Whether a bare cookie header at `index` of `input` is a header, and the quote that ends it: `""` for none, undefined
 * when it is not a header. A `Set-Cookie` header in any case, and a capitalized `Cookie`, are headers anywhere; a
 * lower-case `cookie:` only after a header context, or right after a quote, so `My favourite cookie: oatmeal=great`
 * stays prose. It looks at most 40 characters back.
 */
function headerQuote(input: string, index: number, anywhere: boolean): string | undefined {
	const before = index > 40 ? input.slice(index - 40, index) : `\n${input.slice(0, index)}`;
	const quote = /["'`]$/u.exec(before)?.[0];
	if (quote !== undefined) return quote;
	return anywhere || COOKIE_HEADER_CONTEXT.test(before) ? "" : undefined;
}

/**
 * A cookie pair: its name, then after `=` a quoted value or an unquoted one (after any leading spaces, up to
 * whitespace, `,`, `;`, `"`, `\`, `}` or `)`), then the rest of the pair up to its `;` or `,`.
 */
const COOKIE_PAIR = /([^;,=]*)(?:=(?:"([^"]*)"?|([ \t]*[^;,\s"\\})]+)))?[^;,]*[;,]?/dgu;
/** A cookie name a `,` of joined `Set-Cookie` headers is followed by when it starts another cookie. */
const NEXT_COOKIE = /^ *[^;,= ]+=/u;

/**
 * The values of the cookie pairs of `segment`, as `[start, end)` offsets in it, in one pass: every pair of a `Cookie`
 * header, and the first pair of each cookie of a `Set-Cookie` header, where a `,` followed by `name=` starts another
 * cookie (as fetch's `Headers.get` joins them) and the other pairs are attributes such as `Path` and `Expires`.
 */
function cookieValues(segment: string, setCookie: boolean): [number, number][] {
	const values: [number, number][] = [];
	let first = true;
	for (const pair of segment.matchAll(COOKIE_PAIR)) {
		const value = pair.indices![2] ?? pair.indices![3];
		if (value !== undefined && value[1] > value[0] && (first || !setCookie)) values.push(value);
		first = pair[0].endsWith(",") && NEXT_COOKIE.test(segment.slice(pair.index + pair[0].length));
	}
	return values;
}

/** The cookie values of `input` from `from` to `end`, as replacements of a match at `index`. */
function cookieReplacements(
	input: string,
	from: number,
	end: number,
	setCookie: boolean,
	index: number,
): Replacement[] {
	return cookieValues(input.slice(from, end), setCookie).map(([start, valueEnd]) => ({
		start: from + start - index,
		end: from + valueEnd - index,
		replacement: REDACTED,
	}));
}

/** The cookie values of each quoted element of the array that starts at `from`, which ends no later than `end`. */
function arrayCookieReplacements(
	input: string,
	from: number,
	end: number,
	setCookie: boolean,
	index: number,
): Replacement[] {
	const replacements: Replacement[] = [];
	ARRAY_ELEMENT.lastIndex = from + 1;
	for (
		let element = ARRAY_ELEMENT.exec(input);
		element !== null && element.index < end;
		element = ARRAY_ELEMENT.exec(input)
	) {
		const [start, elementEnd] = element.indices![1] ?? element.indices![2]!;
		replacements.push(...cookieReplacements(input, start, elementEnd, setCookie, index));
	}
	return replacements;
}

/**
 * The cookie values of a `Cookie` or `Set-Cookie` header, of a quoted `cookie` field (`{"cookie":"sid=…"}`, also
 * escape-quoted or holding an array of cookies), or of `cookie="…"` and `'Cookie' => '…'`, with cookie names and
 * attributes kept. A bare header counts only where a header starts, so prose and code stay. A quoted value ends at its
 * closing quote, before any backslashes that escape it. The text a header reads ends at its line break or the next
 * cookie header, so the whole scan is linear.
 */
const COOKIE_VALUES: Redaction = (match) => {
	const input = match.input;
	const setCookie = match[1] !== undefined;
	let from = match.index + match[0].length;
	COOKIE_SEGMENT_END.lastIndex = from;
	const end = COOKIE_SEGMENT_END.exec(input)?.index ?? input.length;
	if (input[from] === "[" && (match[2] !== "" || match[3] !== ":")) {
		return arrayCookieReplacements(input, from, end, setCookie, match.index);
	}
	OPENING_QUOTE.lastIndex = from;
	const opening = OPENING_QUOTE.exec(input)?.[0];
	let quote: string | undefined;
	if (match[2] !== "" || match[3] !== ":") {
		quote = opening?.at(-1);
		from += opening?.length ?? 0;
	} else {
		const anywhere = setCookie || match[0].startsWith("C");
		quote = headerQuote(input, match.index, anywhere);
		// A lower-case `cookie: "…"` outside quotes is code, such as `{ cookie: "theme=dark" }`.
		if (!anywhere && opening !== undefined) quote = undefined;
	}
	if (quote === undefined) return [];
	let segmentEnd = end;
	if (quote !== "") {
		const closing = input.slice(from, end).indexOf(quote);
		if (closing !== -1) segmentEnd = from + closing;
		while (segmentEnd > from && input[segmentEnd - 1] === "\\") segmentEnd--;
	}
	return cookieReplacements(input, from, segmentEnd, setCookie, match.index);
};

/** A `--cookie` or curl `-b` option and its cookies, quoted or not: `--cookie sid=X` or `-b "a=1; b=2"`. */
const COOKIE_OPTION = /(?<![\w-])(?:--cookie|-b)(?:=|[ \t]+)(?:"([^"\n]*)"?|'([^'\n]*)'?|([^\s"']+))/dgu;

/** The cookie values of a `--cookie` or `-b` option. A file name, with no `=`, stays. */
const COOKIE_OPTION_VALUES: Redaction = (match) => {
	const [from, end] = match.indices![1] ?? match.indices![2] ?? match.indices![3]!;
	return cookieReplacements(match.input, from, end, false, match.index);
};

/** Each non-empty capture group of a match, replaced. */
const GROUPS: Redaction = (match) =>
	match
		.indices!.slice(1)
		.flatMap((group) =>
			group !== undefined && group[1] > group[0]
				? [{ start: group[0] - match.index, end: group[1] - match.index, replacement: REDACTED }]
				: [],
		);

/** An option's value, quoted (its quotes kept) or not. */
const OPTION_VALUE_GROUPS = String.raw`(?:"([^"\n]*)"?|'([^'\n]*)'?|([^\s"'<>|]+))`;
/** Option names whose value is a credential, as in `--password X`, `--db-password=X` or `--api-key X`. */
const CREDENTIAL_OPTION = new RegExp(
	String.raw`(?<![\w-])--?(?:[a-z0-9]+-)*(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|client-secret|private-key|auth-token)(?:=|[ \t]+)(?![-<>|])${OPTION_VALUE_GROUPS}`,
	"dgiu",
);
/**
 * A MySQL-style password joined to `-p`: quoted, or unquoted, six characters or more, holding a digit or a symbol. A
 * port mapping (`-p8080:80`, `-p127.0.0.1:80:80/tcp`) or a path (`mkdir -p/tmp/a`) is not one.
 */
const JOINED_PASSWORD_OPTION =
	/(?<!\S)-p(?:"([^"\n]*)"?|'([^'\n]*)'?|(?![\d.:]+(?:\/[a-z]+)?(?![^\s'"]))(?![/.~])(?=[^\s'"]{6})([A-Za-z]*[^\sA-Za-z'"][^\s'"]*))/dgu;
/** `curl -u user:password` and `--user user:password`; a numeric id pair such as `-u 1000:1000` is not one. */
const USER_OPTION = /(?<![\w-])(?:-u|--user)(?:=|[ \t]+)["']?[^\s:"']+:(?!\d+(?![^\s"']))([^\s"']+)/dgu;
/** A netrc entry, `[machine host] login user password secret` from the start of a line, on one line or several. */
const NETRC_PASSWORD = /(?<![^\n])[ \t]*(?:machine[ \t]+\S+\s+)?login\s+\S+\s+password\s+(\S+)/dgu;

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

/**
 * A run of an env-style password: past a `;` unless the `;` ends a connection-string field, that is, comes before
 * another `Name=` (`User Id=`), the end of the line or the end of the text.
 */
const ENV_RUN = String.raw`(?:[^\s;]|;(?![ \t]*(?:[A-Za-z_][\w .-]*=|\r?\n|$)))+`;

/** How far the unquoted value of a password-like field runs. */
const PASSWORD_VALUES: UnquotedValues = {
	json: String.raw`[^\s,;}\]]+`,
	bare: String.raw`[^\r\n]+`,
	env: String.raw`${ENV_RUN}(?:[ \t]+(?![A-Za-z_][\w.-]*=)${ENV_RUN})*`,
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
	[COOKIE_OPTION, COOKIE_OPTION_VALUES],
	[CREDENTIAL_OPTION, GROUPS],
	[JOINED_PASSWORD_OPTION, GROUPS],
	[USER_OPTION, GROUPS],
	[NETRC_PASSWORD, GROUPS],
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
		// A match inside text already replaced, as a header in a YAML block above it is, is skipped unread.
		if (match.index < plainCopied) continue;
		for (const { start, end, replacement } of redaction(match)) {
			const from = match.index + start;
			const to = match.index + end;
			if (from < plainCopied) continue;
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
