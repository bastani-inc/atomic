const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/\bBearer\s+[\w.~+/-]+=*/giu,
	/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/gu,
	/\b(?:sk|pk|rk|api|key|tok|token|secret)[-_][\w-]{12,}/giu,
];

const CREDENTIAL_FIELD_NAME =
	"(?:x-)?(?:api[-_]?key|apikey|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|session[-_]?key|password|passwd|token|secret|key)";
const CREDENTIAL_AUTH_SCHEME = "(?:Bearer|Basic|Digest|Token|ApiKey|OAuth)";

const CREDENTIAL_CONTEXTS: readonly RegExp[] = [
	new RegExp(String.raw`\b${CREDENTIAL_FIELD_NAME}\s*:\s*(?:${CREDENTIAL_AUTH_SCHEME}\s+)?[^\s,;}"']+`, "giu"),
	new RegExp(String.raw`(["']?)${CREDENTIAL_FIELD_NAME}\1\s*:\s*(["'])(?:(?!\2).)*\2`, "giu"),
	new RegExp(String.raw`\b${CREDENTIAL_FIELD_NAME}\s*=\s*[^\s&,;}"']+`, "giu"),
];

export function redactCredentialShapes(text: string): string {
	const byContext = CREDENTIAL_CONTEXTS.reduce(
		(masked, context) =>
			masked.replace(context, (match) => {
				const separator = /[:=]/u.exec(match);
				return separator ? `${match.slice(0, separator.index + 1)} [redacted]` : "[redacted]";
			}),
		text,
	);
	return CREDENTIAL_SHAPES.reduce((masked, shape) => masked.replace(shape, "[redacted]"), byContext);
}
