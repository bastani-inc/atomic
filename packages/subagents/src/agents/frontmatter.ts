import { parseFrontmatter as parseYamlFrontmatter } from "@bastani/atomic";

/**
 * A frontmatter value as a real YAML parser produces it (upstream pi #7598
 * parses agent frontmatter with the yaml library, not a line reader): scalars
 * parse to strings, booleans, numbers, or null; sequences — flow
 * (`tools: [read, bash]`, single- or multi-line) and block (`tools:` followed
 * by `- read` lines at any indentation) — parse to arrays of their string
 * items. Nested maps have no agent-frontmatter spelling and are dropped at
 * parse, so every consumer narrows over a finite union instead of
 * re-deriving YAML semantics per field.
 */
export type FrontmatterValue = string | string[] | boolean | number | null;
export type Frontmatter = Record<string, FrontmatterValue>;

function toFrontmatterValue(value: unknown): FrontmatterValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return undefined;
}

/**
 * Parse a markdown file's frontmatter with the real YAML parser exported by
 * `@bastani/atomic`. This function never throws: agent discovery loads every
 * `.md` file in a directory, and one file with invalid YAML (an unclosed flow
 * sequence, a colon-space inside a plain scalar) must not take down every
 * other agent there. An unparseable document reads as no frontmatter, which
 * makes the loader skip that file for lacking `name`/`description`.
 */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	let parsed: { frontmatter: unknown; body: string };
	try {
		parsed = parseYamlFrontmatter(content);
	} catch {
		return { frontmatter: {}, body: content };
	}
	const frontmatter: Frontmatter = {};
	const raw = parsed.frontmatter;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { frontmatter, body: parsed.body };
	for (const [key, value] of Object.entries(raw)) {
		const narrowed = toFrontmatterValue(value);
		if (narrowed !== undefined) frontmatter[key] = narrowed;
	}
	return { frontmatter, body: parsed.body };
}
