import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMaxSubagentDepth } from "../shared/types.ts";
import { splitToolList } from "./agent-overrides.ts";
import { shouldPreserveAgentExtraField } from "./agent-serializer.ts";
import {
	type AgentConfig,
	type AgentSource,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.ts";
import { type FrontmatterValue, parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";

function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return files;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listFilesRecursive(filePath, predicate));
			continue;
		}
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!predicate(entry.name)) continue;
		files.push(filePath);
	}
	return files;
}

function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
	const parsed = value
		?.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return parsed && parsed.length > 0 ? parsed : undefined;
}

/**
 * Narrow a frontmatter value to its scalar spelling. A YAML sequence where a
 * scalar belongs (`model: [anthropic, x]`) reads as undefined rather than a
 * stringified list, matching upstream's `typeof` narrowing.
 */
function frontmatterString(value: FrontmatterValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use (upstream pi #7598):
 *
 *     tools: read, bash        # string, comma-separated
 *     tools: [read, bash]      # flow sequence
 *     tools:                   # block sequence
 *       - read
 *       - bash
 *
 * so accept either. Anything else yields no tools rather than throwing: this
 * runs inside agent discovery, where a single bad file must not take down
 * every other agent in the same directory.
 */
function parseToolList(value: FrontmatterValue | undefined): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".md"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		// Sequences are legal frontmatter but not valid `name`/`description`
		// spellings; a file whose identity fields are not plain strings is
		// skipped whole, exactly as upstream's loader does.
		const localName = frontmatterString(frontmatter.name);
		const description = frontmatterString(frontmatter.description);
		if (!localName || !description) {
			continue;
		}

		const parsedPackage = parsePackageName(frontmatterString(frontmatter.package), `Agent '${localName}' package`);
		if (parsedPackage.error) continue;
		const packageName = parsedPackage.packageName;
		const runtimeName = buildRuntimeName(localName, packageName);

		const rawTools = parseToolList(frontmatter.tools);
		const parsedTools = splitToolList(rawTools);
		const defaultReads = parseCommaSeparatedList(frontmatterString(frontmatter.defaultReads));
		const skillStr = frontmatterString(frontmatter.skill) || frontmatterString(frontmatter.skills) || undefined;
		const skills = parseCommaSeparatedList(skillStr);
		const fallbackModels = parseCommaSeparatedList(frontmatterString(frontmatter.fallbackModels));
		const fallbackThinkingLevels = parseCommaSeparatedList(frontmatterString(frontmatter.fallbackThinkingLevels));
		const systemPromptModeRaw = frontmatterString(frontmatter.systemPromptMode);
		const inheritProjectContextRaw = frontmatterString(frontmatter.inheritProjectContext);
		const inheritSkillsRaw = frontmatterString(frontmatter.inheritSkills);
		const defaultContextRaw = frontmatterString(frontmatter.defaultContext);
		const extensionsRaw = frontmatterString(frontmatter.extensions);
		const maxSubagentDepthRaw = frontmatterString(frontmatter.maxSubagentDepth);
		const systemPromptMode =
			systemPromptModeRaw === "replace"
				? "replace"
				: systemPromptModeRaw === "append"
					? "append"
					: defaultSystemPromptMode(localName);
		const inheritProjectContext =
			inheritProjectContextRaw === "true"
				? true
				: inheritProjectContextRaw === "false"
					? false
					: defaultInheritProjectContext(localName);
		const inheritSkills =
			inheritSkillsRaw === "true" ? true : inheritSkillsRaw === "false" ? false : defaultInheritSkills();
		const defaultContext =
			defaultContextRaw === "fork"
				? ("fork" as const)
				: defaultContextRaw === "fresh"
					? ("fresh" as const)
					: undefined;

		let extensions: string[] | undefined;
		if (extensionsRaw !== undefined) {
			extensions = extensionsRaw
				.split(",")
				.map((extension) => extension.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (shouldPreserveAgentExtraField(key) && typeof value === "string") extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = normalizeMaxSubagentDepth(maxSubagentDepthRaw);

		agents.push({
			name: runtimeName,
			localName,
			packageName,
			description,
			tools: parsedTools.tools,
			mcpDirectTools: parsedTools.mcpDirectTools,
			model: frontmatterString(frontmatter.model),
			fallbackModels,
			fallbackThinkingLevels,
			thinking: frontmatterString(frontmatter.thinking),
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			defaultContext,
			systemPrompt: body,
			source,
			filePath,
			skills,
			extensions,
			output: frontmatterString(frontmatter.output),
			defaultReads,
			defaultProgress: frontmatterString(frontmatter.defaultProgress) === "true",
			interactive: frontmatterString(frontmatter.interactive) === "true",
			maxSubagentDepth: parsedMaxSubagentDepth,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}
