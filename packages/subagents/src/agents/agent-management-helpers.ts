import type { AgentConfig, AgentScope, ChainConfig, ChainStepConfig } from "./agents.ts";
import { discoverAgentsAll, parsePackageName } from "./agents.ts";
import { discoverAvailableSkills } from "./skills.ts";
import { MAX_SUBAGENT_NESTING_DEPTH, type SubagentToolResult } from "../shared/types.ts";
import type { ManagementContext, ManagementScope } from "./agent-management.ts";

export function result(text: string, isError = false): SubagentToolResult {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

export function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

export function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `config must be valid JSON: ${message}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

export function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

export function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

export function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function parsePackageConfig(value: unknown): { packageName?: string; error?: string } {
	return parsePackageName(value, "config.package");
}

export function allAgents(d: { builtin: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }): AgentConfig[] {
	return [...d.builtin, ...d.user, ...d.project];
}

export function availableNames(cwd: string, kind: "agent" | "chain"): string[] {
	const d = discoverAgentsAll(cwd);
	const items = kind === "agent" ? allAgents(d) : d.chains;
	return [...new Set(items.map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

export function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return allAgents(d)
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function findChains(name: string, cwd: string, scope: AgentScope = "both"): ChainConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return discoverAgentsAll(cwd).chains
		.filter((c) => (scope === "both" || c.source === scope) && (c.name === raw || c.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function nameExistsInScope(cwd: string, scope: ManagementScope, name: string, excludePath?: string): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	for (const c of d.chains) {
		if (c.source === scope && c.name === name && c.filePath !== excludePath) return true;
	}
	return false;
}

export function chainStepAgentNames(step: ChainStepConfig): string[] {
	const names: string[] = [];
	if (typeof step.agent === "string") names.push(step.agent);
	const parallel = step.parallel;
	if (Array.isArray(parallel)) {
		for (const item of parallel) {
			if (item && typeof item === "object") {
				const agent = (item as { agent?: unknown }).agent;
				if (typeof agent === "string") names.push(agent);
			}
		}
	} else if (parallel && typeof parallel === "object") {
		const agent = (parallel as { agent?: unknown }).agent;
		if (typeof agent === "string") names.push(agent);
	}
	return names;
}

export function unknownChainAgents(cwd: string, steps: ChainStepConfig[]): string[] {
	const d = discoverAgentsAll(cwd);
	const known = new Set(allAgents(d).map((a) => a.name));
	const unknown = steps
		.flatMap((step) => chainStepAgentNames(step))
		.filter((agent) => !known.has(agent));
	return [...new Set(unknown)].sort((a, b) => a.localeCompare(b));
}

export function chainStepWarnings(ctx: ManagementContext, steps: ChainStepConfig[]): string[] {
	const warnings: string[] = [];
	const available = new Set(discoverAvailableSkills(ctx.cwd).map((s) => s.name));
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i]!;
		if (s.model) {
			const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === s.model || m.id === s.model);
			if (!found) warnings.push(`Warning: step ${i + 1} (${s.agent}): model '${s.model}' is not in the current model registry.`);
		}
		if (Array.isArray(s.skills) && s.skills.length > 0) {
			const missing = s.skills.filter((sk) => !available.has(sk));
			if (missing.length) warnings.push(`Warning: step ${i + 1} (${s.agent}): skills not found: ${missing.join(", ")}.`);
		}
	}
	return warnings;
}

export function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
}

export function fallbackModelsWarning(ctx: ManagementContext, fallbackModels: string[] | undefined): string | undefined {
	if (!fallbackModels || fallbackModels.length === 0) return undefined;
	const available = new Set(ctx.modelRegistry.getAvailable().flatMap((m) => [`${m.provider}/${m.id}`, m.id]));
	const missing = fallbackModels.filter((model) => !available.has(model));
	return missing.length ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.` : undefined;
}

export function skillsWarning(cwd: string, skills: string[] | undefined): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const available = new Set(discoverAvailableSkills(cwd).map((s) => s.name));
	const missing = skills.filter((s) => !available.has(s));
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}

