import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens, estimateToolsTokens } from "../utils/estimate.ts";
import { getCurrentTools } from "../utils/transcript.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
// OpenRouter counts the input with its own tokenizer and rejects input + max_tokens above the
// window before routing. It counted prose up to 12% above the provider's count (upstream #10497).
const CONTEXT_SAFETY_RATIO = 0.15;
// The 15% margin is kept only while it leaves at least this much output. Otherwise (a nearly full
// large window, or any small window such as a 32k local model) only the fixed margin is kept, and
// output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
const MIN_MAX_TOKENS = 1;

/** Fit maxTokens into the context window, leaving room for the input being counted higher than estimated. */
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	return clampMaxTokensToInput(model, estimateContextTokens(context).tokens, maxTokens);
}

function clampMaxTokensToInput(model: Model<Api>, input: number, maxTokens: number): number {
	const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
	let room = model.contextWindow - input - margin;
	if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
		room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
	}
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
}

export function resolveSamplingParams(
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams
		? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: undefined;
}

export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetryContext: options?.telemetryContext,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		disableContinuation: options?.disableContinuation,
		headers: options?.headers,
		identity: options?.identity,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		streamDeadlineMs: options?.streamDeadlineMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		...(options?.retryDeadline === undefined ? {} : { retryDeadline: options.retryDeadline }),
		metadata: options?.metadata,
		env: options?.env,
	};
}

/**
 * The context estimate, counting tool changes after the last reply as the request sends them. Anthropic models with
 * mid-conversation tool changes send each change after the conversation, as estimated. Other requests declare the
 * current tools at the top instead: a removal only shortens that list, and a definition the last reply's request
 * already declared byte for byte is not new there. Every other definition counts in full.
 */
function estimateSentInputTokens(model: Model<Api>, context: TranscriptContext): number {
	const estimate = estimateContextTokens(context);
	const messages = context.messages;
	const compat = model.compat as { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolChanges?: boolean };
	if (
		model.api === "anthropic-messages" &&
		compat?.supportsMidConvoSystemMessages === true &&
		compat.supportsMidConvoToolChanges === true &&
		getCurrentTools(messages.slice(0, 1)).length > 0
	)
		return estimate.tokens;
	const start = estimate.lastUsageIndex === null ? 0 : estimate.lastUsageIndex + 1;
	const changes = messages
		.slice(start)
		.filter((message) => message.role === "system" && (message.toolsAdded?.length || message.toolsRemoved?.length));
	if (changes.length === 0) return estimate.tokens;
	const declared = new Map(getCurrentTools(messages.slice(0, start)).map((tool) => [tool.name, JSON.stringify(tool)]));
	let unsent = 0;
	for (const message of changes) {
		if (message.role !== "system") continue;
		const added = message.toolsAdded ?? [];
		const changed = added.filter((tool) => declared.get(tool.name) !== JSON.stringify(tool));
		unsent +=
			estimateToolsTokens(message.toolsRemoved) + estimateToolsTokens(added) - estimateToolsTokens(changed);
	}
	return estimate.tokens - unsent;
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const level = clampReasoning(reasoningLevel)!;
	return budgets[level]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/** The smallest thinking budget Claude accepts, on the Anthropic API and on Bedrock. */
export const MIN_THINKING_BUDGET = 1024;

/**
 * Fits a budget-based thinking request into the context window, keeping the context safety margin that guards against
 * an input estimate below the provider's count. The budget is kept whenever it and the minimum answer room fit under
 * that ceiling, and otherwise lowered by exactly what the ceiling lacks: a changed budget makes the provider bill the
 * cached conversation again. Returns undefined when even the smallest budget no longer fits; the request then goes
 * without thinking rather than with a budget the provider rejects, and the budget returns once it fits again.
 */
export function fitThinkingBudget(
	model: Model<Api>,
	context: TranscriptContext,
	maxTokens: number,
	thinkingBudget: number,
): { maxTokens: number; thinkingBudget: number } | undefined {
	const clamped =
		model.contextWindow <= 0
			? Math.max(MIN_MAX_TOKENS, maxTokens)
			: clampMaxTokensToInput(model, estimateSentInputTokens(model, context), maxTokens);
	// A budget that fits is sent as configured, even one below the minimum, which some compatible endpoints accept.
	if (thinkingBudget <= clamped - MIN_ANSWER_TOKENS) return { maxTokens: clamped, thinkingBudget };
	const budget = clamped - MIN_ANSWER_TOKENS;
	if (budget < MIN_THINKING_BUDGET) return undefined;
	return { maxTokens: clamped, thinkingBudget: budget };
}

/**
 * The thinking budget a budget-based request at `reasoning` asks for, and the budget it sends once fitted under the
 * context window as the Anthropic and Bedrock stream functions fit it: undefined when it goes without thinking.
 */
export function fittedThinkingBudget(
	model: Model<Api>,
	context: TranscriptContext,
	options: { reasoning: ThinkingLevel; thinkingBudgets?: ThinkingBudgets; maxTokens?: number },
): { requested: number; sent: number | undefined } {
	const adjusted = adjustMaxTokensForThinking(
		clampMaxTokensToContext(model, context, options.maxTokens ?? model.maxTokens),
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	return {
		requested: adjusted.thinkingBudget,
		sent: fitThinkingBudget(model, context, adjusted.maxTokens, adjusted.thinkingBudget)?.thinkingBudget,
	};
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
