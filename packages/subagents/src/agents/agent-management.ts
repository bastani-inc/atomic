import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import type { SubagentToolResult } from "../shared/types.ts";
import {
	allAgents,
	applyAgentConfig,
	asDisambiguationScope,
	availableNames,
	configObject,
	fallbackModelsWarning,
	findAgents,
	hasKey,
	modelWarning,
	nameExistsInScope,
	normalizeListScope,
	parsePackageConfig,
	result,
	sanitizeName,
	skillsWarning,
} from "./agent-management-helpers.ts";
import { serializeAgent } from "./agent-serializer.ts";
import {
	type AgentConfig,
	type AgentSource,
	buildRuntimeName,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	frontmatterNameForConfig,
} from "./agents.ts";

type ManagementAction = "list" | "get" | "create" | "update" | "delete";
export type ManagementScope = "user" | "project";
export type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry"> &
	Pick<Partial<ExtensionContext>, "getSkillCatalog">;

interface ManagementParams {
	action?: string;
	agent?: string;
	agentScope?: string;
	config?: unknown;
}

type MutableDefinition<T extends { source: AgentSource }> = T & { source: ManagementScope };

function isMutableDefinition<T extends { source: AgentSource }>(value: T): value is MutableDefinition<T> {
	return value.source === "user" || value.source === "project";
}

function resolveTarget<T extends { source: AgentSource; filePath: string; name: string }>(
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): MutableDefinition<T> | SubagentToolResult {
	const mutable = matches.filter(isMutableDefinition);
	if (mutable.length === 0) {
		if (matches.length > 0)
			return result(
				`Agent '${name}' is builtin and cannot be modified. Create a same-named agent in user or project scope to override it.`,
				true,
			);
		const available = availableNames(cwd);
		return result(`Agent '${name}' not found. Available: ${available.join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return result(`Agent '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return result(`Agent '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1)
		return result(
			`Multiple agents named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`,
			true,
		);
	return scoped[0]!;
}

function renamePath(
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	cwd: string,
): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath))
		return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const filePath = path.join(path.dirname(currentPath), `${newName}.md`);
	if (fs.existsSync(filePath) && filePath !== currentPath)
		return {
			error: `File already exists at ${filePath} but is not a valid agent definition. Remove or rename it first.`,
		};
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.extensions !== undefined)
		lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const agents = allAgents(d)
		.filter((agent) => !agent.disabled && (scope === "both" || agent.source === "builtin" || agent.source === scope))
		.sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"Executable agents:",
		...(agents.length
			? agents.map(
					(agent) =>
						`- ${agent.name} (${agent.source}${agent.defaultContext ? `, context: ${agent.defaultContext}` : ""}): ${agent.description}`,
				)
			: ["- (none)"]),
	];
	return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent) return result("Specify 'agent' for get.", true);
	const matches = findAgents(params.agent, ctx.cwd, "both");
	if (!matches.length)
		return result(
			`Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd).join(", ") || "none"}.`,
			true,
		);
	return result(matches.map(formatAgentDetail).join("\n\n"));
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
	if (typeof cfg.name !== "string" || !cfg.name.trim())
		return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim())
		return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name)
		return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const parsedPackage = parsePackageConfig(cfg.package);
	if (parsedPackage.error) return result(parsedPackage.error, true);
	const runtimeName = buildRuntimeName(name, parsedPackage.packageName);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	const d = discoverAgentsAll(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : (d.projectDir ?? path.join(ctx.cwd, CONFIG_DIR_NAME, "agents"));
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, runtimeName))
		return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, `${runtimeName}.md`);
	if (fs.existsSync(targetPath))
		return result(
			`File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`,
			true,
		);
	const warnings: string[] = [];
	if (d.builtin.some((a) => a.name === runtimeName))
		warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	const agent: AgentConfig = {
		name: runtimeName,
		localName: name,
		packageName: parsedPackage.packageName,
		description: cfg.description.trim(),
		source: scope,
		filePath: targetPath,
		systemPrompt: "",
		systemPromptMode: defaultSystemPromptMode(name),
		inheritProjectContext: defaultInheritProjectContext(name),
		inheritSkills: defaultInheritSkills(),
	};
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return result(applyError, true);
	const mw = modelWarning(ctx, agent.model);
	if (mw) warnings.push(mw);
	const fmw = fallbackModelsWarning(ctx, agent.fallbackModels);
	if (fmw) warnings.push(fmw);
	const sw = skillsWarning(ctx.cwd, agent.skills, ctx.getSkillCatalog?.());
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent) return result("Specify 'agent' for update.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(
		params.agent,
		findAgents(params.agent, ctx.cwd, scopeHint ?? "both"),
		ctx.cwd,
		params.agentScope,
	);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	const updated: AgentConfig = { ...target };
	const oldName = target.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim()))
		return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim()))
		return result("config.description must be a non-empty string when provided.", true);
	let newLocalName = target.localName ?? frontmatterNameForConfig(target);
	if (hasKey(cfg, "name")) {
		newLocalName = sanitizeName(cfg.name as string);
		if (!newLocalName) return result("config.name is invalid after sanitization.", true);
	}
	let newPackageName = target.packageName;
	if (hasKey(cfg, "package")) {
		const parsedPackage = parsePackageConfig(cfg.package);
		if (parsedPackage.error) return result(parsedPackage.error, true);
		newPackageName = parsedPackage.packageName;
	}
	const applyError = applyAgentConfig(updated, cfg);
	if (applyError) return result(applyError, true);
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (hasKey(cfg, "model")) {
		const warning = modelWarning(ctx, updated.model);
		if (warning) warnings.push(warning);
	}
	if (hasKey(cfg, "fallbackModels")) {
		const warning = fallbackModelsWarning(ctx, updated.fallbackModels);
		if (warning) warnings.push(warning);
	}
	if (hasKey(cfg, "skills")) {
		const warning = skillsWarning(ctx.cwd, updated.skills, ctx.getSkillCatalog?.());
		if (warning) warnings.push(warning);
	}
	if (updated.name !== oldName) {
		const renamed = renamePath(target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	const headline =
		updated.name === oldName
			? `Updated agent '${updated.name}' at ${updated.filePath}.`
			: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent) return result("Specify 'agent' for delete.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(
		params.agent,
		findAgents(params.agent, ctx.cwd, scopeHint ?? "both"),
		ctx.cwd,
		params.agentScope,
	);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	fs.unlinkSync(target.filePath);
	return result(`Deleted agent '${target.name}' at ${target.filePath}.`);
}

export function handleManagementAction(
	action: string,
	params: ManagementParams,
	ctx: ManagementContext,
): SubagentToolResult {
	switch (action as ManagementAction) {
		case "list":
			return handleList(params, ctx);
		case "get":
			return handleGet(params, ctx);
		case "create":
			return handleCreate(params, ctx);
		case "update":
			return handleUpdate(params, ctx);
		case "delete":
			return handleDelete(params, ctx);
		default:
			return result(`Unknown action: ${action}`, true);
	}
}
