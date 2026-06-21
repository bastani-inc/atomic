import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import type { ExtensionContext } from "@bastani/atomic";
import {
	type AgentConfig,
	type AgentSource,
	type ChainConfig,
	type ChainStepConfig,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	buildRuntimeName,
	frontmatterNameForConfig,
} from "./agents.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { serializeChain, serializeJsonChain } from "./chain-serializer.ts";
import { allAgents, applyAgentConfig, asDisambiguationScope, availableNames, chainStepWarnings, configObject, fallbackModelsWarning, findAgents, findChains, hasKey, modelWarning, nameExistsInScope, normalizeListScope, parsePackageConfig, parseStepList, result, sanitizeName, skillsWarning, unknownChainAgents } from "./agent-management-helpers.ts";
import type { SubagentToolResult } from "../shared/types.ts";

type ManagementAction = "list" | "get" | "create" | "update" | "delete";
export type ManagementScope = "user" | "project";
export type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry">;

interface ManagementParams {
	action?: string;
	agent?: string;
	chainName?: string;
	agentScope?: string;
	config?: unknown;
}

type MutableDefinition<T extends { source: AgentSource }> = T & { source: ManagementScope };

function isMutableDefinition<T extends { source: AgentSource }>(value: T): value is MutableDefinition<T> {
	return value.source === "user" || value.source === "project";
}

function resolveTarget<T extends { source: AgentSource; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): MutableDefinition<T> | SubagentToolResult {
	const mutable = matches.filter(isMutableDefinition);
	if (mutable.length === 0) {
		if (matches.length > 0) {
			return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' is builtin and cannot be modified. Create a same-named ${kind} in user or project scope to override it.`, true);
		}
		const available = availableNames(cwd, kind);
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${available.join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1) return result(`Multiple ${kind}s named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`, true);
	return scoped[0]!;
}

function renamePath(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	cwd: string,
): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const ext = kind === "agent" ? ".md" : currentPath.endsWith(".chain.json") ? ".chain.json" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
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
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

function formatChainStepDetail(step: ChainStepConfig, index: number): string[] {
	const lines: string[] = [];
	if (step.expand || step.collect) {
		const parallel = step.parallel && !Array.isArray(step.parallel) && typeof step.parallel === "object" ? step.parallel as { agent?: unknown; task?: unknown; label?: unknown; outputSchema?: unknown } : undefined;
		const expand = step.expand && typeof step.expand === "object" ? step.expand as { from?: { output?: unknown; path?: unknown }; item?: unknown; key?: unknown; maxItems?: unknown; onEmpty?: unknown } : undefined;
		const collect = step.collect && typeof step.collect === "object" ? step.collect as { as?: unknown; outputSchema?: unknown } : undefined;
		lines.push(`${index + 1}. Dynamic fanout${typeof collect?.as === "string" ? ` -> ${collect.as}` : ""}`);
		if (expand?.from) lines.push(`   Expand: ${String(expand.from.output ?? "?")}${String(expand.from.path ?? "")}`);
		if (typeof expand?.item === "string") lines.push(`   Item variable: ${expand.item}`);
		if (typeof expand?.key === "string") lines.push(`   Key: ${expand.key}`);
		if (typeof expand?.maxItems === "number") lines.push(`   Max items: ${expand.maxItems}`);
		if (typeof expand?.onEmpty === "string") lines.push(`   On empty: ${expand.onEmpty}`);
		if (parallel?.agent) lines.push(`   Agent: ${String(parallel.agent)}`);
		if (typeof parallel?.label === "string") lines.push(`   Label: ${parallel.label}`);
		if (typeof parallel?.task === "string" && parallel.task.trim()) lines.push(`   Task: ${parallel.task}`);
		if (parallel?.outputSchema) lines.push("   Structured output: true");
		if (collect?.outputSchema) lines.push("   Collect schema: true");
		if (step.concurrency !== undefined) lines.push(`   Concurrency: ${step.concurrency}`);
		if (step.failFast !== undefined) lines.push(`   Fail fast: ${step.failFast ? "true" : "false"}`);
		return lines;
	}
	lines.push(`${index + 1}. ${step.agent}`);
	if (step.task?.trim()) lines.push(`   Task: ${step.task}`);
	if (step.output === false) lines.push("   Output: false");
	else if (step.output) lines.push(`   Output: ${step.output}`);
	if (step.outputMode) lines.push(`   Output mode: ${step.outputMode}`);
	if (step.reads === false) lines.push("   Reads: false");
	else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`   Reads: ${step.reads.join(", ")}`);
	if (step.model) lines.push(`   Model: ${step.model}`);
	if (step.skills === false) lines.push("   Skills: false");
	else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`   Skills: ${step.skills.join(", ")}`);
	if (step.progress !== undefined) lines.push(`   Progress: ${step.progress ? "true" : "false"}`);
	return lines;
}

