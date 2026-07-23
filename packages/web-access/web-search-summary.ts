import { complete, getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { QueryResultData } from "./storage.js";
import {
	buildDeterministicSummary,
	generateSummaryDraft,
	type SummaryGenerationContext,
	type SummaryMeta,
} from "./summary-review.js";
import { loadConfig } from "./web-search-config.js";
import { filterByQueryIndices, normalizeSummaryMeta } from "./web-search-formatting.js";

async function resolveFirstAvailableModel(
	ctx: SummaryGenerationContext,
	candidates: Array<{ provider: string; id: string }>,
): Promise<{ model: Model; apiKey: string; headers?: ProviderHeaders }> {
	for (const { provider, id } of candidates) {
		const model = getModel(provider, id);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) {
			return {
				model: auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.baseUrl },
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}
	throw new Error(`No model available: ${candidates.map(c => `${c.provider}/${c.id}`).join(", ")}`);
}

export async function rewriteSearchQuery(
	query: string,
	ctx: SummaryGenerationContext,
	signal: AbortSignal,
): Promise<string> {
	const { model, apiKey, headers } = await resolveFirstAvailableModel(ctx, [
		{ provider: "anthropic", id: "claude-haiku-4-5" },
		{ provider: "google", id: "gemini-2.5-flash" },
		{ provider: "openai", id: "gpt-4.1-mini" },
	]);
	const response = await complete(
		model,
		{
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}` }],
				timestamp: Date.now(),
			}],
		},
		{ apiKey, headers, signal },
	);
	if (response.stopReason === "aborted") throw new Error("Aborted");
	const contentParts = Array.isArray(response.content) ? response.content : [];
	const text = contentParts
		.map(p => {
			if (!p || typeof p !== "object") return "";
			const part = p as Record<string, unknown>;
			return typeof part.text === "string" ? part.text : "";
		})
		.join("")
		.trim();
	if (!text) throw new Error("Rewrite returned empty response");
	return text;
}

export async function generateSummaryForSelectedIndices(
	selectedQueryIndices: number[],
	resultsByIndex: Map<number, QueryResultData>,
	summaryContext: SummaryGenerationContext,
	signal?: AbortSignal,
	modelOverride?: string,
	feedback?: string,
): Promise<{ summary: string; meta: SummaryMeta }> {
	const selectedResults: QueryResultData[] = [];
	for (const qi of selectedQueryIndices) {
		const result = resultsByIndex.get(qi);
		if (result) selectedResults.push(result);
	}
	if (selectedResults.length === 0) {
		throw new Error("No selected results available for summary generation");
	}
	try {
		return await generateSummaryDraft(selectedResults, summaryContext, signal, modelOverride, feedback);
	} catch (err) {
		const isEmptyResponse = err instanceof Error && err.message.includes("Summary model returned empty response");
		if (!isEmptyResponse) throw err;
		const deterministic = buildDeterministicSummary(selectedResults);
		return {
			summary: deterministic.summary,
			meta: {
				...deterministic.meta,
				fallbackReason: "summary-model-empty-response",
			},
		};
	}
}

export async function loadSummaryModelChoices(
	summaryContext: SummaryGenerationContext,
): Promise<{ summaryModels: Array<{ value: string; label: string }>; defaultSummaryModel: string | null }> {
	const summaryModels: Array<{ value: string; label: string }> = [];
	const seen = new Set<string>();
	const availableValues = new Set<string>();

	const addModel = (provider: string, id: string) => {
		const value = `${provider}/${id}`;
		if (seen.has(value)) return;
		seen.add(value);
		summaryModels.push({ value, label: value });
	};

	try {
		const availableModels = summaryContext.modelRegistry.getAvailable();
		for (const model of availableModels) {
			const value = `${model.provider}/${model.id}`;
			availableValues.add(value);
			addModel(model.provider, model.id);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Failed to load summary models: ${message}`);
	}

	const currentModelValue = summaryContext.model
		? `${summaryContext.model.provider}/${summaryContext.model.id}`
		: null;
	if (summaryContext.model && currentModelValue && !seen.has(currentModelValue)) {
		addModel(summaryContext.model.provider, summaryContext.model.id);
	}

	const config = loadConfig();
	const configuredSummaryModel = typeof config.summaryModel === "string" ? config.summaryModel.trim() : "";
	const preferredDefaults = [
		"anthropic/claude-haiku-4-5",
		"openai-codex/gpt-5.3-codex-spark",
	];

	let defaultSummaryModel: string | null = null;
	if (configuredSummaryModel.length > 0 && availableValues.has(configuredSummaryModel)) {
		defaultSummaryModel = configuredSummaryModel;
	}
	if (!defaultSummaryModel) {
		for (const preferred of preferredDefaults) {
			if (availableValues.has(preferred)) {
				defaultSummaryModel = preferred;
				break;
			}
		}
	}
	if (!defaultSummaryModel && summaryModels.length > 0) {
		defaultSummaryModel = summaryModels[0].value;
	}

	return { summaryModels, defaultSummaryModel };
}

export function resolveSummaryForSubmit(
	payload: { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta },
	resultsByIndex: Map<number, QueryResultData>,
): { approvedSummary: string; summaryMeta: SummaryMeta } {
	const submittedSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
	if (submittedSummary.length > 0) {
		return {
			approvedSummary: submittedSummary,
			summaryMeta: normalizeSummaryMeta(payload.summaryMeta, submittedSummary),
		};
	}

	const selected = filterByQueryIndices(payload.selectedQueryIndices, resultsByIndex).results;
	const fallbackResults = selected.length > 0 ? selected : [...resultsByIndex.values()];
	const deterministic = buildDeterministicSummary(fallbackResults);
	return {
		approvedSummary: deterministic.summary,
		summaryMeta: deterministic.meta,
	};
}
