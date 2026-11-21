/** Characters JSON leaves as they are that a string literal in generated code writes as `\u` escapes. */
const ESCAPED_IN_CODE = /[<>/\u2028\u2029]/g;

/**
 * `value` as a JavaScript string literal for code a build script writes: JSON's escapes, and `<`, `>`, `/`, U+2028 and
 * U+2029 as `\u` escapes, so no value can close a `<script>` element around the code or end the literal's line.
 */
export function codeStringLiteral(value: string): string {
	return JSON.stringify(value).replace(
		ESCAPED_IN_CODE,
		(char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
	);
}