function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [`Chain: ${chain.name} (${chain.source})`, `Path: ${chain.filePath}`, `Description: ${chain.description}`];
	if (chain.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(chain)}`);
		lines.push(`Package: ${chain.packageName}`);
	}
	lines.push("", "Steps:");
	for (let i = 0; i < chain.steps.length; i++) {
		lines.push(...formatChainStepDetail(chain.steps[i]!, i));
	}
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const scopedAgents = allAgents(d).filter((a) => scope === "both" || a.source === "builtin" || a.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const agents = scopedAgents.filter((a) => !a.disabled);
	const chains = d.chains.filter((c) => scope === "both" || c.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const diagnostics = d.chainDiagnostics.filter((entry) => scope === "both" || entry.source === scope);
	const lines = [
		"Executable agents:",
		...(agents.length
			? agents.map((a) => `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`)
			: ["- (none)"]),
		"",
		"Chains:",
		...(chains.length ? chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"]),
		...(diagnostics.length ? ["", "Chain diagnostics:", ...diagnostics.map((entry) => `- ${entry.filePath}: ${entry.error}`)] : []),
	];
	return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for get.", true);
	const hasBoth = Boolean(params.agent && params.chainName);
	const blocks: string[] = [];
	let anyFound = false;
	if (params.agent) {
		const matches = findAgents(params.agent, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatAgentDetail));
		}
	}
	if (params.chainName) {
		const matches = findChains(params.chainName, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Chain '${params.chainName}' not found. Available: ${availableNames(ctx.cwd, "chain").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatChainDetail));
		}
	}
	return result(blocks.join("\n\n"), !anyFound);
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name) return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const parsedPackage = parsePackageConfig(cfg.package);
	if (parsedPackage.error) return result(parsedPackage.error, true);
	const runtimeName = buildRuntimeName(name, parsedPackage.packageName);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	const isChain = hasKey(cfg, "steps");
	const d = discoverAgentsAll(ctx.cwd);
	const targetDir = isChain
		? scope === "user" ? d.userChainDir : d.projectChainDir ?? path.join(ctx.cwd, CONFIG_DIR_NAME, "chains")
		: scope === "user" ? d.userDir : d.projectDir ?? path.join(ctx.cwd, CONFIG_DIR_NAME, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, isChain ? `${runtimeName}.chain.md` : `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (!isChain && d.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		const chain: ChainConfig = { name: runtimeName, localName: name, packageName: parsedPackage.packageName, description: cfg.description.trim(), source: scope, filePath: targetPath, steps: parsed.steps! };
		fs.writeFileSync(targetPath, serializeChain(chain), "utf-8");
		const missing = unknownChainAgents(ctx.cwd, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, chain.steps));
		return result([`Created chain '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
	}
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
	const sw = skillsWarning(ctx.cwd, agent.skills);
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for update.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		const updated: AgentConfig = { ...target };
		const oldName = target.name;
		if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
		if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
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
			const mw = modelWarning(ctx, updated.model);
			if (mw) warnings.push(mw);
		}
		if (hasKey(cfg, "fallbackModels")) {
			const fmw = fallbackModelsWarning(ctx, updated.fallbackModels);
			if (fmw) warnings.push(fmw);
		}
		if (hasKey(cfg, "skills")) {
			const sw = skillsWarning(ctx.cwd, updated.skills);
			if (sw) warnings.push(sw);
		}
		if (updated.name !== oldName) {
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, ctx.cwd);
			if (renamed.error) return result(renamed.error, true);
			updated.filePath = renamed.filePath!;
		}
		fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
		if (updated.name !== oldName) {
			const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === oldName)).map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		const headline = updated.name === oldName
			? `Updated agent '${updated.name}' at ${updated.filePath}.`
			: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
		return result([headline, ...warnings].join("\n"));
	}
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	const updated: ChainConfig = { ...target, steps: [...target.steps] };
	const oldName = target.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
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
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		parsedSteps = parsed.steps!;
	}
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(ctx.cwd, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, updated.steps));
	}
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, updated.filePath.endsWith(".chain.json") ? serializeJsonChain(updated) : serializeChain(updated), "utf-8");
	const headline = updated.name === oldName
		? `Updated chain '${updated.name}' at ${updated.filePath}.`
		: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for delete.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	if (params.agent) {
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		fs.unlinkSync(target.filePath);
		const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === target.name)).map((c) => `${c.name} (${c.source})`);
		const lines = [`Deleted agent '${target.name}' at ${target.filePath}.`];
		if (refs.length) lines.push(`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`);
		return result(lines.join("\n"));
	}
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	fs.unlinkSync(target.filePath);
	return result(`Deleted chain '${target.name}' at ${target.filePath}.`);
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): SubagentToolResult {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
