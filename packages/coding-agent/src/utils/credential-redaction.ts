import { redactUrlCredentials } from "../core/error-contract.ts";
import {
	isAsciiWordCode,
	isJsWhitespaceCode,
	isLineTerminatorCode,
	matchesAsciiCaseInsensitiveAt,
} from "./linear-text.js";

const REDACTED = "[redacted]";

/**
 * An ANSI CSI sequence, such as the styling `jq -C` or a terminal-aware CLI puts around a field name, its separator,
 * an authorization scheme or a value, or an OSC sequence such as an OSC 8 hyperlink. Patterns match text with these
 * removed, and redaction maps back to the text.
 */
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;

/** The header of a private key block. {@link PRIVATE_KEY_BLOCK_VALUE} redacts it to its footer, or to the end. */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu;
/** The footer of a private key block. */
const PRIVATE_KEY_FOOTER = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu;

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
const QUOTED_VALUE = String.raw`"[^"\\\n]*(?:(?:\\.|"")[^"\\\n]*)*"?|'[^'\\\n]*(?:(?:\\.|'')[^'\\\n]*)*'?`;
/**
 * A value quoted with escaped quotes, as in JSON inside a JSON string (`\"value\"`). Its escapes are escaped too: `\\`
 * followed by an escaped quote or backslash, or by another character, is one escape, so `\\\"` does not end it. A
 * value nested deeper runs to the next quote.
 */
const ESCAPED_QUOTED_VALUE = String.raw`\\"[^"\\\n]*(?:\\\\(?:\\["\\]|[^\\\n])[^"\\\n]*)*(?:\\")?|\\{2,}"[^"\n]*"?`;
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
	const scheme = String.raw`(?:${CREDENTIAL_AUTH_SCHEME}[ \t]+)?`;
	// A value stays on its line; only a bare `name:` that ends its line may have it alone on the next, indented line,
	// as a YAML plain scalar does, which {@link continuedOnNextLine} checks.
	const nextLine = String.raw`(?:\r?\n[ \t]+)?`;
	// `=` is not `==`, `=>` or `=~`, and spaces after it are not followed by the next `NAME=` (`PASSWORD= PORT=8080`).
	const equals = String.raw`=(?![=>~])(?:[ \t]+(?![A-Za-z_][\w.-]*=))?`;
	return new RegExp(
		String.raw`${name}(?:\\*["'][ \t]*:[ \t]*${value(unquoted.json)}|[ \t]*:(?![ \t]*${BLOCK_INDICATOR})[ \t]*${nextLine}${value(scheme + unquoted.bare)}|(?:\\*["'])?[ \t]*${equals}${value(unquoted.env)})`,
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
/** Generic type names whose arguments can show a value is a type, as in `Optional[str]` or `Record<string, Token>`. */
const GENERIC_NAME =
	/^(?:Optional|Union|Record|Array|ReadonlyArray|Promise|List|Dict|Set|Map|Partial|Readonly|Tuple|Sequence|Mapping)$/u;
/** A type argument that names a type: a builtin type name, or a digit-free PascalCase name of at most 40 characters. */
const TYPE_ARGUMENT = /^[A-Z][A-Za-z]{0,39}$/u;
/** Most characters of a value read as a generic type. */
const MAX_GENERIC_LENGTH = 200;
/** A type name in a generic, and what follows it: an opening bracket, a separator or a closing bracket. */
const GENERIC_TOKEN = /[ \t]*([A-Za-z_]\w*)[ \t]*([<[,>\]]?)/uy;

/**
 * Whether `text` starts with a generic type whose every argument names a type, as in `Optional[str]`,
 * `Map<string, AuthToken>` or `Record<string, Array<Token>>`, and ends there: at the end of the text, whitespace or
 * `,`, `;`, `)`, `}` or `=`. One pass over at most {@link MAX_GENERIC_LENGTH} characters.
 */
function isGenericType(text: string): boolean {
	const closers: string[] = [];
	let position = 0;
	for (;;) {
		GENERIC_TOKEN.lastIndex = position;
		const token = GENERIC_TOKEN.exec(text);
		if (token === null || position > MAX_GENERIC_LENGTH) return false;
		const [, name, next] = token as unknown as [string, string, string];
		position = GENERIC_TOKEN.lastIndex;
		if (next === "<" || next === "[") {
			if (!GENERIC_NAME.test(name)) return false;
			closers.push(next === "<" ? ">" : "]");
			continue;
		}
		if (closers.length === 0 || !(LITERAL.test(name) || TYPE_ARGUMENT.test(name))) return false;
		let closer = next;
		while (closer === closers.at(-1)) {
			closers.pop();
			if (closers.length === 0) return /^(?:$|[\s,;)}=])/u.test(text.slice(position, position + 1));
			closer = text[position] ?? "";
			if (closer === closers.at(-1)) position++;
			else if (closer === ",") position++;
		}
		if (closer !== ",") return false;
	}
}
/** A member access such as `this.token` or `process.env.TOKEN`: code, not a secret. */
const MEMBER_ACCESS =
	/^(?:this|self|process|window|globalThis|options|opts|config|props|state|params|args|ctx|context|req|request|res|response|input|data|env)(?:\.[A-Za-z_$][\w$]*)+$/u;
/**
 * A run of letters and digits that reads as random rather than as an identifier: three or more runs of digits between
 * letters, as in a generated token. `sha256Hex` or `v1Beta2` is a name.
 */
const RANDOM_SEGMENT = /\d+[A-Za-z]+\d+[A-Za-z]+\d/u;

/** Whether `value` is a member access whose names read as identifiers, as `data.apiKey` does and `data.<token>` not. */
function isMemberAccess(value: string): boolean {
	return MEMBER_ACCESS.test(value) && !RANDOM_SEGMENT.test(value);
}

/**
 * A value that stands for one: an angle-bracketed description (`<set to the key 'password' in secret 'db'>`), a word
 * that says the value is not shown or not set, or a run of masking characters.
 */
const PLACEHOLDER_VALUE =
	/^(?:<[^<>\n]{1,200}>|\(?(?:not set|unset|none|empty|hidden|masked|redacted|required|optional)\)?|\*{3,}|•{3,}|x{3,}|X{3,}|\.{3}|…)$/u;
/** A PascalCase type name, as in `SecretRef` or `AccessToken`. */
const TYPE_NAME = /^(?:[A-Z][a-z]+)+$/u;
/** A line of code that declares something, from its indentation: `interface`, `const`, `def`, `private` and so on. */
const DECLARATION_LINE =
	/^[ \t]*(?:interface|type|const|let|var|def|function|class|export|readonly|public|private|protected)\b/u;
/** Another `name: type` pair of the same parameter list whose type is builtin, as in `(user: string, …)`. */
const BUILTIN_PARAMETER =
	/[(,][ \t]*[A-Za-z_$][\w$]*\??[ \t]*:[ \t]*(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|undefined|null|str|int|float|bytes|bool|dict|list)\b/u;
/** How far around a field a code context is looked for. */
const CODE_CONTEXT_LENGTH = 120;

/** The text of the line of `input` before `index`, at most {@link CODE_CONTEXT_LENGTH} characters of it. */
function lineBefore(input: string, index: number): string {
	const start = Math.max(0, index - CODE_CONTEXT_LENGTH);
	const before = input.slice(start, index);
	const lineBreak = before.lastIndexOf("\n");
	return lineBreak === -1 && start > 0 ? "" : before.slice(lineBreak + 1);
}

/** The open parameter list before a field: the text from the last unclosed `(` of its line, or undefined. */
function openParameterList(input: string, index: number): string | undefined {
	const before = lineBefore(input, index);
	const open = before.lastIndexOf("(");
	return open === -1 || before.includes(")", open) ? undefined : before.slice(open);
}

/**
 * Whether the PascalCase value of a field that `match` found sits in code: its line declares something (`interface`,
 * `const`, `def`, `private` …), or it is in a parameter list with another pair of a builtin type, as in
 * `login(user: string, token: AuthToken)`.
 */
function inCodeContext(match: RegExpExecArray): boolean {
	const input = match.input;
	if (DECLARATION_LINE.test(lineBefore(input, match.index))) return true;
	const list = openParameterList(input, match.index);
	if (list === undefined) return false;
	const valueEnd = match.index + match[0].length;
	const after = input.slice(valueEnd, valueEnd + CODE_CONTEXT_LENGTH).split(/[)\n]/u, 1)[0]!;
	return BUILTIN_PARAMETER.test(`${list}${after}`);
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
function holdsSecret(
	match: RegExpExecArray,
	valueStart: number,
	value: string,
	quotedName: boolean,
	password: boolean,
): boolean {
	if (isGenericType(match.input.slice(valueStart, valueStart + MAX_GENERIC_LENGTH + 2))) return false;
	if (/^<[^<>\n]{1,200}>/u.test(match.input.slice(valueStart, valueStart + 202))) return false;
	if (PLACEHOLDER_VALUE.test(value.replace(/[,;.]$/u, ""))) return false;
	const first = /[^\s,;)}\]]*/u.exec(value)![0];
	const rest = value.slice(first.length).trim();
	// Closing punctuation may follow, and a `:` after a parameter list (`def f(token: AuthToken):`).
	if (!/^[,;)}\]]*:?$/u.test(rest)) return true;
	if (LITERAL.test(first)) return false;
	// A number is a count or a duration, as in `"token": 3600`, but a password of digits is still one.
	if (!password && quotedName && /^-?\d+(?:\.\d+)?$/u.test(first)) return false;
	if (isMemberAccess(first)) return false;
	if (password) return true;
	// An array type, `TokenSet[]`, ends its first word at `[`.
	const typeName = first.endsWith("[") ? first.slice(0, -1) : first;
	return !(TYPE_NAME.test(typeName) && inCodeContext(match));
}

/**
 * Whether the value of a bare `name:` that ends its line, found alone on the next line, is that line's whole text and
 * is indented deeper than the name, as a YAML plain scalar continues: `token:` followed by `  <value>`. Code on the next
 * line, as after a Python `def f() -> Token:`, is not a value.
 */
function continuedOnNextLine(match: RegExpExecArray, valueOffset: number): boolean {
	const input = match.input;
	const lineStart = input.lastIndexOf("\n", match.index) + 1;
	const valueStart = match.index + valueOffset;
	const valueLineStart = input.lastIndexOf("\n", valueStart) + 1;
	const valueLineEnd = input.indexOf("\n", valueStart);
	const valueLine = input.slice(valueLineStart, valueLineEnd === -1 ? input.length : valueLineEnd).replace(/\r$/u, "");
	const keyIndent = indentation(input.slice(lineStart, match.index));
	return (
		indentation(valueLine) > keyIndent &&
		valueLine.trim() === match[0].slice(valueOffset).trim() &&
		/^[^\s:=()]+$/u.test(valueLine.trim())
	);
}

