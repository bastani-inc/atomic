import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";

/**
 * The subschema a local `$ref` (`#`, `#/$defs/Item`) names in `root`, or undefined for remote references and
 * references that name nothing. Pointer segments are URI-decoded and JSON Pointer unescaped (`~1` is `/`, `~0` is `~`),
 * as pi-codemode resolves them when it renders tool declarations.
 */
export function resolveSchemaRef(ref: string, root: unknown): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			// Schemas come from tools and MCP servers: a malformed escape names nothing instead of failing the caller.
			return undefined;
		}
		const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || Array.isArray(current) || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	if (typeof current === "boolean") return current;
	return typeof current === "object" && current !== null && !Array.isArray(current)
		? (current as Record<string, unknown>)
		: undefined;
}
