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
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;
	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const terms = [...new Set(tokenize(query))];
		if (!terms.length || !documents.length || limit <= 0) return [];
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
		return documents
			.flatMap((document, index) => {
				let score = 0;
				for (const term of terms) {
					const count = counts[index].get(term);
					if (!count) continue;
					const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / average);
					score += ((idf.get(term) ?? 0) * count * (this.k1 + 1)) / (count + norm);
				}
				return score > 0 ? [{ name: document.name, score }] : [];
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
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
export function createToolSearchDescription(sources: readonly ToolNamespace[] = []): string {
	return `Search deferred tool metadata with BM25 and load matching tools for the next model call.\nSources:\n${sources.length ? sources.map((source) => `- ${source.name}: ${source.description ?? ""}`).join("\n") : "None currently enabled."}`;
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
		prepareLoadout: (loadout) => {
			const sources = new Map<string, ToolNamespace>();
			for (const tool of loadout.registered) {
				const exposure = loadout.getExposure(tool.name);
				const namespace = loadout.getNamespace(tool.name);
				if ((exposure === "codemode" || exposure === "deferred") && namespace)
					sources.set(namespace.name, namespace);
			}
			return { descriptions: { [TOOL_SEARCH_TOOL_NAME]: createToolSearchDescription([...sources.values()]) } };
		},
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
