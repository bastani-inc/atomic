import * as fs from "node:fs";
import * as path from "node:path";
import { shouldPreserveAgentExtraField } from "./agent-serializer.ts";
import { parseChain, parseJsonChain } from "./chain-serializer.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import { splitToolList } from "./agent-overrides.ts";
import {
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	type AgentConfig,
	type AgentSource,
	type ChainConfig,
	type ChainDiscoveryDiagnostic,
} from "./agent-types.ts";
import { normalizeMaxSubagentDepth } from "../shared/types.ts";

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

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const localName = frontmatter.name;
		const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
		if (parsedPackage.error) continue;
		const packageName = parsedPackage.packageName;
		const runtimeName = buildRuntimeName(localName, packageName);

		const rawTools = parseCommaSeparatedList(frontmatter.tools);
		const parsedTools = splitToolList(rawTools);
		const defaultReads = parseCommaSeparatedList(frontmatter.defaultReads);
		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = parseCommaSeparatedList(skillStr);
		const fallbackModels = parseCommaSeparatedList(frontmatter.fallbackModels);
		const fallbackThinkingLevels = parseCommaSeparatedList(frontmatter.fallbackThinkingLevels);
		const systemPromptMode = frontmatter.systemPromptMode === "replace"
			? "replace"
			: frontmatter.systemPromptMode === "append"
				? "append"
				: defaultSystemPromptMode(localName);
		const inheritProjectContext = frontmatter.inheritProjectContext === "true"
			? true
			: frontmatter.inheritProjectContext === "false"
				? false
				: defaultInheritProjectContext(localName);
		const inheritSkills = frontmatter.inheritSkills === "true"
			? true
			: frontmatter.inheritSkills === "false"
				? false
				: defaultInheritSkills();
		const defaultContext = frontmatter.defaultContext === "fork"
			? "fork" as const
			: frontmatter.defaultContext === "fresh"
				? "fresh" as const
				: undefined;

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((extension) => extension.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (shouldPreserveAgentExtraField(key)) extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = normalizeMaxSubagentDepth(frontmatter.maxSubagentDepth);

		agents.push({
			name: runtimeName,
			localName,
			packageName,
			description: frontmatter.description,
			tools: parsedTools.tools,
			mcpDirectTools: parsedTools.mcpDirectTools,
			model: frontmatter.model,
			fallbackModels,
			fallbackThinkingLevels,
			thinking: frontmatter.thinking,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			defaultContext,
			systemPrompt: body,
			source,
			filePath,
			skills,
			extensions,
			output: frontmatter.output,
			defaultReads,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth: parsedMaxSubagentDepth,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

export function loadChainsFromDir(dir: string, source: "user" | "project"): { chains: ChainConfig[]; diagnostics: ChainDiscoveryDiagnostic[] } {
	const chains = new Map<string, ChainConfig>();
	const diagnostics: ChainDiscoveryDiagnostic[] = [];

	for (const filePath of listFilesRecursive(dir, (fileName) => fileName.endsWith(".chain.md") || fileName.endsWith(".chain.json"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const chain = filePath.endsWith(".chain.json") ? parseJsonChain(content, source, filePath) : parseChain(content, source, filePath);
			const existing = chains.get(chain.name);
			if (existing && existing.filePath.endsWith(".chain.json") && filePath.endsWith(".chain.md")) continue;
			chains.set(chain.name, chain);
		} catch (error) {
			diagnostics.push({ source, filePath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
	}

	return { chains: Array.from(chains.values()), diagnostics };
}
