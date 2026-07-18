import { createHash } from "node:crypto";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getEffectiveInputBudget } from "../context-window.js";
import { MIN_RESPONSES_MAX_OUTPUT_TOKENS } from "../openai-responses-payload-sanitizer.js";
import { isOpenAIResponsesCacheApi } from "./compaction-cache.js";
import type { CompactionRequestPrefix } from "./compaction-types.js";
import { projectProviderVisibleInput } from "./provider-visible-input.js";
import { restoreCapturedProviderPrefix } from "./provider-payload-restoration.js";

type JsonRecord = Record<string, unknown>;
type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

export type ProviderTokenCountConfidence = "exact" | "projection" | "heuristic" | "unavailable";

export interface ProviderPayloadTokenEstimate {
	tokens: number;
	confidence: ProviderTokenCountConfidence;
	source: string;
}

export type ProviderPayloadTokenCounter = (
	payload: unknown,
	model: Model<Api>,
) => Promise<ProviderPayloadTokenEstimate | undefined>;

export interface ProviderPayloadRetryGuard {
	rejectedTransportFingerprints: ReadonlySet<string>;
	rejectedInputFingerprints: ReadonlySet<string>;
	strictlySmallerThanInputBytes?: number;
}

export class ProviderPayloadRetryError extends Error {
	constructor(message: string) { super(message); this.name = "ProviderPayloadRetryError"; }
}

export class ProviderPayloadRestorationError extends Error {
	constructor(message: string) { super(message); this.name = "ProviderPayloadRestorationError"; }
}

export type PayloadFitLocalFailure =
	| { kind: "fit"; error: FinalPayloadFitError }
	| { kind: "retry_guard"; error: ProviderPayloadRetryError }
	| { kind: "warm_restoration"; error: ProviderPayloadRestorationError };

export interface PayloadFitState {
	maxTokens: number;
	inputTokens?: number;
	/** Backward-compatible diagnostic alias. */
	inputUpperBound?: number;
	countConfidence?: ProviderTokenCountConfidence;
	countSource?: string;
	/** Exact final transport fingerprint, computed after hooks and output-limit mutation. */
	payloadFingerprint?: string;
	outputLimitSent?: boolean;
	payloadBytes?: number;
	/** Provider-visible input projection, excluding output and transport controls. */
	inputFingerprint?: string;
	inputBytes?: number;
	finalPayloadProven: boolean;
	/** Request-local failure survives adapters that resolve hook throws as assistant errors. */
	localFailure?: PayloadFitLocalFailure;
}

export type FinalPayloadFitFailure = "input_headroom" | "output_budget";

export class FinalPayloadFitError extends Error {
	readonly inputUpperBound: number;
	readonly inputBudget: number;
	readonly contextWindow: number;
	readonly failure: FinalPayloadFitFailure;
	readonly requestMaxTokens: number;

