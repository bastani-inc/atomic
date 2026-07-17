import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getEffectiveInputBudget } from "../context-window.js";
import { MIN_RESPONSES_MAX_OUTPUT_TOKENS } from "../openai-responses-payload-sanitizer.js";
import { createCompactionCachePayloadHook, isOpenAIResponsesCacheApi } from "./compaction-cache.js";
import type { CompactionRequestPrefix } from "./compaction-types.js";

type JsonRecord = Record<string, unknown>;
type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

export interface PayloadFitState {
	maxTokens: number;
	inputUpperBound: number;
	finalPayloadProven: boolean;
}

export type FinalPayloadFitFailure = "input_headroom" | "output_budget";

export class FinalPayloadFitError extends Error {
	readonly inputUpperBound: number;
	readonly inputBudget: number;
	readonly contextWindow: number;
	readonly failure: FinalPayloadFitFailure;

	constructor(
		inputUpperBound: number,
		inputBudget: number,
		contextWindow: number,
		failure: FinalPayloadFitFailure = "input_headroom",
	) {
		super(failure === "output_budget"
			? "Compaction output budget is below the provider minimum"
			: `Compaction input exhausted the provider budget (${inputUpperBound} conservative input tokens, ${inputBudget} input cap, ${contextWindow} total context)`);
		this.name = "FinalPayloadFitError";
		this.inputUpperBound = inputUpperBound;
		this.inputBudget = inputBudget;
		this.contextWindow = contextWindow;
		this.failure = failure;
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every tokenizer token consumes at least one UTF-8 byte; bytes are therefore a safe upper bound. */
export function conservativePayloadTokenUpperBound(payload: unknown): number {
	return new TextEncoder().encode(JSON.stringify(payload)).length + 64;
}

function outputMinimum(model: Pick<Model<Api>, "api">): number {
	return isOpenAIResponsesCacheApi(model.api) ? MIN_RESPONSES_MAX_OUTPUT_TOKENS : 1;
}

function payloadItems(payload: JsonRecord, model: Pick<Model<Api>, "api">): { key: "input" | "messages"; items: unknown[] } | undefined {
	const key = isOpenAIResponsesCacheApi(model.api) ? "input" : "messages";
	const items = payload[key];
	return Array.isArray(items) ? { key, items } : undefined;
}

function clonePayload<T>(value: T): T {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clonePayload(item)) as T;
	const copied: JsonRecord = {};
	for (const key of Reflect.ownKeys(value)) Reflect.set(copied, key, clonePayload(Reflect.get(value, key)));
	return copied as T;
}

/** Replace the candidate's historical provider items with the exact captured payload and append only its new suffix item. */
function reuseCapturedPrefix(candidate: unknown, prefix: CompactionRequestPrefix, model: Model<Api>): unknown {
	if (!isRecord(candidate) || !isRecord(prefix.finalPayload)) throw new FinalPayloadFitError(Number.MAX_SAFE_INTEGER, getEffectiveInputBudget(model), model.contextWindow);
	const prior = payloadItems(prefix.finalPayload, model);
	const next = payloadItems(candidate, model);
	if (!prior || !next || next.items.length === 0) throw new FinalPayloadFitError(Number.MAX_SAFE_INTEGER, getEffectiveInputBudget(model), model.contextWindow);
	const merged = clonePayload(prefix.finalPayload) as JsonRecord;
	merged[prior.key] = [...clonePayload(prior.items), clonePayload(next.items[next.items.length - 1])];
	for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
		if (candidate[key] !== undefined) merged[key] = candidate[key];
	}
	return merged;
}

function setPayloadOutputLimit(payload: unknown, maxTokens: number): void {
	if (!isRecord(payload)) return;
	for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
		if (typeof payload[key] === "number") payload[key] = maxTokens;
	}
}

/** Runs at the adapter's final pre-transport payload boundary and proves the shaped request fits. */
export function createProviderPayloadFitHook(
	model: Model<Api>,
	desiredOutput: number,
	state: PayloadFitState,
	prefix?: CompactionRequestPrefix,
): PayloadHook {
	const cacheHook = prefix ? createCompactionCachePayloadHook(model) : undefined;
	return async (candidate) => {
		let payload = prefix ? reuseCapturedPrefix(candidate, prefix, model) : candidate;
		const cacheShaped = await cacheHook?.(payload, model);
		if (cacheShaped !== undefined) payload = cacheShaped;
		const inputUpperBound = conservativePayloadTokenUpperBound(payload);
		const inputBudget = getEffectiveInputBudget(model);
		const minimum = outputMinimum(model);
		const configuredOutput = Math.min(desiredOutput, model.maxTokens);
		const maxTokens = Math.min(configuredOutput, Math.floor(model.contextWindow - inputUpperBound));
		state.inputUpperBound = inputUpperBound;
		state.maxTokens = maxTokens;
		if (configuredOutput < minimum) {
			throw new FinalPayloadFitError(inputUpperBound, inputBudget, model.contextWindow, "output_budget");
		}
		if (inputUpperBound > inputBudget || maxTokens < minimum) {
			throw new FinalPayloadFitError(inputUpperBound, inputBudget, model.contextWindow, "input_headroom");
		}
		state.finalPayloadProven = true;
		setPayloadOutputLimit(payload, maxTokens);
		return payload;
	};
}

export function providerOutputMinimum(model: Pick<Model<Api>, "api">): number {
	return outputMinimum(model);
}
