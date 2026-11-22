/**
 * `value` as a JavaScript string literal for code a build script writes: JSON's escapes (quotes, backslashes, control
 * characters, lone surrogates), and `<`, `>`, U+2028 and U+2029 as `\u` escapes, so no value can close a `<script>`
 * element around the code, open an HTML comment in it, or end the literal's line. Every build script that writes
 * JavaScript from a value writes the value through this.
 *
 * @param {string} value
 * @returns {string}
 */
export function codeStringLiteral(value) {
	if (typeof value !== "string") throw new TypeError(`codeStringLiteral: ${typeof value} is not a string`);
	return JSON.stringify(value)
		.replaceAll("<", "\\u003C")
		.replaceAll(">", "\\u003E")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * The strings `values` as a JavaScript array literal for code a build script writes: as `JSON.stringify` writes such an
 * array, each element through {@link codeStringLiteral}.
 *
 * @param {readonly string[]} values
 * @returns {string}
 */
export function codeStringArrayLiteral(values) {
	return `[${values.map(codeStringLiteral).join(",")}]`;
}
