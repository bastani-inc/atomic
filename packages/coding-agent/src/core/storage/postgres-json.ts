/** A NUL or surrogate escape after an even number of backslashes, not the literal text `\\u…`. */
export const POSTGRES_UNREPRESENTABLE_ESCAPE = String.raw`'(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89abcdefABCDEF][0-9a-fA-F]{2})'`;

/**
 * Read JSON as jsonb without rejecting the whole document for a lone surrogate or NUL in an unrelated field.
 * Leave input that jsonb accepts unchanged, including a correctly paired surrogate escape.
 */
export function postgresJsonb(column: string): string {
	return String.raw`(CASE WHEN strpos(${column}, '\u') = 0 OR pg_input_is_valid(${column}, 'jsonb') THEN ${column} ELSE regexp_replace(${column}, ${POSTGRES_UNREPRESENTABLE_ESCAPE}, '\1\\ufffd', 'g') END)::jsonb`;
}
