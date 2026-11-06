import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";

/**
 * The subschema a local `$ref` (`#`, `#/$defs/Item`, `#/anyOf/0`) names in `root`, or undefined for remote references
 * and references that name nothing. Segments are read as JSON Pointer (RFC 6901) segments: URI-decoded and unescaped
 * (`~1` is `/`, `~0` is `~`), an empty segment is the empty key, and an index names an array element.
 */
export function resolveSchemaRef(ref: string, root: unknown): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref === "#" ? [] : ref.slice(2).split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			// Schemas come from tools and MCP servers: a malformed escape names nothing instead of failing the caller.
			return undefined;
		}
		const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	if (typeof current === "boolean") return current;
	return typeof current === "object" && current !== null && !Array.isArray(current)
		? (current as Record<string, unknown>)
		: undefined;
}
