export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const UNSAFE_IN_JS_SOURCE: Readonly<Record<string, string>> = {
	"<": "\\u003C",
	">": "\\u003E",
	"/": "\\u002F",
	"\u2028": "\\u2028",
	"\u2029": "\\u2029",
};

export function toJsLiteral(value: JsonValue): string {
	return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (character) => UNSAFE_IN_JS_SOURCE[character]!);
}
