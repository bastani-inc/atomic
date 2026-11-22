import { parse } from "yaml";
import { stripBom } from "./text.ts";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const YAML_RESERVED_PLAIN_SCALARS = new Set(["null", "Null", "NULL", "~", "True", "TRUE", "False", "FALSE"]);
const YAML_RESERVED_KEY_NAMES = new Set([
	"null",
	"Null",
	"NULL",
	"true",
	"True",
	"TRUE",
	"false",
	"False",
	"FALSE",
	"__proto__",
]);

function isSimpleKey(key: string): boolean {
	if (key.length === 0 || YAML_RESERVED_KEY_NAMES.has(key)) return false;
	const first = key.charCodeAt(0);
	const firstOk =
		(first >= 0x61 && first <= 0x7a) || // a-z
		(first >= 0x41 && first <= 0x5a) || // A-Z
		first === 0x5f; // _
	if (!firstOk) return false;
	for (let i = 1; i < key.length; i++) {
		const c = key.charCodeAt(i);
		const ok =
			(c >= 0x61 && c <= 0x7a) || // a-z
			(c >= 0x41 && c <= 0x5a) || // A-Z
			(c >= 0x30 && c <= 0x39) || // 0-9
			c === 0x2d || // -
			c === 0x5f; // _
		if (!ok) return false;
	}
	return true;
}

function isSpaceOnlyPipeHeader(rest: string): boolean {
	if (rest.length === 0 || rest.charCodeAt(0) !== 0x7c) return false; // '|'
	for (let i = 1; i < rest.length; i++) {
		if (rest.charCodeAt(i) !== 0x20) return false; // ASCII space only
	}
	return true;
}

function isDisallowedPlainStart(code: number): boolean {
	// Reject digits, signs, dots (numbers/.inf/.nan), and all YAML 1.2 indicator characters.
	if (code >= 0x30 && code <= 0x39) return true;
	return (
		code === 0x2d || // -
		code === 0x2b || // +
		code === 0x2e || // .
		code === 0x3f || // ?
		code === 0x3a || // :
		code === 0x2c || // ,
		code === 0x5b || // [
		code === 0x5d || // ]
		code === 0x7b || // {
		code === 0x7d || // }
		code === 0x23 || // #
		code === 0x26 || // &
		code === 0x2a || // *
		code === 0x21 || // !
		code === 0x7c || // |
		code === 0x3e || // >
		code === 0x27 || // '
		code === 0x22 || // "
		code === 0x25 || // %
		code === 0x40 || // @
		code === 0x60 // `
	);
}

/**
 * Matches lowercase hex strings (e.g. git commit/tree SHAs) starting with a digit that YAML 1.2 always parses as
 * plain strings: length >= 7, all `[0-9a-f]`, containing at least one `[a-df]` (excluding `e` alone so scientific
 * notation like `1e50000` falls back to `yaml.parse`, and no `x` so `0x...` hex literals fall back).
 */
function isLowerHexGitShaScalar(value: string): boolean {
	if (value.length < 7) return false;
	let hasNonEHexLetter = false;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 0x30 && c <= 0x39) continue;
		if (c >= 0x61 && c <= 0x66) {
			if (c !== 0x65) hasNonEHexLetter = true;
			continue;
		}
		return false;
	}
	return hasNonEHexLetter;
}

/**
 * Parse a single scalar value in the proven YAML 1.2 simple subset:
 * lowercase booleans (`true`/`false`), JSON-compatible double-quoted strings, or safe plain strings.
 * Returns `undefined` to fall back to the full `yaml` parser for any other syntax.
 */
function parseSimpleScalar(raw: string): string | boolean | undefined {
	let end = raw.length;
	while (end > 0 && raw.charCodeAt(end - 1) === 0x20) end--;
	const value = end === raw.length ? raw : raw.slice(0, end);
	if (value.length === 0) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.charCodeAt(0) === 0x22) {
		if (value.length < 2 || value.charCodeAt(value.length - 1) !== 0x22) return undefined;
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	if (YAML_RESERVED_PLAIN_SCALARS.has(value)) return undefined;
	const first = value.charCodeAt(0);
	if (first >= 0x30 && first <= 0x39) {
		return isLowerHexGitShaScalar(value) ? value : undefined;
	}
	if (isDisallowedPlainStart(first)) return undefined;
	if (value.charCodeAt(value.length - 1) === 0x3a) return undefined; // trailing ':'
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c < 0x20) return undefined; // tabs or control chars
		if (c === 0x23 && i > 0 && value.charCodeAt(i - 1) === 0x20) return undefined; // " #" comment
		if (c === 0x3a && i + 1 < value.length && value.charCodeAt(i + 1) === 0x20) return undefined; // ": " mapping
	}
	return value;
}