	constructor(
		inputTokens: number,
		inputBudget: number,
		contextWindow: number,
		failure: FinalPayloadFitFailure = "input_headroom",
		requestMaxTokens = 0,
	) {
		super(failure === "output_budget"
			? "Compaction output budget is below the provider minimum"
			: `Compaction input exhausted the provider budget (${inputTokens} provider input tokens, ${inputBudget} input cap, ${contextWindow} total context)`);
		this.name = "FinalPayloadFitError";
		this.inputUpperBound = inputTokens;
		this.inputBudget = inputBudget;
		this.contextWindow = contextWindow;
		this.failure = failure;
		this.requestMaxTokens = nonnegativeFinite(requestMaxTokens);
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeFinite(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isJsonSerializable(value: unknown): boolean {
	try { JSON.stringify(value); return true; } catch { return false; }
}

function heuristicCount(value: unknown, seen: Set<object>): number | undefined {
	if (value === null || value === undefined) return 0;
	if (typeof value === "string") return Math.ceil(new TextEncoder().encode(value).length / 4);
	if (typeof value === "number" || typeof value === "boolean") return 1;
	if (typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	let total = Array.isArray(value) ? 2 + value.length * 2 : 4;
	const entries: Array<[string, unknown]> = Array.isArray(value)
		? value.map((item, index) => [String(index), item])
		: Object.entries(value);
	for (const [key, item] of entries) {
		const count = heuristicCount(item, seen);
		if (count === undefined) return undefined;
		total += count + (Array.isArray(value) ? 0 : Math.ceil(key.length / 4) + 2);
	}
	seen.delete(value);
	return total;
}

export async function providerAwarePayloadTokenEstimate(
	payload: unknown,
	model: Model<Api>,
	counter?: ProviderPayloadTokenCounter,
): Promise<ProviderPayloadTokenEstimate> {
	if (counter) {
		try {
			const counted = await counter(payload, model);
			if (counted && Number.isFinite(counted.tokens) && counted.tokens >= 0) {
				return { ...counted, tokens: Math.floor(counted.tokens) };
			}
		} catch {
			// Optional exact services degrade to local confidence-typed projection.
		}
	}
	const projection = projectProviderVisibleInput(payload, model.api);
	if (!isJsonSerializable(payload)) {
		return {
			tokens: 0, confidence: "unavailable",
			source: projection.explicit ? `${projection.source}-opaque` : "generic-provider-payload-unavailable",
		};
	}
	if (projection.mediaUnbounded) {
		return { tokens: 0, confidence: "unavailable", source: `${projection.source}-media-unbounded` };
	}
	const estimated = heuristicCount(projection.value, new Set<object>());
	return estimated === undefined
		? { tokens: 0, confidence: "unavailable", source: projection.explicit ? `${projection.source}-opaque` : "generic-provider-payload-unavailable" }
		: { tokens: estimated + 16, confidence: "heuristic", source: projection.source };
}

function fingerprintPayload(payload: unknown): { fingerprint: string; bytes: number } {
	const seen = new WeakSet<object>();
	const encoded = JSON.stringify(payload, (_key, value: unknown) => {
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) return "[Circular]";
			seen.add(value);
		}
		if (typeof value === "bigint") return `${value}n`;
		return value;
	}) ?? String(payload);
	return {
		fingerprint: createHash("sha256").update(encoded).digest("hex"),
		bytes: new TextEncoder().encode(encoded).length,
	};
}

function outputMinimum(model: Pick<Model<Api>, "api">): number {
	return model.api === "openai-responses" || model.api === "azure-openai-responses"
		? MIN_RESPONSES_MAX_OUTPUT_TOKENS : 1;
}

function exactPayloadEqual(left: unknown, right: unknown, pairs = new WeakMap<object, object>()): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const priorPair = pairs.get(left);
	if (priorPair !== undefined) return priorPair === right;
	pairs.set(left, right);
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((item, index) => exactPayloadEqual(item, right[index], pairs));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
	const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index] && exactPayloadEqual(left[key], right[key], pairs));
}

function visibleProjectionRecord(payload: unknown, model: Model<Api>): JsonRecord | undefined {
	const projection = projectProviderVisibleInput(payload, model.api);
	return projection.explicit && isRecord(projection.value) ? projection.value : undefined;
}

function capturedPrefixProjection(
	payload: unknown,
	prefix: CompactionRequestPrefix,
	model: Model<Api>,
	prefixReused: boolean,
): ProviderPayloadTokenEstimate | undefined {
	if (
		!prefixReused || prefix.providerInputTokens === undefined
		|| !Number.isFinite(prefix.providerInputTokens) || !isRecord(prefix.finalPayload)
	) return undefined;
	const priorPayload = prefix.finalPayload;
	const priorItems = payloadItems(priorPayload, model)?.items;
	const currentItems = isRecord(payload) ? payloadItems(payload, model)?.items : undefined;
	if (!priorItems || !currentItems || currentItems.length !== priorItems.length + 1) return undefined;
	if (!priorItems.every((item, index) => exactPayloadEqual(item, currentItems[index]))) return undefined;
	const priorProjection = visibleProjectionRecord(priorPayload, model);
	const currentProjection = visibleProjectionRecord(payload, model);
	const sequenceKey = payloadItems(priorPayload, model)?.key;
	if (!priorProjection || !currentProjection || !sequenceKey) return undefined;
	const priorOutside = { ...priorProjection };
	const currentOutside = { ...currentProjection };
	delete priorOutside[sequenceKey];
	delete currentOutside[sequenceKey];
	if (!exactPayloadEqual(priorOutside, currentOutside)) return undefined;
	const suffix = currentItems[currentItems.length - 1];
	if (projectProviderVisibleInput({ [sequenceKey]: [suffix] }, model.api).mediaUnbounded) return undefined;
	const delta = heuristicCount(suffix, new Set<object>());
	return delta === undefined ? undefined : {
		tokens: nonnegativeFinite(prefix.providerInputTokens) + delta + 16,
		confidence: "projection",
		source: "captured-provider-usage-plus-suffix",
	};
}

