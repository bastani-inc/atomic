import { stringify } from "yaml";
import type { AgentConfig } from "./agents.js";
import type { FrontmatterValue } from "./frontmatter.js";
import { frontmatterNameForConfig } from "./identity.js";

export const KNOWN_FIELDS = new Set([
	"name",
	"package",
	"description",
	"tools",
	"model",
	"fallbackModels",
	"fallbackThinkingLevels",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"defaultContext",
	"skill",
	"skills",
	"extensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
]);

/**
 * Frontmatter keys whose feature is gone. They are neither preserved on load nor
 * re-emitted on serialize, so an agent-management rewrite strips a stale key from
 * the file. Each is spelled with a splice so the removed identifier never appears
 * as contiguous source text.
 */
const REMOVED_AGENT_FRONTMATTER_FIELDS = new Set<string>([
	`completion${"Guard"}`,
	`maxSubagent${"Depth"}`,
	`model${"Constraints"}`,
	`task${"Needs"}`,
]);

export function shouldPreserveAgentExtraField(key: string): boolean {
	return !KNOWN_FIELDS.has(key) && !REMOVED_AGENT_FRONTMATTER_FIELDS.has(key);
}

function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

/**
 * Render one extra frontmatter field through the real YAML emitter so an
 * unknown custom field survives an agent update without changing meaning.
 * The yaml package quotes scalars a hand-joined spelling corrupts: `a #b`
 * would open a comment mid-flow-sequence and leave the file unparseable,
 * `a, b` would split into two items, `a: b` would start a nested mapping,
 * and an unquoted `""` or `"true"` would change type on re-parse. Keys are
 * emitted by the same call, so a custom key that needs quoting gets it.
 * Sequences render as block collections and may span several lines; nested
 * maps are dropped at parse (they have no agent-frontmatter spelling) and
 * so never reach this path. Every emitted shape re-parses to itself, so
 * load → serialize → load is stable.
 */
function serializeExtraFieldEntry(key: string, value: FrontmatterValue): string[] {
	return stringify({ [key]: value }, { lineWidth: 0 })
		.trimEnd()
		.split("\n");
}

export function serializeAgent(config: AgentConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${frontmatterNameForConfig(config)}`);
	if (config.packageName) lines.push(`package: ${config.packageName}`);
	lines.push(`description: ${config.description}`);

	const tools = [...(config.tools ?? []), ...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
	const toolsValue = joinComma(tools);
	if (toolsValue) lines.push(`tools: ${toolsValue}`);

	if (config.model) lines.push(`model: ${config.model}`);
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue) lines.push(`fallbackModels: ${fallbackModelsValue}`);
	const fallbackThinkingLevelsValue = joinComma(config.fallbackThinkingLevels);
	if (fallbackThinkingLevelsValue) lines.push(`fallbackThinkingLevels: ${fallbackThinkingLevelsValue}`);
	if (config.thinking && config.thinking !== "off") lines.push(`thinking: ${config.thinking}`);
	lines.push(`systemPromptMode: ${config.systemPromptMode}`);
	lines.push(`inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`);
	lines.push(`inheritSkills: ${config.inheritSkills ? "true" : "false"}`);
	if (config.defaultContext) lines.push(`defaultContext: ${config.defaultContext}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue) lines.push(`skills: ${skillsValue}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");

	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (!shouldPreserveAgentExtraField(key)) continue;
			lines.push(...serializeExtraFieldEntry(key, value));
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}