/** A sentence that ends inside a bare password value: `.`, `!` or `?`, then a capitalized word. */
const SENTENCE_END = /[.!?](?=[ \t]+[A-Z][a-z])/u;
/** Words of the prose that describes a password rather than holds one, as in `Password: must be 8+ characters`. */
const PROSE_WORD =
	/^(?:a|an|the|is|are|be|been|was|must|should|will|can|cannot|may|not|no|to|of|for|in|on|at|by|and|or|with|without|your|you|it|its|this|that|see|below|above|least|more|than|include|includes|contain|contains|characters?|letters?|digits?|numbers?|symbols?|long|minimum|maximum|required|optional|use|uses|set|stored|saved|sent|shown|hidden|empty)$/iu;
/** Fewest words of a bare password value that can read as prose. */
const MIN_PROSE_WORDS = 4;

/**
 * Whether a bare password value reads as prose about the password: four words or more, at least half of them words
 * such as "must", "be" or "characters". A passphrase such as `correct horse battery staple` does not.
 */
function describesPassword(value: string): boolean {
	const words = value.split(/[\s,;:()]+/u).filter((word) => word !== "");
	if (words.length < MIN_PROSE_WORDS) return false;
	return words.filter((word) => PROSE_WORD.test(word.replace(/[.!?]$/u, ""))).length * 2 >= words.length;
}

/** The value of a credential field: from its separator to its end, unless it holds no secret or names a flag. */
function fieldValue(password: boolean): Redaction {
	return (match) => {
		const text = match[0];
		const separator = /[:=]/u.exec(text)!.index;
		const name = text.slice(0, separator);
		// A name and separator in inline code, as in "Set `password:` in config.yaml", has no value.
		if (match.input[match.index - 1] === "`" && text[separator + 1] === "`") return [];
		const afterSeparator = text.slice(separator + 1);
		// A value alone on the next line is replaced where it stands, keeping the line break and indentation.
		let replaceFrom = separator + 1;
		let replacement = ` ${REDACTED}`;
		if (/^[ \t]*\r?\n/u.test(afterSeparator)) {
			replaceFrom += /^\s*/u.exec(afterSeparator)![0].length;
			replacement = REDACTED;
			if (!continuedOnNextLine(match, replaceFrom)) return [];
		}
		let end = text.trimEnd().length;
		// A bare password ends where a sentence does, as in `Password: x. Change it soon`.
		if (password && text[separator] === ":" && !/^\s*["'\\]/u.test(afterSeparator)) {
			const sentence = afterSeparator.search(SENTENCE_END);
			if (sentence > 0) end = Math.min(end, separator + 1 + sentence);
		}
		// An unquoted password inside a parameter list ends at the next `,` or `)`, as `f(password: x, timeout = 30)`.
		const unquoted = !/^\s*["'\\]/u.test(text.slice(separator + 1));
		if (password && unquoted && openParameterList(match.input, match.index) !== undefined) {
			const stop = text.slice(separator + 1).search(/[,)]/u);
			if (stop !== -1) end = separator + 1 + stop;
		}
		const value = text.slice(separator + 1, end).trimStart();
		// A value redacted already stays as it is.
		if (value.startsWith(REDACTED)) return [];
		if (password && text[separator] === ":" && !/^["'\\]/u.test(value) && describesPassword(value)) return [];
		if (!holdsSecret(match, match.index + end - value.length, value, /["']/u.test(name), password)) return [];
		if (ordinaryCamelCase(match.input, match.index, name)) return [];
		return [{ start: replaceFrom, end, replacement }];
	};
}

/** First words of `<word>Key` names that name a lookup key rather than a secret. */
const ORDINARY_KEY_PREFIX =
	/^(?:primary|sort|cache|foreign|idempotency|partition|row|hash|lookup|map|index|unique|composite|natural|surrogate|hot|short|shortcut|cursor|group|dedup|dedupe|routing|shard|object|storage|message|event|item|entry|list|translation|i18n|public|query|search|react|license|registry|cache|dict|primary|join|sorting|order|range)$/u;

/** A provider's `<word>Key` field (`openaiKey`, `stripeKey`): redacted when its value looks like a secret. */
const PROVIDER_KEY_FIELD = new RegExp(
	String.raw`(?<![A-Za-z0-9])([a-z][a-z0-9]*)Key(?:\\*["'])?[ \t]*[:=][ \t]*(?:${QUOTED_VALUE}|[^\s,;}"'&]+)`,
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
 * Where a header starts: the start of its line (the text before it starts with a line break), a log prefix ending in
 * `]`, or `>`, `<` or `*` of `curl -v`, `-H`, `headers:` or `{`.
 */
const COOKIE_HEADER_CONTEXT = /(?:\n[ \t]*|\][ \t]*|\s[<>*][ \t]*|\s-H[ \t]*|headers?[ \t]*:[ \t]*|\{[ \t]*)$/iu;

/** Where a cookie header is read: as a header, where every value is redacted, or as prose or code. */
type CookieContext = "header" | "prose";

/** An example in prose: an opening parenthesis, as in `(e.g. Set-Cookie: lang=en-US)` or `(for example …`. */
const EXAMPLE_CONTEXT = /\((?:[ \t]*(?:e\.g\.|i\.e\.|eg|ie|for example|for instance|such as|like)[,:]?)?[ \t]*$/iu;

/**
 * Whether a bare cookie header at `index` of `input` is read as a header, and the quote that ends it: `""` for none.
 * One right after `"` or `'` is a header in a string, and one after a backtick is inline code in documentation. A
 * `Set-Cookie` header in any case, and a capitalized `Cookie`, are headers anywhere else but in an example in
 * parentheses, such as `(e.g. Set-Cookie: lang=en-US)`; a lower-case `cookie:` only where a header starts. It looks at
 * most 40 characters back.
 */
function headerQuote(
	input: string,
	index: number,
	anywhere: boolean,
): { readonly quote: string; readonly context: CookieContext } {
	const before = index > 40 ? input.slice(index - 40, index) : `\n${input.slice(0, index)}`;
	const quote = /["'`]$/u.exec(before)?.[0];
	if (quote !== undefined) return { quote, context: quote === "`" ? "prose" : "header" };
	const header = anywhere ? !EXAMPLE_CONTEXT.test(before) : COOKIE_HEADER_CONTEXT.test(before);
	return { quote: "", context: header ? "header" : "prose" };
}

/** A cookie value that stands for one in documentation: `value`, `<value>`, `...`, `xxx`, `***` or a variable. */
const PLACEHOLDER_COOKIE = /^(?:value|<[^<>]*>|\.\.\.|…|x{3,}|X{3,}|\*{3,}|\$\{?[\w.]+\}?|\{\{?[\w. ]+\}?\})$/u;

/**
 * Whether a cookie value in prose or code looks generated: eight characters or more with a letter and a digit, and not
 * a path. `dark`, `en-US` or `31536000` does not.
 */
function generatedCookieValue(value: string): boolean {
	return value.length >= 8 && /[A-Za-z]/u.test(value) && /\d/u.test(value) && !value.includes("/");
}

/**
 * A cookie pair: its name, then after `=` a quoted value or an unquoted one (after any leading spaces, up to
 * whitespace, `,`, `;`, `"` or `)`, a `}` that ends it, as in `{cookie: sid=x}`, or a backslash that starts an escape
 * such as `\n` or `\"`), then the rest of the pair up to its `;` or `,`.
 */
const COOKIE_PAIR =
	/([^;,=]*)(?:=(?:"([^"]*)"?|([ \t]*(?=[^;,\s"\\)}]|\\(?![rntbfu"\\/])|\}(?=[^;,\s"\\)]))[^;,\s"\\)}]*(?:(?:\\(?![rntbfu"\\/])|\}(?=[^;,\s"\\)]))[^;,\s"\\)}]*)*)))?[^;,]*[;,]?/dgu;
/** A cookie name a `,` of joined `Set-Cookie` headers is followed by when it starts another cookie. */
const NEXT_COOKIE = /^ *[^;,= ]+=/u;

/**
 * The values of the cookie pairs of `segment`, as `[start, end)` offsets in it, in one pass: every pair of a `Cookie`
 * header, and the first pair of each cookie of a `Set-Cookie` header, where a `,` followed by `name=` starts another
 * cookie (as fetch's `Headers.get` joins them) and the other pairs are attributes such as `Path` and `Expires`.
 */
