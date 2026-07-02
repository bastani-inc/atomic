import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { COPILOT_CATALOG_HEADERS, DEFAULT_COPILOT_API_BASE_URL, type CopilotModelContext } from "./copilot-model-catalog.ts";
import { withContextWindowOptions } from "./context-window.ts";

const GITHUB_COPILOT_PROVIDER = "github-copilot";
const ENDPOINT_API_PREFERENCE = [
	["/v1/messages", "anthropic-messages"],
	["/responses", "openai-responses"],
	["/chat/completions", "openai-completions"],
] as const satisfies readonly (readonly [string, Api])[];

const ZERO_COST: Model<Api>["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ADAPTIVE_THINKING_LEVEL_MAP: Model<Api>["thinkingLevelMap"] = { minimal: "low", xhigh: "max" };
const REASONING_EFFORT_LEVEL_MAP: Model<Api>["thinkingLevelMap"] = { off: null, minimal: "low", xhigh: "xhigh" };

export interface CopilotModelTemplate {
	baseUrl: string;
	headers?: Record<string, string>;
}

function mapCopilotApi(entry: CopilotModelContext): Api | undefined {
	const endpoints = new Set(entry.supportedEndpoints ?? []);
	return ENDPOINT_API_PREFERENCE.find(([endpoint]) => endpoints.has(endpoint))?.[1];
}

function hasReasoning(entry: CopilotModelContext): boolean {
	return Boolean(
		entry.supports?.reasoningEffort || entry.supports?.adaptiveThinking || entry.supports?.minThinkingBudget || entry.supports?.maxThinkingBudget,
	);
}

function reasoningEffortThinkingLevelMap(entry: CopilotModelContext): Model<Api>["thinkingLevelMap"] {
	const levels = new Set(entry.supports?.reasoningEffortLevels ?? []);
	if (levels.size === 0) return REASONING_EFFORT_LEVEL_MAP;
	const map: Model<Api>["thinkingLevelMap"] = { off: null, minimal: levels.has("low") ? "low" : null };
	if (levels.has("xhigh")) map.xhigh = "xhigh";
	else if (levels.has("max")) map.xhigh = "max";
	return map;
}

function thinkingLevelMapFor(entry: CopilotModelContext): Model<Api>["thinkingLevelMap"] | undefined {
	if (entry.supports?.adaptiveThinking) return ADAPTIVE_THINKING_LEVEL_MAP;
	if (entry.supports?.reasoningEffort) return reasoningEffortThinkingLevelMap(entry);
	return undefined;
}

function canSynthesizeCopilotModel(id: string, entry: CopilotModelContext): boolean {
	if (id.includes("/")) return false;
	if (entry.modelPickerEnabled !== true) return false;
	if (entry.type !== "chat") return false;
	if (entry.policyState?.toLowerCase() === "disabled") return false;
	return mapCopilotApi(entry) !== undefined;
}

export function copilotTemplateFromModels(models: readonly Model<Api>[]): CopilotModelTemplate {
	const sibling = models.find((model) => model.provider === GITHUB_COPILOT_PROVIDER);
	return {
		baseUrl: sibling?.baseUrl ?? DEFAULT_COPILOT_API_BASE_URL,
		headers: sibling?.headers ?? COPILOT_CATALOG_HEADERS,
	};
}

export function synthesizeCopilotCatalogModels(
	catalog: ReadonlyMap<string, CopilotModelContext>,
	existingIds: ReadonlySet<string>,
	template: CopilotModelTemplate,
): Model<Api>[] {
	const synthesized: Model<Api>[] = [];
	for (const [id, entry] of catalog) {
		if (existingIds.has(id) || !canSynthesizeCopilotModel(id, entry)) continue;
		const api = mapCopilotApi(entry);
		if (!api) continue;
		let model: Model<Api> = {
			id,
			name: entry.displayName ?? id,
			api,
			provider: GITHUB_COPILOT_PROVIDER,
			baseUrl: template.baseUrl,
			headers: template.headers,
			reasoning: hasReasoning(entry),
			thinkingLevelMap: thinkingLevelMapFor(entry),
			compat: entry.supports?.adaptiveThinking ? ({ forceAdaptiveThinking: true } as Model<Api>["compat"]) : undefined,
			input: entry.supports?.vision ? ["text", "image"] : ["text"],
			cost: ZERO_COST,
			maxInputTokens: entry.maxInputTokens,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens ?? entry.limits?.maxOutputTokens ?? entry.maxInputTokens ?? entry.contextWindow,
		};
		if (entry.contextWindowOptions && entry.contextWindowOptions.length > 1) {
			model = withContextWindowOptions(model, entry.contextWindowOptions);
		}
		synthesized.push(model);
	}
	return synthesized;
}
