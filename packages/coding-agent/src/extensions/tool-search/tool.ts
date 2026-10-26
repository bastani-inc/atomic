import { type Static, Type } from "typebox";
import type { ExtensionAPI, ToolDefinition, ToolInfo, ToolNamespace } from "../../core/extensions/types.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export interface ToolSearchDocument {
	name: string;
	text: string;
}
export interface ToolSearchMatch {
	name: string;
	score: number;
}
export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}
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
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
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
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}
/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}
/**
 * Whether `query` names the tool: its full name or a suffix after a `__` separator, so `thread_read`
 * and `app__thread_read` both name `mcp__app__thread_read`.
 */
function isNameQuery(query: string, name: string): boolean {
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}
/**
 * Okapi BM25 with the usual parameters. A query that names a tool ranks that tool first, because
 * length normalization can otherwise rank a short description sharing the name's words above it.
 * Ties keep document order.
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
		const terms = [...new Set(tokenize(query))];
		// A query made only of stop words has no BM25 terms, but can still name a tool exactly (`is`).
		if (!terms.length) {
			const nameQuery = normalizeName(query);
			return documents
				.filter((document) => isNameQuery(nameQuery, document.name))
				.slice(0, limit)
				.map((document) => ({ name: document.name, score: 0 }));
		}
		const counts = documents.map((document) => {
			const result = new Map<string, number>();
			for (const term of tokenize(document.text)) result.set(term, (result.get(term) ?? 0) + 1);
			return result;
		});
		const lengths = counts.map((count) => [...count.values()].reduce((sum, value) => sum + value, 0));
		const average = lengths.reduce((sum, value) => sum + value, 0) / documents.length || 1;
		const idf = new Map(
			terms.map((term) => {
				const frequency = counts.filter((count) => count.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
			}),
		);
		const nameQuery = normalizeName(query);
		return documents
			.flatMap((document, index) => {
				let score = 0;
				for (const term of terms) {
					const count = counts[index].get(term);
					if (!count) continue;
					const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / average);
					score += ((idf.get(term) ?? 0) * count * (this.k1 + 1)) / (count + norm);
				}
				// A query naming the tool keeps it even when tokenization shares no term with it (`readthread`
				// for `readThread`).
				const named = isNameQuery(nameQuery, document.name);
				return score > 0 || named ? [{ name: document.name, score, named }] : [];
			})
			.sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score)
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
