/**
 * A frontmatter value. Scalars stay strings; YAML sequence values — flow
 * (`tools: [read, bash]`) and block (`tools:` followed by `- read` lines) —
 * parse to arrays so list fields accept the same spellings a real YAML
 * parser produces (upstream pi #7598). Callers narrow per field: a sequence
 * where a scalar belongs is ignored, never stringified.
 */
export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

function stripSurroundingQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Split the inside of a YAML flow sequence (`[a, b]`) into trimmed items.
 * Items keep no surrounding quotes, matching scalar handling.
 */
function parseFlowSequenceItems(inner: string): string[] {
	return inner
		.split(",")
		.map((item) => stripSurroundingQuotes(item.trim()))
		.filter(Boolean);
}

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const frontmatter: Frontmatter = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	const lines = frontmatterBlock.split("\n");

	for (let index = 0; index < lines.length; index++) {
		const match = lines[index]!.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]!;
		const value = match[2]!.trim();

		// YAML flow sequence: `key: [a, b]`. `[]` parses to an empty list.
		if (value.startsWith("[") && value.endsWith("]")) {
			frontmatter[key] = parseFlowSequenceItems(value.slice(1, -1));
			continue;
		}

		// YAML block sequence: `key:` alone, followed by indented `- item` lines.
		if (value === "") {
			const items: string[] = [];
			while (index + 1 < lines.length) {
				const itemMatch = lines[index + 1]!.match(/^\s+-\s+(.*)$/);
				if (!itemMatch) break;
				items.push(stripSurroundingQuotes(itemMatch[1]!.trim()));
				index++;
			}
			if (items.length > 0) {
				frontmatter[key] = items;
				continue;
			}
		}

		frontmatter[key] = stripSurroundingQuotes(value);
	}

	return { frontmatter, body };
}