function cookieValues(segment: string, setCookie: boolean, context: CookieContext): [number, number][] {
	const values: [number, number][] = [];
	let first = true;
	for (const pair of segment.matchAll(COOKIE_PAIR)) {
		const value = pair.indices![2] ?? pair.indices![3];
		const text = value === undefined ? "" : segment.slice(value[0], value[1]).trim();
		const secret =
			text !== "" && !PLACEHOLDER_COOKIE.test(text) && (context === "header" || generatedCookieValue(text));
		if (value !== undefined && secret && (first || !setCookie)) values.push(value);
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
	context: CookieContext = "header",
): Replacement[] {
	return cookieValues(input.slice(from, end), setCookie, context).map(([start, valueEnd]) => ({
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
	let context: CookieContext = "header";
	if (match[2] !== "" || match[3] !== ":") {
		quote = opening?.at(-1);
		from += opening?.length ?? 0;
		// A property assigned in code, as `document.cookie = "theme=dark; path=/"`, is read as code.
		if (match[2] === "" && input[match.index - 1] === ".") context = "prose";
	} else {
		const anywhere = setCookie || match[0].startsWith("C");
		({ quote, context } = headerQuote(input, match.index, anywhere));
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
	return cookieReplacements(input, from, segmentEnd, setCookie, match.index, context);
};

/** A `--cookie` or curl `-b` option and its cookies, quoted or not: `--cookie sid=X` or `-b "a=1; b=2"`. */
const COOKIE_OPTION = /(?<![\w-])(?:--cookie|-b)(?:=|[ \t]+)(?:"([^"\n]*)"?|'([^'\n]*)'?|([^\s"']+))/dgu;

/** The cookie values of a `--cookie` or `-b` option. A file name, with no `=`, stays. */
const COOKIE_OPTION_VALUES: Redaction = (match) => {
	const [from, end] = match.indices![1] ?? match.indices![2] ?? match.indices![3]!;
	return cookieReplacements(match.input, from, end, false, match.index);
};

/** A private key block, from its header to its footer, or to the end of the text when it has none. */
const PRIVATE_KEY_BLOCK_VALUE: Redaction = (match) => {
	PRIVATE_KEY_FOOTER.lastIndex = match.index + match[0].length;
	const footer = PRIVATE_KEY_FOOTER.exec(match.input);
	const end = footer === null ? match.input.length : footer.index + footer[0].length;
	return [{ start: 0, end: end - match.index, replacement: REDACTED }];
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
/**
 * A value that starts with `-` and still reads as a secret rather than the next option: eight characters or more with
 * a digit, a lower-case and an upper-case letter, as in `--password -<generated>`; `-h127.0.0.1` or `-v` does not.
 */
const DASHED_SECRET = String.raw`-(?=[^\s"'<>|]*\d)(?=[^\s"'<>|]*[a-z])(?=[^\s"'<>|]*[A-Z])[^-\s"'<>|][^\s"'<>|]{6}`;
/** Option names whose value is a credential, as in `--password X`, `--db-password=X` or `--api-key X`. */
const CREDENTIAL_OPTION = new RegExp(
	String.raw`(?<![\w-])--?(?:[a-z0-9]+-)*(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|client-secret|private-key|auth-token)(?:=|[ \t]+)(?:(?![-<>|])|(?=${DASHED_SECRET}))${OPTION_VALUE_GROUPS}`,
	"dgiu",
);
/**
 * A MySQL-style password joined to `-p`: quoted, or unquoted, six characters or more, holding a digit or a symbol, or
 * (group 4) of letters only. A port mapping (`-p8080:80`, `-p127.0.0.1:80:80/tcp`) or a path (`mkdir -p/tmp/a`) is not
 * one.
 */
const JOINED_PASSWORD_OPTION =
	/(?<!\S)-p(?:"([^"\n]*)"?|'([^'\n]*)'?|(?![\d.:]+(?:\/[a-z]+)?(?![^\s'"]))(?![/.~])(?=[^\s'"]{6})([A-Za-z]*[^\sA-Za-z'"][^\s'"]*)|([A-Za-z]{6,})(?![^\s'"]))/dgu;
/** A MySQL or MariaDB client, or a `-u` user option, before a `-p` on its line. */
const MYSQL_CONTEXT = /(?:\b(?:mysql|mariadb)|(?<!\S)-u\S)/u;
/** How far back on its line a MySQL client is looked for. */
const MYSQL_CONTEXT_LENGTH = 200;

/**
 * The password of a `-p` option. One of letters only, which could as well be a flag such as `-pthread`, counts only
 * after a MySQL or MariaDB client or a `-u` option on its line.
 */
const JOINED_PASSWORD: Redaction = (match) => {
	if (match.indices![4] !== undefined) {
		const before = match.input.slice(Math.max(0, match.index - MYSQL_CONTEXT_LENGTH), match.index);
		if (!MYSQL_CONTEXT.test(before.slice(before.lastIndexOf("\n") + 1))) return [];
	}
	return GROUPS(match);
};
/** A registry login's `-p password`, as in `docker login -u bob -p X`: elsewhere `-p` is usually a port. */
const REGISTRY_LOGIN_PASSWORD =
	/\b(?:docker|podman|nerdctl|buildah|skopeo|oras|helm(?:[ \t]+registry)?)[ \t]+login\b[^\n]{0,200}?(?<!\S)-p[ \t]+(?:"([^"\n]*)"?|'([^'\n]*)'?|([^\s"']+))/dgu;
/**
 * `curl -u user:password`, `curl -uuser:password` and `--user user:password`; a numeric id pair such as
 * `-u 1000:1000` is not one.
 */
const USER_OPTION = /(?<![\w-])(?:-u(?:=|[ \t]+)?|--user(?:=|[ \t]+))["']?[^\s:"']+:(?!\d+(?![^\s"']))([^\s"']+)/dgu;
/**
 * A netrc entry: `machine host` or `default`, then any of `login`, `account` and `port` in any order, then `password
 * secret`, on one line or several; or, from the start of a line, `login user password secret` that ends its line or
 * comes before another netrc keyword, so prose such as "login bob password reset failed" stays.
 */
const NETRC_PASSWORD =
	/(?<![^\n])[ \t]*(?:(?:machine[ \t]+\S+|default)(?:\s+(?:login|account|port)\s+\S+)*\s+password\s+(\S+)|login\s+\S+\s+password[ \t]+(\S+)(?=[ \t]*(?:\r?\n|$|(?:machine|default|account|macdef)\s)))/dgu;

/**
 * A token with a well-known prefix, such as `sk-…` or `token_…`. A snake_case or kebab-case name of three or more short
 * words without a digit, such as `key_value_store_backend_config`, is an identifier and stays.
 */
const PREFIXED_TOKEN = /\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu;
const IDENTIFIER_NAME = /^[a-z]{1,12}(?:[-_][a-z]{1,12}){2,}$/iu;
const PREFIXED_TOKEN_VALUE: Redaction = (match) => (IDENTIFIER_NAME.test(match[0]) ? [] : WHOLE(match));

const CREDENTIAL_SHAPES: readonly (readonly [RegExp, Redaction])[] = [
	[/\bBearer[ \t]+[\w.~+/-]+=*/giu, WHOLE],
	[/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu, WHOLE],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/gu, WHOLE],
	[PREFIXED_TOKEN, PREFIXED_TOKEN_VALUE],
];

/**
 * Keywords of connection-string fields (ADO.NET, ODBC, JDBC, libpq, Azure Storage): a `;` before one of them ends a
 * password, while a `;` before another `name=` is part of it, as in `Password=ab;cd=…`.
 */
const CONNECTION_KEYWORD = caseless(
	String.raw`(?:server|data source|address|addr|network address|host|hostname|port|database|initial catalog|dbname|db|user ?id|uid|user ?name|user|pwd|password|encrypt|trust ?server ?certificate|trusted_connection|integrated security|persist security info|connect(?:ion)? ?timeout|timeout|command timeout|application ?name|app|application ?intent|multiple ?active ?result ?sets|multi ?subnet ?failover|pooling|min pool size|max pool size|provider|driver|dsn|attach ?db ?filename|authentication|workstation id|packet size|failover partner|charset|ssl ?mode|sslrootcert|sslcert|sslkey|options|schema|search_path|account ?name|account ?key|default ?endpoints ?protocol|endpoint ?suffix|blob ?endpoint|queue ?endpoint|table ?endpoint|file ?endpoint|shared ?access ?key ?name|shared ?access ?key|shared ?access ?signature|entity ?path|endpoint|tenant ?id|client ?id|column ?encryption ?setting|mars ?connection|language|current ?language)`,
);

/**
 * A run of an env-style password: past a `;` unless the `;` ends a connection-string field, that is, comes before a
 * connection-string keyword and `=` (`User Id=`), spaces and another `Name=`, the end of the line or the end of the
 * text.
 */
const ENV_SEMICOLON = String.raw`;(?![ \t]*${CONNECTION_KEYWORD}[ \t]*=|[ \t]+[A-Za-z_][\w .-]*=|[ \t]*(?:\r?\n|$))`;
// Unrolled, a run of other characters at a time and each split one way only, so a value megabytes long does not exhaust the regular expression's
// backtracking stack.
const ENV_RUN = String.raw`(?=[^\s;]|${ENV_SEMICOLON})[^\s;]*(?:${ENV_SEMICOLON}[^\s;]*)*`;

/** How far the unquoted value of a password-like field runs. */
const PASSWORD_VALUES: UnquotedValues = {
	json: String.raw`[^\s,;}\]]+`,
	// Words separated by single spaces, as a passphrase is; two spaces or a tab end it, as between table columns.
	bare: String.raw`\S+(?: \S+)*`,
	env: String.raw`${ENV_RUN}(?:[ \t]+(?![A-Za-z_][\w.-]*=)${ENV_RUN})*`,
};
const OTHER_RUN = String.raw`[^\s,;}"'&]+`;
const OTHER_VALUES: UnquotedValues = { json: OTHER_RUN, bare: OTHER_RUN, env: OTHER_RUN };

/**
 * Each pattern, in order, with how its matches are redacted. Blocks, cookies and command-line credentials come first,
 * then password-like fields, so a later field on the same line does not end a password's value early.
 */
const STEPS: readonly (readonly [RegExp, Redaction])[] = [
	[PRIVATE_KEY_BLOCK, PRIVATE_KEY_BLOCK_VALUE],
	[COOKIE_HEADER, COOKIE_VALUES],
	[COOKIE_OPTION, COOKIE_OPTION_VALUES],
	[CREDENTIAL_OPTION, GROUPS],
	[JOINED_PASSWORD_OPTION, JOINED_PASSWORD],
	[REGISTRY_LOGIN_PASSWORD, GROUPS],
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
 * {@link redactMatches} over `text`, or, when a pathological input (a value megabytes long) exhausts the regular
 * expression's backtracking stack, over each of its lines, and any line that still does is redacted whole: a credential
 * is never let through because the text was too large to read.
 */
function redactStep(text: string, pattern: RegExp, redaction: Redaction): string {
	try {
		return redactMatches(text, pattern, redaction);
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return text
			.split("\n")
			.map((line) => {
				try {
					return redactMatches(line, pattern, redaction);
				} catch (lineError) {
					if (!(lineError instanceof RangeError)) throw lineError;
					return REDACTED;
				}
			})
			.join("\n");
	}
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
function redactCredentialShapesBase(text: string): string {
	return STEPS.reduce(
		(masked, [pattern, redaction]) => redactStep(masked, pattern, redaction),
		redactUrlCredentials(text),
	);
}

// ============================================================================
// Shared linear helpers (ANSI stripping with origin map & RFC 7617 Basic check)
// ============================================================================

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

function isAsciiLetterCode(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isHexCode(code: number): boolean {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isHorizontalWsCode(code: number): boolean {
	return code === 0x20 || code === 0x09;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function codePointWidthAt(text: string, index: number): number {
	return index + 1 < text.length &&
		isHighSurrogate(text.charCodeAt(index)) &&
		isLowSurrogate(text.charCodeAt(index + 1))
		? 2
		: 1;
}

function base64DigitValue(code: number): number {
	if (code >= 0x41 && code <= 0x5a) return code - 0x41;
	if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
	if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
	if (code === 0x2b) return 62; // +
	if (code === 0x2f) return 63; // /
	return -1;
}

/**
 * Whether `value` is an RFC 7617 `Basic` credential payload: canonical standard Base64 (padded or unpadded,
 * length >= 4) whose decoded bytes are valid printable UTF-8 (no C0/DEL control bytes other than HTAB) containing
 * the `:` (`0x3a`) user-id/password separator. Leaves ordinary prose (`auth`, `mode`, `HTTP`, `Settings`, `Overview`)
 * and challenge parameters (`realm="example"`) untouched while covering every `base64(userid:password)` form.
 */
export function isBasicAuthPayload(value: string): boolean {
	if (value.length < 4 || value.length % 4 === 1) return false;
	let pad = 0;
	for (let i = value.length - 1; i >= 0 && value.charCodeAt(i) === 0x3d; i--) pad++;
	if (pad > 2) return false;
	if (pad > 0 && value.length % 4 !== 0) return false;
	const end = value.length - pad;
	if (end < 2) return false;
	let lastSextet = 0;
	for (let i = 0; i < end; i++) {
		const sextet = base64DigitValue(value.charCodeAt(i));
		if (sextet === -1) return false;
		lastSextet = sextet;
	}
	// Canonical RFC 4648 trailing-bit check (unused trailing bits must be 0).
	const mod4 = end % 4;
	if ((pad === 1 || (pad === 0 && mod4 === 3)) && (lastSextet & 0x03) !== 0) return false;
	if ((pad === 2 || (pad === 0 && mod4 === 2)) && (lastSextet & 0x0f) !== 0) return false;

	const decoded = Buffer.from(value, "base64");
	if (!decoded.includes(0x3a)) return false;
	for (let i = 0; i < decoded.length; i++) {
		const byte = decoded[i]!;
		if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) return false;
	}
	try {
		UTF8_FATAL_DECODER.decode(decoded);
		return true;
	} catch {
		return false;
	}
}

/**
 * Strip ANSI CSI (`ESC [ [0-?]* [ -/]* [@-~]`) and OSC (`ESC ] [^\x07\x1b]* (BEL | ESC \)`) sequences from `text`,
 * returning `plain` and an `origin` array mapping each index in `plain` to its UTF-16 index in `text` (plus
 * `text.length` at the end). Strictly linear single pass (`<= 2 * text.length` steps), with zero regular expressions.
 */
export function stripAnsiWithOrigin(text: string): {
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
		for (let index = copied; index < end; index++) origin[plainLen++] = index;
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
	return { plain: chunks.join(""), origin: origin.subarray(0, plainLen + 1) };
}

// ============================================================================
// Additive monotone linear passes (strictly >= base pass for every input)
// ============================================================================

function isOtherRunCode(code: number): boolean {
	return (
		!isJsWhitespaceCode(code) &&
		code !== 0x2c && // ,
		code !== 0x3b && // ;
		code !== 0x7d && // }
		code !== 0x22 && // "
		code !== 0x27 && // '
		code !== 0x26 // &
	);
}

function isPasswordJsonRunCode(code: number): boolean {
	return (
		!isJsWhitespaceCode(code) &&
		code !== 0x2c && // ,
		code !== 0x3b && // ;
		code !== 0x7d && // }
		code !== 0x5d // ]
	);
}

function isRfc6750BodyCode(code: number): boolean {
	return (
		isAsciiWordCode(code) ||
		code === 0x2e || // .
		code === 0x7e || // ~
		code === 0x2b || // +
		code === 0x2f || // /
		code === 0x2d // -
	);
}

function scanQuotedValueEnd(text: string, start: number): number {
	const quote = text.charCodeAt(start);
	let i = start + 1;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c === 0x0a) break;
		if (c === 0x5c) {
			if (i + 1 < text.length && !isLineTerminatorCode(text.charCodeAt(i + 1))) {
				i += 1 + codePointWidthAt(text, i + 1);
				continue;
			}
			break;
		}
		if (c === quote) {
			if (i + 1 < text.length && text.charCodeAt(i + 1) === quote) {
				i += 2;
				continue;
			}
			i += 1;
			break;
		}
		i += 1;
	}
	return i;
}

function scanEscapedQuotedValueEnd(text: string, start: number): number {
	let bs = start;
	while (bs < text.length && text.charCodeAt(bs) === 0x5c) bs++;
	if (bs >= text.length || text.charCodeAt(bs) !== 0x22) return start;
	const bsCount = bs - start;
	let i = bs + 1;
	if (bsCount === 1) {
		while (i < text.length) {
			const c = text.charCodeAt(i);
			if (c === 0x0a || c === 0x22) break;
			if (c === 0x5c) {
				if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c && i + 2 < text.length) {
					const c2 = text.charCodeAt(i + 2);
					if (c2 === 0x5c) {
						if (i + 3 < text.length && (text.charCodeAt(i + 3) === 0x22 || text.charCodeAt(i + 3) === 0x5c)) {
							i += 4;
							continue;
						}
					} else if (c2 !== 0x0a) {
						i += 2 + codePointWidthAt(text, i + 2);
						continue;
					}
				}
				break;
			}
			i += 1;
		}
		if (i + 1 < text.length && text.charCodeAt(i) === 0x5c && text.charCodeAt(i + 1) === 0x22) {
			i += 2;
		}
		return i;
	}
	while (i < text.length && text.charCodeAt(i) !== 0x22 && text.charCodeAt(i) !== 0x0a) i++;
	if (i < text.length && text.charCodeAt(i) === 0x22) i++;
	return i;
}

/** Whether there are no ANSI escape sequences between plain indices `from` and `to` (inclusive bounds `from <= to`). */
function noAnsiBetween(origin: Int32Array | undefined, from: number, to: number): boolean {
	if (origin === undefined || to <= from) return true;
	return origin[to]! - origin[from]! === to - from;
}

// --- Additive Pass A: Standalone RFC 7617 `Basic <base64(user:pass)>` ---

const BASIC_FAST_CHECK = /basic[ \t]/iu;

function isBasicBoundaryAt(text: string, pos: number): boolean {
	if (pos >= text.length) return true;
	const code = text.charCodeAt(pos);
	if (isJsWhitespaceCode(code)) return true;
	if (
		code === 0x2c || // ,
		code === 0x3b || // ;
		code === 0x29 || // )
		code === 0x7d || // }
		code === 0x5d || // ]
		code === 0x22 || // "
		code === 0x27 || // '
		code === 0x3e || // >
		code === 0x3c || // <
		code === 0x60 || // `
		code === 0x5c // \ (escaped quote \" or escaped newline \n)
	) {
		return true;
	}
	// Trailing sentence period (e.g. `Basic <b64>.`), not a version/host dot like `HTTP/1.1`.
	if (code === 0x2e) {
		return pos + 1 >= text.length || isJsWhitespaceCode(text.charCodeAt(pos + 1));
	}
	return false;
}

function redactStandaloneBasic(text: string): string {
	if (!text.includes("\x1b") && !BASIC_FAST_CHECK.test(text)) return text;
	const { plain, origin } = stripAnsiWithOrigin(text);
	if (!BASIC_FAST_CHECK.test(plain)) return text;
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let redacted = "";
	let copied = 0;
	let plainCopied = 0;
	let i = 0;

	while (i < plain.length) {
		if (plain.charCodeAt(i) === 0x5b && plain.startsWith(REDACTED, i)) {
			i += REDACTED.length;
			continue;
		}
		const c = plain.charCodeAt(i);
		if ((c === 0x42 || c === 0x62) && !(i > 0 && isAsciiWordCode(plain.charCodeAt(i - 1)))) {
			if (matchesAsciiCaseInsensitiveAt(plain, "basic", i)) {
				let valStart = i + 5;
				while (valStart < plain.length && isHorizontalWsCode(plain.charCodeAt(valStart))) valStart++;
				if (valStart > i + 5 && valStart < plain.length) {
					let valEnd = valStart;
					while (valEnd < plain.length && base64DigitValue(plain.charCodeAt(valEnd)) !== -1) valEnd++;
					const padStart = valEnd;
					while (valEnd < plain.length && plain.charCodeAt(valEnd) === 0x3d && valEnd - padStart < 2) valEnd++;
					const candidate = plain.slice(valStart, valEnd);
					const nextChar = valEnd < plain.length ? plain.charCodeAt(valEnd) : -1;
					const afterQuote = valEnd + 1 < plain.length ? plain.charCodeAt(valEnd + 1) : -1;
					// Do not treat `Basic name="value"` (1 `=` before an opening quote) as Base64, but do match JSON keys `{"Basic <b64>": true}` where `:` follows the closing quote.
					const quotedAttrStart =
						(nextChar === 0x22 || nextChar === 0x27) &&
						valEnd - padStart === 1 &&
						afterQuote !== -1 &&
						afterQuote !== 0x3a &&
						!isBasicBoundaryAt(plain, valEnd + 1);
					if (!quotedAttrStart && isBasicBoundaryAt(plain, valEnd) && isBasicAuthPayload(candidate)) {
						if (i >= plainCopied) {
							redacted += text.slice(copied, at(i)) + REDACTED;
							copied = at(valEnd - 1) + 1;
							plainCopied = valEnd;
						}
						i = valEnd;
						continue;
					}
				}
			}
		}
		i++;
	}

	return copied === 0 ? text : redacted + text.slice(copied);
}

// --- Additive Pass B: RFC 7636 PKCE `code_verifier` (JSON, escaped JSON, query/env, YAML, block, CLI) ---

const VERIFIER_FAST_CHECK = /verifier/iu;
const CODE_VERIFIER_NAME = fieldName("code[-_]?verifier", "CodeVerifier");
const CODE_VERIFIER_BLOCK = blockField(CODE_VERIFIER_NAME);
const CODE_VERIFIER_OPTION = new RegExp(
	String.raw`(?<![\w-])--?(?:[a-z0-9]+-)*code-verifier(?:=|[ \t]+)(?:(?![-<>|])|(?=${DASHED_SECRET}))${OPTION_VALUE_GROUPS}`,
	"dgiu",
);
const CODE_VERIFIER_HEADER = new RegExp(
	String.raw`${CODE_VERIFIER_NAME}(?:\\*["'][ \t]*:[ \t]*|[ \t]*:(?![ \t]*${BLOCK_INDICATOR})[ \t]*|(?:\\*["'])?[ \t]*=(?![=>]|~(?![A-Za-z0-9._~-]{42})))`,
	"gu",
);
const CODE_VERIFIER_PLACEHOLDER =
	/^(?:<[^<>\n]{1,200}>|\(?(?:not set|unset|none|empty|hidden|masked|redacted|required|optional)\)?|\*{3,}|•{3,}|x{3,42}|X{3,42}|\.{3}|…)$/u;
const MAX_TYPE_NAME_LENGTH = 40;
const MIN_PKCE_VERIFIER_LENGTH = 43;
const CODE_VERIFIER_NAME_END =
	/(?:AccessToken|RefreshToken|AuthSecret|ClientSecret|ApiKey|CodeVerifier|Secret|Password|Passwd|Pwd|Passphrase)$/u;

function holdsCodeVerifierSecret(
	input: string,
	matchIndex: number,
	matchEnd: number,
	valueStart: number,
	value: string,
	quotedName: boolean,
): boolean {
	if (isGenericType(input.slice(valueStart, valueStart + MAX_GENERIC_LENGTH + 2))) return false;
	if (/^<[^<>\n]{1,200}>/u.test(input.slice(valueStart, valueStart + 202))) return false;
	if (CODE_VERIFIER_PLACEHOLDER.test(value.replace(/[,;.]$/u, ""))) return false;
	const first = /[^\s,;)}\]]*/u.exec(value)![0];
	const rest = value.slice(first.length).trim();
	if (!/^[,;)}\]]*:?$/u.test(rest)) return true;
	if (LITERAL.test(first)) return false;
	if (quotedName && /^-?\d+(?:\.\d+)?$/u.test(first)) return false;
	if (first.length < MIN_PKCE_VERIFIER_LENGTH && isMemberAccess(first)) return false;
	const typeName = first.endsWith("[") ? first.slice(0, -1) : first;
	if (typeName.length <= MAX_TYPE_NAME_LENGTH && TYPE_NAME.test(typeName)) {
		if (DECLARATION_LINE.test(lineBefore(input, matchIndex))) return false;
		const list = openParameterList(input, matchIndex);
		if (list !== undefined) {
			const after = input.slice(matchEnd, matchEnd + CODE_CONTEXT_LENGTH).split(/[)\n]/u, 1)[0]!;
			if (BUILTIN_PARAMETER.test(`${list}${after}`)) return false;
		}
	}
	return true;
}

