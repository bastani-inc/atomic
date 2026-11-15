import { redactUrlCredentials } from "../core/error-contract.ts";

const REDACTED = "[redacted]";

/** An ANSI CSI sequence, such as the styling a terminal-aware tool puts around an authorization scheme. */
const ANSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`;

const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

const CREDENTIAL_SHAPES: readonly RegExp[] = [
	new RegExp(String.raw`(?=b)(?:\b|(?<=${ANSI}))Bearer(?:${ANSI}|\s)+[\w.~+/-]+=*`, "giu"),
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
/** Names that also count after a lower-case letter or digit when capitalized, as in `authToken` or `dbPassword`. */
const CAMEL_CASE_FIELD_NAME = "(?:Password|Passwd|Pwd|Passphrase|Token|Secret|Credentials?|Authorization)";

/**
 * A credential field name. A letter or digit may not come right before it, but `_` or `-` may, so `DB_PASSWORD` and
 * `GITHUB_TOKEN` count while `monkey` does not. A capitalized name also counts after a lower-case letter or digit, so
 * `authToken` and `dbPassword` count while `primaryKey` and `tokenizer` do not.
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
/** A value quoted with escaped quotes, as in JSON inside a JSON string: it runs to the next quote. */
const ESCAPED_QUOTED_VALUE = String.raw`\\+"[^"\n]*"?`;
/** The space, or terminal styling, between a field's separator and its value. */
const GAP = `(?:${ANSI}|\\s)`;

/**
 * A credential field: its name, quoted (`"token":`, `'password':`, `\"token\":`) or not (`token:`, `API_KEY=`), and
 * its value: a quoted string, or an unquoted run that may follow an authorization scheme. The unquoted value of a
 * password-like field runs to the end of its line, because a password may hold spaces, commas or semicolons.
 */
function credentialField(name: string, unquoted: string): string {
	const quoted = (group: number) => QUOTED_VALUE.replaceAll("\\2", `\\${group}`);
	return String.raw`${name}(\\*["']?)\s*(?::${GAP}*(?:${quoted(2)}|${ESCAPED_QUOTED_VALUE}|${unquoted.replace("SCHEME", `(?:${ANSI})*${CREDENTIAL_AUTH_SCHEME}${GAP}+`)})|=${GAP}*(?:${quoted(3)}|${ESCAPED_QUOTED_VALUE}|${unquoted.replace("SCHEME", "(?!)")}))`;
}

/** Password-like fields first, so a later field on the same line does not end a password's value early. */
const CREDENTIAL_FIELDS: readonly RegExp[] = [
	new RegExp(credentialField(fieldName(PASSWORD_FIELD_NAME, "(?!)"), String.raw`(?:SCHEME)?[^\r\n]+`), "gu"),
	new RegExp(
		credentialField(fieldName(OTHER_FIELD_NAME, CAMEL_CASE_FIELD_NAME), String.raw`(?:SCHEME)?[^\s,;}"'&]+`),
		"gu",
	),
];

/**
 * Redact what looks like a credential in `text`: user info in URLs (up to the last `@` of the authority), private key
 * blocks (PEM, OpenSSH and PGP), the value of a credential field in JSON (also JSON inside a JSON string), YAML,
 * HTTP-header or env-style text, and well-known token shapes. An unquoted password-like value (`password`, `passwd`,
 * `pwd`, `passphrase`) is redacted to the end of its line. Every pattern is linear in the length of `text`.
 */
export function redactCredentialShapes(text: string): string {
	const withoutBlocks = redactUrlCredentials(text).replace(PRIVATE_KEY_BLOCK, REDACTED);
	const byField = CREDENTIAL_FIELDS.reduce(
		(masked, field) =>
			masked.replace(field, (match) => {
				const separator = /[:=]/u.exec(match)!;
				return `${match.slice(0, separator.index + 1)} ${REDACTED}`;
			}),
		withoutBlocks,
	);
	return CREDENTIAL_SHAPES.reduce((masked, shape) => masked.replace(shape, REDACTED), byField);
}
