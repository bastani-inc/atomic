import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { PackageAgentFile } from "@bastani/atomic";
import { pathExists } from "../shared/path-exists.js";
import { splitToolList } from "./agent-overrides.js";
import { shouldPreserveAgentExtraField } from "./agent-serializer.js";
import {
	type AgentConfig,
	type AgentSource,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.js";
import { type FrontmatterValue, parseFrontmatter } from "./frontmatter.js";
import { buildRuntimeName, packageAgentNamespace, parsePackageName } from "./identity.js";

async function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean): Promise<string[]> {
	const files: string[] = [];
	if (!(await pathExists(dir))) return files;

	let entries: Dirent[];
	try {
		entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return files;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(filePath, predicate)));
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
 * Narrow a frontmatter value to a boolean. The real YAML parser yields true
 * booleans for the unquoted spellings `serializeAgent` itself writes
 * (`interactive: true`); quoted or hand-written `"true"`/`"false"` strings
 * from the legacy line-reader era stay accepted.
 */
function frontmatterBoolean(value: FrontmatterValue | undefined): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
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

export interface AgentLoadDiagnostic {
	/** Absolute path of the skipped file. */
	path: string;
	/** Why the file was skipped, from the YAML parser when it threw. */
	message: string;
}

export interface AgentDirLoadResult {
	agents: AgentConfig[];
	diagnostics: AgentLoadDiagnostic[];
}

type AgentFileParse = { agent: AgentConfig } | { diagnostic: AgentLoadDiagnostic } | undefined;

/**
 * Parse one agent file. With `packageNamespace` (an agent an installed package ships), the namespace replaces the
 * file's own `package:` frontmatter, so the agent is always named `<namespace>.<name>`.
 */
function parseAgentFile(
	filePath: string,
	content: string,
	source: AgentSource,
	packageNamespace?: string,
): AgentFileParse {
	const { frontmatter, body, parseError } = parseFrontmatter(content);
	if (parseError !== undefined) {
		return { diagnostic: { path: filePath, message: parseError } };
	}

	// Sequences are legal frontmatter but not valid `name`/`description`
	// spellings; a file whose identity fields are not plain strings is
	// skipped whole, exactly as upstream's loader does.
	const localName = frontmatterString(frontmatter.name);
	const description = frontmatterString(frontmatter.description);
	if (!localName || !description) {
		return undefined;
	}

	let packageName: string | undefined;
	if (packageNamespace === undefined) {
		const parsedPackage = parsePackageName(frontmatterString(frontmatter.package), `Agent '${localName}' package`);
		if (parsedPackage.error) return undefined;
		packageName = parsedPackage.packageName;
	} else {
		// The namespace and the name are joined with a dot, so a dotted name could read as another package's agent.
		if (localName.includes(".")) {
			return {
				diagnostic: {
					path: filePath,
					message: `Package agent name '${localName}' must not contain '.'; the package namespace '${packageNamespace}' is joined to it with one.`,
				},
			};
		}
		packageName = packageNamespace;
	}
	const runtimeName = buildRuntimeName(localName, packageName);

	const rawTools = parseToolList(frontmatter.tools);
	const parsedTools = splitToolList(rawTools);
	const inheritProjectContextRaw = frontmatterBoolean(frontmatter.inheritProjectContext);
	const inheritSkillsRaw = frontmatterBoolean(frontmatter.inheritSkills);
	const defaultContextRaw = frontmatterString(frontmatter.defaultContext);
	const extensionsRaw = frontmatterString(frontmatter.extensions);
	const systemPromptModeRaw = frontmatterString(frontmatter.systemPromptMode);
	const defaultReads = parseCommaSeparatedList(frontmatterString(frontmatter.defaultReads));
	const skillStr = frontmatterString(frontmatter.skill) || frontmatterString(frontmatter.skills) || undefined;
	const skills = parseCommaSeparatedList(skillStr);
	const fallbackModels = parseCommaSeparatedList(frontmatterString(frontmatter.fallbackModels));
	const fallbackThinkingLevels = parseCommaSeparatedList(frontmatterString(frontmatter.fallbackThinkingLevels));
	const inheritProjectContext = inheritProjectContextRaw ?? defaultInheritProjectContext(localName);
	const inheritSkills = inheritSkillsRaw ?? defaultInheritSkills();
	const systemPromptMode =
		systemPromptModeRaw === "replace"
			? "replace"
			: systemPromptModeRaw === "append"
				? "append"
				: defaultSystemPromptMode(localName);
	const defaultContext =
		defaultContextRaw === "fork" ? ("fork" as const) : defaultContextRaw === "fresh" ? ("fresh" as const) : undefined;
	let extensions: string[] | undefined;
	if (extensionsRaw !== undefined) {
		extensions = extensionsRaw
			.split(",")
			.map((extension) => extension.trim())
			.filter(Boolean);
	}

	const extraFields: Record<string, FrontmatterValue> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (shouldPreserveAgentExtraField(key)) extraFields[key] = value;
	}

	const agent: AgentConfig = {
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
		defaultProgress: frontmatterBoolean(frontmatter.defaultProgress) === true,
		interactive: frontmatterBoolean(frontmatter.interactive) === true,
		extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
	};
	return { agent };
}