/**
 * Fast exact parser for simple flat, 1-level nested scalar, and simple literal-block (`|`) YAML frontmatter
 * (such as bundled SKILL.md files). Falls back to `yaml.parse` (returning `undefined`) for any other syntax.
 */
function tryParseSimpleFrontmatter(yamlString: string): Record<string, unknown> | undefined {
	const result: Record<string, unknown> = {};
	let currentMap: Record<string, unknown> | undefined;
	let currentMapIndent = 0;
	let currentMapHasEntries = false;
	let hasEntries = false;

	const lines = yamlString.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		let indent = 0;
		while (indent < line.length && line.charCodeAt(indent) === 0x20) indent++;
		if (indent === line.length) continue;
		if (line.charCodeAt(indent) === 0x09 || line.charCodeAt(indent) === 0x23) return undefined; // tab or comment

		const colon = line.indexOf(":", indent);
		if (colon === -1) return undefined;
		const key = line.slice(indent, colon);
		if (!isSimpleKey(key)) return undefined;

		let restStart = colon + 1;
		const hasSeparator = restStart === line.length || line.charCodeAt(restStart) === 0x20;
		if (!hasSeparator) return undefined;
		while (restStart < line.length && line.charCodeAt(restStart) === 0x20) restStart++;
		const rest = line.slice(restStart);

		if (indent === 0) {
			if (currentMap !== undefined && !currentMapHasEntries) return undefined;
			currentMap = undefined;
			currentMapIndent = 0;
			currentMapHasEntries = false;
			if (Object.hasOwn(result, key)) return undefined;
			if (rest.length === 0) {
				const nested: Record<string, unknown> = {};
				result[key] = nested;
				currentMap = nested;
				hasEntries = true;
			} else if (isSpaceOnlyPipeHeader(rest)) {
				// Simple literal block scalar (default clip chomping): 1+ non-empty indented lines at a single uniform indent.
				let blockIndent = 0;
				const blockLines: string[] = [];
				let j = i + 1;
				for (; j < lines.length; j++) {
					const nextLine = lines[j]!;
					let nextIndent = 0;
					while (nextIndent < nextLine.length && nextLine.charCodeAt(nextIndent) === 0x20) nextIndent++;
					// Blank/trailing-blank lines inside or after a block have subtle YAML chomping rules: fall back.
					if (nextIndent === nextLine.length) return undefined;
					if (nextLine.charCodeAt(nextIndent) === 0x09) return undefined;
					if (nextIndent === 0) break;
					if (blockIndent === 0) blockIndent = nextIndent;
					else if (nextIndent < blockIndent) return undefined;
					blockLines.push(nextLine.slice(blockIndent));
				}
				if (blockLines.length === 0) return undefined;
				result[key] = `${blockLines.join("\n")}\n`;
				hasEntries = true;
				i = j - 1;
			} else {
				const scalar = parseSimpleScalar(rest);
				if (scalar === undefined) return undefined;
				result[key] = scalar;
				hasEntries = true;
			}
		} else {
			if (currentMap === undefined) return undefined;
			if (currentMapIndent === 0) currentMapIndent = indent;
			else if (indent !== currentMapIndent) return undefined;
			if (Object.hasOwn(currentMap, key)) return undefined;
			if (rest.length === 0) return undefined;
			const scalar = parseSimpleScalar(rest);
			if (scalar === undefined) return undefined;
			currentMap[key] = scalar;
			currentMapHasEntries = true;
		}
	}

	if (!hasEntries || (currentMap !== undefined && !currentMapHasEntries)) return undefined;
	return result;
}

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(stripBom(content));

	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const fast = tryParseSimpleFrontmatter(yamlString);
	if (fast !== undefined) {
		return { frontmatter: fast as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
