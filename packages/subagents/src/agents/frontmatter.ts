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

type RawFrontmatterValue =
	| string
	| boolean
	| number
	| null
	| RawFrontmatterValue[]
	| { [key: string]: RawFrontmatterValue };
type ParsedYamlDocument = { frontmatter: Record<string, RawFrontmatterValue>; body: string };

function toFrontmatterValue(value: RawFrontmatterValue): FrontmatterValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return undefined;
}

export interface ParsedAgentFrontmatter {
	frontmatter: Frontmatter;
	body: string;
	/**
	 * The YAML parser's error message when the document does not parse.
	 * The switch from a line reader to the real parser made previously
	 * loadable files (a colon-space inside a plain scalar, duplicate keys,
	 * tab-indented block lists) read as frontmatter-less; carrying the
	 * error lets the loader report the skipped file instead of letting it
	 * vanish silently.
	 */
	parseError?: string;
}

/**
 * Parse a markdown file's frontmatter with the real YAML parser exported by
 * `@bastani/atomic`. This function never throws: agent discovery loads every
 * `.md` file in a directory, and one file with invalid YAML (an unclosed flow
 * sequence, a colon-space inside a plain scalar) must not take down every
 * other agent there. An unparseable document reads as no frontmatter, which
 * makes the loader skip that file for lacking `name`/`description`, and the
 * parse error is returned so discovery can surface a diagnostic.
 */
export function parseFrontmatter(content: string): ParsedAgentFrontmatter {
	let parsed: ParsedYamlDocument;
	try {
		parsed = parseYamlFrontmatter<Record<string, RawFrontmatterValue>>(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { frontmatter: {}, body: content, parseError: message };
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