export function parseStepList(raw: unknown): { steps?: ChainStepConfig[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array." };
	if (raw.length === 0) return { error: "config.steps must include at least one step." };
	const steps: ChainStepConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.steps[${i}] must be an object.` };
		const s = item as Record<string, unknown>;
		if (typeof s.agent !== "string" || !s.agent.trim()) return { error: `config.steps[${i}].agent must be a non-empty string.` };
		const step: ChainStepConfig = { agent: s.agent.trim(), task: typeof s.task === "string" ? s.task : "" };
		if (hasKey(s, "phase")) {
			if (typeof s.phase === "string") step.phase = s.phase;
			else return { error: `config.steps[${i}].phase must be a string.` };
		}
		if (hasKey(s, "label")) {
			if (typeof s.label === "string") step.label = s.label;
			else return { error: `config.steps[${i}].label must be a string.` };
		}
		if (hasKey(s, "as")) {
			if (typeof s.as === "string") step.as = s.as;
			else return { error: `config.steps[${i}].as must be a string.` };
		}
		if (hasKey(s, "outputSchema")) {
			if (typeof s.outputSchema === "string") step.outputSchema = s.outputSchema;
			else return { error: `config.steps[${i}].outputSchema must be a schema file path string for saved chains.` };
		}
		if (hasKey(s, "output")) {
			if (s.output === false) step.output = false;
			else if (typeof s.output === "string") step.output = s.output;
			else return { error: `config.steps[${i}].output must be a string or false.` };
		}
		if (hasKey(s, "outputMode")) {
			if (s.outputMode === "inline" || s.outputMode === "file-only") step.outputMode = s.outputMode;
			else return { error: `config.steps[${i}].outputMode must be 'inline' or 'file-only'.` };
		}
		if (hasKey(s, "reads")) {
			if (s.reads === false) step.reads = false;
			else if (Array.isArray(s.reads)) step.reads = s.reads.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].reads must be an array or false.` };
		}
		if (hasKey(s, "model")) {
			if (typeof s.model === "string") step.model = s.model;
			else return { error: `config.steps[${i}].model must be a string.` };
		}
		if (hasKey(s, "skills")) {
			if (s.skills === false) step.skills = false;
			else if (Array.isArray(s.skills)) step.skills = s.skills.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].skills must be an array or false.` };
		}
		if (hasKey(s, "progress")) {
			if (typeof s.progress === "boolean") step.progress = s.progress;
			else return { error: `config.steps[${i}].progress must be a boolean.` };
		}
		steps.push(step);
	}
	return { steps };
}

export function parseTools(raw: string): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const item of parseCsv(raw)) {
		if (item.startsWith("mcp:")) {
			const direct = item.slice(4).trim();
			if (direct) mcpDirectTools.push(direct);
		} else tools.push(item);
	}
	return { tools: tools.length ? tools : undefined, mcpDirectTools: mcpDirectTools.length ? mcpDirectTools : undefined };
}

export function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") target.fallbackModels = undefined;
		else if (typeof cfg.fallbackModels === "string") {
			const models = parseCsv(cfg.fallbackModels);
			target.fallbackModels = models.length ? models : undefined;
		} else if (Array.isArray(cfg.fallbackModels)) {
			const models = cfg.fallbackModels
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
			target.fallbackModels = models.length ? [...new Set(models)] : undefined;
		} else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { target.tools = undefined; target.mcpDirectTools = undefined; }
		else if (typeof cfg.tools === "string") { const parsed = parseTools(cfg.tools); target.tools = parsed.tools; target.mcpDirectTools = parsed.mcpDirectTools; }
		else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") target.skills = undefined;
		else if (typeof cfg.skills === "string") { const skills = parseCsv(cfg.skills); target.skills = skills.length ? skills : undefined; }
		else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") target.systemPromptMode = cfg.systemPromptMode;
		else return "config.systemPromptMode must be 'append' or 'replace' when provided.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") return "config.inheritProjectContext must be a boolean when provided.";
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean when provided.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "defaultContext")) {
		if (cfg.defaultContext === false || cfg.defaultContext === "") target.defaultContext = undefined;
		else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork") target.defaultContext = cfg.defaultContext;
		else return "config.defaultContext must be 'fresh', 'fork', or false when provided.";
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") target.output = undefined;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") target.defaultReads = undefined;
		else if (typeof cfg.reads === "string") {
			const reads = parseCsv(cfg.reads);
			target.defaultReads = reads.length ? reads : undefined;
		} else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") target.maxSubagentDepth = undefined;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) {
			target.maxSubagentDepth = Math.min(cfg.maxSubagentDepth, MAX_SUBAGENT_NESTING_DEPTH);
		} else return `config.maxSubagentDepth must be an integer >= 0 or false when provided; values above ${MAX_SUBAGENT_NESTING_DEPTH} are clamped.`;
	}
	return undefined;
}