function ordinaryCodeVerifierCamelCase(input: string, index: number, name: string): boolean {
	const before = /[A-Za-z0-9]*$/u.exec(input.slice(Math.max(0, index - 64), index))![0];
	const identifier = before + /^[A-Za-z0-9]*/u.exec(name)![0];
	return ORDINARY_CAMEL_CASE_PREFIX.test(/^[a-z]*/u.exec(before)![0]) && !CODE_VERIFIER_NAME_END.test(identifier);
}

function continuedOnNextLineAt(input: string, matchIndex: number, valueStart: number, valueEnd: number): boolean {
	const lineStart = input.lastIndexOf("\n", matchIndex) + 1;
	const valueLineStart = input.lastIndexOf("\n", valueStart) + 1;
	const valueLineEnd = input.indexOf("\n", valueStart);
	const valueLine = input.slice(valueLineStart, valueLineEnd === -1 ? input.length : valueLineEnd).replace(/\r$/u, "");
	const keyIndent = indentation(input.slice(lineStart, matchIndex));
	const trimmed = valueLine.trim();
	return (
		indentation(valueLine) > keyIndent &&
		trimmed === input.slice(valueStart, valueEnd).trim() &&
		/^[^\s:=()]+$/u.test(trimmed)
	);
}

/** Whether `plain` after `valueEnd` has `[ \t]*[redacted]` (meaning `value` was an adjacent header already redacted). */
function followedByRedactedMarker(plain: string, pos: number): boolean {
	let p = pos;
	while (p < plain.length && isHorizontalWsCode(plain.charCodeAt(p))) p++;
	return plain.startsWith(REDACTED, p);
}

