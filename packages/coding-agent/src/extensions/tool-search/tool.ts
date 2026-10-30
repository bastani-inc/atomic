import { type Static, Type } from "typebox";
import type { ExtensionAPI, ToolDefinition, ToolInfo, ToolNamespace } from "../../core/extensions/types.ts";
import { createMcpToolName } from "../mcp/tools.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
/** A tool as the ranker sees it: its name and the texts built by {@link createToolSearchDocument}. */
export interface ToolSearchDocument {
	name: string;
	/** Description, schema descriptions, and property names. */
	text: string;
	/** Name, description, and instructions of the tool's namespace. */
	namespaceText?: string;
}
export interface ToolSearchMatch {
	name: string;
	score: number;
}
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}
/** Unicode word segmentation with identifier boundaries and English stop words and singular forms. */
export function tokenize(text: string): string[] {
	const normalized = text
		.normalize("NFC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	return words
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word));
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties))
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"])
		if (Array.isArray(schema[key])) for (const variant of schema[key]) schemaText(variant, parts);
}
/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	const namespaceText = namespace
		? [namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}
/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}
/**
 * The normalized forms `query` can take for one tool name. MCP tools are registered as
 * `mcp__<server>__<tool>` with `-` and `.` sanitized to `_`, but skills and models also write the
 * dotted `mcp.<server>.<tool>` and the raw `mcp__alteryx-local__…` forms (#4065). In the dotted form
 * only the first two dots separate server and tool. The rest is a raw tool name, either as written
 * (`mcp.srv.get.item/v2` for the tool `get.item/v2`) or with its dots standing for `__`
 * (`mcp.alteryx-local.alteryx_local.get_server_info` for `alteryx_local__get_server_info`); each is
 * named the way registration names it, with `createMcpToolName`.
 */
function nameQueryForms(query: string): Set<string> {
	const trimmed = query.trim();
	const dotted = /^mcp\.([^.]+)\.(.+)$/i.exec(trimmed);
	if (!dotted) return new Set([normalizeName(trimmed), normalizeName(trimmed.replaceAll(".", "__"))]);
	const [, server, tool] = dotted;
	return new Set([
		normalizeName(trimmed),
		normalizeName(createMcpToolName(server, tool)),
		normalizeName(createMcpToolName(server, tool.replaceAll(".", "__"))),
	]);
}
/**
 * Whether `query` names the tool: its full name or a suffix after a `__` separator, so `thread_read`
 * and `app__thread_read` both name `mcp__app__thread_read`, and `mcp.app.thread_read` does too.
 */
function isNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	for (const form of nameQueryForms(query)) if (normalized === form || normalized.endsWith(`__${form}`)) return true;
	return false;
}
/**
 * The tool names `query` names, as {@link isNameQuery} matches them: the exact name when it is
 * registered, else every full-name match, else every `__` suffix match. More than one result is
 * ambiguous; callers must not pick one.
 */
export function resolveToolNames(query: string, names: readonly string[]): string[] {
	if (names.includes(query)) return [query];
	const forms = nameQueryForms(query);
	const full = names.filter((name) => forms.has(normalizeName(name)));
	return full.length ? full : names.filter((name) => isNameQuery(query, name));
}
/** A document split into the fields the ranker weighs differently. */
interface IndexedDocument {
	name: string;
	/** Terms of the name, for example `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	nameTerms: ReadonlySet<string>;
	/** Terms of the last `__` segment of the name, the part models say: `thread`, `read`. */
	localNameTerms: readonly string[];
	textCounts: ReadonlyMap<string, number>;
	textLength: number;
	namespaceTerms: ReadonlySet<string>;
}

function indexDocument(document: ToolSearchDocument): IndexedDocument {
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	const segments = document.name.split("__");
	return {
		name: document.name,
		nameTerms: new Set(tokenize(document.name)),
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		textCounts,
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace name, description, or instructions counts this many times its IDF. They
 * are shared by every tool of the server, so they help find the server but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a query that names a tool (see {@link isNameQuery}) ranks that tool first, before coverage;
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words.
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;
	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		if (!documents.length || limit <= 0) return [];
		const queryTerms = new Set(tokenize(query));
		// A query made only of stop words has no BM25 terms, but can still name a tool exactly (`is`).
		if (queryTerms.size === 0) {
			return documents
				.filter((document) => isNameQuery(query, document.name))
				.slice(0, limit)
				.map((document) => ({ name: document.name, score: 0 }));
		}
		const indexed = documents.map(indexDocument);
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		const idf = new Map(
			[...queryTerms].map((term) => {
				const frequency = indexed.filter(
					(document) =>
						document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
				).length;
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		const matches: (ToolSearchMatch & { covered: number; named: boolean })[] = [];
		for (const document of indexed) {
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			let score = 0;
			let covered = 0;
			for (const term of queryTerms) {
				const count = document.textCounts.get(term) ?? 0;
				const weight =
					(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
					(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
					(count * (this.k1 + 1)) / (count + norm);
				if (weight > 0) covered++;
				score += (idf.get(term) ?? 0) * weight;
			}
			// A query naming the tool keeps it even when tokenization shares no term with it (`readthread`
			// for `readThread`).
			const named = isNameQuery(query, document.name);
			if (score === 0 && !named) continue;
			const local = document.localNameTerms;
			if (score > 0 && local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			matches.push({ name: document.name, score, covered, named });
		}
		return matches
			.sort((a, b) => Number(b.named) - Number(a.named) || b.covered - a.covered || b.score - a.score)
			.slice(0, limit)
			.map(({ name, score }) => ({ name, score }));
	}
}
export const toolSearchSchema = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) });
export type ToolSearchInput = Static<typeof toolSearchSchema>;
export interface ToolSearchToolDetails {
	loaded: string[];
}
export interface ToolSearchToolOptions {
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}
export function isToolSearchTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.parameters === toolSearchSchema;
}
export function createToolSearchDescription(_sources: readonly ToolNamespace[] = []): string {
	return "Search deferred tool metadata with BM25 and load matching tools for the next model call. Some tools may not have been provided upfront; use tool_search to discover currently registered tools.";
}
export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: createToolSearchDescription(),
		parameters: toolSearchSchema,
		exposure: "model-only",
		defaultActive: false,
		execute: async (_id, { query, limit = DEFAULT_TOOL_SEARCH_LIMIT }) => {
			if (!query.trim()) throw new Error("query must not be empty");
			if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
			const active = options.tools?.getActiveTools() ?? [];
			const candidates =
				options.tools
					?.getAllTools()
					.filter(
						(tool) =>
							(tool.exposure === "codemode" || tool.exposure === "deferred") && !active.includes(tool.name),
					) ?? [];
			const matches = new Bm25Ranker().rank(
				query,
				candidates.map((tool) => createToolSearchDocument(tool, tool.namespace)),
				limit,
			);
			if (matches.length) options.tools?.setActiveTools([...active, ...matches.map((match) => match.name)]);
			return {
				content: [
					{
						type: "text",
						text: matches.length
							? `Loaded tools for your next call:\n${matches.map((match) => `- ${match.name}: ${candidates.find((tool) => tool.name === match.name)?.description ?? ""}`).join("\n")}`
							: "No matching tools found.",
					},
				],
				details: { loaded: matches.map((match) => match.name) },
			};
		},
	};
}