function payloadItems(payload: JsonRecord, model: Pick<Model<Api>, "api">): { key: "input" | "messages"; items: unknown[] } | undefined {
	const key = isOpenAIResponsesCacheApi(model.api) ? "input" : "messages";
	const items = payload[key];
	return Array.isArray(items) ? { key, items } : undefined;
}

function setPayloadOutputLimit(payload: unknown, maxTokens: number): boolean {
	if (!isRecord(payload)) return false;
	let sent = false;
	for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
		if (typeof payload[key] === "number") { payload[key] = maxTokens; sent = true; }
	}
	return sent;
}

/** Only exact/projected provider counts make a hard local fit decision. */
export function createProviderPayloadFitHook(
	model: Model<Api>,
	desiredOutput: number,
	state: PayloadFitState,
	prefix?: CompactionRequestPrefix,
	counter?: ProviderPayloadTokenCounter,
	retryGuard?: ProviderPayloadRetryGuard,
): PayloadHook {
	return async (candidate) => {
		let payload = candidate;
		let prefixReused = false;
		if (prefix) {
			const restored = restoreCapturedProviderPrefix(candidate, prefix, model);
			if (!restored.ok) {
				const error = new ProviderPayloadRestorationError(`Warm captured-prefix restoration declined: ${restored.reason}`);
				state.localFailure = { kind: "warm_restoration", error };
				throw error;
			}
			payload = restored.payload;
			prefixReused = true;
		}
		const count = !counter && prefix
			? capturedPrefixProjection(payload, prefix, model, prefixReused) ?? await providerAwarePayloadTokenEstimate(payload, model)
			: await providerAwarePayloadTokenEstimate(payload, model, counter);
		const inputBudget = getEffectiveInputBudget(model);
		const minimum = outputMinimum(model);
		const configuredOutput = nonnegativeFinite(Math.min(desiredOutput, model.maxTokens));
		const exact = count.confidence === "exact" || count.confidence === "projection";
		const remaining = exact ? nonnegativeFinite(model.contextWindow - count.tokens) : configuredOutput;
		state.inputTokens = count.tokens;
		state.inputUpperBound = count.tokens;
		state.countConfidence = count.confidence;
		state.countSource = count.source;
		state.maxTokens = exact ? Math.min(configuredOutput, remaining) : configuredOutput;
		state.outputLimitSent = setPayloadOutputLimit(payload, state.maxTokens);

		const visibleInput = projectProviderVisibleInput(payload, model.api);
		const inputFingerprint = fingerprintPayload(visibleInput.value);
		const transportFingerprint = fingerprintPayload(payload);
		state.inputFingerprint = inputFingerprint.fingerprint;
		state.inputBytes = inputFingerprint.bytes;
		state.payloadFingerprint = transportFingerprint.fingerprint;
		state.payloadBytes = transportFingerprint.bytes;
		if (
			retryGuard?.rejectedInputFingerprints.has(inputFingerprint.fingerprint)
			|| retryGuard?.rejectedTransportFingerprints.has(transportFingerprint.fingerprint)
		) {
			const error = new ProviderPayloadRetryError("Compaction retry suppressed an identical rejected provider input or transport payload");
			state.localFailure = { kind: "retry_guard", error };
			throw error;
		}
		if (
			retryGuard?.strictlySmallerThanInputBytes !== undefined
			&& inputFingerprint.bytes >= retryGuard.strictlySmallerThanInputBytes
		) {
			const error = new ProviderPayloadRetryError("Compaction retry provider input was not strictly smaller than the rejected provider input");
			state.localFailure = { kind: "retry_guard", error };
			throw error;
		}
		if (configuredOutput < minimum) {
			const error = new FinalPayloadFitError(count.tokens, inputBudget, model.contextWindow, "output_budget", state.maxTokens);
			state.localFailure = { kind: "fit", error };
			throw error;
		}
		if (exact && (count.tokens > inputBudget || state.maxTokens < minimum)) {
			const error = new FinalPayloadFitError(count.tokens, inputBudget, model.contextWindow, "input_headroom", state.maxTokens);
			state.localFailure = { kind: "fit", error };
			throw error;
		}
		state.finalPayloadProven = true;
		return payload;
	};
}

export function providerOutputMinimum(model: Pick<Model<Api>, "api">): number {
	return outputMinimum(model);
}