function redactCodeVerifierFields(text: string): string {
	if (!text.includes("\x1b") && !VERIFIER_FAST_CHECK.test(text)) return text;
	const probePlain = stripAnsiWithOrigin(text).plain;
	if (!VERIFIER_FAST_CHECK.test(probePlain)) return text;

	// 1. CLI `--code-verifier` option (skip already-redacted values or adjacent redacted headers).
	let current = redactStep(text, CODE_VERIFIER_OPTION, (match) => {
		const groups = GROUPS(match);
		return groups.filter(({ start, end }) => {
			const val = match[0].slice(start, end);
			if (val.startsWith(REDACTED)) return false;
			if (val.endsWith(":") && followedByRedactedMarker(match.input, match.index + end)) return false;
			return true;
		});
	});
	// 2. YAML block scalar `code_verifier: |`.
	current = redactStep(current, CODE_VERIFIER_BLOCK, BLOCK);

	// 3. Field values (JSON, escaped JSON, query/env `=`, YAML bare `:` and indented next-line).
	const { plain, origin } = stripAnsiWithOrigin(current);
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let redacted = "";
	let copied = 0;
	let plainCopied = 0;
	let scanPos = 0;

	for (;;) {
		CODE_VERIFIER_HEADER.lastIndex = scanPos;
		const header = CODE_VERIFIER_HEADER.exec(plain);
		if (header === null) break;
		const matchIndex = header.index;
		const headerText = header[0];
		const headerEnd = matchIndex + headerText.length;
		if (matchIndex < plainCopied) {
			scanPos = plainCopied;
			continue;
		}
		const separator = /[:=]/u.exec(headerText)!.index;
		const sepAbs = matchIndex + separator;
		const name = headerText.slice(0, separator);
		const sepChar = headerText[separator]!;
		const quotedName = name.includes('"') || name.includes("'");
		const form: "json" | "bare" | "equals" = sepChar === "=" ? "equals" : quotedName ? "json" : "bare";

		let valueStart = headerEnd;
		let replaceFrom = sepAbs + 1;
		let replacement = ` ${REDACTED}`;
		let isNextLine = false;

		if (form === "equals") {
			let ws = headerEnd;
			while (ws < plain.length && isHorizontalWsCode(plain.charCodeAt(ws))) ws++;
			if (ws > headerEnd && isEnvAssignmentAt(plain, ws)) {
				scanPos = headerEnd;
				continue;
			}
			valueStart = ws;
		} else if (form === "bare") {
			if (
				valueStart < plain.length &&
				(plain.charCodeAt(valueStart) === 0x0a ||
					(plain.charCodeAt(valueStart) === 0x0d && plain.charCodeAt(valueStart + 1) === 0x0a))
			) {
				let nextPos = plain.charCodeAt(valueStart) === 0x0d ? valueStart + 2 : valueStart + 1;
				const indentStart = nextPos;
				while (nextPos < plain.length && isHorizontalWsCode(plain.charCodeAt(nextPos))) nextPos++;
				if (nextPos === indentStart) {
					scanPos = headerEnd;
					continue;
				}
				valueStart = nextPos;
				replaceFrom = nextPos;
				replacement = REDACTED;
				isNextLine = true;
			}
		}

		if (valueStart >= plain.length) {
			scanPos = headerEnd;
			continue;
		}
		let valueEnd = valueStart;
		const first = plain.charCodeAt(valueStart);
		if (first === 0x22 || first === 0x27) {
			valueEnd = scanQuotedValueEnd(plain, valueStart);
		} else if (first === 0x5c) {
			const escEnd = scanEscapedQuotedValueEnd(plain, valueStart);
			if (escEnd > valueStart) valueEnd = escEnd;
		}
		if (valueEnd === valueStart) {
			while (valueEnd < plain.length && isOtherRunCode(plain.charCodeAt(valueEnd))) valueEnd++;
		}
		if (valueEnd <= valueStart) {
			scanPos = headerEnd;
			continue;
		}
		scanPos = valueEnd;

		if (plain[matchIndex - 1] === "`" && plain[sepAbs + 1] === "`") continue;
		if (isNextLine && !continuedOnNextLineAt(plain, matchIndex, valueStart, valueEnd)) continue;

		let end = valueEnd;
		while (end > valueStart && isJsWhitespaceCode(plain.charCodeAt(end - 1))) end--;
		const value = plain.slice(sepAbs + 1, end).trimStart();
		if (value.startsWith(REDACTED)) continue;
		if (value.endsWith(":") && followedByRedactedMarker(plain, end)) continue;
		if (!holdsCodeVerifierSecret(plain, matchIndex, valueEnd, end - value.length, value, quotedName)) continue;
		if (ordinaryCodeVerifierCamelCase(plain, matchIndex, name)) continue;
		if (replaceFrom < plainCopied || end <= replaceFrom) continue;

		redacted += text.slice(copied, at(replaceFrom)) + replacement;
		copied = at(end - 1) + 1;
		plainCopied = end;
		if (end > scanPos) scanPos = end;
	}

	return copied === 0 ? current : redacted + current.slice(copied);
}

// --- Additive Pass C: Assigned auth schemes (`auth=Bearer <tok>`, `Authorization=Basic <b64>`) & Bearer `%XX`/`:` tails ---

const AUTH_SCHEMES = ["bearer", "basic", "digest", "token", "apikey", "oauth"] as const;
const AUTH_SCHEME_FAST_CHECK = /(?:bearer|basic|digest|token|apikey|oauth)[ \t]/iu;
const ASSIGNED_SCHEME_HEADER = new RegExp(
	String.raw`(?:${OTHER_NAME}|${PASSWORD_NAME})(?:\\*["'][ \t]*:[ \t]*|(?:\\*["'])?[ \t]*=(?![=>~]))`,
	"gu",
);

function skipAuthSchemePrefix(text: string, start: number): number {
	for (const scheme of AUTH_SCHEMES) {
		if (!matchesAsciiCaseInsensitiveAt(text, scheme, start)) continue;
		let pos = start + scheme.length;
		if (pos < text.length && isHorizontalWsCode(text.charCodeAt(pos))) {
			while (pos < text.length && isHorizontalWsCode(text.charCodeAt(pos))) pos++;
			return pos;
		}
	}
	return start;
}

/**
 * Scan the extended tail of a standalone `Bearer <token>` after the initial `[\w.~+/-]+=*` prefix consumed by the
 * base pass: covers `%XX` percent-encoded segments and internal `:` segments (excluding `://` URLs).
 */
function scanBearerExtendedTailEnd(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (isRfc6750BodyCode(c)) {
			i++;
		} else if (
			c === 0x25 &&
			i + 2 < text.length &&
			isHexCode(text.charCodeAt(i + 1)) &&
			isHexCode(text.charCodeAt(i + 2))
		) {
			i += 3;
		} else if (
			c === 0x3a &&
			!(i + 2 < text.length && text.charCodeAt(i + 1) === 0x2f && text.charCodeAt(i + 2) === 0x2f) &&
			i + 1 < text.length &&
			(isRfc6750BodyCode(text.charCodeAt(i + 1)) ||
				(text.charCodeAt(i + 1) === 0x25 &&
					i + 3 < text.length &&
					isHexCode(text.charCodeAt(i + 2)) &&
					isHexCode(text.charCodeAt(i + 3))))
		) {
			i++;
		} else {
			break;
		}
	}
	while (i < text.length && text.charCodeAt(i) === 0x3d) i++;
	return i;
}

