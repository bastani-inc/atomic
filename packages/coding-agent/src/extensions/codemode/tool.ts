import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import {
	mcpStructuredContentSchema,
	renderToolOutputType,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.js";
import type { ToolDefinition, ToolInfo, ToolLoadout, ToolNamespace } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { codemodeRenderers } from "./renderer.js";

export const CODEMODE_TOOL_NAME = "codemode";
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}
export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;
export interface CodemodeToolOptions {
	getToolNamespace?: (name: string) => ToolNamespace | undefined;
	/** Prompt guidelines shown with tool declarations in describeTool() and ALL_TOOLS. */
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	models?: boolean;
	appendEntry?: (type: string, data: CodemodeStoreEntryData) => void;
	getMode?: () => CodemodeMode;
	getInlineBudget?: () => number | undefined;
}
export const codemodeSchema = Type.Object({
	code: Type.String({
		description:
			'Raw JavaScript source with top-level await and return. Optional first line // @options: {"max_output_tokens": 1000, "timeout_ms": 60000}',
	}),
});
export type CodemodeToolInput = Static<typeof codemodeSchema>;
export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}
export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}
export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}
export function toCodemodeDeclaration(
	tool: AgentTool,
	guidelines: readonly string[] = [],
): Omit<CodemodeTool, "execute"> {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return {
		name: tool.name,
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	};
}
export function getCodemodeCallableTools(tools: readonly AgentTool[]): AgentTool[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}
export interface CodemodeDescriptionOptions {
	models?: boolean;
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	deferred?: ReadonlySet<string>;
	guidelines?: ReadonlyMap<string, readonly string[]>;
	inlineBudget?: number;
}
const INTRO = `Run JavaScript that composes tool calls in a fresh QuickJS worker sandbox.
Top-level await and return work. Use tools.name(args), or tools["raw-name"](args). Tool names normalize to JavaScript identifiers.
No Node, filesystem, network, timers, modules or credentials are available directly. Calls go through session validation and permission hooks. They have real side effects and are not undone after script failure.
Tools with output schemas resolve to structuredContent; others resolve to text. Failed or blocked calls throw. Scripts have a 256 MB memory limit.
Globals: ALL_TOOLS, text(value), image(base64DataUrlOrImageContent), exit(), console.log(...), store(key, value), load(key), await searchTools(query, {limit?, namespace?}), await describeTool(name), await describeNamespace(name).
image() also saves each image to a temp file and the result names its path before the image.
Successful scripts persist store writes on the current session branch; failed scripts discard writes. Unawaited calls are cancelled when the script ends.
Optional first line: // @options: {"max_output_tokens": 1000, "timeout_ms": 60000}. Output defaults to 10000 tokens; there is no default deadline.`;

export function createCodemodeDescription(
	tools: readonly AgentTool[],
	options: CodemodeDescriptionOptions = {},
): string {
	const groups = new Map<
		string,
		{ namespace?: ToolNamespace; entries: { name: string; section: string; cost: number }[] }
	>();
	for (const tool of getCodemodeCallableTools(tools)) {
		if (options.deferred?.has(tool.name)) continue;
		const namespace = options.namespaces?.get(tool.name);
		const key = namespace?.name ?? "";
		let group = groups.get(key);
		if (!group) {
			group = { namespace, entries: [] };
			groups.set(key, group);
		}
		const id = toCodemodeIdentifier(tool.name);
		const section = `### \`${id}\`${id === tool.name ? "" : ` (\`${tool.name}\`)`}\n${renderToolSample(toCodemodeDeclaration(tool, options.guidelines?.get(tool.name))).trim()}`;
		group.entries.push({
			name: tool.name,
			section,
			cost: Math.ceil(section.length / 4),
		});
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = new Set<string>();
	let remaining = options.inlineBudget ?? Number.POSITIVE_INFINITY;
	let queues = ordered
		.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost))
		.filter((queue) => queue.length);
	while (queues.length)
		queues = queues.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	const sections = [
		INTRO,
		"Some nested tools may be omitted, including deferred tools. They remain available through tools and ALL_TOOLS. Use await searchTools(query), await describeTool(name), or await describeNamespace(name) to discover them.",
	];
	if (options.models)
		sections.push(
			`Model API: \`models\` lists and runs classifier and image models with the session's credentials. Read ${CODEMODE_DOCS_PATH} before using it.`,
		);
	if (ordered.length === 0) return sections.join("\n\n");
	sections.push("Nested tools:");
	for (const group of ordered) {
		if (group.namespace) {
			const visible = group.entries.filter((entry) => shown.has(entry.name));
			const listing =
				visible.length === group.entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = group.namespace.description?.trim();
			sections.push(`## ${group.namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of group.entries) if (shown.has(entry.name)) sections.push(entry.section);
	}
	return sections.join("\n\n");
}
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const object = typeof schema === "object" ? schema : undefined;
	const properties = object?.properties;
	if (
		object?.type === "object" &&
		typeof properties === "object" &&
		properties !== null &&
		mcpStructuredContentSchema(schema) === undefined
	) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}
function describeScriptCall(tool: AgentTool): string {
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(toCodemodeDeclaration(tool).outputSchema)}.`;
}
function prepareLoadout(loadout: ToolLoadout, options: CodemodeToolOptions) {
	const only = options.getMode?.() === "only";
	const callable = getCodemodeCallableTools(loadout.callable);
	const descriptions: Record<string, string> = {};
	if (!only)
		for (const tool of loadout.declared)
			if (callable.some((candidate) => candidate.name === tool.name))
				descriptions[tool.name] = describeScriptCall(tool);
	const listed = only ? callable : callable.filter((tool) => loadout.getExposure(tool.name) !== "direct");
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		models: options.models,
		namespaces,
		guidelines,
		deferred: new Set(
			listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	return {
		descriptions,
		hiddenDeclarations: only
			? callable.filter((tool) => loadout.getExposure(tool.name) === "direct").map((tool) => tool.name)
			: [],
	};
}
export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription([], options),
		parameters: codemodeSchema,
		exposure: "model-only",
		concurrency: "exclusive",
		defaultActive: false,
		promptSnippet: "Run JavaScript that calls other tools, filters results, or batches independent calls",
		prepareLoadout: (loadout) => prepareLoadout(loadout, options),
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		execute: async (id, input, signal, update, ctx) =>
			(await import("./execute.js")).executeCodemode(id, input, signal, update, ctx, options),
		...codemodeRenderers,
	};
}
export function createCodemodeTool(
	tools: readonly AgentTool[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	return {
		...wrapToolDefinition(createCodemodeToolDefinition(options)),
		description: createCodemodeDescription(tools, options),
	};
}
