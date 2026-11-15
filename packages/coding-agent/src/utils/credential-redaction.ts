import { redactUrlCredentials } from "../core/error-contract.ts";

const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/gu;

const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/\bBearer\s+[\w.~+/-]+=*/giu,
	/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/gu,
	/\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu,
];

/**
 * A credential field name. A letter or digit may not come right before it, but `_` or `-` may, so `DB_PASSWORD` and
 * `GITHUB_TOKEN` count while `monkey` does not.
 */
const CREDENTIAL_FIELD_NAME =
	"(?<![a-z0-9])(?:x-)?(?:api[-_]?key|apikey|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|session[-_]?key|password|passwd|pwd|credentials?|token|secret|key)";
const CREDENTIAL_AUTH_SCHEME = "(?:Bearer|Basic|Digest|Token|ApiKey|OAuth)";
/**
 * A quoted value runs to its closing quote, past backslash escapes and doubled quotes, or to the end of the line when
 * it is cut off. No alternative overlaps another, so a match never backtracks.
 */
const QUOTED_VALUE = String.raw`(["'])(?:\\.|\2\2|(?!\2)[^\\\n])*\2?`;

/**
 * A credential field, quoted (`"token":`, `'password':`) or not (`token:`, `API_KEY=`), and its value: a quoted
 * string, or an unquoted run that may follow an authorization scheme.
 */
const CREDENTIAL_FIELD = new RegExp(
	String.raw`${CREDENTIAL_FIELD_NAME}(["']?)\s*(?::\s*(?:${QUOTED_VALUE}|(?:${CREDENTIAL_AUTH_SCHEME}\s+)?[^\s,;}"']+)|=\s*(?:${QUOTED_VALUE.replaceAll("\\2", "\\3")}|[^\s&,;}"']+))`,
	"giu",
);

/**
 * Redact what looks like a credential in `text`: user info in URLs (up to the last `@` of the authority), private key
 * blocks, the value of a credential field in JSON, YAML, HTTP-header or env-style text, and well-known token shapes.
 * Every pattern is linear in the length of `text`.
 */
export function redactCredentialShapes(text: string): string {
	const byField = redactUrlCredentials(text)
		.replace(PRIVATE_KEY_BLOCK, "[redacted]")
		.replace(CREDENTIAL_FIELD, (match) => {
			const separator = /[:=]/u.exec(match)!;
			return `${match.slice(0, separator.index + 1)} [redacted]`;
		});
	return CREDENTIAL_SHAPES.reduce((masked, shape) => masked.replace(shape, "[redacted]"), byField);
}