function redactAssignedAuthSchemesAndBearerTails(originalText: string, currentText: string): string {
	if (!originalText.includes("\x1b") && !AUTH_SCHEME_FAST_CHECK.test(originalText)) return currentText;
	const origPlain = stripAnsiWithOrigin(originalText).plain;
	if (!AUTH_SCHEME_FAST_CHECK.test(origPlain)) return currentText;

	// 1. Collect exact assigned-scheme tokens (`auth=Bearer <tok>`, `"auth": Bearer <tok>`, etc.) from original text.
	const assignedTokens = new Map<string, number>();
	let scanPos = 0;
	for (;;) {
		ASSIGNED_SCHEME_HEADER.lastIndex = scanPos;
		const header = ASSIGNED_SCHEME_HEADER.exec(origPlain);
		if (header === null) break;
		const headerEnd = header.index + header[0].length;
		let pos = headerEnd;
		if (header[0].includes("=")) {
			while (pos < origPlain.length && isHorizontalWsCode(origPlain.charCodeAt(pos))) pos++;
		}
		const tokStart = skipAuthSchemePrefix(origPlain, pos);
		if (tokStart > pos && tokStart < origPlain.length) {
			let tokEnd = tokStart;
			const first = origPlain.charCodeAt(tokStart);
			if (first === 0x22 || first === 0x27) {
				tokEnd = scanQuotedValueEnd(origPlain, tokStart);
			} else {
				while (tokEnd < origPlain.length && isOtherRunCode(origPlain.charCodeAt(tokEnd))) tokEnd++;
			}
			if (tokEnd > tokStart) {
				const tok = origPlain.slice(tokStart, tokEnd);
				if (!tok.startsWith(REDACTED)) {
					assignedTokens.set(tok, (assignedTokens.get(tok) ?? 0) + 1);
				}
				scanPos = tokEnd;
				continue;
			}
		}
		scanPos = headerEnd;
	}

	// 2. Collect standalone `Bearer` percent-encoded / colon tails that the base `[\w.~+/-]+=*` regex stopped before.
	const bearerTails = new Map<string, number>();
	for (let i = 0; i < origPlain.length; i++) {
		const c = origPlain.charCodeAt(i);
		if ((c === 0x42 || c === 0x62) && !(i > 0 && isAsciiWordCode(origPlain.charCodeAt(i - 1)))) {
			if (matchesAsciiCaseInsensitiveAt(origPlain, "bearer", i)) {
				let valStart = i + 6;
				while (valStart < origPlain.length && isHorizontalWsCode(origPlain.charCodeAt(valStart))) valStart++;
				if (valStart > i + 6 && valStart < origPlain.length && isRfc6750BodyCode(origPlain.charCodeAt(valStart))) {
					let baseEnd = valStart;
					while (baseEnd < origPlain.length && isRfc6750BodyCode(origPlain.charCodeAt(baseEnd))) baseEnd++;
					while (baseEnd < origPlain.length && origPlain.charCodeAt(baseEnd) === 0x3d) baseEnd++;
					const extEnd = scanBearerExtendedTailEnd(origPlain, baseEnd);
					if (extEnd > baseEnd) {
						const tail = origPlain.slice(baseEnd, extEnd);
						bearerTails.set(tail, (bearerTails.get(tail) ?? 0) + 1);
						i = extEnd - 1;
					} else {
						i = baseEnd - 1;
					}
				}
			}
		}
	}

	if (assignedTokens.size === 0 && bearerTails.size === 0) return currentText;

	// 3. Apply strictly monotone replacements on `currentText` (skipping existing `[redacted]` spans).
	let result = currentText;

	if (assignedTokens.size > 0) {
		const { plain, origin } = stripAnsiWithOrigin(result);
		const at = (index: number) => (origin === undefined ? index : origin[index]!);
		let out = "";
		let copied = 0;
		let plainCopied = 0;
		let pos = 0;

		for (;;) {
			ASSIGNED_SCHEME_HEADER.lastIndex = pos;
			const header = ASSIGNED_SCHEME_HEADER.exec(plain);
			if (header === null) break;
			const headerEnd = header.index + header[0].length;
			if (header.index < plainCopied) {
				pos = plainCopied;
				continue;
			}
			let p = headerEnd;
			while (p < plain.length && isHorizontalWsCode(plain.charCodeAt(p))) p++;
			if (!plain.startsWith(REDACTED, p)) {
				pos = headerEnd;
				continue;
			}
			const markerStart = p;
			const markerEnd = p + REDACTED.length;
			let tokStart = markerEnd;
			while (tokStart < plain.length && isHorizontalWsCode(plain.charCodeAt(tokStart))) tokStart++;
			if (tokStart === markerEnd || tokStart >= plain.length) {
				pos = markerEnd;
				continue;
			}
			if (plain.startsWith(REDACTED, tokStart)) {
				pos = tokStart + REDACTED.length;
				continue;
			}
			let tokEnd = tokStart;
			const first = plain.charCodeAt(tokStart);
			if (first === 0x22 || first === 0x27) {
				tokEnd = scanQuotedValueEnd(plain, tokStart);
			} else {
				while (tokEnd < plain.length && isOtherRunCode(plain.charCodeAt(tokEnd))) tokEnd++;
			}
			const cand = plain.slice(tokStart, tokEnd);
			const remaining = assignedTokens.get(cand) ?? 0;
			if (remaining > 0 && !(cand.endsWith(":") && followedByRedactedMarker(plain, tokEnd))) {
				assignedTokens.set(cand, remaining - 1);
				if (noAnsiBetween(origin, markerEnd - 1, tokStart) && markerStart >= plainCopied) {
					out += result.slice(copied, at(markerStart)) + REDACTED;
				} else if (tokStart >= plainCopied) {
					out += result.slice(copied, at(tokStart)) + REDACTED;
				} else {
					pos = tokEnd;
					continue;
				}
				copied = at(tokEnd - 1) + 1;
				plainCopied = tokEnd;
				pos = tokEnd;
				continue;
			}
			pos = markerEnd;
		}
		if (copied > 0) result = out + result.slice(copied);
	}

	if (bearerTails.size > 0) {
		const { plain, origin } = stripAnsiWithOrigin(result);
		const at = (index: number) => (origin === undefined ? index : origin[index]!);
		let out = "";
		let copied = 0;
		let plainCopied = 0;

		for (
			let markerStart = plain.indexOf(REDACTED);
			markerStart !== -1;
			markerStart = plain.indexOf(REDACTED, markerStart + REDACTED.length)
		) {
			if (markerStart < plainCopied) continue;
			const tailStart = markerStart + REDACTED.length;
			if (tailStart >= plain.length) break;
			const nextCode = plain.charCodeAt(tailStart);
			if (nextCode !== 0x25 && nextCode !== 0x3a) continue;
			const tailEnd = scanBearerExtendedTailEnd(plain, tailStart);
			if (tailEnd <= tailStart) continue;
			const tail = plain.slice(tailStart, tailEnd);
			const remaining = bearerTails.get(tail) ?? 0;
			if (remaining > 0) {
				bearerTails.set(tail, remaining - 1);
				if (noAnsiBetween(origin, tailStart - 1, tailStart)) {
					out += result.slice(copied, at(markerStart)) + REDACTED;
				} else {
					out += result.slice(copied, at(tailStart)) + REDACTED;
				}
				copied = at(tailEnd - 1) + 1;
				plainCopied = tailEnd;
			}
		}
		if (copied > 0) result = out + result.slice(copied);
	}

	return result;
}

// --- Additive Pass D: Long-line linear fallback (>= 4096 chars per line) for Bun Yarr match-limit safety ---

const LONG_LINE_THRESHOLD = 4096;

function hasLongLine(text: string, threshold: number): boolean {
	if (text.length < threshold) return false;
	let start = 0;
	for (;;) {
		const nl = text.indexOf("\n", start);
		if (nl === -1) return text.length - start >= threshold;
		if (nl - start >= threshold) return true;
		start = nl + 1;
	}
}

const CONNECTION_KEYWORD_PATTERNS: readonly string[] = [
	"server",
	"data source",
	"address",
	"addr",
	"network address",
	"host",
	"hostname",
	"port",
	"database",
	"initial catalog",
	"dbname",
	"db",
	"user ?id",
	"uid",
	"user ?name",
	"user",
	"pwd",
	"password",
	"encrypt",
	"trust ?server ?certificate",
	"trusted_connection",
	"integrated security",
	"persist security info",
	"connect(?:ion)? ?timeout",
	"timeout",
	"command timeout",
	"application ?name",
	"app",
	"application ?intent",
	"multiple ?active ?result ?sets",
	"multi ?subnet ?failover",
	"pooling",
	"min pool size",
	"max pool size",
	"provider",
	"driver",
	"dsn",
	"attach ?db ?filename",
	"authentication",
	"workstation id",
	"packet size",
	"failover partner",
	"charset",
	"ssl ?mode",
	"sslrootcert",
	"sslcert",
	"sslkey",
	"options",
	"schema",
	"search_path",
	"account ?name",
	"account ?key",
	"default ?endpoints ?protocol",
	"endpoint ?suffix",
	"blob ?endpoint",
	"queue ?endpoint",
	"table ?endpoint",
	"file ?endpoint",
	"shared ?access ?key ?name",
	"shared ?access ?key",
	"shared ?access ?signature",
	"entity ?path",
	"endpoint",
	"tenant ?id",
	"client ?id",
	"column ?encryption ?setting",
	"mars ?connection",
	"language",
	"current ?language",
];

interface KeywordTrieNode {
	readonly next: Map<number, KeywordTrieNode>;
	terminal: boolean;
}

function expandConnectionKeywordPattern(pattern: string): string[] {
	let variants = [""];
	let i = 0;
	while (i < pattern.length) {
		if (pattern.startsWith("(?:ion)?", i)) {
			variants = variants.flatMap((v) => [v, `${v}ion`]);
			i += 8;
		} else if (i + 1 < pattern.length && pattern[i] === " " && pattern[i + 1] === "?") {
			variants = variants.flatMap((v) => [v, `${v} `]);
			i += 2;
		} else {
			const ch = pattern[i]!;
			variants = variants.map((v) => v + ch);
			i += 1;
		}
	}
	return variants;
}

function buildConnectionKeywordTrie(patterns: readonly string[]): KeywordTrieNode {
	const root: KeywordTrieNode = { next: new Map(), terminal: false };
	for (const pattern of patterns) {
		for (const word of expandConnectionKeywordPattern(pattern)) {
			let node = root;
			for (let i = 0; i < word.length; i++) {
				const code = word.charCodeAt(i);
				let child = node.next.get(code);
				if (child === undefined) {
					child = { next: new Map(), terminal: false };
					node.next.set(code, child);
				}
				node = child;
			}
			node.terminal = true;
		}
	}
	return root;
}