/**
 * Load every agent file in a directory, collecting a diagnostic per file
 * skipped for invalid YAML frontmatter. The real YAML parser is stricter
 * than the line reader it replaced (`description: Deploy: fast` is a
 * nested-mapping error, not a description), so without this record those
 * files would vanish from discovery with no signal.
 */
export async function loadAgentsFromDirWithDiagnostics(dir: string, source: AgentSource): Promise<AgentDirLoadResult> {
	const agents: AgentConfig[] = [];
	const diagnostics: AgentLoadDiagnostic[] = [];

	for (const filePath of await listFilesRecursive(dir, (fileName) => fileName.endsWith(".md"))) {
		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseAgentFile(filePath, content, source);
		if (parsed === undefined) continue;
		if ("diagnostic" in parsed) diagnostics.push(parsed.diagnostic);
		else agents.push(parsed.agent);
	}

	return { agents, diagnostics };
}

/**
 * Load the agent files installed packages ship, in the host's discovery order. Each is named
 * `<package namespace>.<name>`; when two packages ship the same full name, the first one wins and the other is
 * reported.
 */
export async function loadPackageAgentsWithDiagnostics(
	files: readonly PackageAgentFile[],
): Promise<AgentDirLoadResult> {
	const agents: AgentConfig[] = [];
	const diagnostics: AgentLoadDiagnostic[] = [];
	const byName = new Map<string, AgentConfig>();
	for (const file of files) {
		const namespace = packageAgentNamespace(file.packageName, file.packageRoot);
		if (namespace === undefined) {
			diagnostics.push({
				path: file.path,
				message: `Package ${file.source} has no name that can namespace its agents.`,
			});
			continue;
		}
		let content: string;
		try {
			content = await readFile(file.path, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseAgentFile(file.path, content, "package", namespace);
		if (parsed === undefined) continue;
		if ("diagnostic" in parsed) {
			diagnostics.push(parsed.diagnostic);
			continue;
		}
		const agent: AgentConfig = { ...parsed.agent, packageOrigin: { source: file.source, scope: file.scope } };
		const first = byName.get(agent.name);
		if (first) {
			diagnostics.push({
				path: file.path,
				message: `Agent '${agent.name}' from package ${file.source} is shadowed by the same name from package ${first.packageOrigin?.source} (${first.filePath}).`,
			});
			continue;
		}
		byName.set(agent.name, agent);
		agents.push(agent);
	}
	return { agents, diagnostics };
}

export async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentConfig[]> {
	return (await loadAgentsFromDirWithDiagnostics(dir, source)).agents;
}