const CONNECTION_KEYWORD_TRIE = buildConnectionKeywordTrie(CONNECTION_KEYWORD_PATTERNS);

function isEnvAssignmentAt(text: string, pos: number): boolean {
	if (pos >= text.length) return false;
	const first = text.charCodeAt(pos);
	if (!isAsciiLetterCode(first) && first !== 0x5f) return false;
	let p = pos + 1;
	while (p < text.length) {
		const c = text.charCodeAt(p);
		if (isAsciiWordCode(c) || c === 0x2e || c === 0x2d) p++;
		else break;
	}
	return p < text.length && text.charCodeAt(p) === 0x3d;
}

function isConnectionKeywordEqualsAt(text: string, wordStart: number): boolean {
	let node: KeywordTrieNode | undefined = CONNECTION_KEYWORD_TRIE;
	let p = wordStart;
	while (p < text.length && node !== undefined) {
		if (node.terminal) {
			let q = p;
			while (q < text.length && isHorizontalWsCode(text.charCodeAt(q))) q++;
			if (q < text.length && text.charCodeAt(q) === 0x3d) return true;
		}
		let c = text.charCodeAt(p);
		if (c >= 0x41 && c <= 0x5a) c += 32;
		node = node.next.get(c);
		p++;
	}
	if (node?.terminal) {
		let q = p;
		while (q < text.length && isHorizontalWsCode(text.charCodeAt(q))) q++;
		if (q < text.length && text.charCodeAt(q) === 0x3d) return true;
	}
	return false;
}

function isPasswordEnvSemicolon(text: string, semiPos: number): boolean {
	let p = semiPos + 1;
	while (p < text.length && isHorizontalWsCode(text.charCodeAt(p))) p++;
	if (p >= text.length) return false;
	const c = text.charCodeAt(p);
	if (c === 0x0a || (c === 0x0d && p + 1 < text.length && text.charCodeAt(p + 1) === 0x0a)) return false;
	if (isConnectionKeywordEqualsAt(text, p)) return false;
	if (p > semiPos + 1 && (isAsciiLetterCode(c) || c === 0x5f)) {
		let q = p + 1;
		while (q < text.length) {
			const qc = text.charCodeAt(q);
			if (isAsciiWordCode(qc) || qc === 0x20 || qc === 0x2e || qc === 0x2d) q++;
			else break;
		}
		if (q < text.length && text.charCodeAt(q) === 0x3d) return false;
	}
	return true;
}

function scanPasswordEnvRun(text: string, start: number): number {
	if (start >= text.length) return -1;
	const first = text.charCodeAt(start);
	if (isJsWhitespaceCode(first)) return -1;
	if (first === 0x3b && !isPasswordEnvSemicolon(text, start)) return -1;
	let p = start + 1;
	while (p < text.length) {
		const c = text.charCodeAt(p);
		if (isJsWhitespaceCode(c)) break;
		if (c === 0x3b && !isPasswordEnvSemicolon(text, p)) break;
		p++;
	}
	return p;
}

function scanPasswordEnvEnd(text: string, start: number): { readonly valueEnd: number; readonly eolWsEnd: number } {
	let end = scanPasswordEnvRun(text, start);
	if (end === -1) return { valueEnd: start, eolWsEnd: start };
	for (;;) {
		let ws = end;
		while (ws < text.length && isHorizontalWsCode(text.charCodeAt(ws))) ws++;
		if (ws === end) return { valueEnd: end, eolWsEnd: end };
		if (
			ws === text.length ||
			text.charCodeAt(ws) === 0x0a ||
			(text.charCodeAt(ws) === 0x0d && text.charCodeAt(ws + 1) === 0x0a)
		) {
			return { valueEnd: end, eolWsEnd: ws };
		}
		if (isEnvAssignmentAt(text, ws)) return { valueEnd: end, eolWsEnd: end };
		const nextEnd = scanPasswordEnvRun(text, ws);
		if (nextEnd === -1) return { valueEnd: end, eolWsEnd: end };
		end = nextEnd;
	}
}

function scanPasswordBareEnd(text: string, start: number): number {
	if (start >= text.length || isJsWhitespaceCode(text.charCodeAt(start))) return start;
	let i = start;
	while (i < text.length && !isJsWhitespaceCode(text.charCodeAt(i))) i++;
	while (i + 1 < text.length && text.charCodeAt(i) === 0x20 && !isJsWhitespaceCode(text.charCodeAt(i + 1))) {
		i++;
		while (i < text.length && !isJsWhitespaceCode(text.charCodeAt(i))) i++;
	}
	return i;
}

function isCookieEscapeFollowCode(code: number): boolean {
	return (
		code === 0x72 ||
		code === 0x6e ||
		code === 0x74 ||
		code === 0x62 ||
		code === 0x66 ||
		code === 0x75 ||
		code === 0x22 ||
		code === 0x5c ||
		code === 0x2f
	);
}

function isPlainCookieValueCode(code: number): boolean {
	return (
		code !== 0x3b &&
		code !== 0x2c &&
		!isJsWhitespaceCode(code) &&
		code !== 0x22 &&
		code !== 0x5c &&
		code !== 0x29 &&
		code !== 0x7d
	);
}

function isUnquotedCookieValueAt(segment: string, index: number): boolean {
	if (index >= segment.length) return false;
	const code = segment.charCodeAt(index);
	if (code === 0x5c) {
		return index + 1 >= segment.length || !isCookieEscapeFollowCode(segment.charCodeAt(index + 1));
	}
	if (code === 0x7d) {
		if (index + 1 >= segment.length) return false;
		const next = segment.charCodeAt(index + 1);
		return isPlainCookieValueCode(next) || next === 0x7d;
	}
	return isPlainCookieValueCode(code);
}

function isNextCookieAt(segment: string, pos: number): boolean {
	let p = pos;
	while (p < segment.length && segment.charCodeAt(p) === 0x20) p++;
	const nameStart = p;
	while (p < segment.length) {
		const c = segment.charCodeAt(p);
		if (c === 0x3b || c === 0x2c || c === 0x3d || c === 0x20) break;
		p++;
	}
	return p > nameStart && p < segment.length && segment.charCodeAt(p) === 0x3d;
}

function cookieValuesLinear(segment: string, setCookie: boolean, context: CookieContext): [number, number][] {
	const values: [number, number][] = [];
	let first = true;
	let pos = 0;
	while (pos < segment.length) {
		while (pos < segment.length) {
			const c = segment.charCodeAt(pos);
			if (c === 0x3b || c === 0x2c || c === 0x3d) break;
			pos++;
		}
		let valueStart = -1;
		let valueEnd = -1;
		if (pos < segment.length && segment.charCodeAt(pos) === 0x3d) {
			pos++;
			if (pos < segment.length && segment.charCodeAt(pos) === 0x22) {
				pos++;
				valueStart = pos;
				while (pos < segment.length && segment.charCodeAt(pos) !== 0x22) pos++;
				valueEnd = pos;
				if (pos < segment.length && segment.charCodeAt(pos) === 0x22) pos++;
			} else {
				const rawStart = pos;
				let p = pos;
				while (p < segment.length && isHorizontalWsCode(segment.charCodeAt(p))) p++;
				if (isUnquotedCookieValueAt(segment, p)) {
					valueStart = rawStart;
					while (isUnquotedCookieValueAt(segment, p)) p++;
					valueEnd = p;
					pos = p;
				}
			}
		}
		while (pos < segment.length && segment.charCodeAt(pos) !== 0x3b && segment.charCodeAt(pos) !== 0x2c) pos++;
		let endedWithComma = false;
		if (pos < segment.length) {
			endedWithComma = segment.charCodeAt(pos) === 0x2c;
			pos++;
		}
		if (valueStart !== -1) {
			const text = segment.slice(valueStart, valueEnd).trim();
			const secret =
				text !== "" &&
				!text.startsWith(REDACTED) &&
				!PLACEHOLDER_COOKIE.test(text) &&
				(context === "header" || generatedCookieValue(text));
			if (secret && (first || !setCookie)) values.push([valueStart, valueEnd]);
		}
		first = endedWithComma && isNextCookieAt(segment, pos);
	}
	return values;
}

const FALLBACK_PASSWORD_HEADER = new RegExp(
	String.raw`${PASSWORD_NAME}(?:\\*["'][ \t]*:[ \t]*|[ \t]*:(?![ \t]*${BLOCK_INDICATOR})[ \t]*|(?:\\*["'])?[ \t]*=(?![=>~]))`,
	"gu",
);
const FALLBACK_OTHER_HEADER = new RegExp(
	String.raw`${OTHER_NAME}(?:\\*["'][ \t]*:[ \t]*|[ \t]*:(?![ \t]*${BLOCK_INDICATOR})[ \t]*|(?:\\*["'])?[ \t]*=(?![=>~]))`,
	"gu",
);
const FALLBACK_PROVIDER_KEY_HEADER = /(?<![A-Za-z0-9])([a-z][a-z0-9]*)Key(?:\\*["'])?[ \t]*([:=])[ \t]*/gu;

function redactLongLineCookies(line: string): string {
	const { plain, origin } = stripAnsiWithOrigin(line);
	if (!/cookie/iu.test(plain)) return line;
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let out = "";
	let copied = 0;
	let plainCopied = 0;

	for (const match of plain.matchAll(COOKIE_HEADER)) {
		if (match.index < plainCopied) continue;
		const setCookie = match[1] !== undefined;
		let from = match.index + match[0].length;
		COOKIE_SEGMENT_END.lastIndex = from;
		const end = COOKIE_SEGMENT_END.exec(plain)?.index ?? plain.length;
		if (plain[from] === "[" && (match[2] !== "" || match[3] !== ":")) continue;
		OPENING_QUOTE.lastIndex = from;
		const opening = OPENING_QUOTE.exec(plain)?.[0];
		let quote: string | undefined;
		let context: CookieContext = "header";
		if (match[2] !== "" || match[3] !== ":") {
			quote = opening?.at(-1);
			from += opening?.length ?? 0;
			if (match[2] === "" && plain[match.index - 1] === ".") context = "prose";
		} else {
			const anywhere = setCookie || match[0].startsWith("C");
			({ quote, context } = headerQuote(plain, match.index, anywhere));
			if (!anywhere && opening !== undefined) quote = undefined;
		}
		if (quote === undefined) continue;
		let segmentEnd = end;
		if (quote !== "") {
			const closing = plain.slice(from, end).indexOf(quote);
			if (closing !== -1) segmentEnd = from + closing;
			while (segmentEnd > from && plain[segmentEnd - 1] === "\\") segmentEnd--;
		}
		for (const [start, valueEnd] of cookieValuesLinear(plain.slice(from, segmentEnd), setCookie, context)) {
			const absFrom = from + start;
			const absTo = from + valueEnd;
			if (absFrom < plainCopied || absTo <= absFrom) continue;
			out += line.slice(copied, at(absFrom)) + REDACTED;
			copied = at(absTo - 1) + 1;
			plainCopied = absTo;
		}
	}
	return copied === 0 ? line : out + line.slice(copied);
}

function redactLongLineFields(line: string, headerPattern: RegExp, password: boolean): string {
	const { plain, origin } = stripAnsiWithOrigin(line);
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let out = "";
	let copied = 0;
	let plainCopied = 0;
	let scanPos = 0;

	for (;;) {
		headerPattern.lastIndex = scanPos;
		const header = headerPattern.exec(plain);
		if (header === null) break;
		const matchIndex = header.index;
		const headerText = header[0];
		const headerEnd = matchIndex + headerText.length;
		if (matchIndex < plainCopied) {
			scanPos = plainCopied;
			continue;
		}
		const separator = /[:=]/u.exec(headerText)!.index;
		const sepAbs = matchIndex + separator;
		const name = headerText.slice(0, separator);
		const sepChar = headerText[separator]!;
		const quotedName = name.includes('"') || name.includes("'");
		const form: "json" | "bare" | "equals" = sepChar === "=" ? "equals" : quotedName ? "json" : "bare";

		let valueStart = headerEnd;
		if (form === "equals") {
			let ws = headerEnd;
			while (ws < plain.length && isHorizontalWsCode(plain.charCodeAt(ws))) ws++;
			if (ws > headerEnd && isEnvAssignmentAt(plain, ws)) {
				scanPos = headerEnd;
				continue;
			}
			valueStart = ws;
		}
		if (valueStart >= plain.length) {
			scanPos = headerEnd;
			continue;
		}
		let valueEnd = valueStart;
		let eolWsEnd = valueStart;
		const first = plain.charCodeAt(valueStart);
		if (first === 0x22 || first === 0x27) {
			valueEnd = scanQuotedValueEnd(plain, valueStart);
			eolWsEnd = valueEnd;
		} else if (first === 0x5c) {
			const escEnd = scanEscapedQuotedValueEnd(plain, valueStart);
			if (escEnd > valueStart) {
				valueEnd = escEnd;
				eolWsEnd = escEnd;
			}
		}
		if (valueEnd === valueStart) {
			if (password) {
				if (form === "equals") {
					const scanned = scanPasswordEnvEnd(plain, valueStart);
					valueEnd = scanned.valueEnd;
					eolWsEnd = scanned.eolWsEnd;
				} else if (form === "bare") {
					const afterScheme = skipAuthSchemePrefix(plain, valueStart);
					const runStart =
						afterScheme > valueStart &&
						afterScheme < plain.length &&
						!isJsWhitespaceCode(plain.charCodeAt(afterScheme))
							? afterScheme
							: valueStart;
					valueEnd = scanPasswordBareEnd(plain, runStart);
					eolWsEnd = valueEnd;
				} else {
					while (valueEnd < plain.length && isPasswordJsonRunCode(plain.charCodeAt(valueEnd))) valueEnd++;
					eolWsEnd = valueEnd;
				}
			} else {
				const afterScheme = form === "bare" ? skipAuthSchemePrefix(plain, valueStart) : valueStart;
				const runStart =
					afterScheme > valueStart && afterScheme < plain.length && isOtherRunCode(plain.charCodeAt(afterScheme))
						? afterScheme
						: valueStart;
				valueEnd = runStart;
				while (valueEnd < plain.length && isOtherRunCode(plain.charCodeAt(valueEnd))) valueEnd++;
				eolWsEnd = valueEnd;
			}
		}
		if (valueEnd <= valueStart) {
			scanPos = headerEnd;
			continue;
		}
		scanPos = valueEnd;

		if (plain[matchIndex - 1] === "`" && plain[sepAbs + 1] === "`") continue;

		const afterSeparator = plain.slice(sepAbs + 1, valueEnd);
		let trimmedEnd = valueEnd;
		while (trimmedEnd > valueStart && isJsWhitespaceCode(plain.charCodeAt(trimmedEnd - 1))) trimmedEnd--;
		// Preserve trailing ANSI resets before EOL whitespace: only absorb trailing ws when contiguous in raw `line`.
		let end = eolWsEnd > trimmedEnd && noAnsiBetween(origin, trimmedEnd - 1, eolWsEnd - 1) ? eolWsEnd : trimmedEnd;

		// Match main's exact ordering and leading-backslash check for sentence/parameter-list termination.
		const unquoted = !/^\s*["'\\]/u.test(afterSeparator);
		if (password && form === "bare" && unquoted) {
			const sentence = afterSeparator.search(SENTENCE_END);
			if (sentence > 0) {
				trimmedEnd = Math.min(trimmedEnd, sepAbs + 1 + sentence);
				end = trimmedEnd;
			}
		}
		if (password && unquoted && openParameterList(plain, matchIndex) !== undefined) {
			const stop = afterSeparator.search(/[,)]/u);
			if (stop !== -1) {
				trimmedEnd = sepAbs + 1 + stop;
				end = trimmedEnd;
			}
		}

		const value = plain.slice(sepAbs + 1, trimmedEnd).trimStart();
		if (value.startsWith(REDACTED)) continue;
		if (password && form === "bare" && !/^["'\\]/u.test(value) && describesPassword(value)) continue;
		// Reuse main's holdsSecret via a minimal RegExpExecArray-shaped slice only when needed.
		const pseudoMatch = Object.assign([plain.slice(matchIndex, valueEnd)], {
			index: matchIndex,
			input: plain,
		}) as RegExpExecArray;
		if (!holdsSecret(pseudoMatch, trimmedEnd - value.length, value, quotedName, password)) continue;
		if (ordinaryCamelCase(plain, matchIndex, name)) continue;
		const replaceFrom = sepAbs + 1;
		if (replaceFrom < plainCopied || end <= replaceFrom) continue;

		out += `${line.slice(copied, at(replaceFrom))} ${REDACTED}`;
		copied = at(end - 1) + 1;
		plainCopied = end;
		if (end > scanPos) scanPos = end;
	}
	return copied === 0 ? line : out + line.slice(copied);
}

function redactLongLineProviderKeys(line: string): string {
	const { plain, origin } = stripAnsiWithOrigin(line);
	if (!plain.includes("Key")) return line;
	const at = (index: number) => (origin === undefined ? index : origin[index]!);
	let out = "";
	let copied = 0;
	let plainCopied = 0;
	let scanPos = 0;

	for (;;) {
		FALLBACK_PROVIDER_KEY_HEADER.lastIndex = scanPos;
		const header = FALLBACK_PROVIDER_KEY_HEADER.exec(plain);
		if (header === null) break;
		const matchIndex = header.index;
		const headerText = header[0];
		const headerEnd = matchIndex + headerText.length;
		if (matchIndex < plainCopied) {
			scanPos = plainCopied;
			continue;
		}
		const separator = /[:=]/u.exec(headerText)!.index;
		const valStart = headerEnd;
		if (valStart >= plain.length) break;
		const first = plain.charCodeAt(valStart);
		let valEnd: number;
		if (first === 0x22 || first === 0x27) {
			valEnd = scanQuotedValueEnd(plain, valStart);
		} else {
			valEnd = valStart;
			while (valEnd < plain.length && isOtherRunCode(plain.charCodeAt(valEnd))) valEnd++;
		}
		scanPos = valEnd > valStart ? valEnd : headerEnd;
		if (valEnd <= valStart) continue;
		if (ORDINARY_KEY_PREFIX.test(header[1]!)) continue;
		const rawVal = plain.slice(valStart, valEnd).trim();
		if (rawVal.startsWith(REDACTED) || !looksSecret(rawVal)) continue;
		const from = matchIndex + separator + 1;
		if (from < plainCopied) continue;
		out += `${line.slice(copied, at(from))} ${REDACTED}`;
		copied = at(valEnd - 1) + 1;
		plainCopied = valEnd;
	}
	return copied === 0 ? line : out + line.slice(copied);
}

/**
 * Additive linear fallback for lines `>= 4096` characters: catches any credential field, provider key, or cookie
 * value that a regex engine silently aborted on (such as Bun JavaScriptCore Yarr's match limit) without touching
 * already-redacted values or short lines.
 */
function redactLongLineFallback(text: string): string {
	if (!hasLongLine(text, LONG_LINE_THRESHOLD)) return text;
	if (!text.includes(":") && !text.includes("=")) return text;
	const lines = text.split("\n");
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.length < LONG_LINE_THRESHOLD) continue;
		if (!line.includes(":") && !line.includes("=")) continue;
		let next = redactLongLineCookies(line);
		next = redactLongLineFields(next, FALLBACK_PASSWORD_HEADER, true);
		next = redactLongLineFields(next, FALLBACK_OTHER_HEADER, false);
		next = redactLongLineProviderKeys(next);
		if (next !== line) {
			lines[i] = next;
			changed = true;
		}
	}
	return changed ? lines.join("\n") : text;
}

/**
 * Redact what looks like a credential in `text`: user info in URLs (up to the last `@` of the authority), private key
 * blocks (PEM, OpenSSH and PGP), cookie values in `Cookie` and `Set-Cookie` headers and `cookie` fields, credentials
 * on a command line (`--password X`, `-p'X'`, `-u user:X`, `--code-verifier X`) or in a netrc entry, the value of a
 * credential field in JSON (also JSON inside a JSON string), YAML (also a block scalar), HTTP-header or env-style
 * text (including `code_verifier` and auth-scheme assignments like `auth=Bearer <token>`), and well-known token shapes
 * (including RFC 6750 `Bearer` tokens and RFC 7617 `Basic` credentials). A password-like value runs to the end of its
 * own value: its closing quote, the `,` or `}` after a JSON literal, the next `NAME=` of env-style text, or the end of
 * its line after a bare `password:`. Literals, types and code identifiers are left as they are. ANSI styling anywhere
 * does not hide a credential.
 */
export function redactCredentialShapes(text: string): string {
	const base = redactCredentialShapesBase(text);
	const afterBasic = redactStandaloneBasic(base);
	const afterVerifier = redactCodeVerifierFields(afterBasic);
	const afterSchemes = redactAssignedAuthSchemesAndBearerTails(text, afterVerifier);
	return redactLongLineFallback(afterSchemes);
}
